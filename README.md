# KoboEnhance

[![CI](https://github.com/omar-devlop/koboenhance/actions/workflows/ci.yml/badge.svg)](https://github.com/omar-devlop/koboenhance/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Manifest V3 browser extension that gives [KoboToolbox](https://www.kobotoolbox.org/)
bulk project management on the **Projects** list page — bulk actions, account
scans, reports, and moving projects to a second account. It runs entirely in your
browser session: no backend, no calls to anything but KoboToolbox itself, and no
credentials stored outside the page.

---

## Features

### Bulk action toolbar (Projects page)
Injected into Kobo's own actions row. Layout:
**[Settings] · [KoboCollect list] · action select · source select · Pause/Resume · Run/Stop ·
Run history**. While a run is active an orange **Pause/Resume** button appears
between the source select and Run/Stop; the other toolbar buttons match Kobo's
own secondary style. Pick an **action** and a **source**, then Run (or
Pause/Stop mid-run).

- **Actions — 19, in 5 groups:**
  - *Permissions:* Share with user(s), Remove user access, Copy permissions
    from project, Apply permission template
  - *Project status:* Archive projects, Unarchive projects
  - *Project metadata:* Add prefix/suffix, Replace text in names, Update
    description, Update country, Update sector, Manage tags
  - *Settings:* Allow anonymous submissions, Disallow anonymous submissions
  - *Account tools:* Check user access, Permission audit, Country portfolio
    report, Export project list, Move projects to another account
- **Source:** Selected projects (live count) · By project UID(s) · Entire
  account (respects the current list filter; still abortable)
- Contextual fields appear only when needed: user(s) + permission (Share
  accepts multiple comma/space/line separated usernames on one row), prefix/
  suffix, find/replace, description, country (multi), sector (single), tags
  (append / replace / remove), source project (with a *Use selected* button),
  permission template (saved user→permission sets)
- **Permission templates** — save a reusable set of users and their
  KoboToolbox permissions (e.g. "CCCM Standard Team": user1 → Owner,
  user2 → Editor, …) via the template picker's *Manage* button, then apply a
  selected template to many projects in one run. Applied additively:
  users already present keep their current permission and are reported as
  skipped. Templates persist in this browser's localStorage.
- **Anonymous submissions** — bulk toggle "Allow submissions to this form
  without a username and password" on or off for the selected projects (the
  UI implements this as granting/removing `add_submissions` for the
  `AnonymousUser` collaborator, which is exactly what this action does).
- **Settings** — the gear button leftmost in the toolbar opens a modal panel of
  extension settings, built from the same shell as the KoboCollect and
  Permission-templates panels. It currently holds one section: the
  **interface language** selector, listing every locale that has registered a
  dictionary (**English, French, Arabic**). Choosing a language persists it in
  `localStorage["ke:lang"]` and reloads the page so every surface re-renders.
  Adding a language is one locale file + one manifest line; the selector picks
  it up with no further wiring.
- **KoboCollect survey list** — the smartphone button right of the settings
  gear and left of the action
  selector opens a modal panel that loads the OpenRosa `/formList` endpoint
  (the same list the KoboCollect app shows: deployed, collectable surveys) and
  offers a CSV report download once loaded. It is a toolbar button, not a
  selector action, so it opens the modal directly. The list auto-loads on
  open, with a reload button. A Username + Password pair lets you view
  **another** account's list; leave both empty to use your own login (session,
  no prompts). On a rejected login or failed load the table is cleared and the
  Download button stays visible but greyed out, so a report is never produced
  from a missing list. Report filenames follow the standard
  `<prefix>-<user>-<timestamp>` naming; when the list came from another
  account the typed account is folded into the name (e.g.
  `kobocollect-forms-(bob)-alice-20260923-1515.csv` vs. the
  own-account `kobocollect-forms-alice-20260923-1515.csv`).
- **Run history and audit log** — the clock button at the far right (same
  style as the KoboCollect button) opens a panel listing every executed run: action, timestamp, signed-in user,
  project count, success/error/cancelled/skipped counts, and the settings
  snapshot. Each bulk run keeps its exact CSV (per-row **Details** download);
  the whole log exports as a CSV index. The log persists in this browser's
  localStorage (capped, newest first) and is recorded automatically by the
  executor — **credentials are never stored**. This is a toolbar button, not a
  selector action, so it opens the modal directly without entering the run
  loop.
