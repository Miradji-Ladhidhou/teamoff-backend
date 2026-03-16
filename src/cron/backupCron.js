const cron = require('node-cron');
const systemSettingsService = require('../services/systemSettingsService');
const { runDatabaseBackup, cleanupOldBackups } = require('../services/backupService');

// Expressions cron par fréquence (exécution à 2h du matin)
const CRON_EXPRESSIONS = {
  daily: '0 2 * * *',      // Tous les jours à 2h
  weekly: '0 2 * * 0',     // Chaque dimanche à 2h
  monthly: '0 2 1 * *',    // Le 1er de chaque mois à 2h
};

let currentTask = null;
let currentFrequency = null;

async function runBackupJob() {
  try {
    const { dbRetentionDays } = await systemSettingsService.getSettings();

    console.log('[BackupCron] Démarrage sauvegarde automatique...');
    const result = await runDatabaseBackup();

    // Mettre à jour lastBackupAt dans les settings
    await systemSettingsService.updateSettings({ lastBackupAt: result.createdAt });

    console.log(`[BackupCron] Sauvegarde créée : ${result.filename} (${result.sizeBytes} bytes)`);

    // Nettoyage des anciens backups
    const cleanup = cleanupOldBackups(dbRetentionDays);
    if (cleanup.deleted.length > 0) {
      console.log(`[BackupCron] Nettoyage : ${cleanup.deleted.length} fichier(s) supprimé(s) (rétention ${dbRetentionDays} jours)`);
    }
  } catch (err) {
    console.error('[BackupCron] Erreur lors de la sauvegarde automatique :', err.message);
  }
}

/**
 * Initialise ou met à jour le cron en fonction des settings actuels.
 * Appelé au démarrage et à chaque modification des paramètres base de données.
 */
async function initBackupCron() {
  try {
    const { dbBackupFrequency } = await systemSettingsService.getSettings();
    const expression = CRON_EXPRESSIONS[dbBackupFrequency] || CRON_EXPRESSIONS.daily;

    // Si la fréquence n'a pas changé, ne rien faire
    if (currentFrequency === dbBackupFrequency && currentTask) {
      return;
    }

    // Arrêter la tâche précédente si elle existe
    if (currentTask) {
      currentTask.stop();
      currentTask = null;
    }

    currentTask = cron.schedule(expression, runBackupJob, { scheduled: true });
    currentFrequency = dbBackupFrequency;

    console.log(`[BackupCron] Sauvegarde automatique planifiée : fréquence "${dbBackupFrequency}" (${expression})`);
  } catch (err) {
    console.error('[BackupCron] Impossible d\'initialiser le cron de sauvegarde :', err.message);
  }
}

module.exports = { initBackupCron, runBackupJob };
