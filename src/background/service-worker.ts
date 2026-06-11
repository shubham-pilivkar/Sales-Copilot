// Service worker — copilot state machine and message router.

import { CopilotState, MessageType, StorageKey, API_BASE_URL, WSMessageType } from '../constants.js';
import { CopilotWSClient, type WSStatus } from '../lib/copilot-ws-client.js';
import {
  startCopilotSession,
  stopCopilotSession,
  login,
  register,
  logout,
  refreshToken,
  checkAudioConsent,
  recordAudioConsent,
  getPreferences,
  updatePreferences,
} from '../lib/api-client.js';
import { onMessage, sendToTab } from '../lib/messaging.js';
import type { Nudge, TranscriptSegment, TalkRatio, ProspectProfile, MeetingSummary, WSError } from '../types/ws.js';
import type { CopilotStateSnapshot } from '../types/messages.js';

// --- State (persisted to chrome.storage.session for SW suspend survival) ---
let state: CopilotState = CopilotState.IDLE;
let sessionId: string | null = null;
let meetingTabId: number | null = null;
let prospectEmail = '';
const wsClient = new CopilotWSClient();
let pendingStart: { tabId: number; email: string } | null = null;
// Synchronous re-entrancy guard: the IDLE/ERROR state check below runs before
// several awaits (consent check, session create), so two near-simultaneous
// START_COPILOT calls could both pass it and create two billed sessions.
let starting = false;
const CONTENT_SCRIPT_FILE = 'assets/meet-copilot.ts-loader.js';

// Restore state on SW wake. Event listeners are registered synchronously and
// can fire before this async restore completes, so they MUST await `ready`
// first — otherwise GET_STATE/STOP/alarms act on a stale IDLE state and either
// spawn a duplicate session, swallow a stop, or defeat the safety alarms.
let markReady: () => void = () => {};
const ready: Promise<void> = new Promise((resolve) => { markReady = resolve; });

(async () => {
  try {
    const got = await chrome.storage.session.get([
      StorageKey.COPILOT_STATE, StorageKey.SESSION_ID, 'sc_meeting_tab', 'sc_prospect_email',
    ]);
    if (got[StorageKey.COPILOT_STATE] && got[StorageKey.COPILOT_STATE] !== CopilotState.IDLE) {
      state = got[StorageKey.COPILOT_STATE];
      sessionId = got[StorageKey.SESSION_ID] || null;
      meetingTabId = got.sc_meeting_tab || null;
      prospectEmail = got.sc_prospect_email || '';
      // If was active, attempt reconnect
      if (state === CopilotState.ACTIVE || state === CopilotState.RECONNECTING) {
        await reconnectWS();
      } else if (state === CopilotState.CONNECTING) {
        // A SW that died mid-connect can't recover the in-flight handshake;
        // surface it as an error rather than getting stuck on "Connecting…".
        setState(CopilotState.ERROR);
      }
    }
  } catch { /* fresh session */ } finally {
    markReady();
  }
})();

// --- State Machine ---

function setState(newState: CopilotState): void {
  state = newState;
  chrome.storage.session.set({
    [StorageKey.COPILOT_STATE]: state,
    [StorageKey.SESSION_ID]: sessionId,
    sc_meeting_tab: meetingTabId,
    sc_prospect_email: prospectEmail,
  }).catch(() => {});
  // G3: Badge indicator
  if (state === CopilotState.ACTIVE) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
  } else if (state === CopilotState.IDLE) {
    chrome.action.setBadgeText({ text: '' });
  } else if (state === CopilotState.ERROR) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
  broadcastState();
}

function broadcastState(): void {
  const payload = {
    type: MessageType.STATE_UPDATE,
    state, sessionId, prospectEmail, meetingTabId,
  };
  chrome.runtime.sendMessage(payload).catch(() => {});
  if (meetingTabId) sendToTab(meetingTabId, payload);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function contentScriptReady(tabId: number): Promise<boolean> {
  const response = await sendToTab(tabId, { type: MessageType.CONTENT_PING });
  return Boolean(
    response
      && typeof response === 'object'
      && 'ok' in response
      && (response as { ok?: boolean }).ok,
  );
}

async function ensureMeetContentScript(tabId: number): Promise<boolean> {
  if (await contentScriptReady(tabId)) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch (err) {
    console.warn('[SW] Content script injection failed:', err);
  }
  await wait(150);
  return contentScriptReady(tabId);
}

async function sendLifecycleToMeeting(phase: 'started' | 'stopped', sid?: string): Promise<void> {
  if (!meetingTabId) return;
  await ensureMeetContentScript(meetingTabId);
  const result = await sendToTab(meetingTabId, {
    type: MessageType.COPILOT_LIFECYCLE,
    phase,
    sessionId: sid,
  });
  if (result && typeof result === 'object' && 'ok' in result && !(result as { ok?: boolean }).ok) {
    console.warn('[SW] Lifecycle message was not delivered:', result);
  }
}

// --- WS Client Events ---

wsClient.onStatusChange = (status: WSStatus) => {
  if (status === 'connected') setState(CopilotState.ACTIVE);
  else if (status === 'reconnecting') setState(CopilotState.RECONNECTING);
  else if (status === 'closed' && state !== CopilotState.IDLE && state !== CopilotState.STOPPING) setState(CopilotState.ERROR);
};

wsClient.onNudge = (nudge: Nudge) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'NUDGE', nudge });
};

