export const STORAGE_BUCKET = 'memoir-backups';
export const SUPPORT_EMAIL = 'hello@memoir.sh';
export const STORAGE_LIST_LIMIT = 1000;
export const STORAGE_REMOVE_LIMIT = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProSubscription(rows) {
  return (rows || []).some((row) => row && row.status === 'pro');
}

export function userStoragePrefix(userId) {
  if (!UUID_RE.test(String(userId || ''))) return null;
  return `${userId}/`;
}

export function alreadyGone(error) {
  if (!error) return false;
  if (error.status === 404) return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('not found') || msg.includes('user not found');
}

function isFolderEntry(entry) {
  return entry && entry.id == null;
}

function childPath(folder, name) {
  return folder ? `${folder}/${name}` : name;
}

// Recursively list object paths under `root` (no trailing slash). Folders are
// entries with id === null. Pages at STORAGE_LIST_LIMIT.
export async function listAllObjectPaths({ listFolder, root }) {
  const paths = [];
  async function walk(folder) {
    let offset = 0;
    for (;;) {
      const result = await listFolder(folder, { limit: STORAGE_LIST_LIMIT, offset });
      if (result?.error) return { error: result.error, paths };
      const entries = Array.isArray(result?.data) ? result.data : [];
      for (const entry of entries) {
        const name = typeof entry?.name === 'string' ? entry.name : '';
        if (!name || name === '.' || name === '..') continue;
        if (name.includes('/') || name.includes('\\')) continue;
        const child = childPath(folder, name);
        if (isFolderEntry(entry)) {
          const nested = await walk(child);
          if (nested.error) return nested;
        } else {
          paths.push(child);
        }
      }
      if (entries.length < STORAGE_LIST_LIMIT) break;
      offset += STORAGE_LIST_LIMIT;
    }
    return { paths };
  }
  return walk(root);
}

// List every object under prefix, remove in batches of 1000, 502-equivalent
// (ok:false) if list/remove errors, a batch removes fewer than requested, or
// a re-list still finds objects.
export async function wipeUserStorage({ listFolder, removeObjects, prefix }) {
  const root = String(prefix || '').replace(/\/+$/, '');
  if (!root) return { ok: false, error: 'bad_prefix', stage: 'prefix' };

  const first = await listAllObjectPaths({ listFolder, root });
  if (first.error) return { ok: false, error: first.error, stage: 'list' };
  const paths = first.paths || [];

  let deleted = 0;
  for (let i = 0; i < paths.length; i += STORAGE_REMOVE_LIMIT) {
    const batch = paths.slice(i, i + STORAGE_REMOVE_LIMIT);
    const result = await removeObjects(batch);
    if (result?.error) {
      return { ok: false, error: result.error, stage: 'remove', deleted };
    }
    const n = Array.isArray(result?.removed) ? result.removed.length : 0;
    if (n < batch.length) {
      return {
        ok: false,
        error: 'partial_remove',
        stage: 'remove',
        requested: batch.length,
        removed: n,
        deleted,
      };
    }
    deleted += n;
  }

  const again = await listAllObjectPaths({ listFolder, root });
  if (again.error) return { ok: false, error: again.error, stage: 'relist' };
  if ((again.paths || []).length > 0) {
    return { ok: false, error: 'prefix_not_empty', stage: 'relist', remaining: again.paths.length };
  }
  return { ok: true, deleted };
}

export async function deleteCallerAccount({
  userId,
  subscriptions,
  subscriptionError,
  listFolder,
  removeObjects,
  deleteUser,
}) {
  const prefix = userStoragePrefix(userId);
  if (!prefix) return { status: 400, body: { error: 'bad_user' } };
  if (subscriptionError) return { status: 502, body: { error: 'plan_lookup_failed' } };
  if (isProSubscription(subscriptions)) {
    return {
      status: 409,
      body: {
        error: 'subscription_active',
        message: `Cancel your Pro subscription before deleting your account. Email ${SUPPORT_EMAIL}.`,
      },
    };
  }
  const wipe = await wipeUserStorage({ listFolder, removeObjects, prefix });
  if (!wipe.ok) {
    return { status: 502, body: { error: 'storage_wipe_failed', stage: wipe.stage } };
  }
  let delErr = null;
  try {
    const res = await deleteUser(userId);
    delErr = res?.error || null;
  } catch (err) {
    delErr = err;
  }
  if (delErr && !alreadyGone(delErr)) {
    return { status: 502, body: { error: 'delete_failed' } };
  }
  return {
    status: 200,
    body: { deleted: true, id: userId, already_gone: alreadyGone(delErr) },
  };
}
