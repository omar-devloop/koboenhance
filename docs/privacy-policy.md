# KoboEnhance privacy policy

Last updated: 22 October 2026
Effective date: 22 October 2026

KoboEnhance is a browser extension that adds bulk project management to
[KoboToolbox](https://www.kobotoolbox.org/). It has **no server of its own**:
the extension runs inside your browser and talks only to the KoboToolbox
servers listed below.

## What the extension accesses

- **Your KoboToolbox session.** The extension acts as you inside the
  KoboToolbox web app, using the session the app has already established.
- **Project data you act on.** Project names, UIDs, descriptions, settings,
  tags, deployment state, permissions, and the user names you share with or
  remove.
- **Submissions, only when you copy a project to another account.** The
  submission XML of the projects you selected is read from your account and
  uploaded to the destination account you configured.
- **API tokens, only for the cross-account copy.** You type the destination
  account's API token. The extension also reads your own account's API token
  from your KoboToolbox server (`GET /token/`) so a long copy does not stop if
  your page session expires. Both tokens are held in memory only: a page reload
  clears them, and neither is ever written to storage.
- **Run history.** Action, timestamp, your user name, project counts and the
  result rows (project UID/name and outcome) of each run, kept locally so you
  can review or export it.
- **Error diagnostics.** If something goes wrong, the extension keeps a small,
  redacted record (message, stack trace, page path, version, language and
  browser) in this browser so you can copy it into a support report. Nothing is
  uploaded automatically.

## What the extension stores, and where

Everything is stored in your own browser. Nothing is uploaded to the
maintainer or to any third party.

| Storage | Key | Contents |
|---|---|---|
| Page storage (`localStorage` on the KoboToolbox origin) | `ke:lang` | your language choice |
| | `ke:tags:visible` | whether the Tags column is shown |
| | `ke:permissionTemplates` | permission templates you saved |
| | `ke:runHistory` | the last runs and their result rows |
| Page session (`sessionStorage`) | `ke:pausedRun` | the snapshot of a paused run, so it can be resumed on the same tab |
| Extension storage (`chrome.storage.local`) | `ke:transfer:mappings` | the destination UID of each project an earlier run copied, so a renamed copy is still recognised; whether a project already exists is always re-checked against the destination's own project list |
| | `ke:transfer:server` | the last destination server you picked (Global or EU) — no account name is kept |
| | `ke:diagnostics` | the last 20 extension errors, with API tokens redacted: message, stack, page path, version, language and browser |

If extension storage is unavailable, the transfer mapping falls back to page
storage so the feature still works.

Page storage is scoped to the **browser profile**, not to a KoboToolbox account.
On a shared browser profile, anyone using that profile can see the templates,
preferences and run history saved there. Run history entries record the user name
so runs can be told apart.

**Never stored:** your KoboToolbox password, the source API token, the
destination API token, and any cookie value.

## What the extension sends, and to where

Requests go only to the four KoboToolbox hosts named in the extension's
manifest:

- `eu.kobotoolbox.org`, `kf.kobotoolbox.org`
- `kc-eu.kobotoolbox.org`, `kc.kobotoolbox.org`

There is no analytics, telemetry, advertising, crash reporting, or any other
third-party request.

## What the extension does not do

- It does not run on any site other than the KoboToolbox hosts above.
- It does not sell, share or transfer your data to anyone.
- It does not use your data to determine creditworthiness or for lending.
- It does not read your data for purposes unrelated to the bulk actions you
  start.

## Retention and deletion

Local data is removed when you uninstall the extension. Page storage can also
be cleared at any time from your browser's site-data settings for the
KoboToolbox origin. Diagnostics are capped at 20 entries and can be cleared from
the About popup. API tokens are discarded when the page is reloaded or closed.
Exported CSV files are ordinary downloads that you control.

## Permissions and why they are needed

- **`storage`** — remembers UI preferences, permission templates, run history,
  transfer mappings and local error diagnostics.
- **Host access to the four KoboToolbox hosts** — reads and changes the account
  you are signed in to, and the second account you configure as a copy
  destination. The service worker uses it for the destination account, whose
  server does not allow the page's cross-origin requests.

## Contact

Questions or deletion requests: open an issue at
<https://github.com/omar-devlop/koboenhance/issues>.

## Changes

Material changes to this policy will be published with a new version of the
extension and a new "last updated" date above.
