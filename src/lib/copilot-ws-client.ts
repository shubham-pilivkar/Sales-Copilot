// Copilot WebSocket client — real-time bidirectional channel.
// Handles: connect, auth, ping/pong keepalive, reconnect with backoff,
// binary audio upstream, JSON nudges downstream.

import {
  WS_RECONNECT_BACKOFFS_MS,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  WSMessageType,
} from '../constants.js';
import type {
  Nudge,
  TranscriptSegment,
  TalkRatio,
  ProspectProfile,
  QualificationScores,
  MeetingSummary,
  WSServerMessage,
  WSClientMessage,
  WSError,
} from '../types/ws.js';

export type WSStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export class CopilotWSClient {
  private _ws: WebSocket | null = null;
  private _status: WSStatus = 'idle';
  private _reconnectAttempt = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private _url = '';
  private _intentionalClose = false;

  // Event callbacks
  onNudge: ((nudge: Nudge) => void) | null = null;
  onTranscript: ((segment: TranscriptSegment) => void) | null = null;
  onStageUpdate: ((stage: string) => void) | null = null;
  onTalkRatio: ((data: TalkRatio) => void) | null = null;
  onProspectContext: ((profile: ProspectProfile) => void) | null = null;
  onQualification: ((scores: QualificationScores) => void) | null = null;
  onMeetingSummary: ((summary: MeetingSummary) => void) | null = null;
  onError: ((error: WSError) => void) | null = null;
  onStatusChange: ((status: WSStatus) => void) | null = null;
  onSessionReady: (() => void) | null = null;

  get status(): WSStatus {
    return this._status;
  }

  /** Connect to the copilot WebSocket. `url` includes session_id + token query. */
  connect(url: string): void {
    // Kill any pending reconnect/ping timers from a previous lifecycle so a
    // stale timer can't spawn a second parallel socket after this connect.
    this._clearTimers();
    this._url = url;
    this._intentionalClose = false;
    this._reconnectAttempt = 0;
    this._doConnect();
  }

  /** Send a binary audio PCM frame. */
  sendAudio(pcmBuffer: ArrayBuffer): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(pcmBuffer);
    }
  }

  /** Send a JSON control message. */
  sendJSON(data: WSClientMessage): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }

  /** Gracefully close the connection. */
  close(): void {
    this._intentionalClose = true;
    this._clearTimers();
    // Detach handlers before closing so this socket's late onclose can't run
    // _onClose and (e.g.) null out a newer socket or schedule a reconnect.
    this._teardownSocket();
    this._setStatus('closed');
  }

  // --- Internal ---

  /** Detach handlers from and close the current socket, then drop the reference. */
  private _teardownSocket(): void {
    const ws = this._ws;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(1000, 'superseded'); } catch { /* already closing */ }
    this._ws = null;
  }

  private _doConnect(): void {
    // Supersede any existing socket so two connections never run in parallel.
    this._teardownSocket();
    this._setStatus(this._reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    try {
      const ws = new WebSocket(this._url);
      this._ws = ws;
      ws.binaryType = 'arraybuffer';
      // Identity-guard every handler: if `ws` is no longer the current socket
      // (superseded by a reconnect/new connect), ignore its late events.
      ws.onopen = () => { if (ws === this._ws) this._onOpen(); };
      ws.onmessage = (ev) => { if (ws === this._ws) this._onMessage(ev); };
      ws.onclose = (ev) => { if (ws === this._ws) this._onClose(ev); };
      ws.onerror = () => {}; // onclose always follows
    } catch {
      this._scheduleReconnect();
    }
  }

  private _onOpen(): void {
    this._reconnectAttempt = 0;
    this._setStatus('connected');
    this._startPing();
  }

  private _onMessage(ev: MessageEvent): void {
    if (ev.data instanceof ArrayBuffer) return; // unexpected binary from server
    try {
      const msg = JSON.parse(ev.data as string) as WSServerMessage;
      this._routeMessage(msg);
    } catch {
      /* malformed JSON — ignore */
    }
  }

  private _routeMessage(msg: WSServerMessage): void {
    switch (msg.type) {
      case WSMessageType.PONG:
        this._clearPongTimeout();
        break;
      case WSMessageType.SESSION_READY:
        this.onSessionReady?.();
        break;
      case WSMessageType.NUDGE:
        this.onNudge?.(msg.nudge);
        break;
      case WSMessageType.TRANSCRIPT:
        this.onTranscript?.(msg);
        break;
      case WSMessageType.STAGE_UPDATE:
        this.onStageUpdate?.(msg.stage);
        break;
      case WSMessageType.TALK_RATIO:
        this.onTalkRatio?.(msg);
        break;
      case WSMessageType.PROSPECT_CONTEXT:
        this.onProspectContext?.(msg.profile);
        break;
      case WSMessageType.QUALIFICATION_UPDATE:
        this.onQualification?.(msg.scores);
        break;
      case WSMessageType.MEETING_SUMMARY:
        this.onMeetingSummary?.(msg.summary);
        break;
      case WSMessageType.ERROR:
        this.onError?.(msg);
        break;
    }
  }

  private _onClose(ev: CloseEvent): void {
    this._clearTimers();
    this._ws = null;
    if (this._intentionalClose) {
      this._setStatus('closed');
      return;
    }
    if (ev.code === 4001) {
      // Auth rejected/expired. Don't blind-reconnect with the same dead token —
      // surface it so the owner can refresh the token and reconnect.
      this._setStatus('closed');
      this.onError?.({ code: 4001, message: 'auth' });
      return;
    }
    this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    if (this._reconnectAttempt >= WS_MAX_RECONNECT_ATTEMPTS) {
      this._setStatus('closed');
      this.onError?.({ code: 'max_reconnect', message: 'Connection lost' });
      return;
    }
    this._setStatus('reconnecting');
    const delay = WS_RECONNECT_BACKOFFS_MS[
      Math.min(this._reconnectAttempt, WS_RECONNECT_BACKOFFS_MS.length - 1)
    ];
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(() => this._doConnect(), delay);
  }

  private _startPing(): void {
    this._clearTimers();
    this._pingTimer = setInterval(() => {
      // Clear any prior pong timer before arming a new one. Without this, a
      // second ping firing before the previous pong arrives would orphan the
      // earlier setTimeout — it could later fire and close a healthy socket.
      this._clearPongTimeout();
      this.sendJSON({ type: WSMessageType.PING });
      this._pongTimeout = setTimeout(() => {
        // No pong received — connection is dead
        if (this._ws) this._ws.close(4002, 'pong_timeout');
      }, WS_PONG_TIMEOUT_MS);
    }, WS_PING_INTERVAL_MS);
  }

  private _clearPongTimeout(): void {
    if (this._pongTimeout) {
      clearTimeout(this._pongTimeout);
      this._pongTimeout = null;
    }
  }

  private _clearTimers(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    this._clearPongTimeout();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _setStatus(s: WSStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.onStatusChange?.(s);
  }
}
