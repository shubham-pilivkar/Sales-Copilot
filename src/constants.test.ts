import { describe, it, expect } from 'vitest';
import { MessageType, WSMessageType, NudgeType, CopilotState } from './constants.js';

describe('constants wire values', () => {
  it('internal MessageType keys map to themselves', () => {
    expect(MessageType.START_COPILOT).toBe('START_COPILOT');
    expect(MessageType.COPILOT_NOTICE).toBe('COPILOT_NOTICE');
  });

  it('WSMessageType uses the backend snake_case wire strings', () => {
    expect(WSMessageType.SESSION_START).toBe('session_start');
    expect(WSMessageType.NUDGE).toBe('nudge');
    expect(WSMessageType.SESSION_READY).toBe('session_ready');
  });

  it('NudgeType values match the backend contract', () => {
    expect(NudgeType.OBJECTION_HANDLING).toBe('objection_handling');
    expect(NudgeType.TALK_RATIO_WARNING).toBe('talk_ratio_warning');
  });

  it('enums are frozen at runtime', () => {
    expect(Object.isFrozen(CopilotState)).toBe(true);
    expect(Object.isFrozen(WSMessageType)).toBe(true);
  });
});
