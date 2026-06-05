// Consent page — stores user's audio permission and records server-side.

import { StorageKey, API_BASE_URL } from '../constants.js';

document.getElementById('allow-btn').addEventListener('click', async () => {
  await chrome.storage.local.set({ [StorageKey.AUDIO_CONSENT]: true });
  // Record consent server-side
  try {
    const got = await chrome.storage.local.get([StorageKey.AUTH_TOKEN, StorageKey.API_BASE_URL]);
    const base = got[StorageKey.API_BASE_URL] || API_BASE_URL;
    const token = got[StorageKey.AUTH_TOKEN];
    if (token) {
      await fetch(`${base}/api/v1/auth/consent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } catch { /* best-effort */ }
  window.close();
});

document.getElementById('deny-btn').addEventListener('click', () => {
  window.close();
});