wsClient.onTranscript = (segment: TranscriptSegment) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'TRANSCRIPT', ...segment });
};

wsClient.onStageUpdate = (stage: string) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'STAGE_UPDATE', stage });
};

wsClient.onTalkRatio = (data: TalkRatio) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'TALK_RATIO', ...data });
};

wsClient.onProspectContext = (profile: ProspectProfile) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'PROSPECT_CONTEXT', profile });
};

wsClient.onMeetingSummary = (summary: MeetingSummary) => {
  // The summary arrives during teardown, after meetingTabId may already be
  // cleared — fall back to the tab retained for the post-stop grace window.
  const tab = meetingTabId ?? summaryTabId;
  if (tab) sendToTab(tab, { type: 'MEETING_SUMMARY', summary });
  // Summary received — no need to keep the grace window open.
  finishWsGraceClose();
};

wsClient.onError = (err: WSError) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'WS_ERROR', ...err });
  // Try token refresh on auth failure
  if (err.code === 'auth_expired' || err.code === 4001) {
    refreshToken().then((newToken) => {
      if (newToken && sessionId) reconnectWS();
    }).catch(() => {});
  }
};

wsClient.onSessionReady = () => {
  wsClient.sendJSON({ type: WSMessageType.SESSION_START, prospect_email: prospectEmail });
  startAudioCapture();
  startHeartbeatMonitor(); // #5: begin monitoring offscreen
};

// --- WS Reconnect (after SW suspend/resume) ---

async function reconnectWS(): Promise<void> {
  if (!sessionId) return;
  try {
    const token = (await chrome.storage.local.get(StorageKey.AUTH_TOKEN))[StorageKey.AUTH_TOKEN];
    const baseUrl = (await chrome.storage.local.get(StorageKey.API_BASE_URL))[StorageKey.API_BASE_URL] || API_BASE_URL;
    const wsBase = baseUrl.replace(/^http/, 'ws');
    wsClient.connect(`${wsBase}/ws/copilot/${sessionId}?token=${token}`);
  } catch {
    setState(CopilotState.ERROR);
  }
}

// --- Offscreen Management ---

async function ensureOffscreen(): Promise<void> {
  try {
    const existing = await chrome.offscreen.hasDocument().catch(() => false);
    if (existing) return;
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture meeting audio for AI sales copilot',
    });
  } catch (err) {
    console.error('[SW] ensureOffscreen failed:', err);
  }
}

async function closeOffscreen(): Promise<void> {
  try { await chrome.offscreen.closeDocument(); } catch { /* already closed */ }
}

// When the SW (re)starts capture, the offscreen runs its idempotent
// stopCapture() first, which disconnects its old port. Without this guard the
// port.onDisconnect handler would see that as a death and restart again —
// an infinite loop. We suppress restart-on-disconnect for a short window
// around any SW-initiated start.
let expectPortChurn = false;
let portChurnTimer: ReturnType<typeof setTimeout> | null = null;
function suppressPortRestart(): void {
  expectPortChurn = true;
  if (portChurnTimer) clearTimeout(portChurnTimer);
  portChurnTimer = setTimeout(() => { expectPortChurn = false; portChurnTimer = null; }, 4000);
}

async function startAudioCapture(): Promise<void> {
  if (!meetingTabId) return;
  const tabId = meetingTabId; // capture non-null before awaits reset narrowing
  try {
    suppressPortRestart();
    await ensureOffscreen();
    // @types/chrome only declares the callback form; wrap it in a promise.
    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(new Error(lastError.message)); else resolve(id);
      });
    });
    chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_START_CAPTURE,
      streamId,
      tabId,
    }).catch(() => {});
  } catch (err) {
    console.error('[SW] startAudioCapture failed:', err);
  }
}

async function stopAudioCapture(): Promise<void> {
  chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_STOP_CAPTURE }).catch(() => {});
  await closeOffscreen();
}

