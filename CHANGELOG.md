# Changelog

All notable changes to KoboEnhance are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/). Chrome accepts
1–4 dot-separated integers, so prerelease suffixes are not used in
`manifest.json`.

## [Unreleased]

## [1.0.0] — 2026-10-21

First Chrome Web Store release.

### Added

- Bulk-action toolbar on the KoboToolbox Projects page: share/remove/copy
  permissions, permission templates, archive/unarchive, rename and replace text,
  descriptions, country/sector, tags, and anonymous-submission toggles.
- Whole-account runs that respect the current Projects-page filter, with manual
  UID lists as an alternative.
- CSV exports: project lists, permission audits, country/sector portfolios, and
  per-run result reports.
- Cross-account project copy: forms, media, submissions and form versions, with a
  preflight count, destination allowance check, live destination-name matching,
  skip-on-re-run, and a per-project report.
- Pause/resume for long runs (same-tab snapshot, 24-hour TTL) and a local run
  history with CSV export.
- Editable Tags and Notes on the Form Summary page, plus a Tags column on the
  Projects list.
- English, French and Arabic UI (translation-key parity enforced at build time).
- Local-only error diagnostics with a "Copy diagnostics" button in the About
  popup; a startup failure banner instead of a silently missing toolbar.

### Security

- Source and destination API tokens are held in memory only — never in page
  storage, extension storage, run history or a paused snapshot.
- The destination token is refused when it belongs to the signed-in account.
- Service-worker requests are restricted to the four KoboToolbox hosts and sent
  without cookies.
- The Web Store zip is built from an allow-list and refused if a manifest path is
  missing or a source/doc/data file slips in.
- Service-worker requests are additionally restricted to an allow-list of the
  API paths the transfer uses, and a message is ignored unless it comes from
  this extension's own content script on one of the four hosts.
- Service-worker requests refuse to follow redirects, so a request cannot be
  sent off the allow-list.
- A 429's `Retry-After` is honoured by both retry loops (capped at 60 s), so a
  throttled account is not retried before it says it is ready.
- CSV exports escape a leading `=`, `+`, `-` or `@` in text cells, so a project
  name cannot become a formula when the report is opened in a spreadsheet.
- The page's `postMessage` bridge checks the origin, and the account filter URL
  it carries is validated before it is stored and again before it is fetched.
- The unused `downloads` permission was removed: the extension now requests
  `storage` only, and CSV exports are saved with an object URL.

[Unreleased]: https://github.com/omar-devlop/koboenhance/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/omar-devlop/koboenhance/releases/tag/v1.0.0
