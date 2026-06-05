// API client — REST endpoints for auth and copilot session management.
// Pattern ported from chrome_extension/src/api/client.js

import { StorageKey, API_BASE_URL } from '../constants.js';

async function getBaseUrl() {
  try {
    const got = await chrome.storage.local.get(StorageKey.API_BASE_URL);
    return got[StorageKey.API_BASE_URL] || API_BASE_URL;
  } catch {
    return API_BASE_URL;
  }
}

async function getToken() {
  try {
    const got = await chrome.storage.local.get(StorageKey.AUTH_TOKEN);
    return got[StorageKey.AUTH_TOKEN] || null;
  } catch {
    return null;
  }
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(path, init = {}) {
  const baseUrl = await getBaseUrl();
  const token = await getToken();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(token),
      ...(init.headers || {}),
    },
  });
  if (response.status === 401) {
    throw new AuthError();
  }
  return response;
}

export class AuthError extends Error {
  constructor() { super('auth_expired'); this.name = 'AuthError'; }
}

// --- Auth ---

export async function login(email, password) {
  const baseUrl = await getBaseUrl();
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `login_failed_${res.status}`);
  }
  const data = await res.json();
  await chrome.storage.local.set({
    [StorageKey.AUTH_TOKEN]: data.token,
    [StorageKey.USER_EMAIL]: data.user.email,
    [StorageKey.USER_NAME]: data.user.name,
  });
  return data;
}

export async function register(email, name, password) {
  const baseUrl = await getBaseUrl();
  const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `register_failed_${res.status}`);
  }
  const data = await res.json();
  await chrome.storage.local.set({
    [StorageKey.AUTH_TOKEN]: data.token,
    [StorageKey.USER_EMAIL]: data.user.email,
    [StorageKey.USER_NAME]: data.user.name,
  });
  return data;
}

export async function logout() {
  await chrome.storage.local.remove([StorageKey.AUTH_TOKEN, StorageKey.USER_EMAIL, StorageKey.USER_NAME]);
}

export async function refreshToken() {
  const baseUrl = await getBaseUrl();
  const token = await getToken();
  if (!token) return null;
  const res = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  await chrome.storage.local.set({ [StorageKey.AUTH_TOKEN]: data.token });
  return data.token;
}

export async function checkAudioConsent() {
  const res = await request('/api/v1/auth/consent', { method: 'GET' });
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  return data.has_consent === true;
}

// --- Copilot Sessions ---

export async function startCopilotSession(prospectEmail) {
  const res = await request('/api/v1/copilot/sessions', {
    method: 'POST',
    body: JSON.stringify({ prospect_email: prospectEmail, platform: 'google_meet' }),
  });
  if (!res.ok) throw new Error(`copilot_start_failed_${res.status}`);
  return res.json(); // { session_id, ws_url }
}

export async function stopCopilotSession(sessionId) {
  const res = await request(`/api/v1/copilot/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`copilot_stop_failed_${res.status}`);
  return { ok: true };
}

export async function enrichProspect(email) {
  const res = await request('/api/v1/prospects/enrich', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`enrich_failed_${res.status}`);
  return res.json();
}

export async function getPreferences() {
  const res = await request('/api/v1/preferences', { method: 'GET' });
  if (!res.ok) throw new Error(`preferences_failed_${res.status}`);
  return res.json();
}

export async function updatePreferences(preferences) {
  const res = await request('/api/v1/preferences', {
    method: 'PUT',
    body: JSON.stringify(preferences),
  });
  if (!res.ok) throw new Error(`preferences_update_failed_${res.status}`);
  return res.json();
}
