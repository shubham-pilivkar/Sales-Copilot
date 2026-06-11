import { describe, it, expect } from 'vitest';
import { getErrorMessage, renderError } from './error-messages.js';

describe('error-messages', () => {
  it('returns the mapped message for a known code', () => {
    expect(getErrorMessage('auth_expired')).toMatch(/session has expired/i);
  });

  it('falls back to the unknown message for an unknown code', () => {
    expect(getErrorMessage('definitely-not-a-code')).toBe(getErrorMessage('unknown'));
  });

  it('renderError prefers code, then message, then unknown', () => {
    expect(renderError({ code: 'no_consent' })).toMatch(/permission/i);
    expect(renderError({ message: 'custom failure' })).toBe('custom failure');
    expect(renderError(null)).toBe(getErrorMessage('unknown'));
    expect(renderError({})).toBe(getErrorMessage('unknown'));
  });

  // B39: producers append a status suffix / emit numeric WS codes that didn't
  // match the table keys, so users saw raw codes instead of friendly text.
  it('strips a trailing _<status> suffix to find the mapped message', () => {
    expect(getErrorMessage('login_failed_401')).toBe(getErrorMessage('login_failed'));
    expect(getErrorMessage('copilot_start_failed_500')).toBe(getErrorMessage('copilot_start_failed'));
  });

  it('maps WS aliases (max_reconnect, numeric 4001) to friendly text', () => {
    expect(getErrorMessage('max_reconnect')).toBe(getErrorMessage('ws_max_reconnect'));
    expect(renderError({ code: 4001 })).toBe(getErrorMessage('ws_auth_failed'));
  });
});
