// API client — REST endpoints for auth and copilot session management.

import { StorageKey, API_BASE_URL } from '../constants.js';
import type {
  AuthResponse,
  CreateSessionResponse,
  Preferences,
} from '../types/api.js';
import type { ProspectProfile } from '../types/ws.js';

/** RequestInit constrained to a plain-object header map (what this client uses). */
type ReqInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

async function getBaseUrl(): Promise<string> {
  try {
    const got = await chrome.storage.local.get(StorageKey.API_BASE_URL);
    return got[StorageKey.API_BASE_URL] || API_BASE_URL;
  } catch {
    return API_BASE_URL;
  }
}

async function getToken(): Promise<string | null> {
  try {
    const got = await chrome.storage.local.get(StorageKey.AUTH_TOKEN);
    return got[StorageKey.AUTH_TOKEN] || null;
  } catch {
    return null;
  }
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(path: string, init: ReqInit = {}, _retried = false): Promise<Response> {
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
    // Attempt a single transparent refresh + retry before giving up, so an
    // expired-but-refreshable token doesn't surface as a hard failure.
    if (!_retried) {
      const newToken = await refreshToken();
      if (newToken) return request(path, init, true);
    }
    throw new AuthError();
  }
  return response;
}

async function requestWithTimeout(path: string, init: ReqInit = {}, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(path, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Raw fetch (no auth/refresh) with an abort timeout — for unauthenticated calls. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export class AuthError extends Error {
  constructor() {
    super('auth_expired');
    this.name = 'AuthError';
  }
}

// --- Auth ---

export async function login(email: string, password: string): Promise<AuthResponse> {
  const baseUrl = await getBaseUrl();
  const res = await fetchWithTimeout(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `login_failed_${res.status}`);
  }
  const data = (await res.json()) as AuthResponse;
  await chrome.storage.local.set({
    [StorageKey.AUTH_TOKEN]: data.token,
    [StorageKey.USER_EMAIL]: data.user.email,
    [StorageKey.USER_NAME]: data.user.name,
  });
  return data;
}

export async function register(email: string, name: string, password: string): Promise<AuthResponse> {
  const baseUrl = await getBaseUrl();
  const res = await fetchWithTimeout(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `register_failed_${res.status}`);
  }
  const data = (await res.json()) as AuthResponse;
  await chrome.storage.local.set({
    [StorageKey.AUTH_TOKEN]: data.token,
    [StorageKey.USER_EMAIL]: data.user.email,
    [StorageKey.USER_NAME]: data.user.name,
  });
  return data;
}

export async function logout(): Promise<void> {
  await chrome.storage.local.remove([StorageKey.AUTH_TOKEN, StorageKey.USER_EMAIL, StorageKey.USER_NAME]);
}

let _refreshInFlight: Promise<string | null> | null = null;

export async function refreshToken(): Promise<string | null> {
  // Single-flight: concurrent callers (REST 401 + WS auth error) share one
  // refresh so a later response can't clobber a newer token.
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    const baseUrl = await getBaseUrl();
    const token = await getToken();
    if (!token) return null;
    const res = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { token: string };
    await chrome.storage.local.set({ [StorageKey.AUTH_TOKEN]: data.token });
    return data.token;
  })().finally(() => {
    _refreshInFlight = null;
  });
  return _refreshInFlight;
}

export async function checkAudioConsent(): Promise<boolean> {
  // Timeout: this is awaited synchronously in the copilot-start flow, so a hung
  // backend would otherwise stall start with no feedback.
  const res = await requestWithTimeout('/api/v1/auth/consent', { method: 'GET' });
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  return data.has_consent === true;
}

export async function recordAudioConsent(): Promise<unknown> {
  const res = await requestWithTimeout('/api/v1/auth/consent', { method: 'POST' });
  if (!res.ok) throw new Error(`consent_failed_${res.status}`);
  return res.json().catch(() => ({ ok: true }));
}

// --- Copilot Sessions ---

export async function startCopilotSession(prospectEmail: string): Promise<CreateSessionResponse> {
  // Timeout so a hung backend doesn't leave the SW stuck in CONNECTING forever.
  const res = await requestWithTimeout('/api/v1/copilot/sessions', {
    method: 'POST',
    body: JSON.stringify({ prospect_email: prospectEmail, platform: 'google_meet' }),
  });
  if (!res.ok) throw new Error(`copilot_start_failed_${res.status}`);
  return (await res.json()) as CreateSessionResponse;
}

export async function stopCopilotSession(sessionId: string): Promise<{ ok: boolean }> {
  const res = await request(`/api/v1/copilot/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`copilot_stop_failed_${res.status}`);
  return { ok: true };
}

export async function enrichProspect(email: string): Promise<ProspectProfile> {
  const res = await request('/api/v1/prospects/enrich', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`enrich_failed_${res.status}`);
  return (await res.json()) as ProspectProfile;
}

export async function getPreferences(): Promise<Preferences> {
  const res = await request('/api/v1/preferences', { method: 'GET' });
  if (!res.ok) throw new Error(`preferences_failed_${res.status}`);
  return (await res.json()) as Preferences;
}

export async function updatePreferences(preferences: Preferences): Promise<Preferences> {
  const res = await request('/api/v1/preferences', {
    method: 'PUT',
    body: JSON.stringify(preferences),
  });
  if (!res.ok) throw new Error(`preferences_update_failed_${res.status}`);
  return (await res.json()) as Preferences;
}
