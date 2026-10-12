const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { Utilisateur, Entreprise, Conge } = require('../models');
const { getLeaveRules, getEffectiveLeaveRules } = require('./politiqueConges');
const { resolveManagerDelivery } = require('./managerCrossServicePolicy');
const systemSettingsService = require('./systemSettingsService');
const logger = require('../utils/logger');

const isSocketDebug = process.env.SOCKET_DEBUG === 'true';

function socketLog(...args) {
  if (isSocketDebug) {
    logger.info(...args);
  }
}

class NotificationService {
  constructor() {
    this.io = null;
    this.connectedUsers = new Map(); // userId -> socketId
  }

  initialize(server) {
    this.io = new Server(server, {
      cors: {
        origin: process.env.FRONTEND_URL
          ? process.env.FRONTEND_URL.split(',').map((o) => o.trim())
          : ['http://localhost:3001', 'http://localhost:5173'],
        methods: ["GET", "POST"]
      }
    });

    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        if (!token) {
          logger.warn('Socket auth failed: no token');
          return next(new Error('Authentication error'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await Utilisateur.findByPk(decoded.id);

        if (!user) {
          logger.warn('Socket auth failed: user not found', decoded);
          return next(new Error('User not found'));
        }

        socket.userId = user.id;
        socket.user = user;
        next();
      } catch (err) {
        logger.warn('Socket auth failed:', err.message);
        next(new Error('Authentication error'));
      }
    });

    this.io.on('connection', (socket) => {
      socketLog(`User ${socket.userId} connected`);

      // Stocker la connexion
      this.connectedUsers.set(socket.userId, socket.id);

      // Événements utilisateur
      socket.on('disconnect', () => {
        socketLog(`User ${socket.userId} disconnected`);
        this.connectedUsers.delete(socket.userId);
      });

      socket.on('join-room', (room) => {
        const ownCompanyRoom = socket.user?.entreprise_id
          ? `company-${socket.user.entreprise_id}`
          : null;
        if (room === ownCompanyRoom) {
          socket.join(room);
          socketLog(`User ${socket.userId} joined room: ${room}`);
        }
      });

      socket.on('leave-room', (room) => {
        socket.leave(room);
        socketLog(`User ${socket.userId} left room: ${room}`);
      });
    });

    return this.io;
  }

  // Envoyer une notification à un utilisateur spécifique
  notifyUser(userId, event, data) {
    const socketId = this.connectedUsers.get(userId);
    if (socketId) {
      this.io.to(socketId).emit(event, data);
      return true;
    }
    return false;
  }

  // Envoyer une notification à tous les utilisateurs d'une entreprise
  async notifyCompany(companyId, event, data) {
    if (!this.io || !companyId) return;
    const { pushNotifications } = await systemSettingsService.getSettings();
    if (!pushNotifications) return;

    const congeId = data?.conge?.id || data?.congeId;
    if (!congeId) return;

    const conge = data.conge?.toJSON ? data.conge.toJSON() : data.conge || await Conge.findByPk(congeId);
    if (!conge) return;

    const [employee, entreprise, users] = await Promise.all([
      conge.utilisateur?.id
        ? Promise.resolve(conge.utilisateur)
        : Utilisateur.findByPk(conge.utilisateur_id, { attributes: ['id', 'prenom', 'nom', 'service'] }),
      Entreprise.findByPk(companyId, { attributes: ['politique_conges'] }),
      Utilisateur.findAll({
        where: { entreprise_id: companyId, statut: 'actif' },
        attributes: ['id', 'role', 'service'],
      }),
    ]);

    if (!employee) return;
    const leaveService = employee.service || conge.utilisateur?.service || null;
    const leaveRules = getLeaveRules(entreprise);
    if (event === 'conge-created' && !leaveRules.notification_settings.on_create) return;
    if (event === 'conge-status-changed'
      && ((data.action === 'validated' && !leaveRules.notification_settings.on_validate)
        || (data.action === 'rejected' && !leaveRules.notification_settings.on_reject))) return;
    const workflow = conge.effective_approval_workflow
      || getEffectiveLeaveRules(leaveRules, leaveService).approval_workflow;

    for (const recipient of users) {
      let managerCanValidate = true;
      let managerCanView = true;

      if (recipient.role === 'manager' && recipient.id !== employee.id) {
        const delivery = resolveManagerDelivery({
          rules: leaveRules, manager: recipient, targetService: leaveService,
          actionRequired: event === 'conge-created' && conge.statut === 'en_attente_manager'
            && ['manager', 'manager_only', 'manager_admin'].includes(workflow),
        });
        if (!delivery.in_app) continue;
        managerCanValidate = delivery.mode === 'action';
        managerCanView = delivery.canView;
      } else if (recipient.role === 'manager') {
        managerCanValidate = false;
      }

      const eventConge = managerCanView
        ? { ...conge, utilisateur: conge.utilisateur || employee }
        : {
          id: conge.id, statut: conge.statut, date_debut: conge.date_debut, date_fin: conge.date_fin,
          utilisateur: { prenom: employee.prenom, nom: employee.nom, service: employee.service },
        };
      if (recipient.id !== employee.id) {
        eventConge.commentaire_employe = null;
        eventConge.commentaire_manager = null;
        eventConge.commentaire_admin = null;
      }
      const payload = { ...data, conge: eventConge };
      if (recipient.role === 'manager') {
        payload.notification_mode = managerCanValidate ? 'action' : 'information';
      } else if (recipient.role === 'admin_entreprise') {
        const pendingAdmin = workflow === 'admin_only' && conge.statut === 'en_attente_manager'
          || workflow === 'manager_admin' && conge.statut === 'valide_manager';
        payload.notification_mode = recipient.id !== employee.id && pendingAdmin
          && ['conge-created', 'conge-status-changed'].includes(event) ? 'action' : 'information';
      }
      this.notifyUser(recipient.id, event, payload);
    }
  }

  // Envoyer une notification à une salle spécifique
  notifyRoom(room, event, data) {
    this.io.to(room).emit(event, data);
  }

  // Diffuser à tous les utilisateurs connectés
  broadcast(event, data) {
    this.io.emit(event, data);
  }

  // Obtenir le nombre d'utilisateurs connectés
  getConnectedUsersCount() {
    return this.connectedUsers.size;
  }

  // Vérifier si un utilisateur est connecté
  isUserConnected(userId) {
    return this.connectedUsers.has(userId);
  }
}

module.exports = new NotificationService();