- **Pause & resume** — while a run is active the orange **Pause** button (same
  shape as Run, between the source select and Run/Stop) parks the loop between
  items; it becomes **Resume** to continue exactly where it parked. Pausing
  never interrupts an in-flight request and leaves Stop working normally. While
  paused, a **Download progress report** button appears next to it, exporting
  the CSV of everything completed so far (same filename prefix + `Timestamp`
  column as the final report, so the stage is always verifiable). If the page
  reloads mid-pause, the pending UID list, settings, and completed rows are
  kept in this tab's page session (sessionStorage, valid for the same login and
  site for up to 24h): a **Resume** button appears on the next load, offering
  **Resume / Download progress report / Discard / Cancel**. Resumed runs skip
  the confirm dialog and seed their report with the pre-pause rows, so the
  finished CSV stays the full report "as if never paused". Too-large runs
  (many thousands of UIDs) pause in-session only and warn that they can't be
  rescued after a reload. Account scans pause in-session at their item-loop
  boundaries but are not persisted.
- **Internationalization** — every user-facing string flows through the
  `KE.i18n` engine (`core/i18n/i18n.ts`). The **English** dictionary
  (`core/i18n/locales/en.ts`) is the source of truth for keys, with **French**
  and **Arabic** dictionaries beside it. Lookups are typed, so an unknown
  string — or a language missing any key — fails the build; a new language is
  one locale file + one manifest line and shows up in the Settings selector by
  itself (`KE.i18n.locales()`). English is the default (no page-language
  detection); the choice is made in the toolbar **Settings** panel and persisted
  in `localStorage["ke:lang"]`. Arabic ships all six CLDR plural forms
  (`~zero ~one ~two ~few ~many ~other`) that `Intl.PluralRules` selects, so
  counts read correctly at 0, 1, 2, 3-10 and 11+. Canonical values (action ids,
  statuses, CSV column keys, filenames, permission codes) stay
  language-neutral by design.
- Live progress toast with a progress bar; each affected row's checkbox is
  replaced by a status icon (pending / running / done / error) for the run
- Completion toast with metrics and a **Download report** button (CSV);
  filenames resolve instantly from the captured username
