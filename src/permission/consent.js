// Consent page — stores user's audio permission and records server-side.

import { MessageType, StorageKey, API_BASE_URL } from '../constants.js';

document.getElementById('allow-btn').addEventListener('click', async () => {
  const allowBtn = document.getElementById('allow-btn');
  allowBtn.disabled = true;
  allowBtn.textContent = 'Saving...';

  // Record consent server-side
  let recorded = false;
  try {
    const got = await chrome.storage.local.get([StorageKey.AUTH_TOKEN, StorageKey.API_BASE_URL]);
    const base = got[StorageKey.API_BASE_URL] || API_BASE_URL;
    const token = got[StorageKey.AUTH_TOKEN];
    if (token) {
      const res = await fetch(`${base}/api/v1/auth/consent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      recorded = res.ok;
    }
  } catch { /* handled below */ }

  if (!recorded) {
    allowBtn.disabled = false;
    allowBtn.textContent = 'Allow Audio Capture';
    alert('Could not record consent with the server. Please check your login/backend connection and try again.');
    return;
  }

  await chrome.storage.local.set({ [StorageKey.AUDIO_CONSENT]: true });
  await chrome.runtime.sendMessage({ type: MessageType.AUDIO_CONSENT_GRANTED }).catch(() => {});
  window.close();
});

document.getElementById('deny-btn').addEventListener('click', () => {
  window.close();
});
