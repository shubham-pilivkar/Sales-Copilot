// Messaging wrapper — ported from MeetMinutes chrome_extension/src/lib/messaging.js
// Normalizes chrome.runtime message passing with typed handlers.

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const CHANNEL_CLOSED = 'message channel closed';

/**
 * Send a message to the service worker. Never throws.
 * @param {{ type: string } & Record<string, unknown>} message
 * @returns {Promise<{ ok: true, data?: unknown } | { ok: false, error: string }>}
 */
export async function sendMessage(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (response === undefined) return { ok: true };
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(NO_RECEIVER)) return { ok: false, error: 'no_receiver' };
    if (msg.includes(CHANNEL_CLOSED)) return { ok: false, error: 'channel_closed' };
    return { ok: false, error: msg };
  }
}

/**
 * Register typed message handlers.
 * @param {Record<string, (msg: any, sender?: any) => unknown | Promise<unknown>>} handlerMap
 * @returns {() => void} unsubscribe function
 */
export function onMessage(handlerMap) {
  const listener = (message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    if (sender && sender.id && sender.id !== chrome.runtime.id) return false;

    const handler = handlerMap[message.type];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(message, sender))
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async response
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/**
 * Send a message to a specific tab's content script.
 * @param {number} tabId
 * @param {{ type: string } & Record<string, unknown>} message
 */
export async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return { ok: false, error: 'tab_unreachable' };
  }
}
