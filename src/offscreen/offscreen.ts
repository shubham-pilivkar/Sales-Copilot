// Offscreen document — captures tab + mic audio via AudioWorklet,
// streams 16kHz PCM Int16 to the service worker via a port.

import { MessageType } from '../constants.js';

const SAMPLE_RATE = 16000;
const HEARTBEAT_INTERVAL_MS = 15_000; // Send heartbeat every 15s
const HEAP_LIMIT_MB = 200; // Warn if heap exceeds this

let audioContext: AudioContext | null = null;
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let port: chrome.runtime.Port | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// Notify SW we're ready
chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_READY });

// #5: Heartbeat — proves offscreen is alive
function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_READY }).catch(() => {});
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

chrome.runtime.onMessage.addListener((msg: { type?: string; streamId?: string }) => {
  if (msg.type === MessageType.OFFSCREEN_START_CAPTURE) {
    startCapture(msg.streamId as string);
  } else if (msg.type === MessageType.OFFSCREEN_STOP_CAPTURE) {
    stopCapture();
  }
});

async function startCapture(streamId: string): Promise<void> {
  // Idempotent: tear down any existing graph/port first so a re-trigger
  // (heartbeat restart, port reconnect) never stacks a second pipeline.
  stopCapture();
  try {
    // 1. Capture tab audio (participants). The chromeMediaSource/mandatory
    //    constraint is a legacy Chrome API not in the standard TS types.
    // Local consts are used throughout: TS resets narrowing of the nullable
    // module-level vars across awaits, so we keep non-null locals.
    const tabConstraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    } as unknown as MediaStreamConstraints;
    const tab = await navigator.mediaDevices.getUserMedia(tabConstraints);
    tabStream = tab;

    // Keep tab audio audible to the user (handle autoplay policy)
    const monitorEl = document.getElementById('tab-monitor') as HTMLAudioElement | null;
    if (monitorEl) {
      monitorEl.srcObject = tab.clone();
      const playPromise = monitorEl.play();
      if (playPromise) {
        playPromise.catch(() => {
          // #10: Autoplay blocked — notify SW so popup can show user action needed
          chrome.runtime.sendMessage({ type: MessageType.MONITOR_BLOCKED }).catch(() => {});
          // Retry on user interaction
          document.addEventListener('click', () => {
            monitorEl.play().catch(() => {});
          }, { once: true });
        });
      }
    }

    // 2. Capture mic (user's voice)
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      console.warn('[Offscreen] Mic not available — tab-only mode');
    }
    micStream = mic;

    // 3. Create AudioContext at target sample rate
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioContext = ctx;

    // 4. Load AudioWorklet
    const workletUrl = chrome.runtime.getURL('public/audio-worklet.js');
    await ctx.audioWorklet.addModule(workletUrl);

    // 5. Open port to SW
    const p = chrome.runtime.connect({ name: 'audio-stream' });
    port = p;

    // 6. Wire tab audio → worklet → silent sink (keeps process() firing)
    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    silentSink.connect(ctx.destination);

    const workletOpts: AudioWorkletNodeOptions = { processorOptions: { targetRate: SAMPLE_RATE } };

    const tabSource = ctx.createMediaStreamSource(tab);
    const tabWorklet = new AudioWorkletNode(ctx, 'copilot-audio-processor', workletOpts);
    tabWorklet.port.onmessage = (ev: MessageEvent) => {
      // Re-read `port` at call time — stopCapture() may have nulled it.
      const out = port;
      if (!out) return;
      if (ev.data instanceof ArrayBuffer) {
        out.postMessage({ type: 'audio_chunk', data: ev.data, source: 'tab' });
      }
    };
    tabSource.connect(tabWorklet);
    tabWorklet.connect(silentSink); // Must connect to destination graph for process() to fire

    // 7. Wire mic → worklet → silent sink (if available)
    if (mic) {
      const micSource = ctx.createMediaStreamSource(mic);
      const micWorklet = new AudioWorkletNode(ctx, 'copilot-audio-processor', workletOpts);
      micWorklet.port.onmessage = (ev: MessageEvent) => {
        const out = port;
        if (!out) return;
        if (ev.data instanceof ArrayBuffer) {
          out.postMessage({ type: 'audio_chunk', data: ev.data, source: 'mic' });
        }
      };
      micSource.connect(micWorklet);
      micWorklet.connect(silentSink); // Silent — user won't hear their own mic echo
    }

    console.info('[Offscreen] Audio capture started (worklet @' + ctx.sampleRate + 'Hz, tab' + (mic ? '+mic' : '') + ')');
    startHeartbeat();
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
  if (port) { port.disconnect(); port = null; }
  console.info('[Offscreen] Audio capture stopped');
}
