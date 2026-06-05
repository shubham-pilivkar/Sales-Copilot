// Offscreen document — captures tab + mic audio via AudioWorklet,
// streams 16kHz PCM Int16 to the service worker via a port.
// Pattern from chrome_extension/src/offscreen/transcribe.js
// Upgraded: AudioWorklet for real-time performance, dual-source (tab + mic).

import { MessageType } from '../constants.js';

const SAMPLE_RATE = 16000;

let audioContext = null;
let tabStream = null;
let micStream = null;
let port = null;

// Notify SW we're ready
chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_READY });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MessageType.OFFSCREEN_START_CAPTURE) {
    startCapture(msg.streamId);
  } else if (msg.type === MessageType.OFFSCREEN_STOP_CAPTURE) {
    stopCapture();
  }
});

async function startCapture(streamId) {
  try {
    // 1. Capture tab audio (participants)
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    // Keep tab audio audible to the user
    const monitorEl = document.getElementById('tab-monitor');
    if (monitorEl) monitorEl.srcObject = tabStream.clone();

    // 2. Capture mic (user's voice)
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      console.warn('[Offscreen] Mic not available — tab-only mode');
    }

    // 3. Create AudioContext at target sample rate
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

    // 4. Load AudioWorklet
    const workletUrl = chrome.runtime.getURL('public/audio-worklet.js');
    await audioContext.audioWorklet.addModule(workletUrl);

    // 5. Open port to SW
    port = chrome.runtime.connect({ name: 'audio-stream' });

    // 6. Wire tab audio → worklet → silent sink (keeps process() firing)
    const silentSink = audioContext.createGain();
    silentSink.gain.value = 0;
    silentSink.connect(audioContext.destination);

    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const tabWorklet = new AudioWorkletNode(audioContext, 'copilot-audio-processor');
    tabWorklet.port.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        port.postMessage({ type: 'audio_chunk', data: ev.data, source: 'tab' }, [ev.data]);
      }
    };
    tabSource.connect(tabWorklet);
    tabWorklet.connect(silentSink); // Must connect to destination graph for process() to fire

    // 7. Wire mic → worklet → silent sink (if available)
    if (micStream) {
      const micSource = audioContext.createMediaStreamSource(micStream);
      const micWorklet = new AudioWorkletNode(audioContext, 'copilot-audio-processor');
      micWorklet.port.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          port.postMessage({ type: 'audio_chunk', data: ev.data, source: 'mic' }, [ev.data]);
        }
      };
      micSource.connect(micWorklet);
      micWorklet.connect(silentSink); // Silent — user won't hear their own mic echo
    }

    console.info('[Offscreen] Audio capture started (worklet, tab' + (micStream ? '+mic' : '') + ')');
  } catch (err) {
    console.error('[Offscreen] Capture failed:', err);
  }
}

function stopCapture() {
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  if (tabStream) { tabStream.getTracks().forEach(t => t.stop()); tabStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (port) { port.disconnect(); port = null; }
  console.info('[Offscreen] Audio capture stopped');
}

