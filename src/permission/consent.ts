// Consent page — acquires the REAL Chrome microphone permission, then asks the
// service worker to record consent and resume any pending start.
//
// This page is the only place the mic permission can be granted: offscreen
// documents cannot show a permission prompt (getUserMedia there fails with
// NotAllowedError unless the extension origin was already granted). So the
// "Allow" click here must trigger getUserMedia in THIS visible window first —
// otherwise the session silently runs in tab-only mode (no user speech, few
// nudges) for every new user.

import { MessageType } from '../constants.js';

const allowBtn = document.getElementById('allow-btn') as HTMLButtonElement;
const denyBtn = document.getElementById('deny-btn') as HTMLButtonElement;

function setError(message: string, html = false): void {
  let el = document.getElementById('consent-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'consent-error';
    el.style.cssText = 'margin-top:12px;color:#dc2626;font-size:12px;line-height:1.5;';
    allowBtn.insertAdjacentElement('beforebegin', el);
  }
  if (html) el.innerHTML = message; else el.textContent = message;
}

function clearError(): void {
  document.getElementById('consent-error')?.remove();
}

/** Trigger Chrome's actual mic permission prompt from this visible page. */
async function acquireMicPermission(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the grant — release the device immediately.
    stream.getTracks().forEach((t) => t.stop());
    return { ok: true };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return { ok: false, reason: name };
  }
}

allowBtn.addEventListener('click', async () => {
  allowBtn.disabled = true;
  denyBtn.disabled = true;
  clearError();
  allowBtn.textContent = 'Requesting microphone…';

  // Step 1: the real Chrome permission. Without this, the offscreen capture
  // silently degrades to tab-only mode on every fresh install.
  const mic = await acquireMicPermission();
  if (!mic.ok) {
    allowBtn.disabled = false;
    denyBtn.disabled = false;
    allowBtn.textContent = 'Retry — Allow Audio Capture';
    if (mic.reason === 'NotAllowedError') {
      setError(
        'Microphone access was blocked. To fix: click the lock/tune icon in this '
        + 'window’s address bar → Site settings → Microphone → Allow, '
        + 'then click Retry. (Or remove the block under chrome://settings/content/microphone.)',
      );
    } else if (mic.reason === 'NotFoundError') {
      setError('No microphone was found. Connect a microphone and click Retry.');
    } else {
      setError(`Could not access the microphone (${mic.reason || 'unknown error'}). Click Retry.`);
    }
    return;
  }

  // Step 2: record consent server-side and resume the pending session start.
  allowBtn.textContent = 'Saving…';
  try {
    const res = await chrome.runtime.sendMessage({ type: MessageType.AUDIO_CONSENT_GRANTED });
    if (!res?.ok) {
      throw new Error(res?.error || 'consent_failed');
    }
    allowBtn.textContent = res.data?.resumed ? 'Starting…' : 'Saved';
    window.close();
  } catch (err) {
    allowBtn.disabled = false;
    denyBtn.disabled = false;
    allowBtn.textContent = 'Allow Audio Capture';
    const message = err instanceof Error ? err.message : String(err);
    setError(`Could not record consent or resume the assistant. ${message}`);
  }
});

denyBtn.addEventListener('click', () => {
  window.close();
});