// --- Copilot Start/Stop ---

async function startCopilot(tabId: number, email: string): Promise<void> {
  if (starting) return;
  if (state !== CopilotState.IDLE && state !== CopilotState.ERROR) return;
  starting = true;
  try {
    // Check local + server-side consent before opening a session or capture.
    const consent = await chrome.storage.local.get(StorageKey.AUDIO_CONSENT);
    const hasLocalConsent = consent[StorageKey.AUDIO_CONSENT] === true;
    let serverReachable = true;
    let hasServerConsent = false;
    if (hasLocalConsent) {
      try {
        hasServerConsent = await checkAudioConsent();
      } catch {
        // Network/server failure — DON'T wipe a validly-recorded local consent
        // and force a re-grant loop. Surface an error and bail.
        serverReachable = false;
      }
    }
    if (!serverReachable) {
      notifyUser('consent_check_failed', 'Could not verify audio consent — check your connection and retry.');
      return;
    }
    if (!hasLocalConsent || !hasServerConsent) {
      if (!hasServerConsent) {
        await chrome.storage.local.remove(StorageKey.AUDIO_CONSENT);
      }
      pendingStart = { tabId, email };
      await chrome.storage.session.set({ [StorageKey.PENDING_START]: pendingStart });
      try {
        const consentWin = await chrome.windows.create({
          url: chrome.runtime.getURL('src/permission/consent.html'),
          type: 'popup',
          width: 480,
          height: 520,
          focused: true,
        });
        // If the user closes the consent window without granting, clear the
        // pending start so it can't silently auto-start a session much later.
        const winId = consentWin?.id;
        if (winId !== undefined) {
          const onClosed = (closedId: number) => {
            if (closedId !== winId) return;
            chrome.windows.onRemoved.removeListener(onClosed);
            if (pendingStart) {
              pendingStart = null;
              chrome.storage.session.remove(StorageKey.PENDING_START).catch(() => {});
            }
          };
          chrome.windows.onRemoved.addListener(onClosed);
        }
      } catch (err) {
        console.error('[SW] Failed to open consent window:', err);
      }
      return; // User needs to grant consent first
    }

    // Assign session fields BEFORE setState so the persisted snapshot/broadcast
    // for CONNECTING carries the real tab + email, not stale nulls.
    meetingTabId = tabId;
    prospectEmail = email;
    setState(CopilotState.CONNECTING);
    await sendLifecycleToMeeting('started');

    try {
      const { session_id, ws_url } = await startCopilotSession(email);
      sessionId = session_id;

      const token = (await chrome.storage.local.get(StorageKey.AUTH_TOKEN))[StorageKey.AUTH_TOKEN];
      if (!token) throw new Error('not_authenticated');
      const baseUrl = (await chrome.storage.local.get(StorageKey.API_BASE_URL))[StorageKey.API_BASE_URL] || API_BASE_URL;
      const wsBase = baseUrl.replace(/^http/, 'ws');
      const serverWsUrl = ws_url || '';
      const baseWsUrl = serverWsUrl.includes('localhost')
        ? `${wsBase}/ws/copilot/${sessionId}`
        : serverWsUrl || `${wsBase}/ws/copilot/${sessionId}`;
      wsClient.connect(`${baseWsUrl}?token=${encodeURIComponent(token)}`);

      await sendLifecycleToMeeting('started', sessionId ?? undefined);
    } catch (err) {
      console.error('[SW] startCopilot failed:', err);
      setState(CopilotState.ERROR);
      // Tell the meeting tab to tear down its overlay so it doesn't leak.
      await sendLifecycleToMeeting('stopped');
    }
  } finally {
    starting = false;
  }
}

async function stopCopilot(): Promise<void> {
  if (state === CopilotState.IDLE) return;
  setState(CopilotState.STOPPING);
  startForceStopAlarm(); // #7: timeout safety net

  wsClient.sendJSON({ type: WSMessageType.SESSION_STOP });
  // Don't close the socket immediately: the backend generates and sends the
  // meeting_summary during teardown (a few seconds later). Keep the WS open for
  // a short grace window so that summary can arrive, then close.
  summaryTabId = meetingTabId;
  scheduleWsGraceClose();
  await stopAudioCapture();
  stopHeartbeatMonitor(); // #5: stop monitoring

  if (sessionId) {
    stopCopilotSession(sessionId).catch(() => {});
  }
  if (meetingTabId) {
    await sendLifecycleToMeeting('stopped');
  }

  sessionId = null;
  meetingTabId = null;
  prospectEmail = '';
  clearForceStopAlarm(); // #7: cleanup succeeded, cancel force-stop
  setState(CopilotState.IDLE);
}

