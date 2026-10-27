// Selection and removal policy for expired/exhausted share bundles.
// Used by the Deno edge function and by Node tests. Does not talk to SQL
// storage.objects — callers must remove files through the Storage API, then
// delete rows only for paths the API confirmed.
export const SHARE_BUCKET = 'memoir-backups';
export const DEFAULT_MAX_USES = 5;

export function canonicalSharePath(createdBy, token) {
  if (typeof createdBy !== 'string' || typeof token !== 'string') return null;
  if (!createdBy || !token) return null;
  return `${createdBy}/shares/${token}.gz`;
}

export function isTrustedSharePath(link) {
  const expected = canonicalSharePath(link?.created_by, link?.token);
  return typeof link?.backup_id === 'string' && expected !== null && link.backup_id === expected;
}

export function isDueForPurge(link, now = new Date()) {
  if (!link) return false;
  const expired = !!link.expires_at && new Date(link.expires_at).getTime() < now.getTime();
  const uses = Number(link.use_count);
  const max = link.max_uses == null || link.max_uses === '' ? DEFAULT_MAX_USES : Number(link.max_uses);
  const exhausted = Number.isFinite(uses) && Number.isFinite(max) && uses >= max;
  return expired || exhausted;
}

export function selectPurgeableShares(rows, now = new Date()) {
  const due = [];
  const skippedUntrusted = [];
  for (const link of rows || []) {
    if (!isDueForPurge(link, now)) continue;
    if (!isTrustedSharePath(link)) {
      skippedUntrusted.push(link);
      continue;
    }
    due.push(link);
  }
  return { due, skippedUntrusted };
}

// Constant-time-ish compare that does not early-return on length.
export function secretsEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  const max = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let i = 0; i < max; i++) {
    mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

// listShares() -> rows
// removeObjects(paths) -> { removed: string[], error? }
//   `removed` is the subset confirmed gone (including already-absent objects).
//   On API failure, return { error, removed: [] } so no rows are deleted.
// deleteShareRows(ids) -> { error? }
export async function purgeExpiredShares({ listShares, removeObjects, deleteShareRows, now = new Date() }) {
  const rows = await listShares();
  const { due, skippedUntrusted } = selectPurgeableShares(rows, now);
  const paths = due.map((link) => link.backup_id);
  let removed = [];
  if (paths.length) {
    const result = await removeObjects(paths);
    if (result?.error) {
      return {
        considered: (rows || []).length,
        due: due.length,
        skipped_untrusted: skippedUntrusted.length,
        deleted_objects: 0,
        deleted_links: 0,
        error: String(result.error.message || result.error),
      };
    }
    removed = Array.isArray(result?.removed) ? result.removed : [];
  }
  const removedSet = new Set(removed);
  const idsToDelete = due.filter((link) => removedSet.has(link.backup_id)).map((link) => link.id);
  if (idsToDelete.length) {
    const del = await deleteShareRows(idsToDelete);
    if (del?.error) throw del.error;
  }
  return {
    considered: (rows || []).length,
    due: due.length,
    skipped_untrusted: skippedUntrusted.length,
    deleted_objects: removed.length,
    deleted_links: idsToDelete.length,
  };
}
