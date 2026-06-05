// Structured error messages — user-friendly text for each error code.
// Ported from chrome_extension/src/lib/error-messages.js

const ERROR_MESSAGES = {
  // Auth
  auth_expired: 'Your session has expired. Please log in again.',
  login_failed: 'Invalid email or password.',
  register_failed: 'Registration failed. Please try again.',

  // Copilot lifecycle
  copilot_start_failed: 'Failed to start the sales assistant. Please try again.',
  no_consent: 'Audio permission required. Please grant access first.',
  not_in_meeting: 'Open a Google Meet call first.',

  // Audio
  mic_permission_denied: 'Microphone access denied. Check your browser permissions.',
  tab_capture_failed: 'Failed to capture meeting audio. Try refreshing the page.',
  monitor_blocked: 'Meeting audio is muted due to browser autoplay policy. Click the page to restore.',

  // WebSocket
  ws_connect_failed: 'Connection to server failed. Retrying...',
  ws_max_reconnect: 'Connection lost. Please restart the assistant.',
  ws_auth_failed: 'Server authentication failed. Please log in again.',

  // STT
  stt_failed: 'Transcription temporarily unavailable. Nudges limited to keyword detection.',
  stt_no_api_key: 'Transcription service not configured.',

  // General
  unknown: 'Something went wrong. Please try again.',
};

/**
 * Get a user-friendly error message for a code.
 * @param {string} code
 * @returns {string}
 */
export function getErrorMessage(code) {
  return ERROR_MESSAGES[code] || ERROR_MESSAGES.unknown;
}

/**
 * Render an error message string from a backend error event.
 * @param {{ code?: string, message?: string }} error
 * @returns {string}
 */
export function renderError(error) {
  if (!error) return ERROR_MESSAGES.unknown;
  return ERROR_MESSAGES[error.code] || error.message || ERROR_MESSAGES.unknown;
}
