// Sales Copilot Extension — constants, enums, and their derived types.
//
// Each enum is a frozen `as const` object so the runtime values/wire format are
// unchanged, while a same-named exported type gives a literal union for TS
// consumers (e.g. `CopilotState.IDLE` is the value, `CopilotState` is the type).

export const CopilotState = Object.freeze({
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  ACTIVE: 'ACTIVE',
  RECONNECTING: 'RECONNECTING',
  STOPPING: 'STOPPING',
  ERROR: 'ERROR',
} as const);
export type CopilotState = (typeof CopilotState)[keyof typeof CopilotState];

export const NudgeType = Object.freeze({
  DISCOVERY_QUESTION: 'discovery_question',
  OBJECTION_HANDLING: 'objection_handling',
  PAIN_POINT: 'pain_point',
  PRICING_CONCERN: 'pricing_concern',
  COMPETITOR_MENTION: 'competitor_mention',
  NEXT_BEST_QUESTION: 'next_best_question',
  PERSONALIZED_PITCH: 'personalized_pitch',
  FOLLOW_UP_REMINDER: 'follow_up_reminder',
  TALK_RATIO_WARNING: 'talk_ratio_warning',
  MEETING_STAGE_UPDATE: 'meeting_stage_update',
} as const);
export type NudgeType = (typeof NudgeType)[keyof typeof NudgeType];

export const NudgePriority = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const);
export type NudgePriority = (typeof NudgePriority)[keyof typeof NudgePriority];

export const MeetingStage = Object.freeze({
  OPENING: 'opening',
  DISCOVERY: 'discovery',
  PRESENTING: 'presenting',
  OBJECTION_HANDLING: 'objection_handling',
  NEGOTIATION: 'negotiation',
  CLOSING: 'closing',
} as const);
export type MeetingStage = (typeof MeetingStage)[keyof typeof MeetingStage];

// Internal message types between SW ↔ popup ↔ content ↔ offscreen
export const MessageType = Object.freeze({
  // Popup → SW
  START_COPILOT: 'START_COPILOT',
  STOP_COPILOT: 'STOP_COPILOT',
  GET_STATE: 'GET_STATE',
  LOGIN: 'LOGIN',
  REGISTER: 'REGISTER',
  LOGOUT: 'LOGOUT',
  GET_PREFERENCES: 'GET_PREFERENCES',
  UPDATE_PREFERENCES: 'UPDATE_PREFERENCES',
  AUDIO_CONSENT_GRANTED: 'AUDIO_CONSENT_GRANTED',
  // SW → popup / content
  STATE_UPDATE: 'STATE_UPDATE',
  // SW → content
  COPILOT_LIFECYCLE: 'COPILOT_LIFECYCLE',
  COPILOT_NOTICE: 'COPILOT_NOTICE', // SW → content/popup: non-fatal user-facing notice
  // Content → SW
  MEETING_DETECTED: 'MEETING_DETECTED',
  MEETING_ENDED: 'MEETING_ENDED',
  SPEAKER_CHANGE: 'SPEAKER_CHANGE',
  NUDGE_DISMISS: 'NUDGE_DISMISS',
  NUDGE_ACTED: 'NUDGE_ACTED',
  // Offscreen ↔ SW
  OFFSCREEN_READY: 'OFFSCREEN_READY',
  OFFSCREEN_START_CAPTURE: 'OFFSCREEN_START_CAPTURE',
  OFFSCREEN_STOP_CAPTURE: 'OFFSCREEN_STOP_CAPTURE',
  OFFSCREEN_AUDIO_LEVEL: 'OFFSCREEN_AUDIO_LEVEL',
  OFFSCREEN_CAPTURE_FAILED: 'OFFSCREEN_CAPTURE_FAILED',
  MONITOR_BLOCKED: 'MONITOR_BLOCKED',
  MIC_MUTE_STATE: 'MIC_MUTE_STATE',
} as const);
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// WebSocket message types (extension ↔ backend)
export const WSMessageType = Object.freeze({
  // Upstream
  AUDIO_META: 'audio_meta',
  SPEAKER_CHANGE: 'speaker_change',
  MIC_MUTE: 'mic_mute',
  SESSION_START: 'session_start',
  SESSION_STOP: 'session_stop',
  NUDGE_DISMISS: 'nudge_dismiss',
  NUDGE_ACTED: 'nudge_acted',
  PING: 'ping',
  // Downstream
  TRANSCRIPT: 'transcript',
  NUDGE: 'nudge',
  STAGE_UPDATE: 'stage_update',
  TALK_RATIO: 'talk_ratio',
  QUALIFICATION_UPDATE: 'qualification_update',
  PROSPECT_CONTEXT: 'prospect_context',
  MEETING_SUMMARY: 'meeting_summary',
  ERROR: 'error',
  PONG: 'pong',
  SESSION_READY: 'session_ready',
} as const);
export type WSMessageType = (typeof WSMessageType)[keyof typeof WSMessageType];

// WebSocket reconnect
export const WS_RECONNECT_BACKOFFS_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];
export const WS_MAX_RECONNECT_ATTEMPTS = 5;
export const WS_PING_INTERVAL_MS = 25_000;
export const WS_PONG_TIMEOUT_MS = 10_000;

// Storage keys
export const StorageKey = Object.freeze({
  AUTH_TOKEN: 'sc_auth_token',
  USER_EMAIL: 'sc_user_email',
  USER_NAME: 'sc_user_name',
  API_BASE_URL: 'sc_api_base',
  COPILOT_STATE: 'sc_copilot_state',
  SESSION_ID: 'sc_session_id',
  PROSPECT_EMAIL: 'sc_prospect_email',
  AUDIO_CONSENT: 'sc_audio_consent',
  PENDING_START: 'sc_pending_start',
} as const);
export type StorageKey = (typeof StorageKey)[keyof typeof StorageKey];

// Default API base
export const API_BASE_URL = 'https://test-api.meetminutes.in';
