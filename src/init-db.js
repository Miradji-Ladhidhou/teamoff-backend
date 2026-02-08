require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runSqlFile() {
  try {
    // Charge le fichier SQL
    const sqlFilePath = path.join(__dirname, 'teamoff.sql'); 
    const sql = fs.readFileSync(sqlFilePath, { encoding: 'utf8' });

    // Exécute tout le script
    await pool.query(sql);
    console.log('✅ Base de données initialisée avec succès !');
  } catch (err) {
    console.error('❌ Erreur lors de l\'initialisation :', err);
  } finally {
    await pool.end();
  }
}

runSqlFile();
