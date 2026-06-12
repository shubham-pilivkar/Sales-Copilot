// Offscreen document — captures tab + mic audio via AudioWorklet,
// streams 16kHz PCM Int16 to the service worker via a port.
//
// Audio architecture (matches the official chrome.tabCapture guidance):
//   tab capture (processing DISABLED — it's program audio, not a mic)
//     ├─→ ctx.destination            (playback: capture mutes the tab, so we
//     │                               re-play it; AudioContext routing is the
//     │                               sanctioned pattern — NOT an <audio> element,
//     │                               whose autoplay behavior is profile-dependent)
//     └─→ worklet → silent sink      (16kHz PCM for STT)
//   mic capture (echoCancellation ON — must not pick up meeting audio from speakers)
//     └─→ worklet → silent sink      (16kHz PCM; never to destination — no self-echo)
//
// The AudioContext runs at the NATIVE sample rate: the worklet resamples to
// 16kHz for Deepgram, and playback through a 16kHz context would downsample
// everything the user hears to telephone quality.

import { MessageType } from '../constants.js';

const TARGET_RATE = 16000;
const HEARTBEAT_INTERVAL_MS = 15_000; // Send heartbeat every 15s
const HEAP_LIMIT_MB = 200; // Warn if heap exceeds this

let audioContext: AudioContext | null = null;
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let port: chrome.runtime.Port | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let micCaptured = false;
// Re-entrancy token: a second startCapture invalidates any in-flight one, so
// two concurrent starts can never stack two audio graphs/ports.
let captureGen = 0;

// (Re)connect the audio port to the SW. If the SW is terminated mid-session,
// its old port dies — without reconnect, ALL PCM would be silently dropped for
// the rest of the meeting. Retries with backoff while capture is live.
function connectPort(): void {
  const p = chrome.runtime.connect({ name: 'audio-stream' });
  port = p;
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    // audioContext === null means stopCapture() ran (intentional teardown).
    // Otherwise the SW went away — reconnect so audio keeps flowing once it
    // restarts. The SW re-registers its onConnect listener at startup.
    if (audioContext !== null) {
      setTimeout(() => {
        if (audioContext !== null && port === null) {
          try { connectPort(); } catch { /* retry on next disconnect tick */ }
        }
      }, 1000);
    }
  });
}

// chrome.runtime.Port messages are JSON-serialized (NOT structured-cloned), so
// an ArrayBuffer would arrive at the SW as `{}` and all audio would be silently
// dropped. Encode PCM as base64 for the hop; the SW decodes it back to bytes.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000; // avoid arg-count limits on fromCharCode.apply
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Notify SW we're ready (catch: the SW may be mid-restart at boot)
chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_READY }).catch(() => {});

// #5: Heartbeat — proves offscreen is alive, and carries an audio-health
// snapshot so failures are visible instead of looking like a healthy session.
function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_READY,
      audio: currentAudioState(),
    }).catch(() => {});
    // #6: Heap watchdog (performance.memory is a non-standard Chrome extension)
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) {
      const usedMB = mem.usedJSHeapSize / (1024 * 1024);
      if (usedMB > HEAP_LIMIT_MB) {
        console.warn(`[Offscreen] Heap high: ${usedMB.toFixed(0)}MB — forcing GC-friendly cleanup`);
        // Can't force GC but can null large buffers
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function currentAudioState(): { contextState: string; mic: boolean; tab: boolean } {
  return {
    contextState: audioContext?.state ?? 'none',
    mic: micCaptured && !!micStream?.getAudioTracks().some((t) => t.readyState === 'live'),
    tab: !!tabStream?.getAudioTracks().some((t) => t.readyState === 'live'),
  };
}

chrome.runtime.onMessage.addListener((msg: { type?: string; streamId?: string }) => {
  if (msg.type === MessageType.OFFSCREEN_START_CAPTURE) {
    startCapture(msg.streamId as string);
  } else if (msg.type === MessageType.OFFSCREEN_STOP_CAPTURE) {
    stopCapture();
  } else if (msg.type === MessageType.RESUME_AUDIO_PLAYBACK) {
    // User clicked "enable audio" in the overlay/popup — retry resuming the
    // context (this is reachable, unlike a click handler inside this document).
    resumePlayback();
  }
});

async function resumePlayback(): Promise<void> {
  const ctx = audioContext;
  if (!ctx) return;
  try {
    await ctx.resume();
  } catch { /* stays suspended */ }
  if (ctx.state !== 'running') {
    chrome.runtime.sendMessage({ type: MessageType.AUDIO_PLAYBACK_SUSPENDED }).catch(() => {});
  } else {
    chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_READY,
      audio: currentAudioState(),
    }).catch(() => {});
  }
}

