# Chrome Web Store submission pack

Everything the dashboard asks for, drafted from the code. Replace the remaining
`<…>` placeholders and delete this paragraph before uploading.

## Before the first upload

- [ ] Host `docs/privacy-policy.md` at a stable public HTTPS URL (below).
- [ ] Create the screenshots (below) with a **demo account** — no real project
      names, UIDs or account labels.
- [ ] Confirm `manifest.json`, `package.json` and the `1.0.0` entry in
      `CHANGELOG.md` all agree.
- [ ] Run `npm ci && npm run check` and use the produced
      `dist/KoboEnhance-1.0.0.zip` — do not upload a manually edited folder.
- [ ] Upload **unlisted** first and test with 2–3 users (see “Beta loop”).

## Contact and hosting

The policy's contact is the repository issue tracker
(`https://github.com/omar-devlop/koboenhance/issues`); swap it for a dedicated
address if you prefer email. If you use an address, make it one you are happy
to keep — it stays in the policy.

The policy must be at a stable public HTTPS URL. Two workable options:

1. **Separate public repo** (recommended): `koboenhance-site` with
   `index.html` and `privacy.html`, GitHub Pages from the default branch. Keeps
   the extension repo private and stops `docs/` internal notes from being
   published.
2. **Cloudflare Pages / Netlify**: connect the repo, publish only the
   `docs/privacy-policy.md` converted to HTML or a small `site/` folder.

Do **not** enable GitHub Pages from the extension repo's `/docs` folder unless
you are happy publishing this submission pack too.

Suggested URLs to record here once live:

- Privacy policy: `<https://…/privacy>`
- Support / issues: `<https://github.com/…/issues>`

## Version policy

- Chrome versions are 1–4 dot-separated integers (`1.0.0`, `1.0.1`). No
  `-beta`, no date suffix.
- `1.0.0` is the first upload, **unlisted**. Visibility can be switched to
  public later without a new upload.
- Any code change after upload needs a new version (`1.0.1`) — never reuse one.
- Before each upload: bump `manifest.json` and `package.json` together, add the
  `CHANGELOG.md` entry, tag the commit, attach the zip to the release.
  `tools/package.mjs` fails when the two versions disagree.

## Screenshots (3–5, 1280×800 or 640×400)

Capture at 1280×800 with a demo account that has believable but fake projects.

1. Projects page with the KoboEnhance toolbar: action picker, source picker,
   Run button.
2. Confirm dialog showing the project count and, for a transfer, the
   Projects / Submissions / Destination allowance facts.
3. Transfer settings panel with the source-token row and destination server.
4. A finished run report or the run-history panel with mixed success/skip rows.
5. Optional: a permission template or Tags/Notes column on the Form Summary
   page.

Do not include real usernames, account labels, project names or submission
content. Blur anything you cannot replace.

## Listing copy

**Name:** KoboEnhance

**Short description (≤132 chars):**
Bulk actions, reports and cross-account project copying for KoboToolbox — runs
entirely in your browser.

**Detailed description (draft):**

> KoboEnhance adds a bulk-action toolbar to the KoboToolbox Projects page and
> works only on the account you are already signed in to.
>
> • Share, remove and copy permissions; apply permission templates
> • Archive/unarchive, rename, re-describe, set country/sector, edit tags
> • Export project lists and permission audits as CSV
> • Build country/sector portfolio reports
> • Copy projects — forms, media, submissions and form versions — to a second
>   Kobo account you configure, with a preflight count and an allowance check
> • Pause and resume long runs; review a local run history
>
> There is no KoboEnhance server: requests go only to KoboToolbox's own hosts.
> No analytics, no telemetry, no third-party requests. API tokens are kept in
> memory only and are never stored.
>
> Supports `eu.kobotoolbox.org` and `kf.kobotoolbox.org`. Independent tool, not
> affiliated with KoboToolbox.

**Category:** Productivity
**Language:** English (the UI also has French and Arabic)

## Dashboard declarations

**Single purpose:**
Bulk management of KoboToolbox projects from the Projects page: permissions,
metadata, reports, and copying projects to a second account the user configures.

**Permission justifications:**

- `storage` — remembers UI preferences, permission templates, run history,
  transfer mappings and local error diagnostics. Tokens are never stored.
- Host permissions for `eu.kobotoolbox.org`, `kf.kobotoolbox.org`,
  `kc-eu.kobotoolbox.org`, `kc.kobotoolbox.org` — the content script runs on the
  two signed-in Kobo hosts, and the service worker uses the same four hosts to
  read the source account and write the destination account during a
  user-initiated copy. No other host is contacted.

**Remote code:** No — all code is packaged in the extension; nothing is fetched
or evaluated at runtime.

**Data usage:**

- Website content: **yes** — project metadata, permissions and submission XML
  are read and written on KoboToolbox at the user's request.
- Personally identifiable information: **yes, handled locally** — Kobo
  usernames/permissions and submission content can contain personal data. It is
  processed in the browser and sent only to the user's own KoboToolbox accounts;
  it is never sent to the developer or a third party.
- Not sold, not shared with third parties, not used for analytics, advertising
  or creditworthiness.
- Privacy policy URL: `<https://…/privacy>`

## Reviewer notes

> KoboEnhance is a content script on the KoboToolbox Projects page. Sign in at
> `https://eu.kobotoolbox.org` (or `https://kf.kobotoolbox.org`), open
> **Projects**, and the toolbar appears in Kobo's actions row above the table.
>
> Most actions (archive, rename, permissions, CSV export) can be reviewed with
> one account. **Cross-account copy needs two accounts:**
> - Source: `<reviewer-source@example.com>` / `<password>`
> - Destination: `<reviewer-dest@example.com>` / `<password>` (its API token is
>   `<token>`, or read it from the destination's Account Settings)
>
> In the toolbar choose **Copy projects to another account** → **Transfer
> settings** → pick the destination server, paste the destination token, select
> one project, Run. A preflight dialog shows the counts before anything is
> copied. The extension reads the source token from `GET /token/` and keeps both
> tokens in memory only; they are never written to storage. No network request
> leaves the four Kobo hosts in the manifest.

## Beta loop

1. Upload `1.0.0` as **unlisted**; share the store link with testers.
2. Ask each tester for: Chrome version, Kobo host, action used, and the output
   of **About → Copy diagnostics** if anything failed.
3. Keep the zip for the tested version; never patch the uploaded file.
4. Fix findings → bump to `1.0.1` → upload → when the beta is stable, switch
   visibility to public (or publish `1.0.1`).

## After publishing

- Tag the published commit and attach the zip to a GitHub release.
- Keep the previous zip: the store cannot downgrade, so a rollback means
  uploading the previous code with a higher version number.
- Refresh the Kobo API/DOM checks when Kobo changes the Projects page or the
  asset API, and after any report of “the toolbar disappeared”.
