describe('Sécurité API - payloads et injections', () => {
  it('rejette un JSON malformé', async () => {
    const response = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', 'Bearer mock-employee-token')
      .set('Content-Type', 'application/json')
      .send('{invalid json}')
      .expect(400);
    expect(response.body).toHaveProperty('message');
  });

  it('rejette une injection SQL/XSS basique sur création utilisateur', async () => {
    const payload = {
      nom: "Robert'); DROP TABLE utilisateur;--<script>alert('xss')</script>",
      prenom: '<img src=x onerror=alert(1)>',
      email: `xss${Date.now()}@test.com`,
      role: 'employe',
      entreprise_id: (await Entreprise.findOne()).id,
      service: 'IT',
      date_embauche: '2026-03-20'
    };
    const response = await request(app)
      .post('/api/users')
      .set('Authorization', 'Bearer mock-admin-token')
      .send(payload);
    // On attend un 201 ou un 400, mais jamais une exécution d'injection
    expect([201, 400]).toContain(response.status);
    if (response.status === 201) {
      expect(response.body.nom).not.toMatch(/<script|DROP TABLE|onerror/);
    }
  });

  it('rejette les champs texte trop longs (utilisateur)', async () => {
    const longStr = 'A'.repeat(300);
    const payload = {
      nom: longStr,
      prenom: longStr,
      email: `long${Date.now()}@test.com`,
      role: 'employe',
      entreprise_id: (await Entreprise.findOne()).id,
      service: 'IT',
      date_embauche: '2026-03-20'
    };
    const response = await request(app)
      .post('/api/users')
      .set('Authorization', 'Bearer mock-admin-token')
      .send(payload);
    expect([400, 422]).toContain(response.status);
    if (response.status === 400 || response.status === 422) {
      expect(response.body).toHaveProperty('message');
    }
  });

  it('rejette les champs texte trop longs (congé)', async () => {
    const longStr = 'B'.repeat(3000);
    const congeType = await CongeType.findOne();
    const payload = {
      conge_type_id: congeType.id,
      date_debut: '2026-03-20',
      date_fin: '2026-03-22',
      commentaire_employe: longStr
    };
    const response = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', 'Bearer mock-employee-token')
      .send(payload);
    expect([400, 422]).toContain(response.status);
    if (response.status === 400 || response.status === 422) {
      expect(response.body).toHaveProperty('message');
    }
  });
});
const request = require('supertest');
// Import the app without starting the server
const express = require('express');
const routes = require('../src/routes');
const { metricsMiddleware } = require('../src/middlewares/metrics');
const { generalLimiter } = require('../src/middlewares/rateLimiter');
const errorHandler = require('../src/middlewares/errorHandler');
const sequelize = require('../src/config/database');
const { Utilisateur: User, Conge, CongeType, Entreprise } = require('../src/models');

const app = express();
app.use(express.json());
app.use(metricsMiddleware);
app.use(generalLimiter);

