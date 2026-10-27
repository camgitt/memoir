// Selection and removal policy for expired/exhausted share bundles.
// Used by the Deno edge function and by Node tests. Does not talk to SQL
// storage.objects — callers must remove files through the Storage API, then
// delete rows only for paths the API confirmed.
export const SHARE_BUCKET = 'memoir-backups';
export const DEFAULT_MAX_USES = 5;
export const PURGE_PAGE_SIZE = 1000;
export const REMOVE_BATCH_SIZE = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonicalSharePath(createdBy, token) {
  if (!UUID_RE.test(String(createdBy || '')) || !UUID_RE.test(String(token || ''))) return null;
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

// PostgREST `.or(...)` filter: expired rows, or rows that have been used at
// least once (exhaustion vs max_uses is applied in isDueForPurge).
export function dueShareOrFilter(now = new Date()) {
  const iso = new Date(now).toISOString();
  return `expires_at.lt."${iso}",use_count.gte.1`;
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

function errText(error) {
  return String(error?.message || error);
}

// listSharePage({ afterId, limit, now }) -> { rows, error? }
//   Keyset pages of candidate rows (already filtered in SQL when possible).
// listShares() -> rows  (optional one-shot helper for tests)
// removeObjects(paths) -> { removed: string[], error? }
// deleteShareRows(ids) -> { error? }
export async function purgeExpiredShares({
  listSharePage,
  listShares,
  removeObjects,
  deleteShareRows,
  now = new Date(),
  pageSize = PURGE_PAGE_SIZE,
  removeBatchSize = REMOVE_BATCH_SIZE,
} = {}) {
  const pageFn = listSharePage || (async ({ afterId }) => {
    if (afterId) return { rows: [] };
    try {
      return { rows: (await listShares()) || [] };
    } catch (error) {
      return { rows: [], error };
    }
  });

  let afterId = null;
  let considered = 0;
  const due = [];
  const skippedUntrusted = [];
  for (;;) {
    const { rows, error } = await pageFn({ afterId, limit: pageSize, now });
    if (error) {
      return {
        considered,
        due: due.length,
        skipped_untrusted: skippedUntrusted.length,
        deleted_objects: 0,
        deleted_links: 0,
        error: errText(error),
      };
    }
    const page = rows || [];
    if (!page.length) break;
    considered += page.length;
    const sel = selectPurgeableShares(page, now);
    due.push(...sel.due);
    skippedUntrusted.push(...sel.skippedUntrusted);
    afterId = page[page.length - 1].id;
    if (page.length < pageSize) break;
  }

  let deletedObjects = 0;
  let deletedLinks = 0;
  for (let i = 0; i < due.length; i += removeBatchSize) {
    const batch = due.slice(i, i + removeBatchSize);
    const paths = batch.map((link) => link.backup_id);
    const result = await removeObjects(paths);
    if (result?.error) {
      return {
        considered,
        due: due.length,
        skipped_untrusted: skippedUntrusted.length,
        deleted_objects: deletedObjects,
        deleted_links: deletedLinks,
        error: errText(result.error),
      };
    }
    const removed = Array.isArray(result?.removed) ? result.removed : [];
    deletedObjects += removed.length;
    const removedSet = new Set(removed);
    const ids = batch.filter((link) => removedSet.has(link.backup_id)).map((link) => link.id);
    if (ids.length) {
      const del = await deleteShareRows(ids);
      if (del?.error) throw del.error;
      deletedLinks += ids.length;
    }
  }

  return {
    considered,
    due: due.length,
    skipped_untrusted: skippedUntrusted.length,
    deleted_objects: deletedObjects,
    deleted_links: deletedLinks,
  };
}