/** Acquire the tab-capture stream without ever hard-failing on constraint
 *  support differences across Chrome versions.
 *  Attempt 1: legacy-only syntax with goog* processing disables.
 *  Attempt 2 (fallback): bare legacy constraints — the known-working baseline.
 *  Finally: best-effort applyConstraints() for the standard processing keys
 *  (modern API on the live track — no legacy/modern mixing). */
async function acquireTabStream(streamId: string): Promise<MediaStream> {
  const legacyWithDisables = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        googEchoCancellation: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
        googHighpassFilter: false,
      },
    },
  } as unknown as MediaStreamConstraints;
  const legacyBare = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  } as unknown as MediaStreamConstraints;

  let tab: MediaStream;
  try {
    tab = await navigator.mediaDevices.getUserMedia(legacyWithDisables);
    console.info('[Offscreen] Tab captured with goog* processing disables');
  } catch (err) {
    console.warn('[Offscreen] goog* constraints rejected — falling back to bare capture:', err);
    tab = await navigator.mediaDevices.getUserMedia(legacyBare);
  }

  // Best-effort: disable processing via the modern per-track API. Harmless if
  // the track/browser rejects it — quality improves when it sticks.
  for (const track of tab.getAudioTracks()) {
    try {
      await track.applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } as MediaTrackConstraints);
    } catch { /* not supported for this track — keep capturing regardless */ }
  }
  return tab;
}

