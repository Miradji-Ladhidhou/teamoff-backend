const DEFAULT_TIMEZONE = process.env.DEFAULT_APP_TIMEZONE || 'Europe/Paris';

function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: timezone.trim() });
    return true;
  } catch {
    return false;
  }
}

function normalizeTimezone(timezone) {
  return isValidTimezone(timezone) ? timezone.trim() : null;
}

function resolveTimezone(parametres, preferredTimezone) {
  return normalizeTimezone(preferredTimezone)
    || normalizeTimezone(parametres?.timezone)
    || normalizeTimezone(DEFAULT_TIMEZONE)
    || 'UTC';
}

function formatDateInTimezone(dateValue, timezone) {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(date);
}

function toIsoString(dateValue) {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

module.exports = { isValidTimezone, normalizeTimezone, resolveTimezone, formatDateInTimezone, toIsoString };
