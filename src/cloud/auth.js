import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET } from './constants.js';

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

const CONFIRMED_URL = 'https://memoir.sh/confirmed';
const RESET_URL = 'https://memoir.sh/reset-password';

export async function signUp(email, password) {
  const res = await supaFetch(`/auth/v1/signup?redirect_to=${encodeURIComponent(CONFIRMED_URL)}`, { method: 'POST', body: JSON.stringify({ email, password }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign up failed');
  return data;
}

export async function signIn(email, password) {
  const res = await supaFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign in failed');
  return data;
}

export async function refreshSession(refreshToken) {
  const res = await supaFetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Token refresh failed');
  return data;
}

export async function saveSession(session) {
  await fs.ensureDir(configDir);
  const payload = { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: Date.now() + (session.expires_in * 1000), user: { id: session.user.id, email: session.user.email } };
  await fs.writeFile(AUTH_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return payload;
}

export async function getSession() {
  if (!await fs.pathExists(AUTH_FILE)) return null;
  const stored = await fs.readJson(AUTH_FILE);
  if (stored.expires_at < Date.now() + 60000) {
    try { return await saveSession(await refreshSession(stored.refresh_token)); }
    catch { await fs.remove(AUTH_FILE); return null; }
  }
  return stored;
}

export async function logout() { if (await fs.pathExists(AUTH_FILE)) await fs.remove(AUTH_FILE); }
export async function isLoggedIn() { return !!(await getSession()); }

// A failed plan lookup is not evidence that a user is on Free. Callers use
// this value to choose destructive retention limits, so fail closed instead of
// silently downgrading a Pro account and pruning its history.
export async function getSubscription(session) {
  const res = await supaFetch('/rest/v1/subscriptions?select=*&user_id=eq.' + encodeURIComponent(session.user.id), {
    headers: { 'Authorization': `Bearer ${session.access_token}` },
  });
  if (!res.ok) throw new Error(`Could not verify subscription (${res.status}). Existing backups were not pruned.`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Could not verify subscription. Existing backups were not pruned.');
  if (!data.length) return { status: 'free' };
  return data[0];
}

export async function resetPassword(email) {
  const res = await supaFetch(`/auth/v1/recover?redirect_to=${encodeURIComponent(RESET_URL)}`, { method: 'POST', body: JSON.stringify({ email }) });
  if (!res.ok) { const data = await res.json(); throw new Error(data.error_description || data.msg || 'Password reset failed'); }
}

async function requireDelete(res, label) {
  if (res.ok || res.status === 404) return;
  let detail = '';
  try { detail = (await res.text()).trim(); } catch {}
  throw new Error(`${label} failed (${res.status})${detail ? ': ' + detail : ''}. Nothing else was reported as deleted; retry account deletion.`);
}

// Deletes the data the current user is authorized to delete. Auth-user removal
// itself requires a privileged server-side endpoint and must never be attempted
// with a service-role key from this CLI.
export async function deleteAccount(session) {
  const headers = { 'Authorization': `Bearer ${session.access_token}`, 'apikey': SUPABASE_ANON_KEY };
  const backupsRes = await fetch(`${SUPABASE_URL}/rest/v1/backups?select=*&user_id=eq.${encodeURIComponent(session.user.id)}`, { headers });
  if (!backupsRes.ok) throw new Error(`Could not enumerate backups (${backupsRes.status}); account deletion stopped safely.`);
  const backups = await backupsRes.json();

  for (const backup of backups) {
    if (typeof backup.storage_path !== 'string' || !backup.storage_path.startsWith(session.user.id + '/')) throw new Error('Unsafe backup path; account deletion stopped.');
    const object = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`, {
      method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [backup.storage_path] }),
    });
    await requireDelete(object, 'Backup object deletion');
    const row = await fetch(`${SUPABASE_URL}/rest/v1/backups?id=eq.${encodeURIComponent(backup.id)}`, { method: 'DELETE', headers });
    await requireDelete(row, 'Backup metadata deletion');
  }

  await requireDelete(await fetch(`${SUPABASE_URL}/rest/v1/shared_links?user_id=eq.${encodeURIComponent(session.user.id)}`, { method: 'DELETE', headers }), 'Shared-link deletion');
  await requireDelete(await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(session.user.id)}`, { method: 'DELETE', headers }), 'Subscription deletion');
  await logout();
  return { localDataDeleted: true, authUserDeleted: false };
}

export { AUTH_FILE, supaFetch };
