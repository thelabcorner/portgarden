# Port Garden architecture and contributor map

Read this before changing the repository.

## Product boundary

Port Garden is a Windows desktop utility for inspecting TCP listening ports,
their owning processes, and what those processes are serving. It is **not** a
process explorer, not a network scanner, and not a system optimizer.

**Windows-only.** No macOS or Linux code paths exist and none should be added
without an explicit product decision. The UI follows the WebSeal design system;
the platform is Windows. Do not introduce vibrancy, transparency or blur.

**Design language:** an in-house shadcn New York / zinc system, dense by default:
small precise type, a weight ladder rather than a size ladder, hairline structure,
tinted borderless chips, panels with no shadow, and monospace reserved for real
code blocks. Tokens, the type scale, control heights, the radius scale and the
component grammar are all in `src/renderer/style.css`, which is the source of
truth for contributors. One deliberate deviation: the system is light-only
upstream and this app also ships dark, because the product brief asked for it.

## Engineering rules

1. **One source of truth.** One validator for settings, one elevation reading,
   one port map, one HTTP probe per process. Two answers to one question is two
   answers waiting to disagree.
2. **Absence is reported, never implied.** A withheld command line, an unknown
   project, a vanished process, an unreadable owner, a port that speaks no HTTP —
   each says so. A blank cell that looks like a bug is worse than one that
   explains itself.
3. **Never trust the renderer's idea of authority.** The renderer may say what the
   user clicked. Anything destructive re-derives its own permission in the main
   process.
4. **A pid is not identity.** See `identity.ts`. Re-verify before signalling.
5. **Measure before optimising, and record the number.** Every non-obvious cost in
   the probe scripts and the CSS is annotated with the measurement that produced
   it. Several plausible-sounding designs were wrong by seconds.
6. **Do not touch unrelated dirty work.** Never `reset`, `clean` or broad-format.
7. **Zero dead code.** No placeholder exports, no unused settings, no config
   nothing reads. A deferred feature is absent, not stubbed.

## Source map

- `src/shared/types.ts`: every main↔renderer contract. Honest about nulls.

Main process:

- `src/main/index.ts`: startup, single-instance lock, tray, theme listener.
  `app.whenReady()` is not optional — creating a window before it throws.
- `src/main/window.ts`: window lifetime, caption overlay, the three places a theme
  change must land, and the reveal fallback that guarantees a window appears even
  if the renderer never reports a first paint.
- `src/main/ipc.ts`: the entire channel surface. Push-based state, native confirm
  dialogs, the refresh loop, and the identify/capture/open handlers.
- `src/main/probe.ts`: runs probe scripts, resolves the PowerShell host once.
- `src/main/snapshot.ts`: raw probes → rows. Owns CPU samples, the detail cache,
  the previous-scan diff, the history ring, and the precomputed search index.
- `src/main/identify.ts`: HTTP identification, sandboxed capture, loopback guard,
  the identity cache.
- `src/main/project.ts`: project-root inference, declared-port extraction, role
  classification.
- `src/main/identity.ts`: the pid-recycling check.
- `src/main/control.ts`: Close/Terminate with live re-verification.
- `src/main/group.ts`: ancestry and descendants, cycle-safe.
- `src/main/parse.ts`: every external string, all tested.
- `src/main/settings.ts`: the single settings validator, pre-seeded protect list.
- `src/main/store.ts`: atomic persistence in the user profile.
- `src/main/logger.ts`: bounded, redacted activity log.
- `src/main/pidfile.ts`: the running instance's pid and start time. A tray-only
  app has no window to match on, and Electron's executable path does not contain
  the app name, so this is the only reliable way to find it, including for the
  app's own tooling.
- `src/main/elevation.ts`: current token; the one explicit way to change it.
- `src/main/desktop.ts`: tray and login item, both optional.
- `src/main/tray-icon.ts`: icon rasterised in code, no binary asset.

Renderer (no framework, no runtime dependencies):

- `src/renderer/dom.ts`: `el`, keyed `reconcile`, `setValueIfIdle`, inline icons.
- `src/renderer/scroll-view.ts`: overlay scroll thumb (§12).
- `src/renderer/ui.ts`: card/button/badge/chip/stat primitives and formatters.
- `src/renderer/views.ts`: ports, history, settings, and the row builders.
- `src/renderer/app.ts`: shell, navigation, command menu, shortcuts, theme,
  caption-area reservation.
- `src/renderer/style.css`: WebSeal tokens, dense scale, Windows chrome.

Probes (`resources/probe/`, JSONL out):

- `fast.ps1`: listening sockets, owners for listener pids, listener rows, reserved
  ranges. ~975 ms warm, ~1.5 s per spawn.
