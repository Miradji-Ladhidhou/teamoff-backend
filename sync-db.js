'use strict';

console.error('[migration-safety] Synchronisation directe du schéma bloquée. Utilisez les migrations explicites autorisées.');
process.exitCode = 1;
