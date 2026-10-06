import { describe, expect, it } from 'vitest';
import {
  FIELD_SEPARATOR,
  RECORD_SEPARATOR,
  parseGoneList,
  parsePackedBindings,
  parsePackedListenerDetails,
  parsePackedProcesses,
  parseParentMap
} from './parse.js';

/**
 * The packed format: 0x1F between fields, 0x1E between records.
 *
 * These parsers exist because serialising one JSON object per process cost about
 * 2.4 seconds on a machine with 1180 of them. Packing them costs 24ms. The tests
 * below are the contract that makes that safe: the separators must never appear
 * in the values they delimit, and a malformed field must not invent a value.
 */

const F = FIELD_SEPARATOR;
const R = RECORD_SEPARATOR;

describe('parsePackedProcesses', () => {
  it('reads every field of a process row', () => {
    const packed = ['8123', 'node', 'dev', 'C:\\nodejs\\node.exe', '2026-01-01T00:00:00.0000000Z', '52428800', '123456', '1'].join(F);
    expect(parsePackedProcesses(packed)).toEqual([
      {
        pid: 8123,
        name: 'node',
        owner: 'dev',
        image: 'C:\\nodejs\\node.exe',
        createdAt: '2026-01-01T00:00:00.0000000Z',
        workingSetBytes: 52428800,
        cpuTicks: 123456,
        sessionId: 1
      }
    ]);
  });

  it('lowercases the image name so protect-list matching is stable', () => {
    expect(parsePackedProcesses(['4', 'System', '', '', '', '0', '0', '0'].join(F))[0]?.name).toBe('system');
  });

  it('treats an empty field as withheld rather than as an empty value', () => {
    // `Path` is only read for listener pids, so a null here means "this process
    // is not a listener", not "the OS refused". A null here still means refused.
    const [process] = parsePackedProcesses(['1636', 'lsass', '', '', '', '1024', '0', '0'].join(F));
    expect(process?.owner).toBeNull();
    expect(process?.image).toBeNull();
    expect(process?.createdAt).toBeNull();
  });

  it('reads several records', () => {
    const packed = ['1', 'a', '', '', '', '1', '1', '1'].join(F) + R + ['2', 'b', '', '', '', '2', '2', '2'].join(F);
    expect(parsePackedProcesses(packed).map((entry) => entry.pid)).toEqual([1, 2]);
  });

  it('returns nothing for an empty payload', () => {
    expect(parsePackedProcesses('')).toEqual([]);
  });

  it('survives a truncated row rather than throwing', () => {
    // A probe that died mid-line must not cost the user the whole table.
    const [process] = parsePackedProcesses(['9', 'thing'].join(F));
    expect(process?.pid).toBe(9);
    expect(process?.workingSetBytes).toBe(0);
  });

  it('coerces a non-numeric field to zero rather than NaN', () => {
    expect(parsePackedProcesses(['9', 'x', '', '', '', 'not-a-number', '', ''].join(F))[0]?.workingSetBytes).toBe(0);
  });

  it('keeps a path containing spaces and unicode intact', () => {
    const path = 'C:\\Users\\josé\\pro\\my app\\node.exe';
    expect(parsePackedProcesses(['1', 'node', 'dev', path, '', '1', '1', '1'].join(F))[0]?.image).toBe(path);
  });
});

describe('parsePackedBindings', () => {
  it('reads port, pid and bind address', () => {
    expect(parsePackedBindings(['5180', '102180', '127.0.0.1'].join(F))).toEqual([{ port: 5180, pid: 102180, address: '127.0.0.1' }]);
  });

  it('reads an IPv6 wildcard bind, whose colons must not split the record', () => {
    // `::` contains the field separator's cousin but not the separator itself,
    // which is exactly why 0x1F was chosen over a printable delimiter.
    expect(parsePackedBindings(['443', '4', '::'].join(F))).toEqual([{ port: 443, pid: 4, address: '::' }]);
  });

  it('reads a scoped IPv6 address', () => {
    expect(parsePackedBindings(['5000', '7', 'fe80::1%12'].join(F))[0]?.address).toBe('fe80::1%12');
  });

  it('reads several sockets', () => {
    const packed = ['3000', '1', '0.0.0.0'].join(F) + R + ['3000', '2', '::'].join(F);
    expect(parsePackedBindings(packed)).toHaveLength(2);
  });

  it('returns nothing for an empty payload', () => {
    expect(parsePackedBindings('')).toEqual([]);
  });
});

describe('parseParentMap', () => {
  it('reads pid:ppid pairs', () => {
    const parents = parseParentMap('102180:75244,75244:1234,1234:0');
    expect(parents.get(102180)).toBe(75244);
    expect(parents.get(75244)).toBe(1234);
  });

  it('maps a parent of 0 to null', () => {
    // pid 0 is not a process. Treating it as an ancestor would put a meaningless
    // entry at the top of every parent chain.
    expect(parseParentMap('4:0').get(4)).toBeNull();
  });

  it('skips a pair with no colon rather than inventing an entry', () => {
    // Dropping the process from the parent map entirely would be worse than
    // recording an honest null, so only a syntactically hopeless pair is skipped.
    const parents = parseParentMap('100:50,garbage,400:200');
    expect(parents.size).toBe(2);
    expect(parents.get(100)).toBe(50);
    expect(parents.has('garbage' as unknown as number)).toBe(false);
    expect(parents.get(400)).toBe(200);
  });

  it('treats an empty parent field as unknown, not as absent', () => {
    // `300:` is a process whose parent could not be read. Recording it as "no
    // parent" keeps it in the tree; skipping it would erase it.
    const parents = parseParentMap('300:');
    expect(parents.size).toBe(1);
    expect(parents.get(300)).toBeNull();
  });

  it('returns an empty map for an empty payload', () => {
    expect(parseParentMap('').size).toBe(0);
  });
});

describe('parsePackedListenerDetails', () => {
  it('reads a full row', () => {
    const packed = ['102180', 'node vite.js --port 5180', 'C:\\nodejs\\node.exe', '2026-09-30T02:32:50.2111370Z'].join(F);
    expect(parsePackedListenerDetails(packed)).toEqual([
      {
        pid: 102180,
        commandLine: 'node vite.js --port 5180',
        image: 'C:\\nodejs\\node.exe',
        createdAt: '2026-09-30T02:32:50.2111370Z'
      }
    ]);
  });

  it('reads a protected process as all-null rather than dropping the row', () => {
    // System, wininit and services.exe withhold a command line even from an
    // administrator. The row must survive with honest nulls.
    const [entry] = parsePackedListenerDetails(['4', '', '', ''].join(F));
    expect(entry).toEqual({ pid: 4, commandLine: null, image: null, createdAt: null });
  });

  it('keeps a command line containing quotes and flags intact', () => {
    const argv = '"C:\\Program Files\\nodejs\\node.exe" vite --open --host 127.0.0.1 --port 5180';
    const [entry] = parsePackedListenerDetails(['102180', argv, '', ''].join(F));
    expect(entry?.commandLine).toBe(argv);
  });
});

describe('parseGoneList', () => {
  it('reads a comma separated pid list', () => {
    expect(parseGoneList('100,200,300')).toEqual([100, 200, 300]);
  });

  it('returns nothing for an empty payload', () => {
    expect(parseGoneList('')).toEqual([]);
  });

  it('drops entries that are not positive integers', () => {
    expect(parseGoneList('100,x,0,-5,200')).toEqual([100, 200]);
  });
});