- `detail.ps1`: parent pids for everything, command lines for listeners. ~3.2 s,
  off the refresh loop.
- `identity.ps1`: one process's live identity, for the pre-kill check.

Renderer extras:

- `src/renderer/demo.html`, `demo.ts`, `demo-stub.ts`, `demo-data.ts`: the
  documentation demo. The real views and stylesheet against fictional data, so the
  README screenshot cannot drift from the interface. Reached only via
  `PORTGARDEN_DEMO=1` in an unpackaged dev run; `window.ts` refuses it when
  packaged, because a port tool that could show invented rows would have failed at
  the one thing it is for.

Scripts:

- `scripts/capture-window.ps1`: DPI-aware `PrintWindow` capture, for reviewing the
  UI. See the DPI note below.
- `scripts/stop-portgarden.ps1`: kills Port Garden and only Port Garden.

## Authority invariants

### Data collection

- The port map comes from `MSFT_NetTCPConnection` with `State = 2`. It is the
  class `Get-NetTCPConnection` wraps, read directly to skip 295 ms of cdXML
  module overhead. `State = 2` is the enum member and is not localized.
- `Get-CimInstance Win32_Process` costs 2.1–2.3 s regardless of filter size, and a
  few thousand disjunction clauses fail outright with "Quota violation". Never
  filter it, never put it in the refresh loop. Its cost is per-call, so one
  unfiltered read supplies every parent pid.
- Command lines, image paths and creation times are read only for listener pids.
  `Path` and `.ToUniversalTime().ToString('o')` throw for most processes, and a
  caught throw costs ~2.5 ms.
- Never call a .NET method inside a per-process PowerShell loop. Use a hashtable
  for lookup and `foreach { ... } -join` for assembly.
- Probe scripts emit JSONL with bulk data packed into single delimited strings
  (0x1F field, 0x1E record). `ConvertTo-Json` unwraps single-element arrays.
- `netsh` output is parsed positionally, never by localized header text.
- Elevation is read once from `whoami /groups` and cached.
- The two tiers are never awaited together. The fast tier is the table; the detail
  tier enriches and republishes.

### Identification and capture

- The probe is a plain HTTP request. Loading a page is only justified when a
  picture is wanted.
- The capture window is `sandbox: true`, no node integration, no preload, an
  ephemeral session partition, and **loopback only**, enforced in the main process
  rather than trusted from the caller.
- Permission requests in the probe window are denied, never prompted: a hidden
  window cannot obtain consent.
- Identification is scoped to dev-server roles and cached per process identity, so
  a new process on the same port is re-probed rather than inheriting the answer.
- **Thumbnails never enter `AppState`.** A 1280×800 PNG is a few hundred
  kilobytes; it is returned to the caller that asked for it and held in the
  renderer's own map.
- `open-url` is restricted to loopback http(s).

### Measure, then optimise

Every cost in the probe scripts and the CSS is annotated with the measurement
that produced it. `npm run bench` reproduces them. Read those numbers before
changing a query, a loop, or a rule:

- The fast tier runs inside one long-lived PowerShell host (`probe.ts`). It exists
  because start-up and the CIM connection are 43% of a scan and were paid on every
  spawn; it takes a steady-state scan from 1,435 ms to 975 ms. The detail tier
  deliberately does not use it - it is off the critical path, and a second
  long-lived process is a second thing that can wedge.
- **The host is an accelerator, never a dependency.** Every failure - missing
  host, dead host, busy host, timeout - must fall back to a one-shot `execFile`,
  which is exactly the pre-host behaviour. A timed-out host is killed, not reused.
  Before adding a failure mode, check that it lands in `runFastScript`'s catch.
- The host cannot leak: when the parent dies its stdin reaches EOF and PowerShell
  exits. That is load-bearing and was verified by force-killing the app, not
  assumed. Do not replace the stdin protocol with a socket or a file.
- `netstat -ano` was implemented and tested, and **rejected on comparison**: it
  found 129 listeners where the CIM class found 144, with 11 address differences.
  It is 49 ms against 515 ms, and still not worth it. Do not revisit this without
  a run of `npm run bench` proving the two agree.
- The port map comes from `MSFT_NetTCPConnection` with `State = 2`, not from
  `Get-NetTCPConnection` (a cdXML wrapper over the same class, 295 ms slower) and
  not from `netstat` (fast, but its state word is translated).
- User names are resolved only for pids that hold a port. An LSA lookup per
  process is ~293 ms machine-wide and ~61 ms for the ~93 listeners.
- Only listener rows are emitted. Other processes contribute a count.
- `Path` and `StartTime` throw for unreachable processes and a caught throw costs
  ~2.5 ms; read them only for listener pids.
