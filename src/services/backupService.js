const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(exec);

class BackupService {
  constructor() {
    this.backupDir = path.join(__dirname, '../../backups');
    this.retentionDays = 30; // Garder les sauvegardes 30 jours
  }

  // Créer une sauvegarde complète de la base de données
  async createDatabaseBackup() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `backup-${timestamp}.sql`;
      const filepath = path.join(this.backupDir, filename);

      // S'assurer que le répertoire de sauvegarde existe
      await fs.mkdir(this.backupDir, { recursive: true });

      // Commande pg_dump pour PostgreSQL
      const dbConfig = {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME,
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD
      };

      const dumpCommand = `pg_dump -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.username} -d ${dbConfig.database} -f ${filepath}`;

      // Exécuter la commande de sauvegarde
      await execAsync(dumpCommand, {
        env: { ...process.env, PGPASSWORD: dbConfig.password }
      });

      console.log(`✅ Sauvegarde créée: ${filename}`);

      // Compresser le fichier
      await this.compressBackup(filepath);

      // Nettoyer les anciennes sauvegardes
      await this.cleanupOldBackups();

      return { success: true, filename, filepath };

    } catch (error) {
      console.error('❌ Erreur lors de la création de la sauvegarde:', error);
      throw error;
    }
  }

  // Compresser une sauvegarde
  async compressBackup(filepath) {
    try {
      const compressedPath = `${filepath}.gz`;
      await execAsync(`gzip ${filepath}`);
      console.log(`📦 Sauvegarde compressée: ${path.basename(compressedPath)}`);
      return compressedPath;
    } catch (error) {
      console.warn('⚠️ Erreur lors de la compression:', error.message);
      return filepath; // Retourner le fichier non compressé
    }
  }

  // Restaurer une sauvegarde
  async restoreDatabaseBackup(filename) {
    try {
      const filepath = path.join(this.backupDir, filename);

      // Vérifier que le fichier existe
      await fs.access(filepath);

      const dbConfig = {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME,
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD
      };

      // Commande de restauration
      const restoreCommand = `psql -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.username} -d ${dbConfig.database} -f ${filepath}`;

      await execAsync(restoreCommand, {
        env: { ...process.env, PGPASSWORD: dbConfig.password }
      });

      console.log(`✅ Sauvegarde restaurée: ${filename}`);
      return { success: true };

    } catch (error) {
      console.error('❌ Erreur lors de la restauration:', error);
      throw error;
    }
  }

  // Lister les sauvegardes disponibles
  async listBackups() {
    try {
      const files = await fs.readdir(this.backupDir);
      const backups = files
        .filter(file => file.startsWith('backup-') && (file.endsWith('.sql') || file.endsWith('.sql.gz')))
        .map(file => {
          const stats = fs.statSync(path.join(this.backupDir, file));
          return {
            filename: file,
            size: stats.size,
            createdAt: stats.birthtime,
            compressed: file.endsWith('.gz')
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt);

      return backups;
    } catch (error) {
      console.error('Erreur lors de la liste des sauvegardes:', error);
      return [];
    }
  }

  // Nettoyer les anciennes sauvegardes
  async cleanupOldBackups() {
    try {
      const backups = await this.listBackups();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

      const oldBackups = backups.filter(backup => backup.createdAt < cutoffDate);

      for (const backup of oldBackups) {
        const filepath = path.join(this.backupDir, backup.filename);
        await fs.unlink(filepath);
        console.log(`🗑️ Ancienne sauvegarde supprimée: ${backup.filename}`);
      }

    } catch (error) {
      console.error('Erreur lors du nettoyage des sauvegardes:', error);
    }
  }

  // Programmer des sauvegardes automatiques
  scheduleAutomaticBackups() {
    // Sauvegarde quotidienne à 2h du matin
    const scheduleDailyBackup = () => {
      const now = new Date();
      const nextBackup = new Date(now);
      nextBackup.setHours(2, 0, 0, 0);

      if (nextBackup <= now) {
        nextBackup.setDate(nextBackup.getDate() + 1);
      }

      const timeUntilBackup = nextBackup - now;

      setTimeout(async () => {
        try {
          await this.createDatabaseBackup();
        } catch (error) {
          console.error('Erreur sauvegarde automatique:', error);
        }
        // Reprogrammer pour le lendemain
        scheduleDailyBackup();
      }, timeUntilBackup);
    };

    scheduleDailyBackup();
    console.log('🔄 Sauvegardes automatiques programmées');
  }
}

module.exports = new BackupService();