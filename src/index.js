const express = require('express');
const sequelize = require('./config/database');
const routes = require('./routes');

const app = express();
app.use(express.json());

// Routes
app.use('/api', routes);

// Sync DB
const startServer = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Connexion DB OK');

    await sequelize.sync({ alter: process.env.NODE_ENV === 'development' });
    console.log('✅ Base synchronisée');

    const PORT = process.env.PORT || 5500;
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ Impossible de démarrer le serveur :', err);
    process.exit(1); // quitte si la DB est inaccessible
  }
};

startServer();
