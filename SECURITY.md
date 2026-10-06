# Security

## Reporting

Report a vulnerability through GitHub's [private vulnerability
reporting](../../security/advisories/new) rather than a public issue.

Please include the version, what you expected, what happened, and the smallest
reproduction you have. This is a single-maintainer project, so expect a first
response in days rather than hours.

## What Port Garden is allowed to do

It is worth being precise about this, because a tool that can end processes is a
tool with real authority.

**It reads.** Process metadata for every running process, and — for pids that hold
a listening port — the command line, image path and creation time. Command lines
are read only for listening pids and are never written to disk or sent anywhere.

**It writes.** Settings, a bounded redacted log and a pid file, all in
`%APPDATA%\portgarden`. Nothing is written outside the user profile.

**It ends processes.** `taskkill` against pids the user explicitly selected, after
re-verifying the identity the row was drawn with. Protected processes cannot be
terminated without an explicit override in a native confirmation dialog.

**It makes HTTP requests** to loopback addresses, to identify what a dev server is
serving. Scoped to processes classified as dev servers, plus any port the user
explicitly asks about.

**It renders pages** in a hidden window, only when the user asks for a screenshot,
and only for an address it identified on loopback.

## Non-negotiables

- **Loopback only.** The identification probe and the capture window refuse
  anything that is not `127.0.0.1`, `localhost` or `::1`. The check lives in the
  main process rather than being trusted from the caller.
- **The capture window is treated as hostile territory.** It loads a page served
  by an unknown local process, so it runs sandboxed with no node integration, no
  preload, a throwaway session partition that shares no cookies or storage with
  the app, and permission requests denied rather than prompted — a hidden window
  cannot obtain consent.
- **Elevation is never implicit.** Port Garden runs unprivileged by default and is
  fully useful that way. "Relaunch as administrator" is an explicit action, and
  while elevated the title bar shows a persistent **Admin** badge.
- **No network egress.** The renderer's Content-Security-Policy is
  `default-src 'none'`. In development it adds exactly the Vite HMR websocket and
  nothing else; the packaged document has no network access at all.
- **No secrets.** Port Garden stores no credentials. Identified URLs are loopback
  addresses.

## Known limitations

These are honest boundaries, not vulnerabilities, but they shape what the tool can
be trusted for:

- **Identification is one HTTP request.** A port that answers with a page title is
  not the same as a port that is *safe*. Do not treat "Port Garden says it is a
  dev server" as an assurance.
- **Close is best effort, Terminate is not.** On Windows there is no SIGTERM:
  `Terminate` is an uncatchable `TerminateProcess`, so a database force-ended
  through the override may need crash recovery.
- **The child-process scope is approximate.** `taskkill /T` walks the tree at kill
  time, which can differ from the preview shown before the click. The dialog says
  so.
- **Command lines appear in the UI.** If a dev server was started with a secret in
  its own arguments, that secret is visible on screen and screenshot-able.
- **The activity log redacts credentials but is not a vault.** Review it before
  sharing.
