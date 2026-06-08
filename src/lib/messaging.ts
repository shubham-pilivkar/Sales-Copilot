// Messaging wrapper — normalizes chrome.runtime message passing with typed,
// discriminated-union handlers.

import type {
  ExtMessage,
  ExtMessageType,
  MessageByType,
  MessageResponse,
} from '../types/messages.js';

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const CHANNEL_CLOSED = 'message channel closed';

/** Send a message to the service worker (or another context). Never throws. */
export async function sendMessage<T = unknown>(message: ExtMessage): Promise<MessageResponse<T>> {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (response === undefined) return { ok: true };
    return response as MessageResponse<T>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(NO_RECEIVER)) return { ok: false, error: 'no_receiver' };
    if (msg.includes(CHANNEL_CLOSED)) return { ok: false, error: 'channel_closed' };
    return { ok: false, error: msg };
  }
}

/** A handler for one message variant, narrowed to that variant's payload. */
export type MessageHandler<K extends ExtMessageType> = (
  msg: MessageByType<K>,
  sender?: chrome.runtime.MessageSender,
) => unknown | Promise<unknown>;

/** Map of message type -> handler, each receiving the correctly narrowed message. */
export type MessageHandlerMap = {
  [K in ExtMessageType]?: MessageHandler<K>;
};

/** Register typed message handlers. Returns an unsubscribe function. */
export function onMessage(handlerMap: MessageHandlerMap): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageResponse) => void,
  ): boolean => {
    if (!message || typeof (message as { type?: unknown }).type !== 'string') return false;
    if (sender && sender.id && sender.id !== chrome.runtime.id) return false;

    const msg = message as ExtMessage;
    const handlers = handlerMap as Record<
      string,
      ((m: ExtMessage, s?: chrome.runtime.MessageSender) => unknown | Promise<unknown>) | undefined
    >;
    const handler = handlers[msg.type];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(msg, sender))
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true; // async response
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/** Send a message to a specific tab's content script. Never throws. */
export async function sendToTab(tabId: number, message: ExtMessage): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return { ok: false, error: 'tab_unreachable' };
  }
}