- Never call a .NET method inside a per-process loop (~1.5 ms each). Use hashtable
  indexing and `foreach { ... } -join`.
- Never serialise one JSON object per process. Pack into delimited strings.
- `Get-CimInstance Win32_Process` is 2.1-2.3 s whatever the filter, and a
  disjunction of a few thousand clauses fails with "Quota violation". One
  unfiltered read supplies every parent pid.

### The running instance

- The pid file records pid **and** start time, and consumers verify the start time
  before acting, for the same reason the app verifies process identity before
  terminating one: Windows recycles pids.
- `scripts/stop-portgarden.ps1` uses the pid file first and the window title
  second. Do not match on image name or command line: this machine runs several
  Electron apps and Electron's own executable path contains no app name.

### Termination

- `Close` = `taskkill /PID n` (WM_CLOSE, windowed processes only).
- `Terminate` = `taskkill /F /T /PID n`. Uncatchable, plus children.
- There is no SIGTERM on Windows. Never imply an escalation that did not happen.
- OS failure messages are surfaced verbatim. Never paraphrase them.
- `/T` walks the tree at kill time; the preview is from an earlier snapshot and
  the dialog says so.
- Protected processes require `allowProtected`, which only the native dialog sets.

### Identity

- `(pid, createdAt, image)` must all match. Components Windows withheld are
  skipped, not treated as mismatches.
- Image paths compare case-insensitively, trailing separators ignored.
- The identity tuple is complete from the *first* scan, because the fast tier
  reads creation time and image for listener pids.

### Settings

- `parseSettings` is the only validator. `applyPatch` validates the *merged*
  result, never field by field.
- A malformed file yields defaults, never a partial merge.
- An explicitly empty `protect` list is honoured; it differs from an absent one.
- `DEFAULT_PROTECT` is stored in the order `normalizeProtect` produces, so parsing
  the defaults returns the defaults. There is a fixed-point test.
- `refreshMs` snaps to `REFRESH_CHOICES`, whose floor is above the fast tier's own
  duration so scans cannot queue behind each other.
- Writes are atomic. Never write to Program Files.

### Renderer

- State is pushed, never polled.
- **`reconcile` calls `update` for newly created nodes as well as existing ones.**
  A `create` that builds an empty shell for `update` to fill — which is how every
  port row works — renders blank otherwise.
- **Every grid container that can hold wide content declares
  `grid-template-columns: minmax(0, 1fr)`.** An implicit column is `auto`, which
  resolves to max-content: a table with a `min-width` three grids deep forces each
  ancestor wider than the window and everything past the right edge is clipped.
  `min-width: 0` on the items is not sufficient; the track must be told it may
  shrink.
- **A full-width row's `colspan` must equal the column count**, or `table-layout:
  fixed` creates an extra implicit column and every column shifts when a row
  expands.
- The scroll container is never replaced. Doing so resets `scrollTop`, which reads
  as the table jumping to the top every few seconds.
- The one-second tick calls `View.tick`, which rewrites only relative-time text.
  It must never call `update`.
- Row action handlers resolve their row from the current scan at click time rather
  than closing over the row they were created with, so a row is created exactly
  once even though its data changes on every scan.
- Never claim certainty the data does not support. Project confidence, unavailable
  command lines, missing owners and non-HTTP ports are all labelled.

### Development environment

- **Multiple Electron applications run on this machine** (Port Garden, opencode,
  the OpenFork desktop host). Never `Stop-Process -Name electron`. Use
  `scripts/stop-portgarden.ps1`, which identifies the app by the window it owns.
- **`capture-window.ps1` calls `SetProcessDPIAware()` before measuring.** A
  DPI-unaware process gets virtualized coordinates from `GetWindowRect`, so a
  1770-physical-pixel window reports as 1194 and the capture silently becomes the
  top-left crop — which looks exactly like a broken layout.
- **The CSP is dev-aware** (`electron.vite.config.ts`). Production is
  `default-src 'none'`; development adds the Vite HMR websocket. Without that,
  CSS is served correctly, every edit is silently ignored, and it reads like a
  build that is not running.

## Tests and verification

```sh
npm run verify     # typecheck + vitest + build
```

Suites are colocated with the code they cover and named `<module>.test.ts`. They
target what has to be right: JSONL and packed-record parsing, `netsh` ranges under
English and zh-CN output, address normalization, CPU deltas including the
recycled-pid case, the project root walk, `-p` gating, role classification,
cycle-safe tree walks, identity matching, settings validation, and log redaction.

## Adding a platform

Do not. This is a Windows utility. If Windows ever stops being the only target,
that is a new project, not a branch in this one.