const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { Utilisateur } = require('../models');

class NotificationService {
  constructor() {
    this.io = null;
    this.connectedUsers = new Map(); // userId -> socketId
  }

  initialize(server) {
    this.io = new Server(server, {
      cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3000",
        methods: ["GET", "POST"]
      }
    });

    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        if (!token) {
          return next(new Error('Authentication error'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await Utilisateur.findByPk(decoded.id);

        if (!user) {
          return next(new Error('User not found'));
        }

        socket.userId = user.id;
        socket.user = user;
        next();
      } catch (err) {
        next(new Error('Authentication error'));
      }
    });

    this.io.on('connection', (socket) => {
      console.log(`User ${socket.userId} connected`);

      // Stocker la connexion
      this.connectedUsers.set(socket.userId, socket.id);

      // Événements utilisateur
      socket.on('disconnect', () => {
        console.log(`User ${socket.userId} disconnected`);
        this.connectedUsers.delete(socket.userId);
      });

      socket.on('join-room', (room) => {
        socket.join(room);
        console.log(`User ${socket.userId} joined room: ${room}`);
      });

      socket.on('leave-room', (room) => {
        socket.leave(room);
        console.log(`User ${socket.userId} left room: ${room}`);
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
  notifyCompany(companyId, event, data) {
    this.io.to(`company-${companyId}`).emit(event, data);
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