# Contributing to Port Garden

Thanks for looking. This is a small, focused utility and the bar for changes is
"does this make the answer to *what is holding this port* faster or more
trustworthy".

## Getting set up

```sh
npm install
npm run dev
```

Windows only. `npm run verify` runs typecheck, the test suite and a production
build, and is what CI runs.

There is no build step for the probes: `resources/probe/*.ps1` are read from disk
at runtime, so editing one takes effect on the next scan.

## Before you open a pull request

```sh
npm run verify     # typecheck + vitest + build
```

If you touched a probe script or a stylesheet rule, also run:

```sh
npm run bench      # the measurements that chose the current design
```

Every non-obvious cost in `resources/probe/` and `src/renderer/style.css` carries
a comment naming the measurement that produced it. If your change contradicts one
of those numbers, the number wins until you have a new one.

## Ground rules

`AGENTS.md` is the contributor map and holds the invariants. The ones most likely
to bite:

1. **Never make absence look like a bug.** A withheld command line, an unknown
   project, a vanished process, an unreadable owner and a port that speaks no HTTP
   all say so in the UI. A blank cell is worse than one that explains itself.
2. **A pid is not identity.** Windows recycles pids, so every destructive action
   re-verifies `(pid, creation time, image path)` in the main process before
   signalling. Do not add a path that skips this.
3. **The renderer is not trusted.** It may say what the user clicked. Anything
   destructive re-derives its own authority in the main process.
4. **The table is never rebuilt.** Rows are created once and only their text
   changes. Replacing the scroll container resets `scrollTop`.
5. **Measure, then optimise.** Several plausible-sounding designs here were wrong
   by seconds. The comments record which.
6. **No dead code.** No placeholder exports, no settings nothing reads, no config
   nothing loads. A deferred feature is absent, not stubbed.

## Tests

Suites sit beside the code they cover, named `<module>.test.ts`. They target the
parts that have to be right rather than the parts that are easy:

- JSONL and packed-record parsing
- `netsh` range parsing against English **and** zh-CN output
- bind-address normalization, including the dual-stack cases
- CPU deltas, including the recycled-pid case
- the project-root walk, `-p` gating, role classification
- cycle-safe ancestry and descendant walks
- identity matching, settings validation, log redaction

A bug fix should come with a test that fails without it.

## Adding a platform

Please do not. This is a Windows utility; the probes, the kill semantics and the
chrome are all Windows-specific. A cross-platform Port Garden would be a new
project rather than a branch in this one.

## Reporting a bug

Include what you expected, what happened, and — for anything involving a port or
a process — the output of:

```powershell
Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'State = 2' |
  Where-Object LocalPort -eq 3000
```

Port Garden writes a bounded, redacted log. **Check it before pasting it:** it
redacts credential-shaped arguments, but command lines are still command lines.
It lives at `%APPDATA%\portgarden\logs\portgarden.log`.

## Licensing

Contributions are accepted under the MIT licence, matching [LICENSE](LICENSE).