// --- WS grace close (keep socket briefly open to receive meeting_summary) ---
let summaryTabId: number | null = null;
let wsGraceTimer: ReturnType<typeof setTimeout> | null = null;
const WS_GRACE_CLOSE_MS = 8000;

function scheduleWsGraceClose(): void {
  if (wsGraceTimer) clearTimeout(wsGraceTimer);
  wsGraceTimer = setTimeout(finishWsGraceClose, WS_GRACE_CLOSE_MS);
}

function finishWsGraceClose(): void {
  if (wsGraceTimer) { clearTimeout(wsGraceTimer); wsGraceTimer = null; }
  summaryTabId = null;
  wsClient.close();
}

// --- Message Router ---

onMessage({
  [MessageType.START_COPILOT]: async (msg) => {
    await ready;
    await startCopilot(msg.tabId, msg.prospectEmail);
  },
  [MessageType.STOP_COPILOT]: async () => {
    await ready;
    await stopCopilot();
  },
  [MessageType.GET_STATE]: async (): Promise<CopilotStateSnapshot> => {
    await ready;
    return { state, sessionId, prospectEmail, meetingTabId };
  },
  [MessageType.LOGIN]: async (msg) => {
    return login(msg.email, msg.password);
  },
  [MessageType.REGISTER]: async (msg) => {
    return register(msg.email, msg.name, msg.password);
  },
  [MessageType.LOGOUT]: async () => {
    await ready;
    await stopCopilot();
    await logout();
  },
  [MessageType.GET_PREFERENCES]: async () => {
    return getPreferences();
  },
  [MessageType.UPDATE_PREFERENCES]: async (msg) => {
    return updatePreferences(msg.preferences);
  },
  [MessageType.AUDIO_CONSENT_GRANTED]: async () => {
    await ready;
    // Record server-side consent first. The backend refuses session_start
    // without this audit record, so this must not be best-effort.
    await recordAudioConsent();
    await chrome.storage.local.set({ [StorageKey.AUDIO_CONSENT]: true });

    // Resume pending session start
    const stored = await chrome.storage.session.get(StorageKey.PENDING_START);
    const start = pendingStart || stored[StorageKey.PENDING_START];
    pendingStart = null;
    await chrome.storage.session.remove(StorageKey.PENDING_START);
    if (start?.tabId && start?.email) {
      await startCopilot(start.tabId, start.email);
      return { resumed: true };
    }
    return { resumed: false };
  },
  [MessageType.MEETING_DETECTED]: async (msg, sender) => {
    await ready;
    const tid = sender?.tab?.id || msg.tabId;
    // Don't repoint an in-progress session to a different Meet tab — that would
    // misroute nudges/transcripts away from the live call.
    if (state !== CopilotState.IDLE && state !== CopilotState.ERROR
        && meetingTabId && tid && tid !== meetingTabId) {
      return;
    }
    if (tid) meetingTabId = tid;
  },
  [MessageType.MEETING_ENDED]: async (_msg, sender) => {
    await ready;
    // Only the tab hosting the active session may end it. Otherwise leaving an
    // unrelated second Meet tab would tear down the live call.
    const tid = sender?.tab?.id;
    if (meetingTabId && tid && tid !== meetingTabId) return;
    await stopCopilot();
  },
  [MessageType.MIC_MUTE_STATE]: (msg) => {
    // Forward mic mute to backend via WS
    wsClient.sendJSON({ type: WSMessageType.MIC_MUTE, muted: msg.muted });
  },
  [MessageType.SPEAKER_CHANGE]: (msg) => {
    // Forward speaker change to backend
    wsClient.sendJSON({ type: WSMessageType.SPEAKER_CHANGE, speaker: msg.speaker, timestamp: msg.wall_clock_ms });
  },
  [MessageType.NUDGE_DISMISS]: (msg) => {
    wsClient.sendJSON({
      type: WSMessageType.NUDGE_DISMISS,
      nudge_id: msg.nudge_id,
      nudge_type: msg.nudge_type,
    });
  },
  [MessageType.NUDGE_ACTED]: (msg) => {
    wsClient.sendJSON({
      type: WSMessageType.NUDGE_ACTED,
      nudge_id: msg.nudge_id,
      nudge_type: msg.nudge_type,
    });
  },
  [MessageType.OFFSCREEN_READY]: () => {
    lastHeartbeatAt = Date.now();
    console.info('[SW] Offscreen ready');
  },
  [MessageType.MONITOR_BLOCKED]: () => {
    // Autoplay policy blocked meeting audio playback — tell the user to click.
    notifyUser('monitor_blocked', 'Click the meeting tab to enable audio.');
  },
  [MessageType.OFFSCREEN_CAPTURE_FAILED]: (msg) => {
    // Audio capture could not start — surface it and don't pretend we're ACTIVE.
    notifyUser('capture_failed', msg?.error || 'Could not capture meeting audio.');
    if (state === CopilotState.ACTIVE || state === CopilotState.CONNECTING) {
      setState(CopilotState.ERROR);
    }
  },
});

