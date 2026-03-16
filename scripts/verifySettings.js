require('dotenv').config();

const jwt = require('jsonwebtoken');
const { sequelize, Utilisateur, SystemSetting, AuditLog } = require('../src/models');

const baseUrl = process.env.SETTINGS_VERIFY_BASE_URL || 'http://localhost:5500/api';

async function apiRequest(token, method, endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    json,
    text,
  };
}

async function main() {
  await sequelize.authenticate();

  const superAdmin = await Utilisateur.findOne({ where: { role: 'super_admin' } });
  if (!superAdmin) {
    throw new Error('Aucun utilisateur super_admin trouve pour les tests Parametres.');
  }

  const token = jwt.sign(
    {
      id: superAdmin.id,
      role: superAdmin.role,
      entreprise_id: superAdmin.entreprise_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  const checks = [];

  const before = await apiRequest(token, 'GET', '/settings');
  checks.push({ check: 'GET /settings', ok: before.status === 200, status: before.status });
  if (!before.json) {
    throw new Error('GET /settings ne retourne pas un JSON valide.');
  }

  const original = {
    appName: before.json.appName,
    maxFileSize: before.json.maxFileSize,
    maintenanceMode: before.json.maintenanceMode,
  };

  const maintenanceMessage = 'Maintenance planifiee pour verification TeamOff.';

  const updateGeneral = await apiRequest(token, 'PUT', '/settings/sections/general', {
    appName: `${original.appName || 'TeamOff'} QA`,
    maintenanceMessage,
    maxFileSize: 12,
  });
  checks.push({
    check: 'PUT /settings/sections/general',
    ok: updateGeneral.status === 200,
    status: updateGeneral.status,
  });

  const maintenanceOn = await apiRequest(token, 'POST', '/settings/actions/maintenance', {
    enabled: true,
    maintenanceMessage,
  });
  checks.push({
    check: 'POST /settings/actions/maintenance (on)',
    ok: maintenanceOn.status === 200,
    status: maintenanceOn.status,
  });

  const systemInfo = await apiRequest(token, 'GET', '/settings/system-info');
  checks.push({
    check: 'GET /settings/system-info',
    ok: systemInfo.status === 200,
    status: systemInfo.status,
    maintenanceMode: systemInfo.json?.maintenanceMode,
  });

  const history = await apiRequest(token, 'GET', '/settings/history?limit=15');
  checks.push({
    check: 'GET /settings/history',
    ok: history.status === 200 && Array.isArray(history.json?.logs),
    status: history.status,
    count: history.json?.logs?.length || 0,
  });

  const historyCsv = await fetch(`${baseUrl}/settings/history/csv`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  checks.push({
    check: 'GET /settings/history/csv',
    ok: historyCsv.status === 200 && (historyCsv.headers.get('content-type') || '').includes('text/csv'),
    status: historyCsv.status,
    contentType: historyCsv.headers.get('content-type') || null,
  });

  const backup = await apiRequest(token, 'POST', '/settings/actions/backup');
  checks.push({
    check: 'POST /settings/actions/backup',
    ok: backup.status === 200 && Boolean(backup.json?.backup?.filename),
    status: backup.status,
    filename: backup.json?.backup?.filename || null,
  });

  if (backup.json?.backup?.filename) {
    const download = await fetch(`${baseUrl}/settings/backups/${backup.json.backup.filename}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    checks.push({
      check: 'GET /settings/backups/:filename',
      ok: download.status === 200,
      status: download.status,
      contentType: download.headers.get('content-type') || null,
    });
  }

  const maintenanceOff = await apiRequest(token, 'POST', '/settings/actions/maintenance', {
    enabled: false,
  });
  checks.push({
    check: 'POST /settings/actions/maintenance (off)',
    ok: maintenanceOff.status === 200,
    status: maintenanceOff.status,
  });

  const restore = await apiRequest(token, 'PUT', '/settings/sections/general', {
    appName: original.appName,
    maxFileSize: original.maxFileSize,
    maintenanceMessage,
    maintenanceMode: original.maintenanceMode,
  });
  checks.push({
    check: 'Restore valeurs initiales section general',
    ok: restore.status === 200,
    status: restore.status,
  });

  const row = await SystemSetting.findOne({ where: { key: 'global' } });
  checks.push({
    check: 'DB system_settings key=global',
    ok: Boolean(row),
    hasMaintenanceMessage: typeof row?.data?.maintenanceMessage === 'string',
    maintenanceModeType: typeof row?.data?.maintenanceMode,
  });

  const settingsAudits = await AuditLog.count({ where: { entity: 'system_settings' } });
  checks.push({
    check: 'DB audit_logs entity=system_settings',
    ok: settingsAudits > 0,
    count: settingsAudits,
  });

  const failed = checks.filter((item) => item.ok === false);
  const report = {
    baseUrl,
    allOk: failed.length === 0,
    failedCount: failed.length,
    checks,
  };

  console.log(JSON.stringify(report, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('VERIFY_SETTINGS_ERROR', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
