// REST API contract between the extension and the backend.
// Mirrors app/auth/router.py, app/sessions, and app/preferences.py.

import type { NudgeType } from '../constants.js';

export interface AuthUser {
  id?: string;
  email: string;
  name: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  name: string;
  password: string;
}

export interface CreateSessionResponse {
  session_id: string;
  /** May be empty; the client builds its own WS URL when so. */
  ws_url: string;
}

/** Per-nudge-type on/off toggles, keyed by the nudge type wire value. */
export type NudgePreferences = Partial<Record<NudgeType, boolean>>;

export interface Preferences {
  nudge_preferences: NudgePreferences;
  store_transcripts: boolean;
  store_nudges: boolean;
  retention_days: number;
}
