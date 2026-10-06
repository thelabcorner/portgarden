import { describe, expect, it } from 'vitest';
import {
  isElevatedFromWhoami,
  parseExcludedRanges,
  parseProbeLines,
  type ProbeRecord
} from './parse.js';

/**
 * Real `netsh` output, captured verbatim, with its heading row intact. These are
 * the fixtures that decide whether Port Garden works at all on a Windows install
 * that is not English - the reason the parsing is positional.
 */
const NETSH_ENGLISH = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    ----------
      8085        8085
     24233       24332
     50000       50059     *
     50060       50159

* - Administered port exclusions.
`;

/**
 * A zh-CN install. The headings and the footer note are translated; the port
 * numbers are not, and the numeric columns keep the same shape. A parser that
 * looked for "Start Port" would return nothing here, and the app would show no
 * reserved ranges at all.
 */
const NETSH_CHINESE = `
协议 tcp 端口排除范围

起始端口    结束端口
----------    ----------
      8085        8085
     24233       24332
     50000       50059     *
     50060       50159

* - 管理端口排除。
`;

describe('parseExcludedRanges', () => {
  it('reads the ranges regardless of the display language', () => {
    const english = parseExcludedRanges(NETSH_ENGLISH);
    const chinese = parseExcludedRanges(NETSH_CHINESE);
    expect(chinese).toEqual(english);
    expect(english).toEqual([
      { start: 8085, end: 8085, administered: false },
      { start: 24233, end: 24332, administered: false },
      { start: 50000, end: 50059, administered: true },
      { start: 50060, end: 50159, administered: false }
    ]);
  });

  it('never reads the separator rule or the dashed heading as a range', () => {
    for (const range of parseExcludedRanges(NETSH_ENGLISH)) {
      expect(range.start).toBeGreaterThan(0);
      expect(range.end).toBeGreaterThanOrEqual(range.start);
    }
  });

  it('rejects an inverted range rather than normalizing it', () => {
    expect(parseExcludedRanges('     50000       49999')).toEqual([]);
  });

  it('rejects a port outside the valid range', () => {
    expect(parseExcludedRanges('     70000       70010')).toEqual([]);
    expect(parseExcludedRanges('         0          10')).toEqual([]);
  });

  it('returns nothing for output with no ranges at all', () => {
    expect(parseExcludedRanges('')).toEqual([]);
    expect(parseExcludedRanges('\n\n')).toEqual([]);
  });
});

describe('isElevatedFromWhoami', () => {
  it('detects the high integrity SID', () => {
    const text = `
Mandatory Label\High Mandatory Level                Label            S-1-16-12288      S-1-16-12288
`;
    expect(isElevatedFromWhoami(text)).toBe(true);
  });

  it('detects the medium integrity SID as not elevated', () => {
    const text = `
Mandatory Label\Medium Mandatory Level             Label            S-1-16-8192       S-1-16-8192
`;
    expect(isElevatedFromWhoami(text)).toBe(false);
  });

  it('does not depend on the localized label', () => {
    const chinese = `
强制标签\高强制级别    标签            S-1-16-12288      S-1-16-12288
`;
    expect(isElevatedFromWhoami(chinese)).toBe(true);
  });

  it('is false for empty output', () => {
    expect(isElevatedFromWhoami('')).toBe(false);
  });
});

describe('parseProbeLines', () => {
  it('reads one record per line', () => {
    const text = [
      '{"k":"tb","v":"3000\\u001f8123\\u001f0.0.0.0"}',
      '{"k":"m","listeners":1,"procs":1,"cores":8}'
    ].join('\n');
    const records = parseProbeLines(text);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ k: 'tb' });
    expect(records[1]).toMatchObject({ k: 'm', cores: 8 });
  });

  it('tolerates blank lines and surrounding whitespace', () => {
    const text = '\n  {"k":"gg","v":"99,100"}  \n\n\n{"k":"gg","v":"101"}\n';
    expect(parseProbeLines(text)).toHaveLength(2);
  });

  it('skips a line that is not valid JSON rather than failing the whole scan', () => {
    // A stray warning on stdout must not cost the user their table.
    const text = 'WARNING: something\n{"k":"m","listeners":3,"procs":3,"cores":4}\n';
    const records: ProbeRecord[] = parseProbeLines(text);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ k: 'm', listeners: 3 });
  });

  it('skips a record with an unknown discriminator', () => {
    expect(parseProbeLines('{"k":"unknown-thing","x":1}')).toEqual([]);
    expect(parseProbeLines('{"k":123}')).toEqual([]);
  });

  it('treats a missing payload as empty rather than undefined', () => {
    expect(parseProbeLines('{"k":"tb"}')[0]).toEqual({ k: 'tb', v: '' });
  });

  it('carries a probe error through instead of dropping it', () => {
    const records = parseProbeLines('{"k":"e","stage":"listeners","message":"Access denied"}');
    expect(records[0]).toEqual({ k: 'e', stage: 'listeners', message: 'Access denied' });
  });

  it('reads the identity record emitted by the pre-kill probe', () => {
    const records = parseProbeLines('{"k":"i","pid":8123,"name":"node","own":"dev","st":"2026-01-01T00:00:00Z","image":null}');
    expect(records[0]).toMatchObject({ k: 'i', pid: 8123, name: 'node', own: 'dev', image: null });
  });
});