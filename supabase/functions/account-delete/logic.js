export const STORAGE_BUCKET = 'memoir-backups';
export const SUPPORT_EMAIL = 'hello@memoir.sh';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProSubscription(rows) {
  return (rows || []).some((row) => row && row.status === 'pro');
}

export function userStoragePrefix(userId) {
  if (!UUID_RE.test(String(userId || ''))) return null;
  return `${userId}/`;
}
