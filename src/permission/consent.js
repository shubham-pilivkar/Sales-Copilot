// Consent page — asks the service worker to record consent and resume pending start.

import { MessageType } from '../constants.js';

const allowBtn = document.getElementById('allow-btn');
const denyBtn = document.getElementById('deny-btn');

function setError(message) {
  let el = document.getElementById('consent-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'consent-error';
    el.style.cssText = 'margin-top:12px;color:#dc2626;font-size:12px;line-height:1.4;';
    allowBtn.insertAdjacentElement('beforebegin', el);
  }
  el.textContent = message;
}

allowBtn.addEventListener('click', async () => {
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
});

denyBtn.addEventListener('click', () => {
  window.close();
});
