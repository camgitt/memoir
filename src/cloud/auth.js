import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './constants.js';

const isWin = process.platform === 'win32';
const configDir = isWin
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'memoir')
  : path.join(os.homedir(), '.config', 'memoir');
const AUTH_FILE = path.join(configDir, 'auth.json');

async function supaFetch(endpoint, options = {}) {
  const url = `${SUPABASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  return res;
}

export async function signUp(email, password) {
  const res = await supaFetch('/auth/v1/signup', {
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

export async function getSubscription(session) {
  const res = await supaFetch('/rest/v1/subscriptions?select=*&user_id=eq.' + session.user.id, {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
  });
  const data = await res.json();
  if (!res.ok || !data.length) return { status: 'free' };
  return data[0];
}

export { AUTH_FILE, supaFetch };