- Runs sequentially with execution pacing centralized in the executor (see
  [Centralized execution controls](#centralized-execution-controls)); **Stop**
  cancels cleanly and marks the rest as *cancelled*

### Extra page integrations
- **Tags column** — a persistent, toggleable "Tags" column on the projects
  table (Kobo's Fields menu included), fed from each project's own
  `settings.extra_metadata.tags`
- **Tags row** on the Form Summary page
- **Notes widget** on the Form Summary page — a resizable, per-project notes
  field (tracking info, reminders, follow-ups) stored in
  `settings.extra_metadata.notes`; saves merge the current `extra_metadata` so
  tags and other keys are never overwritten
- **Username auto-detection** — login data, `/users/me/`, filter URLs, or DOM;
  no manual entry needed for exports/filenames
- **No wasted calls** — the MAIN-world hook reuses Kobo's own network
  responses (asset list/detail) for filters, username, and tags/notes

### Move projects to another account

A bulk action that copies projects from the account you are signed in to a
**second Kobo account**, on either server (Global ↔ EU): the form with all its
deployed versions and its form media, plus the submissions. Submission
attachments are not copied.

- **Transfer settings panel** (the gear on the action's row 2) holds both
  accounts. The **source** account's API token is read automatically from your
  signed-in session and shown read-only (masked, with Show / Copy / Read again);
  the **destination** server + API token are typed and then proved with a real
  authenticated request before the run unlocks.
- **Neither token is ever saved.** Both live in memory for the lifetime of the
  page and nowhere else — not in storage, not in run history, not in a paused
  run. After a reload you are asked again.
- **The destination cannot be the account you are signed in to.** If the token
  you paste is your own account's token, the panel refuses it before making any
  request and says why. The run re-checks the same thing before it starts.
- **Source reads use the source token, not just the cookie.** Every read of the
  signed-in account carries `Authorization: Token <source token>` when one is
  available, which is what stops a long run from dying when the page session
  expires mid-transfer. If the token cannot be read the session is used, and the
  panel says so; a token that *is* sent and refused is dropped and the request is
  retried once on the session.
- **A preflight before you confirm.** The confirm dialog states how many
  projects will be copied, how many submissions that is, and how much submission
  allowance the destination has left for the current billing period (from
  Kobo's `/api/v2/service_usage/`), including the reset date. **A shortfall is a
  warning, not a block** — you decide — and anything that cannot be read is said
  plainly rather than omitted. This exists because a destination at its cap
  answers every submission with HTTP 402: without the check, a run copies the
  forms first and then discovers the submissions have nowhere to go.
- **Re-running is safe** — before anything is created, the destination account's
  own project list is read and a project that is already there (same recorded
  UID, or same name) is skipped instead of copied again. The dialog's "Projects
  to copy" and "Submissions to copy" use that same list, so they match what the
  run will do.

---

## How it works

Project management is modeled as three independent concepts, so no feature
re-implements execution:

- **Scope** (which projects) — `core/scope/scope.service.ts`
- **Action** (what happens) — a normalized descriptor registered in
  `core/actions/action-registry.ts`
- **Execution** (how it runs) — `core/execution/action.executor.ts`:
  `validate → confirm → resolve → execute → summarize`, with progress,
  cancellation, per-row status, and a stable finished payload (dialog or
  toast + CSV).

## Tech stack

- **TypeScript** (ES2022, strict) — classic IIFE scripts, no bundler. All
  modules share one `window.KoboEnhance` namespace, typed via the ambient
  `.d.ts` files in `types/`.
- **Chrome Manifest V3** — content scripts on KoboToolbox; one isolated-world
  content script plus one MAIN-world hook (`entry/inject.js`), and one
  background service worker (`core/transfer/transport.sw.js`).
- **Permissions** — `storage` and host access to the four official
  KoboToolbox hosts. No analytics, and no calls outside the KoboToolbox
  instances the transfer names. The service worker and the two extra hosts
  (`kc.kobotoolbox.org`, `kc-eu.kobotoolbox.org`) exist for the cross-account
  transfer: Kobo sends no CORS headers on the KC host, so a submission can only
  be posted to the other account from a background worker. It sends
  `Authorization: Token …` to an explicit allow-list of those hosts, with
  `credentials: "omit"`, so the signed-in account's cookie is never attached to
  a destination request.

## Project structure

```
core/                      framework layers (shared, low-level)
  state/store.ts           selected UIDs, active filter URL
  errors/errors.ts         ApiError, ValidationError
  auth/auth.service.ts     base URL + CSRF from session; username resolution
  api/                     HTTP client, pagination, and endpoint wrappers
                           (assets, permissions, users, environment)
  scraper/scraper.service.ts  reads the live DOM (row UIDs, checkboxes)
  export/export.service.ts CSV building, union keys, download, naming
  scope/scope.service.ts   SCOPE concept: what a run targets
  collections/surveys.ts   whole-account UID resolver for the toolbar
  dom/dom.ts               generic DOM element factory (el), layer-agnostic
  i18n/i18n.ts             internationalization core (t/tP engine, KE.i18n)
  i18n/locales/en.ts       English dictionary (key source of truth)
  i18n/locales/fr.ts       French dictionary
  i18n/locales/ar.ts       Arabic dictionary (full CLDR plural forms)
  actions/                 THE action contract + registry (source of truth)
  execution/action.executor.ts  EXECUTION concept: the per-item run loop
  templates.store.ts       permission templates
  transfer/                cross-account move: source credential, destination
                           store, usage/allowance reads, source & destination
                           APIs, submission XML, mapping store, and the
                           background service worker (transport.sw.ts)
features/                  the actual products
  bulk-actions/            toolbar facade + per-action definitions
  permissions/             account scans: check access, permission audit
  reports/                 account scans: export projects, country portfolio
  transfer/                transfer.action (the bulk action), the copy pipeline,
                           the pre-run preflight, and the transfer settings panel
  collect/                 KoboCollect survey-list panel (OpenRosa /formList)
  history/                 run history & audit log (store + panel)
  paused-run/              Pause & resume page-session snapshot (store)
  tags/                    tags column + form-summary tags row
  notes/                   form-summary notes widget
ui/                        in-page UI
  components.ts            dialogs, toast system (renders via core/dom)
  integration.ts           the toolbar, pickers, selection sync, run wiring
entry/                     entry points
  inject.js (MAIN world)   hooks fetch/XHR to capture filters, username, tags, notes
  main.js (isolated world) boots the integration once the DOM is ready
types/                     shared ambient types (domain + KE namespace)
manifest.json              MV3 manifest; lists the compiled .js files in order
build.ps1                  compiles .ts → .js in place (see below)
```

All sources are `.ts`; `manifest.json` loads the compiled `.js` files emitted
next to them by the build.

## Dependency rules

Modules depend in one direction only, and dependencies are expressed through
the shared `window.KoboEnhance` namespace (there are no module imports):

```
entry → ui → features → core
```

- **core** — generic API, execution, state, scope, and infrastructure logic.
  Must not import from `features` or `ui`.
- **features** — business/product functionality. May depend on `core` (and on
  other features).
- **ui** — DOM rendering + integration. May depend on `features` and `core`.
- **entry** — browser entry/bootstrap + wiring. May depend on anything below.
- Circular dependencies are avoided; e.g. the default UI gateway for the
  executor is injected by `entry/main.js` (`actionExecutor.setDefaultUi`)
  instead of the executor reading `components` directly.

## Results vs. reports

Execution results and their presentation are separate concerns:

- **`ActionResult<TData>`** describes what *happened*: the per-project status /
  message / error plus the action-specific `data` (bulk actions), or the
  structured rows/counts of a whole-run scan (`ScanResult`). A `panel`-kind
  action is neither: the executor skips the per-item loop entirely for it
  (collect currently lives behind its own toolbar button instead of the
  selector, so it never reaches the executor).
- **Reports** are consumed from those results. The executor collects the
  standardized results; the export service (`exportSvc`) is the report stage
  that turns them into the required output format.

  - Bulk: the executor flattens each result with the registry's `rowFor`
    (stable base columns + unioned `data` keys) and formats the CSV via
    `exportSvc`.
  - Account scans: their `execute` returns *declared export intent* as
    `files: ReportFileSpec[]` (`{ filename, rows, columns }`); the executor
    materializes it into CSV with `exportSvc.buildCsvFiles` before
    `report.summary` builds the finished UI.

Actions never contain CSV formatting logic; CSV, dialogs, toasts (and any
future JSON/Excel export) are presentation-stage concerns hanging off the same
`ReportFileSpec` input.

## Execution context (`ActionContext.runtime`)

Every running action receives an `ActionContext` (bulk validation/confirmation,
whole-run scans) and either an `ItemContext` (per-project, bulk) or an
`AccountExecuteContext` (account scans). All three carry the same
`ActionRuntime` bundle, assembled once per run by the executor
(`core/execution/action.executor.ts`):

- `api.assets` / `api.permissions` / `api.users` — the platform APIs actions
  write and read through.
- `scope` — scope resolution/collection (`resolveUids`/`collect`).
- `pagination` — whole-account asset-listing loops.
- `auth` — `baseUrl` + `getUsername()` for own-account details.
- `permissions` — the permission catalog for label lookups in reports.
- `runItems` — the shared per-item loop account scans drive.
- `execution` — the resolved execution policy for this run (`KoboExecutionOptions`), so sub-loops share the same central pacing.
- `report.scalarFields` — row flattening for exports.

Actions consume the context instead of reaching into unrelated global state;
`window.KoboEnhance` stays for cross-module wiring and the services that
necessarily span IIFE boundaries. The runtime is intentionally **not** a
service locator: it carries only what actions call while executing, and a
capability should be added there only when an action actually needs it at run
time.

## Centralized execution controls

Timing and parallelism are owned by the execution layer, not by individual
actions. Actions describe **what** to execute; the executor decides **how** it
is paced. Every per-item loop — bulk actions and account scans alike — runs
through `runItems` with a single *resolved policy* per run
(`types/global.d.ts` → `KoboExecutionOptions`):

- `concurrency` — max item operations executed at once. `1` (the default)
  keeps the strictly sequential behavior: each item completes before the next
  starts. `> 1` runs a bounded pool that still emits report rows in input
  order and still honors cancellation.
- `itemDelayMs` — pause between each successfully processed item. `200` by
  default. This replaces the old per-action `delayMs` (bulk 300, permission
  scans 200, exports 0) with a single server-friendly value.
- `requestPacingMs` — minimum gap between item *start* times (rough request
  pacing for runs whose items issue several HTTP requests). `0` = no pacing
  beyond `itemDelayMs`.

Policy resolution per run: global defaults merged with the run override
`RunOptions.execution`, then applied to every loop.

Where to tune it:

- **Per run:** pass `execution: { itemDelayMs, concurrency, requestPacingMs }`
  in the `RunOptions` handed to `actionExecutor.runAction` — e.g. a future
  toolbar "slower / faster" control without touching any action.
- **Globally:** `KE.actionExecutor.setExecutionPolicy({ itemDelayMs: 400 })`
  (read the current defaults with `getExecutionPolicy()`).

Cancellation is unchanged: `KE.actionExecutor.abort()` aborts the run's signal
immediately (fetch-level abort via the API client). Client-side retry/backoff
for transient failures lives centrally in `core/api/client.ts` — never
retried: validation/auth/permission 4xx, `AbortError`, and offline.

Account scans call `runtime.runItems({ items, signal, perItem, ... })` with no
timing of their own; the executor's bound `runtime.runItems` injects the
resolved policy automatically.

## Adding a new action

> Adding a new action should require changing the action/feature and registry,
> not manually modifying unrelated UI or executor code.

The toolbar dropdown, field visibility, validation, confirmation, scope
resolution, execution loop, cancellation, and CSV output are all driven
generically from the registered descriptor. Write a new action module, register
it, list it in `manifest.json` — everything else is picked up automatically.

**1. Where it belongs.** A persistent bulk action is a new module under
`features/bulk-actions/actions/<name>.ts`. An account-kind scan is a feature
module under `features/permissions/` or `features/reports/`. The module does
three things: `const KE = window.KoboEnhance; const A = KE.actionRegistry;`,
define config + result-data types, then `A.register(id, descriptor)`. When
finished, add the compiled `.js` to the `content_scripts` array in
`manifest.json` (this is the registration wiring; nothing else is hand-wired).

**2. Config type.** A lean interface narrowing `ActionRequest` to exactly what
the action reads. The executor builds the request map from the shared keys —
pick from `username, usernames, users, permission, templateId, prefix,
suffix, findText, replaceText, description, countries, sectors, tags,
tagsMode, sourceProject` (adding a new toolbar input means extending the
UI/executor contract once, as `sourceProject` did for Copy permissions — then
it is reusable by any action):

```ts
interface ReplaceDescConfig extends KoboRecord {
  findText: string;
  replaceText: string;
}
```

**3. Result data type.** The per-project payload whose keys become the extra
CSV report columns:

```ts
interface ReplaceDescData extends KoboRecord {
  Old_Description?: string;
  New_Description?: string;
}
```

**4. Implement the descriptor.** Register with full metadata. `kind` defaults
to `"bulk"`; `fields`/`requiredFields` drive toolbar inputs and shared
validation; `confirmDetails` appends lines to the generated confirm dialog, and
`confirmDetailsBlock` returns the same detail structured (`facts` / `warnings` /
`notes`) so the dialog can align the numbers and mark the warnings — prefer it
whenever the detail is more than one short line;
return a raw result from `execute` (the default `formatResult` turns
`{ unchanged: false }` into `success` and `{ unchanged: true }` into `skipped`
with `skipReason`). A `kind: "panel"` action skips the bulk loop altogether and
`ui/integration.ts` opens its modal directly (no panel action is currently
registered; the KoboCollect list is reached via its own toolbar button):

```ts
A.register("replace_in_description", {
  label: "Replace text in descriptions",
  group: "Project metadata",
  description: "Find and replace text in project descriptions",
  icon: "align-left",
  fields: ["find", "replace"],
  requiredFields: ["find"],
  stepLabel: "Editing descriptions",
  reportFields: ["Old_Description", "New_Description"],
  skipReason: "Text not found in description",
  confirmDetails(context: ActionContext<ReplaceDescConfig>) {
    return [`Find: "${context.request.findText}"`, `Replace with: "${context.request.replaceText || ""}"`];
  },
  execute(ctx: ItemContext<ReplaceDescConfig> | AccountExecuteContext<ReplaceDescConfig, ReplaceDescData>) {
    const c = ctx as ItemContext<ReplaceDescConfig>;
    const { findText, replaceText } = c.request;
    return c.runtime.api.assets.fetchAsset(c.uid, c.signal).then((asset) => {
      const oldText = (asset && asset.settings && asset.settings.description) || "";
      const newText = oldText.split(findText).join(replaceText || "");
      const data: ReplaceDescData = { Old_Description: oldText, New_Description: newText };
      return newText === oldText
        ? { unchanged: true, projectName: (asset && asset.name) || "", data }
        : c.runtime.api.assets.updateAssetDescription(c.uid, newText, c.signal).then(() => ({
            unchanged: false,
            projectName: (asset && asset.name) || "",
            data,
          }));
    });
  },
} as ActionParams<ReplaceDescConfig, ReplaceDescData>);
```

**5. Validation.** Defaults come from `requiredFields` (per-field wording via
`fieldMessages`) plus the empty-target backstop; no `validate` needed for the
common case. For custom checks (e.g. a username existence probe), provide
`async validate(context)` and use `context.runtime.api.users.lookupUser(...)` —
see `features/permissions/shared.search.ts`.

**6. Contexts.** Bulk validate/confirm receive `ActionContext`; per-project
execute receives `ItemContext` (`uid`, `request: TConfig`, `signal`, `runtime`);
account-kind execute receives `AccountExecuteContext` (`uidList`, `filterUrl`,
`signal`, `onProgress`, `request`, `def`, `runtime`). Services are consumed
from `ctx.runtime` (api assets/permissions/users, `scope`, `pagination`,
`auth`, `permissions`, `runItems`, `execution`, `report.scalarFields`) — never
from the global namespace during execution.

**7. Registration.** `A.register(id, descriptor)` throws on a duplicate id and
normalizes the descriptor through `KE.actionInterface.normalizeAction`, which
fills the shared defaults (validate/confirm/formatResult/permissionOut/
targetUserOut/summary). `A.textOf`/`A.permissionLabel` are available for
`confirmDetails` wording.

**8. UI discovery.** `ui/integration.ts` builds the dropdown from
`integratedActions.ACTIONS` (a live view over `registry.ACTIONS`), grouping
options by `group` and storing the label in `tip`; row-2 inputs are shown by
`uiFields` (`fields`). Nothing in the UI knows individual action ids.

**9. Scope.** The executor owns scope: explicit UIDs pass through, whole-account
runs resolve via `context.runtime.scope.resolveUids` (survey-only, respecting
the current list filter). Account-kind actions receive the resolved
`uidList`/`filterUrl` and can use `runtime.scope.collect` or
`runtime.pagination.fetchAllAssets` themselves.

**10. Results → reports.** Bulk: the executor normalizes each result, flattens
it with `registry.rowFor` (stable base columns + `data` keys), and formats the
CSV via `exportSvc`. Account scans return *declared export intent* as
`files: ReportFileSpec[]` (`{ filename, rows, columns }`); the report stage
(`exportSvc.buildCsvFiles`) materializes the CSV before `report.summary`
builds the finished toast/dialog. Actions never format CSV themselves.

**11. Build and test.** Run the type-check + emit (`powershell -NoProfile
-ExecutionPolicy Bypass -File build.ps1`), then confirm every emitted script
parses (`node -e` with `new vm.Script(...)` over the files `manifest.json`
lists). Confirm the new action appears in the dropdown output and that its CSV
columns match `reportFields`.
> The repo's older `ke_registry_verify.js` / `ke_report_verify.js` harnesses are
> **not** in the tree — this step describes a check you have to run yourself
> until they are restored.

## Public surface (`window.KoboEnhance`)

`store · errors · auth · apiClient · pagination · apiAssets · apiPermissions ·
apiUsers · apiEnvironment · scraper · exportSvc · surveys · scopeService ·
actionInterface · actionRegistry · dom · components · actionExecutor ·
integratedActions · collect · history · templates · tagsColumn · formSummaryTags ·
formSummaryNotes · integration` plus the transfer feature's own:
`transferTransport · transferState · transferDestination · transferSourceAccount ·
transferUsage · transferSource · transferDest · transferSubmissionsXml ·
transferMapping · transferPipeline · transferPreflight · transfer`

Every property is a *live runtime dependency* of at least one independently
loaded module:

- Modules are classic ES IIFEs with no imports — the shared namespace is the
  only way separate scripts pass services to each other (e.g. every API
  service, `auth`, `errors`, `store`, `dom`, `i18n`). These must stay global.
- `i18n` (core/i18n) is the internationalization engine + the English, French
  and Arabic dictionaries.
  Loaded right after `dom` so every later module can call `KE.i18n.t()`.
- `components` (ui) lives in its own script and is consumed by `integration`
  (ui) and bootstrapped by `entry/main` — so it must stay on the namespace.
- `actionInterface` / `actionRegistry` / `actionExecutor` / `integratedActions`
  are the public action runtime: feature modules register into the registry,
  the executor resolves through it, and `integratedActions` is the toolbar's
  facade.
- `tagsColumn` / `formSummaryTags` / `formSummaryNotes` / `integration` are
  bootstrap entry points that `entry/main` (or the tags column) calls after load.
- `collect` is the KoboCollect panel facade (`fetchFormList` / `openPanel`)
  consumed by the toolbar's smartphone button, which sits left of the action
  selector and calls `openPanel` directly.
- `history` is the run-history service: its store module self-registers as the
  executor's audit sink (`actionExecutor.setHistorySink`) and its panel module
  installs `openPanel`, which the toolbar's history button calls.
- `pausedRun` is the pause & resume snapshot service
  (`features/paused-run/paused-run.store.ts`): the toolbar saves a parked run
  into it and reads/validates it back to offer Resume after a page reload.
  Validation needs `auth` + `actionRegistry`, so it stays a separate module.
- `templates` is the permission-template store (`core/templates.store.ts`) used
  by the Apply-permission-template action and the template manager dialog.

Account scans (`sharedSearch`, `permissionAudit`, `exportProjects`,
`countryPortfolio`) are *not* exposed any more: they register their actions in
the registry like everything else and run through `integratedActions.run` → the
executor, so their old individual `run` facades were unnecessary exposure.

## Build

Requires **Node.js 20+**. The toolchain is pinned by `package.json`
(TypeScript 5.9.3):

```bash
npm ci          # once per clone / lockfile change
npm run build   # compile .ts in place to the .js the manifest loads
npm run typecheck
```

`build.ps1` is a Windows shortcut for the same compile; it prefers the local
`node_modules` TypeScript and only falls back to `KE_NODE` / `TSC_NODE` /
`TSC_JS` overrides. Reported type errors must be fixed to exit 0. Reload the
extension after any rebuild.

## Package for the Chrome Web Store

```bash
npm run package
```

or, on Windows, `powershell -NoProfile -ExecutionPolicy Bypass -File package.ps1`.
Both build first, then stage only what the extension loads — `manifest.json`,
the emitted `.js` files, icons and the popup — into
`dist/KoboEnhance-<version>.zip`.

`tools/package.mjs` (the Node port of the old `package.ps1`) fails if a path the
manifest references is missing, if `manifest.version` and `package.json` disagree,
or if a `.ts`, `.md`, `.csv`, `.ps1` or `.map` file reaches the package. A CSV
export of a real account must never ship, so `.csv` is refused outright (and
`.csv` files are gitignored everywhere in the tree).

## Install / use

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `dist/stage` after `npm run package` (or the repo
   root after `npm run build`).
3. Open a KoboToolbox **Projects** page (`eu.kobotoolbox.org`, `kf.kobotoolbox.org`).
4. Tick projects (or pick UIDs / entire account), choose an action, Run.

Other KoboToolbox instances: add the host to `host_permissions` and the
content-script `matches` in `manifest.json`.

## Status

- Fully TypeScript: all modules compiled to `.js`; `build.ps1` exits 0 and
  every emitted script parses clean.
- Tested against `https://eu.kobotoolbox.org`.
- Country/sector pickers use `GET /api/v2/environment/` (Kobo removed the old
  V1 `/environment/` endpoint).
- The cross-account transfer has been exercised end-to-end against real source
  and destination accounts (projects, forms, media and submissions).
- Submission counting reads `deployment__submission_count` from the project
  list; `/api/v2/asset_usage/` was abandoned because it omits projects shared
  from an organization, which made the preflight report 0.
- Privacy policy: `docs/privacy-policy.md` (host it at a public URL before
  submission; see `docs/store-submission.md`).
- A startup failure now shows a banner with **Reload** / **Copy diagnostics**
  instead of leaving the page without a toolbar; uncaught errors are kept in a
  redacted, local 20-entry ring in `chrome.storage.local` (`ke:diagnostics`).
  Nothing is uploaded.

## License

MIT — see [`LICENSE`](LICENSE).

## Notes & limitations

- The working set is the live checkbox selection (or manual UIDs / whole
  account). "Select all" applies to the loaded page only.
- Whole-account runs use Kobo's current list filter, captured from the page's
  own API requests; it falls back to all assets if never seen.
- Status icons appear only for affected rows; the selection is not
  auto-cleared afterwards.
- Selectors match Kobo's stable CSS-module prefixes
  (`projectsTableRow-module__…`, `projectViews-module__…`); they survive
  hashed-class renames but may need a tweak on a breaking Kobo layout change.