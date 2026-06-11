// Consent page — asks the service worker to record consent and resume pending start.

import { MessageType } from '../constants.js';

const allowBtn = document.getElementById('allow-btn') as HTMLButtonElement;
const denyBtn = document.getElementById('deny-btn') as HTMLButtonElement;

function setError(message: string): void {
  let el = document.getElementById('consent-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'consent-error';
    el.style.cssText = 'margin-top:12px;color:#dc2626;font-size:12px;line-height:1.4;';
    allowBtn.insertAdjacentElement('beforebegin', el);
  }
  el.textContent = message;
}

/**
 * Trigger the browser's microphone permission prompt from this (visible)
 * extension page. The offscreen document that actually captures audio cannot
 * show a permission prompt, so the grant must happen here — it persists for the
 * extension origin and the offscreen document (same origin) can then use the
 * mic. Tracks are released immediately; the offscreen reopens its own.
 */
async function requestMicPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (err) {
    console.warn('[Consent] Microphone permission not granted:', err);
    return false;
  }
}

// Records consent in the service worker and resumes the pending session start.
async function recordConsentAndStart(): Promise<void> {
  allowBtn.disabled = true;
  denyBtn.disabled = true;
  allowBtn.textContent = 'Saving...';
  try {
    const res = await chrome.runtime.sendMessage({ type: MessageType.AUDIO_CONSENT_GRANTED });
    if (!res?.ok) {
      throw new Error(res?.error || 'consent_failed');
    }
    allowBtn.textContent = res.data?.resumed ? 'Starting...' : 'Saved';
    window.close();
  } catch (err) {
    allowBtn.disabled = false;
    denyBtn.disabled = false;
    allowBtn.textContent = 'Allow Audio Capture';
    const message = err instanceof Error ? err.message : String(err);
    setError(`Could not record consent or resume the assistant. ${message}`);
  }
}

let micWarned = false;

allowBtn.addEventListener('click', async () => {
  // Second click after a mic-denial warning: user chose to continue tab-only.
  if (micWarned) {
    await recordConsentAndStart();
    return;
  }

  allowBtn.disabled = true;
  denyBtn.disabled = true;
  allowBtn.textContent = 'Requesting mic...';

  // Trigger the native mic prompt here; the offscreen document can't.
  const micGranted = await requestMicPermission();
  if (!micGranted) {
    // Denial is non-fatal — pause so the user can read this, then let them
    // continue in tab-only mode (or grant mic via site settings and retry).
    micWarned = true;
    setError('Microphone access was blocked, so only participant (tab) audio will be captured. To include your voice, allow the microphone via the address-bar site settings, then reopen this. Otherwise, click again to continue without your mic.');
    allowBtn.disabled = false;
    denyBtn.disabled = false;
    allowBtn.textContent = 'Continue without microphone';
    return;
  }

  await recordConsentAndStart();
});

denyBtn.addEventListener('click', () => {
  window.close();
});
