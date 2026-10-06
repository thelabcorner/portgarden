import { describe, expect, it } from 'vitest';
import { normalizeAddress, percentCpu, isPort, round1, inReservedRange } from './parse.js';

describe('normalizeAddress', () => {
  it('collapses every wildcard spelling to one comparable form', () => {
    // A dual-stack listener reports both of these, and they are one port with
    // two bindings - not two ports.
    expect(normalizeAddress('0.0.0.0')).toEqual({ address: 'any', family: 'IPv4', wildcard: true });
    expect(normalizeAddress('::')).toEqual({ address: 'any', family: 'IPv6', wildcard: true });
    expect(normalizeAddress('::ffff:0.0.0.0')).toEqual({ address: 'any', family: 'IPv6', wildcard: true });
    expect(normalizeAddress('0000:0000:0000:0000:0000:0000:0000:0000')).toEqual({ address: 'any', family: 'IPv6', wildcard: true });
  });

  it('recognises loopback in both families', () => {
    expect(normalizeAddress('127.0.0.1')).toEqual({ address: 'loopback', family: 'IPv4', wildcard: false });
    expect(normalizeAddress('::1')).toEqual({ address: 'loopback', family: 'IPv6', wildcard: false });
    expect(normalizeAddress('::ffff:127.0.0.1')).toEqual({ address: 'loopback', family: 'IPv6', wildcard: false });
  });

  it('drops a zone suffix, which never changes which interface a bind covers', () => {
    expect(normalizeAddress('fe80::1%12')).toEqual({ address: 'fe80::1', family: 'IPv6', wildcard: false });
  });

  it('keeps a specific host address intact', () => {
    expect(normalizeAddress('192.168.1.20')).toEqual({ address: '192.168.1.20', family: 'IPv4', wildcard: false });
  });
});

describe('percentCpu', () => {
  it('converts a tick delta into whole-machine percentage across cores', () => {
    // 10 seconds of wall clock, 1 second of CPU time, across 4 cores: 1/(10*4) = 2.5%.
    expect(percentCpu(0, 0, 1e7, 10_000, 4)).toBe(2.5);
  });

  it('returns null when the counter went backwards', () => {
    // A recycled pid produces exactly this shape, and rendering it as a number
    // would put a nonsense spike in the table.
    expect(percentCpu(5e7, 0, 1e7, 10_000, 4)).toBeNull();
  });

  it('returns null without a positive interval or core count', () => {
    expect(percentCpu(0, 10_000, 1e7, 10_000, 4)).toBeNull();
    expect(percentCpu(0, 0, 1e7, 10_000, 0)).toBeNull();
  });

  it('reports zero rather than a blank for an idle process', () => {
    expect(percentCpu(1e7, 0, 1e7, 10_000, 8)).toBe(0);
  });
});

describe('isPort', () => {
  it('accepts the valid range and rejects everything else', () => {
    expect(isPort(1)).toBe(true);
    expect(isPort(65535)).toBe(true);
    expect(isPort(0)).toBe(false);
    expect(isPort(65536)).toBe(false);
    expect(isPort(3000.5)).toBe(false);
  });
});

describe('round1', () => {
  it('rounds to one decimal place', () => {
    expect(round1(2.456)).toBe(2.5);
    expect(round1(2.44)).toBe(2.4);
  });
});

describe('inReservedRange', () => {
  const ranges = [
    { start: 50000, end: 50059, administered: true },
    { start: 24233, end: 24332, administered: false }
  ];

  it('includes both endpoints of a range', () => {
    expect(inReservedRange(50000, ranges)).toBe(true);
    expect(inReservedRange(50059, ranges)).toBe(true);
  });

  it('excludes ports outside every range', () => {
    expect(inReservedRange(49999, ranges)).toBe(false);
    expect(inReservedRange(50060, ranges)).toBe(false);
  });

  it('reports a free port as free when nothing is reserved', () => {
    expect(inReservedRange(3000, ranges)).toBe(false);
  });
});