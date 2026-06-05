// Copilot WebSocket client — real-time bidirectional channel.
// Pattern ported from chrome_extension/src/lib/bridge-client.js
// Handles: connect, auth, ping/pong keepalive, reconnect with backoff,
// binary audio upstream, JSON nudges downstream.

import {
  WS_RECONNECT_BACKOFFS_MS,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  WSMessageType,
} from '../constants.js';

/**
 * @typedef {'idle'|'connecting'|'connected'|'reconnecting'|'closed'} WSStatus
 */

export class CopilotWSClient {
  constructor() {
    /** @type {WebSocket|null} */
    this._ws = null;
    /** @type {WSStatus} */
    this._status = 'idle';
    this._reconnectAttempt = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._reconnectTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._pingTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._pongTimeout = null;
    this._url = '';
    this._intentionalClose = false;

    // Event callbacks
    this.onNudge = null;        // (nudge) => void
    this.onTranscript = null;   // (segment) => void
    this.onStageUpdate = null;  // (stage) => void
    this.onTalkRatio = null;    // (data) => void
    this.onProspectContext = null; // (profile) => void
    this.onQualification = null;// (scores) => void
    this.onMeetingSummary = null;// (summary) => void
    this.onError = null;        // (error) => void
    this.onStatusChange = null; // (status) => void
    this.onSessionReady = null; // () => void
  }

  get status() { return this._status; }

  /**
   * Connect to the copilot WebSocket.
   * @param {string} url - Full WSS URL including session_id and token query param
   */
  connect(url) {
    this._url = url;
    this._intentionalClose = false;
    this._reconnectAttempt = 0;
    this._doConnect();
  }

  /** Send binary audio PCM frame. */
  sendAudio(pcmBuffer) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(pcmBuffer);
    }
  }

  /** Send a JSON control message. */
  sendJSON(data) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }

  /** Gracefully close the connection. */
  close() {
    this._intentionalClose = true;
    this._clearTimers();
    if (this._ws) {
      this._ws.close(1000, 'client_stop');
      this._ws = null;
    }
    this._setStatus('closed');
  }

  // --- Internal ---

  _doConnect() {
    this._setStatus(this._reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    try {
      this._ws = new WebSocket(this._url);
      this._ws.binaryType = 'arraybuffer';
      this._ws.onopen = () => this._onOpen();
      this._ws.onmessage = (ev) => this._onMessage(ev);
      this._ws.onclose = (ev) => this._onClose(ev);
      this._ws.onerror = () => {}; // onclose always follows
    } catch (err) {
      this._scheduleReconnect();
    }
  }

  _onOpen() {
    this._reconnectAttempt = 0;
    this._setStatus('connected');
    this._startPing();
  }

  _onMessage(ev) {
    if (ev.data instanceof ArrayBuffer) return; // unexpected binary from server

    try {
      const msg = JSON.parse(ev.data);
      this._routeMessage(msg);
    } catch { /* malformed JSON — ignore */ }
  }

  _routeMessage(msg) {
    switch (msg.type) {
      case WSMessageType.PONG:
        this._clearPongTimeout();
        break;
      case WSMessageType.SESSION_READY:
        if (this.onSessionReady) this.onSessionReady();
        break;
      case WSMessageType.NUDGE:
        if (this.onNudge) this.onNudge(msg.nudge);
        break;
      case WSMessageType.TRANSCRIPT:
        if (this.onTranscript) this.onTranscript(msg);
        break;
      case WSMessageType.STAGE_UPDATE:
        if (this.onStageUpdate) this.onStageUpdate(msg.stage);
        break;
      case WSMessageType.TALK_RATIO:
        if (this.onTalkRatio) this.onTalkRatio(msg);
        break;
      case WSMessageType.PROSPECT_CONTEXT:
        if (this.onProspectContext) this.onProspectContext(msg.profile);
        break;
      case WSMessageType.QUALIFICATION_UPDATE:
        if (this.onQualification) this.onQualification(msg.scores);
        break;
      case WSMessageType.MEETING_SUMMARY:
        if (this.onMeetingSummary) this.onMeetingSummary(msg.summary);
        break;
      case WSMessageType.ERROR:
        if (this.onError) this.onError(msg);
        break;
    }
  }

  _onClose(ev) {
    this._clearTimers();
    this._ws = null;
    if (this._intentionalClose || ev.code === 4001) {
      this._setStatus('closed');
      return;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectAttempt >= WS_MAX_RECONNECT_ATTEMPTS) {
      this._setStatus('closed');
      if (this.onError) this.onError({ code: 'max_reconnect', message: 'Connection lost' });
      return;
    }
    this._setStatus('reconnecting');
    const delay = WS_RECONNECT_BACKOFFS_MS[
      Math.min(this._reconnectAttempt, WS_RECONNECT_BACKOFFS_MS.length - 1)
    ];
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(() => this._doConnect(), delay);
  }

  _startPing() {
    this._clearTimers();
    this._pingTimer = setInterval(() => {
      this.sendJSON({ type: WSMessageType.PING });
      this._pongTimeout = setTimeout(() => {
        // No pong received — connection is dead
        if (this._ws) this._ws.close(4002, 'pong_timeout');
      }, WS_PONG_TIMEOUT_MS);
    }, WS_PING_INTERVAL_MS);
  }

  _clearPongTimeout() {
    if (this._pongTimeout) { clearTimeout(this._pongTimeout); this._pongTimeout = null; }
  }

  _clearTimers() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    this._clearPongTimeout();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }

  _setStatus(s) {
    if (this._status === s) return;
    this._status = s;
    if (this.onStatusChange) this.onStatusChange(s);
  }
}
