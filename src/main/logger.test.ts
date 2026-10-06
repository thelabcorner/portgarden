import { describe, expect, it } from 'vitest';
import { LOG_CAPACITY, redact } from './logger.js';

describe('redact', () => {
  it('strips a credential passed as a flag', () => {
    // A dev-server command line is a plausible place for a token to appear, and
    // this log is the first thing anyone reads when something goes wrong.
    expect(redact('node app.js --api-key=sk-abc123def456ghi789')).toContain('--api-key=***');
    expect(redact('node app.js --api-key=sk-abc123def456ghi789')).not.toContain('sk-abc123');
  });

  it('strips a credential passed as two arguments', () => {
    expect(redact('serve --token hunter2hunter2')).toBe('serve --token ***');
  });

  it('covers the flag spellings that matter', () => {
    for (const flag of ['--secret', '--password', '--passwd', '--pwd', '--auth', '--token', '--api_key']) {
      expect(redact(`cmd ${flag}=supersecretvalue`)).not.toContain('supersecretvalue');
    }
  });

  it('strips a recognised token prefix outright', () => {
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('***');
    expect(redact('sk-proj-abcdefghijklmnop')).toBe('***');
  });

  it('strips an authorization header value', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });

  it('leaves an ordinary command line intact', () => {
    const line = 'node C:\\work\\api\\node_modules\\vite\\bin\\vite.js --port 5173 --host';
    expect(redact(line)).toBe(line);
  });

  it('leaves a path that merely looks secret-free alone', () => {
    expect(redact('reveal C:\\work\\api')).toBe('reveal C:\\work\\api');
  });

  it('is safe on an empty string', () => {
    expect(redact('')).toBe('');
  });
});

describe('log capacity', () => {
  it('bounds the ring so a long session cannot grow without limit', () => {
    expect(LOG_CAPACITY).toBeLessThanOrEqual(1000);
    expect(LOG_CAPACITY).toBeGreaterThan(0);
  });
});