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
});
