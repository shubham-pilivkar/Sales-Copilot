// Discriminated union of every internal runtime message passed between the
// popup, service worker, content script, and offscreen document.
//
// Each variant is keyed on `type`. The wire `type` strings match the values in
// `MessageType` (constants.ts); the SW→content "render" messages (NUDGE,
// TRANSCRIPT, …) are sent with raw string types and are typed here too so the
// full contract is covered.

import type { CopilotState, MeetingStage } from '../constants.js';
import type {
  Nudge,
  TranscriptSegment,
  TalkRatio,
  ProspectProfile,
  MeetingSummary,
} from './ws.js';
import type { Preferences } from './api.js';

/** Snapshot of copilot state broadcast by the service worker. */
export interface CopilotStateSnapshot {
  state: CopilotState;
  sessionId: string | null;
  prospectEmail: string;
  meetingTabId: number | null;
}

// --- Popup → SW (commands) ---
export type StartCopilotMsg = { type: 'START_COPILOT'; tabId: number; prospectEmail: string };
export type StopCopilotMsg = { type: 'STOP_COPILOT' };
export type GetStateMsg = { type: 'GET_STATE' };
export type LoginMsg = { type: 'LOGIN'; email: string; password: string };
export type RegisterMsg = { type: 'REGISTER'; email: string; name: string; password: string };
export type LogoutMsg = { type: 'LOGOUT' };
export type GetPreferencesMsg = { type: 'GET_PREFERENCES' };
export type UpdatePreferencesMsg = { type: 'UPDATE_PREFERENCES'; preferences: Preferences };
export type AudioConsentGrantedMsg = { type: 'AUDIO_CONSENT_GRANTED' };

// --- SW → popup / content ---
export type StateUpdateMsg = { type: 'STATE_UPDATE' } & CopilotStateSnapshot;

// --- SW → content (lifecycle + notices) ---
export type CopilotLifecycleMsg = {
  type: 'COPILOT_LIFECYCLE';
  phase: 'started' | 'stopped';
  sessionId?: string;
};
export type CopilotNoticeMsg = { type: 'COPILOT_NOTICE'; code: string; message: string };
export type ContentPingMsg = { type: 'CONTENT_PING' };

// --- SW → content (render messages; raw string types) ---
export type NudgeMsg = { type: 'NUDGE'; nudge: Nudge };
export type TranscriptMsg = { type: 'TRANSCRIPT' } & TranscriptSegment;
export type StageUpdateMsg = { type: 'STAGE_UPDATE'; stage: MeetingStage | string };
export type TalkRatioMsg = { type: 'TALK_RATIO' } & TalkRatio;
export type ProspectContextMsg = { type: 'PROSPECT_CONTEXT'; profile: ProspectProfile };
export type MeetingSummaryMsg = { type: 'MEETING_SUMMARY'; summary: MeetingSummary };
export type WsErrorMsg = { type: 'WS_ERROR'; code: string | number; message?: string };

// --- Content → SW (events) ---
export type MeetingDetectedMsg = { type: 'MEETING_DETECTED'; tabId: number | null };
export type MeetingEndedMsg = { type: 'MEETING_ENDED'; reason: string };
export type SpeakerChangeMsg = { type: 'SPEAKER_CHANGE'; speaker: string; wall_clock_ms: number };
export type NudgeDismissMsg = { type: 'NUDGE_DISMISS'; nudge_id: string; nudge_type: string };
export type NudgeActedMsg = { type: 'NUDGE_ACTED'; nudge_id: string; nudge_type: string };
export type MicMuteStateMsg = { type: 'MIC_MUTE_STATE'; muted: boolean };

// --- Offscreen ↔ SW ---
/** Snapshot of the offscreen audio graph health, piggybacked on heartbeats. */
export interface OffscreenAudioState {
  contextState: string;
  mic: boolean;
  tab: boolean;
}
export type OffscreenReadyMsg = { type: 'OFFSCREEN_READY'; audio?: OffscreenAudioState };
export type OffscreenStartCaptureMsg = { type: 'OFFSCREEN_START_CAPTURE'; streamId: string; tabId: number };
export type OffscreenStopCaptureMsg = { type: 'OFFSCREEN_STOP_CAPTURE' };
export type OffscreenAudioLevelMsg = { type: 'OFFSCREEN_AUDIO_LEVEL'; level: number };
export type OffscreenCaptureFailedMsg = { type: 'OFFSCREEN_CAPTURE_FAILED'; error: string };
export type MonitorBlockedMsg = { type: 'MONITOR_BLOCKED' };

// --- Audio health (offscreen → SW → content/popup) ---
export type MicUnavailableMsg = { type: 'MIC_UNAVAILABLE'; reason?: string };
export type AudioPlaybackSuspendedMsg = { type: 'AUDIO_PLAYBACK_SUSPENDED' };
export type ResumeAudioPlaybackMsg = { type: 'RESUME_AUDIO_PLAYBACK' };
export type AudioStatusMsg = {
  type: 'AUDIO_STATUS';
  mic: boolean;
  tab: boolean;
  playback: boolean;
  micReason?: string;
};
export type GetAudioStatusMsg = { type: 'GET_AUDIO_STATUS' };
export type OpenConsentPageMsg = { type: 'OPEN_CONSENT_PAGE' };

/** Every message that flows over chrome runtime messaging. */
export type ExtMessage =
  | StartCopilotMsg
  | StopCopilotMsg
  | GetStateMsg
  | LoginMsg
  | RegisterMsg
  | LogoutMsg
  | GetPreferencesMsg
  | UpdatePreferencesMsg
  | AudioConsentGrantedMsg
  | StateUpdateMsg
  | CopilotLifecycleMsg
  | CopilotNoticeMsg
  | ContentPingMsg
  | NudgeMsg
  | TranscriptMsg
  | StageUpdateMsg
  | TalkRatioMsg
  | ProspectContextMsg
  | MeetingSummaryMsg
  | WsErrorMsg
  | MeetingDetectedMsg
  | MeetingEndedMsg
  | SpeakerChangeMsg
  | NudgeDismissMsg
  | NudgeActedMsg
  | MicMuteStateMsg
  | OffscreenReadyMsg
  | OffscreenStartCaptureMsg
  | OffscreenStopCaptureMsg
  | OffscreenAudioLevelMsg
  | OffscreenCaptureFailedMsg
  | MonitorBlockedMsg
  | MicUnavailableMsg
  | AudioPlaybackSuspendedMsg
  | ResumeAudioPlaybackMsg
  | AudioStatusMsg
  | GetAudioStatusMsg
  | OpenConsentPageMsg;

/** All valid message discriminants. */
export type ExtMessageType = ExtMessage['type'];

/** Narrow the union to a single variant by its `type` literal. */
export type MessageByType<K extends ExtMessageType> = Extract<ExtMessage, { type: K }>;

/** Envelope returned by the messaging layer for request/response handlers. */
export interface MessageResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
