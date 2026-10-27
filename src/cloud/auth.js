import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET, SUPPORT_EMAIL } from './constants.js';

const isWin = process.platform === 'win32';
const configDir = isWin
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'memoir')
  : path.join(os.homedir(), '.config', 'memoir');
const AUTH_FILE = path.join(configDir, 'auth.json');

async function supaFetch(endpoint, options = {}) {
  const url = `${SUPABASE_URL}${endpoint}`;
  return fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

// GoTrue's REST API takes the post-email landing URL as a `redirect_to`
// QUERY PARAM. `options.emailRedirectTo` / `options.redirectTo` in the JSON
// body is supabase-js's client shape — sent raw it is silently ignored and
// the email links fall back to the project's Site URL. Both URLs below must
// also be on the Auth → URL Configuration → Redirect URLs allow-list.
const CONFIRMED_URL = 'https://memoir.sh/confirmed';
const RESET_URL = 'https://memoir.sh/reset-password';

export async function signUp(email, password) {
  const res = await supaFetch(`/auth/v1/signup?redirect_to=${encodeURIComponent(CONFIRMED_URL)}`, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign up failed');
  return data;
}

export async function signIn(email, password) {
  const res = await supaFetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign in failed');
  return data;
}

export async function refreshSession(refreshToken) {
  const res = await supaFetch('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Token refresh failed');
  return data;
}

export async function saveSession(session) {
  await fs.ensureDir(configDir);
  const payload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: Date.now() + (session.expires_in * 1000),
    user: {
      id: session.user.id,
      email: session.user.email,
    },
  };
  await fs.writeFile(AUTH_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return payload;
}

export async function getSession() {
  if (!await fs.pathExists(AUTH_FILE)) return null;

  const stored = await fs.readJson(AUTH_FILE);

  // If token expires within 60 seconds, refresh
  if (stored.expires_at < Date.now() + 60000) {
    try {
      const refreshed = await refreshSession(stored.refresh_token);
      return await saveSession(refreshed);
    } catch {
      // Refresh failed — session is dead
      await fs.remove(AUTH_FILE);
      return null;
    }
  }

  return stored;
}

export async function logout() {
  if (await fs.pathExists(AUTH_FILE)) {
    await fs.remove(AUTH_FILE);
  }
}

export async function isLoggedIn() {
  const session = await getSession();
  return !!session;
}

// A failed plan lookup is not evidence that a user is on Free. Callers use
// this value to choose destructive retention limits, so fail closed instead of
// silently downgrading a Pro account and pruning its history.
export async function getSubscription(session) {
  const res = await supaFetch('/rest/v1/subscriptions?select=*&user_id=eq.' + encodeURIComponent(session.user.id), {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
  });
  if (!res.ok) throw new Error(`Could not verify subscription (${res.status}). Existing backups were not pruned.`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Could not verify subscription. Existing backups were not pruned.');
  if (!data.length) return { status: 'free' };
  return data[0];
}

export async function resetPassword(email) {
  const res = await supaFetch(`/auth/v1/recover?redirect_to=${encodeURIComponent(RESET_URL)}`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error_description || data.msg || 'Password reset failed');
  }
}

async function requireDelete(res, label) {
  if (res.ok || res.status === 404) return;
  let detail = '';
  try { detail = (await res.text()).trim(); } catch {}
  throw new Error(`${label} failed (${res.status})${detail ? ': ' + detail : ''}. Nothing else was reported as deleted; retry account deletion.`);
}

async function requireRowDelete(res, label, { expectedMinRows = 0 } = {}) {
  await requireDelete(res, label);
  if (res.status === 204) {
    throw new Error(`${label} failed: server returned 204 without representation (check RLS DELETE policy). Nothing else was reported as deleted; retry account deletion.`);
  }
  let rows = [];
  try {
    rows = await res.json();
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows)) {
    throw new Error(`${label} failed: unexpected response shape. Nothing else was reported as deleted; retry account deletion.`);
  }
  if (expectedMinRows > 0 && rows.length < expectedMinRows) {
    throw new Error(`${label} failed: 0 rows removed (check RLS DELETE policy). Nothing else was reported as deleted; retry account deletion.`);
  }
  return rows;
}

async function verifyNoneRemaining(endpoint, headers, label) {
  const checkRes = await fetch(`${SUPABASE_URL}${endpoint}`, { headers });
  if (!checkRes.ok) {
    throw new Error(`${label} verification failed (${checkRes.status}). Nothing else was reported as deleted; retry account deletion.`);
  }
  const remaining = await checkRes.json();
  if (!Array.isArray(remaining) || remaining.length > 0) {
    throw new Error(`${label} failed: 0 rows removed while account rows still exist (check RLS DELETE policy). Nothing else was reported as deleted; retry account deletion.`);
  }
}

// Deletes the data the current user is authorized to delete, then asks the
// hosted `account-delete` function to remove the Auth login. That function
// uses the service role on the server to delete only the JWT subject. This
// CLI never sends a service-role key or a caller-chosen user id.
export async function deleteAccount(session) {
  const headers = {
    'Authorization': `Bearer ${session.access_token}`,
    'apikey': SUPABASE_ANON_KEY,
  };
  const deleteHeaders = {
    ...headers,
    'Prefer': 'return=representation',
  };

  // Deleting data does not cancel a Stripe subscription, and the billing
  // webhook re-creates the subscription row on the next renewal. Stop before
  // deleting anything while the account is paying, or while the plan can't be read.
  let sub;
  try {
    sub = await getSubscription(session);
  } catch (error) {
    throw new Error(`Could not check your plan (${error.message.replace(/ Existing backups were not pruned\.$/, '')}). Nothing was deleted; retry account deletion.`);
  }
  if (sub.status === 'pro') {
    throw new Error(`Your Pro subscription is still active, and deleting your data would not stop billing. Email ${SUPPORT_EMAIL} to cancel it, then run this again. Nothing was deleted.`);
  }

  const backupsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/backups?select=*&user_id=eq.${encodeURIComponent(session.user.id)}`,
    { headers }
  );
  if (!backupsRes.ok) {
    throw new Error(`Could not enumerate backups (${backupsRes.status}); account deletion stopped safely.`);
  }
  const backups = await backupsRes.json();

  for (const backup of backups) {
    if (typeof backup.storage_path !== 'string' || !backup.storage_path.startsWith(session.user.id + '/')) {
      throw new Error('Unsafe backup path; account deletion stopped.');
    }
    const objectRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`, {
      method: 'DELETE',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: [backup.storage_path] }),
    });
    await requireDelete(objectRes, 'Backup object deletion');

    const rowRes = await fetch(
      `${SUPABASE_URL}/rest/v1/backups?id=eq.${encodeURIComponent(backup.id)}`,
      { method: 'DELETE', headers: deleteHeaders }
    );
    await requireRowDelete(rowRes, 'Backup metadata deletion', { expectedMinRows: 1 });
  }

  // Share bundles go before their rows, like backups above: if a bundle
  // delete fails, the row is still there for the retry to find.
  const linksRes = await fetch(
    `${SUPABASE_URL}/rest/v1/shared_links?select=id,backup_id&created_by=eq.${encodeURIComponent(session.user.id)}`,
    { headers }
  );
  if (!linksRes.ok) {
    throw new Error(`Could not enumerate shared links (${linksRes.status}). Nothing else was reported as deleted; retry account deletion.`);
  }
  const links = await linksRes.json();
  if (!Array.isArray(links)) {
    throw new Error('Could not enumerate shared links. Nothing else was reported as deleted; retry account deletion.');
  }
  for (const link of links) {
    if (typeof link?.backup_id === 'string' && link.backup_id.startsWith(session.user.id + '/')) {
      const shareObjRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`, {
        method: 'DELETE',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prefixes: [link.backup_id] }),
      });
      await requireDelete(shareObjRes, 'Shared bundle object deletion');
    }
  }

  const sharedRes = await fetch(
    `${SUPABASE_URL}/rest/v1/shared_links?created_by=eq.${encodeURIComponent(session.user.id)}`,
    { method: 'DELETE', headers: deleteHeaders }
  );
  const deletedLinks = await requireRowDelete(sharedRes, 'Shared-link deletion');
  if (deletedLinks.length < links.length) {
    await verifyNoneRemaining(
      `/rest/v1/shared_links?select=id&created_by=eq.${encodeURIComponent(session.user.id)}&limit=1`,
      headers,
      'Shared-link deletion'
    );
  }

  const subRes = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(session.user.id)}`,
    { method: 'DELETE', headers: deleteHeaders }
  );
  const deletedSubs = await requireRowDelete(subRes, 'Subscription deletion');
  if (deletedSubs.length === 0) {
    await verifyNoneRemaining(
      `/rest/v1/subscriptions?select=user_id&user_id=eq.${encodeURIComponent(session.user.id)}&limit=1`,
      headers,
      'Subscription deletion'
    );
  }

  const identityRes = await fetch(`${SUPABASE_URL}/functions/v1/account-delete`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const identityText = await identityRes.text().catch(() => '');
  let identityBody = {};
  try { identityBody = identityText ? JSON.parse(identityText) : {}; } catch { identityBody = {}; }
  if (!identityRes.ok) {
    if (identityRes.status === 409 && identityBody.error === 'subscription_active') {
      throw new Error(identityBody.message || `Your Pro subscription is still active. Email ${SUPPORT_EMAIL} to cancel it, then run this again. Nothing else was reported as deleted; retry account deletion.`);
    }
    const detail = identityBody.message || identityText.trim();
    throw new Error(
      `Auth identity deletion failed (${identityRes.status})${detail ? ': ' + detail : ''}. ` +
      'Cloud data for this account was already removed; retry account deletion to finish removing the login.'
    );
  }
  if (identityBody?.deleted !== true) {
    throw new Error(
      'Auth identity deletion failed: unexpected response. ' +
      'Cloud data for this account was already removed; retry account deletion to finish removing the login.'
    );
  }

  await logout();
  return { localDataDeleted: true, authUserDeleted: true };
}

export { AUTH_FILE, supaFetch };