function notifyUser(code: string, message: string): void {
  const payload = { type: MessageType.COPILOT_NOTICE, code, message };
  if (meetingTabId) sendToTab(meetingTabId, payload);
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// --- Audio Port (binary data from offscreen) ---

const SOURCE_MIC = 0x01;
const SOURCE_TAB = 0x02;

// Decode base64 PCM sent by the offscreen document over the runtime port.
function base64ToUint8Array(b64: string): Uint8Array {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

// #5: Offscreen heartbeat monitoring via chrome.alarms
const HEARTBEAT_ALARM = 'sc_heartbeat_check';
// chrome.alarms clamps periodInMinutes to a 1-minute minimum in packed builds,
// so sub-minute values are not honored. Use 1 min and a timeout comfortably
// larger than the real check cadence to avoid spurious restarts.
const HEARTBEAT_INTERVAL_MIN = 1;
const HEARTBEAT_TIMEOUT_MS = 90_000; // 90s without heartbeat = dead
let lastHeartbeatAt = 0;

// #7: Force-stop alarm (timeout on stop)
const FORCE_STOP_ALARM = 'sc_force_stop';
const FORCE_STOP_TIMEOUT_MIN = 2; // 2 min max for stop

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name === HEARTBEAT_ALARM) {
    if (state !== CopilotState.ACTIVE) return;
    if (lastHeartbeatAt === 0) {
      // SW restarted: in-memory heartbeat is lost. Don't silently skip the
      // check (the old bug) — verify the offscreen document actually exists and
      // restart capture if it's gone.
      const alive = await chrome.offscreen.hasDocument().catch(() => false);
      if (!alive) {
        console.warn('[SW] No offscreen document after SW restart — restarting capture');
        startAudioCapture().catch(() => {});
      } else {
        lastHeartbeatAt = Date.now(); // assume alive; let normal timeout logic take over
      }
      return;
    }
    if (Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
      console.warn('[SW] Offscreen heartbeat timeout — restarting capture');
      startAudioCapture().catch(() => {});
    }
  } else if (alarm.name === FORCE_STOP_ALARM) {
    // #7: Force cleanup if stop is taking too long
    if (state === CopilotState.STOPPING) {
      console.warn('[SW] Force-stop alarm fired — forcing cleanup');
      sessionId = null; meetingTabId = null; prospectEmail = '';
      setState(CopilotState.IDLE);
    }
  }
});

function startHeartbeatMonitor(): void {
  lastHeartbeatAt = Date.now();
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_INTERVAL_MIN });
}

function stopHeartbeatMonitor(): void {
  chrome.alarms.clear(HEARTBEAT_ALARM);
}

function startForceStopAlarm(): void {
  chrome.alarms.create(FORCE_STOP_ALARM, { delayInMinutes: FORCE_STOP_TIMEOUT_MIN });
}

function clearForceStopAlarm(): void {
  chrome.alarms.clear(FORCE_STOP_ALARM);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'audio-stream') return;
  port.onMessage.addListener((msg: { type?: string; data?: string; source?: string }) => {
    if (msg.type === 'audio_chunk' && typeof msg.data === 'string' && msg.data.length > 0) {
      // msg.data is base64 PCM (ports JSON-serialize, so it can't be a raw buffer).
      const sourceTag = msg.source === 'mic' ? SOURCE_MIC : SOURCE_TAB;
      const audio = base64ToUint8Array(msg.data);
      if (audio.length === 0) return;
      const tagged = new Uint8Array(1 + audio.length);
      tagged[0] = sourceTag;
      tagged.set(audio, 1);
      wsClient.sendAudio(tagged.buffer as ArrayBuffer);
    }
  });
  port.onDisconnect.addListener(() => {
    if (expectPortChurn) return; // expected churn from a SW-initiated (re)start
    if (state === CopilotState.ACTIVE) {
      console.warn('[SW] Audio port disconnected — restarting capture');
      startAudioCapture().catch(() => {});
    }
  });
});

// Tab close → auto-stop
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (tabId === meetingTabId) stopCopilot();
});

console.info('[Sales Copilot SW] loaded');