async function startCapture(streamId: string): Promise<void> {
  // Idempotent: tear down any existing graph/port first so a re-trigger
  // (heartbeat restart, port reconnect) never stacks a second pipeline.
  stopCapture();
  // Async re-entrancy guard: if another startCapture begins while this one is
  // awaiting (gUM/addModule), this run becomes stale and must abort.
  const gen = ++captureGen;
  const stale = () => gen !== captureGen;
  try {
    // 1. Capture tab audio (participants). The chromeMediaSource/mandatory
    //    constraint is a legacy Chrome API not in the standard TS types.
    //
    // We want ALL WebRTC voice processing disabled on the tab capture — the
    // meeting audio is program audio, not a microphone (noiseSuppression
    // mangles overlapping speakers, autoGainControl pumps, echoCancellation
    // cancels our own playback of this stream toward silence).
    //
    // IMPORTANT (regression fix): legacy `mandatory` syntax must NEVER be mixed
    // with modern constraint keys in the same object — Chrome rejects that with
    // "Malformed constraint: Cannot use both optional/mandatory and specific or
    // advanced constraints", which killed the entire capture (zero audio).
    // Strategy: try legacy-only with goog* disables; fall back to the bare
    // constraints that are guaranteed to work; then best-effort
    // applyConstraints() on the live track for the standard properties.
    const tab = await acquireTabStream(streamId);
    if (stale()) { tab.getTracks().forEach((t) => t.stop()); return; }
    tabStream = tab;
    // NOTE: tab playback is wired later via the Web Audio graph
    // (tabSource → ctx.destination). We deliberately do NOT clone the tab
    // stream into a separate <audio> element — cloning a tabCapture stream is a
    // known Chrome issue that silently breaks the capture tap (the worklet goes
    // silent) or breaks playback. The official pattern feeds ONE
    // MediaStreamSource into both the destination and the worklet.

    // 2. Capture mic (user's voice). Echo cancellation must stay ON here: the
    //    meeting audio plays from the user's speakers and would otherwise be
    //    picked up by the mic — Deepgram's "user" stream would then contain
    //    the prospect's voice (speaker misattribution).
    let mic: MediaStream | null = null;
    micCaptured = false;
    try {
      // Pre-check the permission state: offscreen documents CANNOT show a
      // permission prompt, so a 'prompt' state here means getUserMedia would
      // fail with NotAllowedError. Surface that as an actionable signal
      // instead of silently degrading to tab-only mode.
      let permState = 'prompt';
      try {
        const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        permState = status.state;
      } catch { /* permissions API unavailable — try gUM anyway */ }

      if (permState === 'granted') {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (stale()) { mic.getTracks().forEach((t) => t.stop()); tab.getTracks().forEach((t) => t.stop()); return; }
        micCaptured = true;
      } else {
        console.warn(`[Offscreen] Mic permission state=${permState} — cannot prompt from offscreen`);
        chrome.runtime.sendMessage({
          type: MessageType.MIC_UNAVAILABLE,
          reason: permState, // 'prompt' = never granted, 'denied' = blocked
        }).catch(() => {});
      }
    } catch (micErr) {
      console.warn('[Offscreen] Mic not available — tab-only mode:', micErr);
      chrome.runtime.sendMessage({
        type: MessageType.MIC_UNAVAILABLE,
        reason: micErr instanceof Error ? micErr.name : 'error',
      }).catch(() => {});
    }
    micStream = mic;

    // 3. Create AudioContext at the NATIVE rate (no sampleRate option). The
    //    worklet resamples to 16kHz for STT; playback must stay native-quality.
    const ctx = new AudioContext();
    audioContext = ctx;

    // 4. Load AudioWorklet
    const workletUrl = chrome.runtime.getURL('public/audio-worklet.js');
    await ctx.audioWorklet.addModule(workletUrl);
    if (stale()) { ctx.close().catch(() => {}); tab.getTracks().forEach((t) => t.stop()); mic?.getTracks().forEach((t) => t.stop()); return; }

    // 5. Open port to SW (auto-reconnects if the SW restarts mid-session)
    connectPort();

    // 6. Wire the graph.
    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    silentSink.connect(ctx.destination);

    const workletOpts: AudioWorkletNodeOptions = { processorOptions: { targetRate: TARGET_RATE } };

    const tabSource = ctx.createMediaStreamSource(tab);
    // Playback: tab capture mutes the tab, so route the captured audio to the
    // default output. This is the official tabCapture pattern and replaces the
    // old <audio> element (whose autoplay could silently fail per-profile, with
    // an unreachable click-to-retry inside this invisible document).
    tabSource.connect(ctx.destination);

    const tabWorklet = new AudioWorkletNode(ctx, 'copilot-audio-processor', workletOpts);
    tabWorklet.port.onmessage = (ev: MessageEvent) => {
      // Re-read `port` at call time — stopCapture() may have nulled it.
      const out = port;
      if (!out) return;
      if (ev.data instanceof ArrayBuffer) {
        out.postMessage({ type: 'audio_chunk', data: arrayBufferToBase64(ev.data), source: 'tab' });
      }
    };
    tabSource.connect(tabWorklet);
    tabWorklet.connect(silentSink); // Must connect to destination graph for process() to fire

    // 7. Wire mic → worklet → silent sink (if available). Never to destination.
    if (mic) {
      const micSource = ctx.createMediaStreamSource(mic);
      const micWorklet = new AudioWorkletNode(ctx, 'copilot-audio-processor', workletOpts);
      micWorklet.port.onmessage = (ev: MessageEvent) => {
        const out = port;
        if (!out) return;
        if (ev.data instanceof ArrayBuffer) {
          out.postMessage({ type: 'audio_chunk', data: arrayBufferToBase64(ev.data), source: 'mic' });
        }
      };
      micSource.connect(micWorklet);
      micWorklet.connect(silentSink); // Silent — user won't hear their own mic echo
    }

    // 8. Autoplay guard: extension pages are normally exempt, but if the
    //    context starts suspended, resume it; if that fails, tell the SW so
    //    the overlay can show a clickable "enable meeting audio" button.
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch { /* handled below */ }
      if (stale()) return; // teardown already handled by the newer run
    }
    if ((ctx.state as string) !== 'running') {
      console.warn('[Offscreen] AudioContext suspended — playback needs user action');
      chrome.runtime.sendMessage({ type: MessageType.AUDIO_PLAYBACK_SUSPENDED }).catch(() => {});
    }

    console.info(
      '[Offscreen] Audio capture started (ctx@' + ctx.sampleRate + 'Hz → ' + TARGET_RATE +
      'Hz, tab' + (mic ? '+mic' : ' only') + ', playback=' + ctx.state + ')',
    );
    startHeartbeat();
    // Immediate health snapshot (don't wait 15s for the first heartbeat)
    chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_READY,
      audio: currentAudioState(),
    }).catch(() => {});
  } catch (err) {
    console.error('[Offscreen] Capture failed:', err);
    // Tell the SW so it can surface this and not silently believe audio flows.
    chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_CAPTURE_FAILED,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    stopCapture();
  }
}

function stopCapture(): void {
  stopHeartbeat();
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  if (tabStream) { tabStream.getTracks().forEach((t) => t.stop()); tabStream = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  micCaptured = false;
  if (port) { port.disconnect(); port = null; }
  console.info('[Offscreen] Audio capture stopped');
}