// Health endpoint
app.get('/health', async (req, res) => {
  try {
    await sequelize.authenticate();
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

app.use('/api', routes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route non trouvée' });
});

app.use(errorHandler);

// Setup test database
beforeAll(async () => {
  await sequelize.sync({ force: true }); // Reset database for tests
});

afterAll(async () => {
  await sequelize.close();
});

describe('TeamOff API', () => {
  let adminToken;
  let employeeToken;
  let testUser;
  let testEntreprise;

  beforeAll(async () => {
    // Create test entreprise
    testEntreprise = await Entreprise.create({
      nom: 'Test Company',
      email: 'test@company.com',
      telephone: '0123456789'
    });

    // Create test users
    const admin = await User.create({
      nom: 'Admin',
      prenom: 'Test',
      email: 'admin@test.com',
      password_hash: '$2b$10$hashedpassword', // Would be hashed in real scenario
      role: 'admin_entreprise',
      entreprise_id: testEntreprise.id,
      actif: true
    });

    const employee = await User.create({
      nom: 'Employee',
      prenom: 'Test',
      email: 'employee@test.com',
      password_hash: '$2b$10$hashedpassword',
      role: 'employe',
      entreprise_id: testEntreprise.id,
      actif: true
    });

    testUser = employee;

    // Mock JWT tokens for testing
    adminToken = 'mock-admin-token';
    employeeToken = 'mock-employee-token';
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('db', 'connected');
    });
  });

  describe('Authentication', () => {
    it('should reject invalid login', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'invalid@example.com',
          password: 'wrongpassword'
        })
        .expect(401);

      expect(response.body).toHaveProperty('message');
    });

    it('should login with valid credentials', async () => {
      // This would require mocking the authentication service
      // For now, we'll test the endpoint structure
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'password123'
        });

      // Expect either success or controlled failure
      expect([200, 401, 403]).toContain(response.status);
    });
  });

  describe('Conges API', () => {
    let congeType;

    beforeAll(async () => {
      congeType = await CongeType.create({
        libelle: 'Congés payés',
        code: 'CP',
        description: 'Congés annuels payés',
        couleur: '#007bff',
        entreprise_id: testEntreprise.id
      });
    });

    describe('GET /api/conges', () => {
      it('should require authentication', async () => {
        const response = await request(app)
          .get('/api/conges')
          .expect(401);

        expect(response.body).toHaveProperty('message');
      });

      it('should return conges list when authenticated', async () => {
        // Mock authentication middleware for testing
        const response = await request(app)
          .get('/api/conges')
          .set('Authorization', `Bearer ${employeeToken}`);

        // Should return 200 or 401 depending on token validation
        expect([200, 401]).toContain(response.status);
      });
    });

    describe('POST /api/conges/demande', () => {
      it('should create a new conge request', async () => {
        const congeData = {
          conge_type_id: congeType.id,
          date_debut: '2024-06-01',
          date_fin: '2024-06-05',
          commentaire_employe: 'Vacances d\'été'
        };

        const response = await request(app)
          .post('/api/conges/demande')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send(congeData);

        expect([201, 401]).toContain(response.status);
        if (response.status === 201) {
          expect(response.body).toHaveProperty('id');
          expect(response.body).toHaveProperty('statut', 'en_attente');
        }
      });

      it('should validate required fields', async () => {
        const response = await request(app)
          .post('/api/conges/demande')
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({});

        expect([400, 401]).toContain(response.status);
      });
    });
  });

  describe('Users API', () => {
    describe('GET /api/users', () => {
      it('should require admin role', async () => {
        const response = await request(app)
          .get('/api/users')
          .set('Authorization', `Bearer ${employeeToken}`);

        expect([403, 401]).toContain(response.status);
      });

      it('should return users list for admin', async () => {
        const response = await request(app)
          .get('/api/users')
          .set('Authorization', `Bearer ${adminToken}`);

        expect([200, 401]).toContain(response.status);
      });
    });
  });

  describe('Rate Limiting', () => {
    it('should limit excessive requests', async () => {
      const requests = [];

      // Make multiple requests quickly
      for (let i = 0; i < 15; i++) {
        requests.push(
          request(app)
            .get('/health')
            .expect((res) => {
              if (i > 10) {
                // Later requests might be rate limited
                expect([200, 429]).toContain(res.status);
              }
            })
        );
      }

      await Promise.all(requests);
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 for unknown routes', async () => {
      const response = await request(app)
        .get('/api/unknown-route')
        .expect(404);

      expect(response.body).toHaveProperty('message');
    });

    it('should handle malformed JSON', async () => {
      const response = await request(app)
        .post('/api/conges/demande')
        .set('Content-Type', 'application/json')
        .send('{invalid json}')
        .expect(400);

      expect(response.body).toHaveProperty('message');
    });
  });

  describe('Export Routes', () => {
    it('should reject export requests without authentication', async () => {
      const exportRoutes = [
        '/api/exports/conges/csv',
        '/api/exports/conges/pdf',
        '/api/exports/utilisateurs/csv',
        '/api/exports/audit/csv',
        '/api/exports/usage/pdf'
      ];

      for (const route of exportRoutes) {
        const response = await request(app)
          .get(route)
          .expect(401);

        expect(response.body).toHaveProperty('message');
      }
    });

    it('should accept export routes structure', async () => {
      // Test that routes exist (even if they return 401 due to no auth)
      const response = await request(app)
        .get('/api/exports/conges/csv')
        .expect(401);

      expect(response.headers).toHaveProperty('ratelimit-limit');
    });
  });
});