// WebSocket protocol contract between the extension and the backend.
// Mirrors app/ws/protocol.py + the payloads produced by app/audio/pipeline.py.

import type { NudgeType, NudgePriority, MeetingStage } from '../constants.js';

// --- Shared payload shapes ---

export interface Nudge {
  id: string;
  type: NudgeType | string;
  priority: NudgePriority | string;
  title: string;
  message: string;
  suggested_response?: string;
  confidence?: number;
  timestamp?: number;
}

export interface TranscriptSegment {
  speaker: string;
  text: string;
  is_final: boolean;
  confidence?: number;
  segment_id?: string;
}

export interface TalkRatio {
  ratio: number;
  warning?: boolean;
  user_pct?: number;
  prospect_pct?: number;
}

export interface ProspectProfile {
  name?: string;
  title?: string;
  company?: string;
  industry?: string;
  company_size?: string;
}

export interface MeetingSummary {
  key_points?: string[];
  objections?: string[];
  action_items?: string[];
  qualification_score?: number;
  next_steps?: string;
  overall_sentiment?: string;
}

export interface QualificationScores {
  budget?: number;
  authority?: number;
  need?: number;
  timeline?: number;
  overall?: number;
}

// --- Downstream frames (backend → extension), discriminated on `type` ---

export type WSServerMessage =
  | { type: 'pong' }
  | { type: 'session_ready'; session_id?: string }
  | { type: 'nudge'; nudge: Nudge }
  | ({ type: 'transcript' } & TranscriptSegment)
  | { type: 'stage_update'; stage: MeetingStage | string }
  | ({ type: 'talk_ratio' } & TalkRatio)
  | { type: 'prospect_context'; profile: ProspectProfile }
  | { type: 'qualification_update'; scores: QualificationScores }
  | { type: 'meeting_summary'; summary: MeetingSummary }
  | { type: 'error'; code: string | number; message: string; recoverable?: boolean };

// --- Upstream frames (extension → backend) ---
// Note: audio is sent as binary (ArrayBuffer with a 1-byte source tag), not JSON.

export type WSClientMessage =
  | { type: 'ping' }
  | { type: 'session_start'; prospect_email: string }
  | { type: 'session_stop' }
  | { type: 'mic_mute'; muted: boolean }
  | { type: 'speaker_change'; speaker: string; timestamp: number }
  | { type: 'nudge_dismiss'; nudge_id: string; nudge_type: string }
  | { type: 'nudge_acted'; nudge_id: string; nudge_type: string };

/** Error payload surfaced via the ws-client `onError` callback. */
export interface WSError {
  code: string | number;
  message?: string;
}
