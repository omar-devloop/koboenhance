# Security policy

KoboEnhance runs entirely in your browser and talks only to the four
KoboToolbox hosts named in `manifest.json`. It has no backend.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's
private vulnerability reporting on this repository
(**Security → Report a vulnerability**), or contact the maintainer through the
GitHub profile linked in the repository sidebar.

Include the extension version, the Kobo host, the action involved, and — if you
can — the diagnostics from **About → Copy diagnostics** (tokens are redacted
before they are stored).

## What is in scope

- Cross-origin or off-allow-list requests from the content script or the
  background service worker
- Token or cookie leakage (storage, run history, paused-run snapshots, logs)
- Code injection from Kobo-supplied data (project names, descriptions, tags,
  submission content) into the extension UI
- CSV formula injection in generated reports
- Weak validation of the `postMessage` bridge between the MAIN-world hook and
  the isolated-world content script

## Out of scope

- Vulnerabilities in KoboToolbox itself (report them to Kobo)
- Anything that requires the user to paste malicious content into the extension
  by hand
- The extension reading data the signed-in Kobo user can already see

## Security model, in short

- **No credentials are stored.** The source and destination API tokens live in
  memory only; a page reload clears them.
- **No third-party requests.** No analytics, telemetry, or remote code.
- **Least privilege.** The extension requests `storage` and host access to the
  four official KoboToolbox hosts.
- **Local-only data.** Settings, templates, run history and redacted
  diagnostics stay in the browser profile.
