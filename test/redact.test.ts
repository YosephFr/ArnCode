import { describe, expect, it } from 'vitest';
import {
  redact,
  redactDeep,
  registerEnvironmentSecrets,
  registerSecret,
  StreamingRedactor,
} from '../src/redact.js';

const apiToken = ['sk', 'ant', 'api03', 'syntheticForUnitTests123'].join('-');
const oauthToken = ['sk', 'ant', 'oat01', 'syntheticForUnitTests456'].join('-');

describe('secret redaction', () => {
  it('redacts API/OAuth-shaped tokens and explicitly registered credentials', () => {
    registerSecret('opaque-test-token-987654');
    registerEnvironmentSecrets({ SERVICE_PASSWORD: 'test-password-value', PATH: '/usr/bin' });
    const result = redact(
      `${apiToken} ${oauthToken} opaque-test-token-987654 test-password-value /usr/bin`,
    );
    expect(result).toBe('[redacted] [redacted] [redacted] [redacted] /usr/bin');
  });

  it('masks authorization header values', () => {
    expect(redact('Authorization: Bearer unregistered-sensitive-value')).toBe(
      'Authorization: Bearer [redacted]',
    );
    // Inside JSON, masking each string keeps quotes and escapes intact.
    expect(redactDeep({ command: 'curl -H "Authorization: Bearer $TOKEN" x', n: [1] })).toEqual({
      command: 'curl -H "Authorization: Bearer [redacted]" x',
      n: [1],
    });
  });

  it('does not leak tokens at any streaming boundary', () => {
    for (const token of [apiToken, oauthToken, 'streaming-opaque-test-token']) {
      if (token.startsWith('streaming')) registerSecret(token);
      const value = `Before ${token} after.\n`;
      for (let boundary = 1; boundary < value.length; boundary++) {
        const stream = new StreamingRedactor();
        const output =
          stream.write(value.slice(0, boundary)) +
          stream.write(value.slice(boundary)) +
          stream.flush();
        expect(output).toBe('Before [redacted] after.\n');
      }
      const stream = new StreamingRedactor();
      expect([...value].map((character) => stream.write(character)).join('') + stream.flush()).toBe(
        'Before [redacted] after.\n',
      );
    }
  });

  it('releases ordinary text promptly and masks an unterminated token', () => {
    const stream = new StreamingRedactor();
    expect(stream.write('Hello there!')).toBe('Hello there!');
    expect(stream.write(apiToken)).toBe('[redacted]');
    expect(stream.flush()).toBe('');
    expect(stream.write('Done.')).toBe('Done.');
  });

  it('keeps a longer known secret hidden when a shorter secret shares its prefix', () => {
    registerSecret('overlap-test');
    registerSecret('overlap-test-credential');
    const stream = new StreamingRedactor();
    expect(stream.write('overlap-test')).toBe('');
    expect(stream.write('-credential!') + stream.flush()).toBe('[redacted]!');
  });
});
