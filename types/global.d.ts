/**
 * types/global.d.ts ——— the window.KoboEnhance namespace surface.
 *
 * The extension attaches every module to window.KoboEnhance as classic content
 * scripts. This declaration types that global namespace so each migrated .ts
 * script can read/write typed modules without imports. Interfaces here are
 * tightened as files migrate; nothing here changes runtime behavior.
 */

interface Window {
  KoboEnhance: KoboEnhanceGlobal;
}

/** Page-level context the in-page integration keeps (core/state/store.js). */
interface PageContext {
  currentProjectUid: string | null;
  selectedUids: UID[];
  lastFilterUrl: string | null;
  filterParams: Record<string, unknown>;
}

interface KoboStore {
  load(): Promise<{ pageContext: PageContext }>;
  getState(): { pageContext: PageContext };
  setPageContext(ctx: Partial<PageContext>): void;
}

interface KoboErrors {
  ApiError: new (message: string, status?: number, detail?: string) => ApiErrorInstance;
  ValidationError: new (message: string) => ApiErrorInstance;
}

interface ApiErrorInstance extends Error {
  name: string;
  status?: number;
  detail?: string;
  /** How long the server asked us to wait before retrying (ms), from a 429's
   *  "Retry-After" header. Undefined when the server did not say. */
  retryAfterMs?: number;
}

/** One redacted error captured by core/errors/guard.ts. */
interface KeDiagnosticsEntry {
  time: string;
  kind: "error" | "rejection" | "startup";
  message: string;
  stack?: string;
  /** Origin + path only (never the query string). */
  url: string;
  lang: string;
  version: string;
  userAgent: string;
}

/** Local-only diagnostics: a bounded ring buffer plus a copyable report.
 *  Nothing is ever uploaded; see docs/privacy-policy.md. */
interface KoboDiagnostics {
  /** Installs the window error/unhandledrejection guards. Idempotent. */
  install(): void;
  /** Records one error (redacted and bounded) and persists the recent ring. */
  record(kind: KeDiagnosticsEntry["kind"], error: unknown): void;
  /** Records a startup failure and shows the standalone failure banner. */
  showStartupFailure(error: unknown): void;
  /** Recent entries, newest first (a copy, safe to mutate). */
  entries(): KeDiagnosticsEntry[];
  /** Pretty JSON for the clipboard. */
  toJSON(): string;
  /** Copies toJSON() to the clipboard; false when both paths fail. */
  copy(): Promise<boolean>;
}

interface KoboAuthService {
  getBaseUrl(): string;
  getCsrfToken(): string | null;
  buildHeaders(extra?: Record<string, string>): Record<string, string>;
  isAuthError(status: number): boolean;
  getUsername(): Promise<string>;
  cacheUsername(name: string): boolean;
  usernameFromFilterUrl(url: string): string;
}

interface RequestOptions {
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  method?: string;
  body?: BodyInit | null;
  signal?: AbortSignal;
}

/** How a client authenticates. "session" = the signed-in page/session (session
 *  cookie + CSRF, same-origin). "token" = a second account addressed by an API
 *  token on its own base URL (Authorization header only, no cookies, no CSRF). */
type KeClientMode = "session" | "token";

interface KeClientConfig {
  mode: KeClientMode;
  /** Base URL that paths resolve against. Defaults to the page origin in
   *  session mode; token clients must be given an explicit origin. */
  baseUrl?: string;
  /** API token. Only used in "token" mode. */
  token?: string;
}

interface KoboApiClient {
  mode: KeClientMode;
  baseUrl(): string;
  resolveUrl(path: string | null | undefined): string;
  request(url: string, options?: RequestOptions, retried?: boolean): Promise<unknown>;
  get<T = unknown>(url: string, options?: RequestOptions): Promise<T>;
  post<T = unknown>(url: string, options?: RequestOptions): Promise<T>;
  patch<T = unknown>(url: string, options?: RequestOptions): Promise<T>;
  delete<T = unknown>(url: string, options?: RequestOptions): Promise<T>;
}

interface KoboPagination {
  fetchAllByFilter<T>(filterUrl: string, onPage: (results: T[]) => void, signal?: AbortSignal): Promise<T[]>;
  fetchAllAssets(url: string, onPage: (page: Page<Project>) => void, signal?: AbortSignal): Promise<void>;
  sanitizeFilterUrl(raw: unknown): string | null;
}

interface KoboAssetsApi {
  fetchAsset(uid: UID, signal?: AbortSignal): Promise<Project>;
  setAssetActive(uid: UID, active: boolean, signal?: AbortSignal): Promise<unknown>;
  renameAsset(uid: UID, newName: string, signal?: AbortSignal): Promise<unknown>;
  updateAssetCountry(uid: UID, countries: CountryOption[], signal?: AbortSignal): Promise<unknown>;
  updateAssetSector(uid: UID, sector: SectorOption | KoboRecord, signal?: AbortSignal): Promise<unknown>;
  updateAssetDescription(uid: UID, description: string, signal?: AbortSignal): Promise<unknown>;
  updateAssetExtraMetadata(uid: UID, extraMetadata: ExtraMetadata, signal?: AbortSignal): Promise<unknown>;
  updateAssetTags(uid: UID, extraMetadata: ExtraMetadata, signal?: AbortSignal): Promise<unknown>;
}

interface KoboPermissionsApi {
  getPermissions(uid: UID, signal?: AbortSignal): Promise<unknown>;
  getPermissionAssignments(uid: UID, signal?: AbortSignal): Promise<PermissionAssignment[]>;
  shareAsset(uid: UID, username: string, permissionCode: string, signal?: AbortSignal): Promise<unknown>;
  removePermission(uid: UID, username: string, signal?: AbortSignal): Promise<unknown>;
  removeAsset(uid: UID, username: string, signal?: AbortSignal): Promise<unknown>;
  removePermissionAssignment(uid: UID, id: string, signal?: AbortSignal): Promise<unknown>;
}

interface KoboUsersApi {
  lookupUser(username: string, signal?: AbortSignal): Promise<User>;
  getCurrentUser(signal?: AbortSignal): Promise<User>;
}

interface KoboEnvironmentApi {
  fetchEnvironment(signal?: AbortSignal): Promise<EnvironmentResponse>;
}

interface KoboExportService {
  toCSV(rows: Array<Record<string, unknown>>, headers?: string[]): string;
  /** Report stage: materializes declared export specs into CSV UiFile[]. */
  buildCsvFiles(specs: Array<ReportFileSpec | null | undefined> | null | undefined): UiFile[];
  scalarFields(obj: Project | KoboRecord): Record<string, string | number | boolean | null>;
  unionKeys(rows: Array<Record<string, unknown>>): string[];
  download(filename: string, content: string, mime?: string): void;
  timestamp(): string;
  makeFilename(prefix: string, ext?: string): Promise<string>;
}

interface KoboScraper {
  getCurrentProjectUid(): string | null;
  getSelectedCheckboxUids(): UID[];
  getRowUid(row: Element | null): string | null;
  getRowCheckbox(row: Element | null): HTMLInputElement | null;
}

interface KoboSurveyCollections {
  resolveUids(opts: { filterUrl?: string | null; onProgress?: RunProgressHandler; signal?: AbortSignal }): Promise<UID[]>;
  collect(opts: { uidList?: UID[] | null; filterUrl?: string | null; onProgress?: RunProgressHandler; signal?: AbortSignal }): Promise<Project[]>;
}

interface KoboScopeService {
  normalizeUids(uids?: Array<UID | null | undefined> | null): UID[];
  resolveUids(opts: { uids?: UID[] | null; filterUrl?: string | null; signal?: AbortSignal; onProgress?: RunProgressHandler }): Promise<UID[]>;
  collect(opts: { uids?: UID[] | null; filterUrl?: string | null; signal?: AbortSignal; onProgress?: RunProgressHandler; raw?: boolean }): Promise<Project[]>;
}

interface KoboActionInterface {
  normalizeAction<
    TConfig extends ActionConfig = ActionRequest,
    TResultData extends ActionResultData = KoboRecord
  >(input: Action<TConfig, TResultData> | ActionParams<TConfig, TResultData> | KoboRecord, id: string): Action<TConfig, TResultData>;
  define<
    TConfig extends ActionConfig = ActionRequest,
    TResultData extends ActionResultData = KoboRecord
  >(params: ActionParams<TConfig, TResultData>): Action<TConfig, TResultData>;
  validateBase<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    def: Action<TConfig, TResultData>, context: ActionContext<TConfig, TResultData>
  ): Promise<ValidationIssue | string | null> | ValidationIssue | string | null;
  validateAccount<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    def: Action<TConfig, TResultData>, context: ActionContext<TConfig, TResultData>
  ): ValidationIssue | string | null;
  confirmBulk<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    def: Action<TConfig, TResultData>, context: ActionContext<TConfig, TResultData>
  ): ConfirmOptions;
  confirmAccount<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    def: Action<TConfig, TResultData>, context: ActionContext<TConfig, TResultData>
  ): ConfirmOptions;
  bulkSummary(def: Action, res: RunReport | KoboRecord | null | undefined): UiToast;
  fieldMessage(field: string): string;
  fieldSatisfied<TConfig extends ActionConfig = ActionRequest>(field: string, request: TConfig): boolean;
  FIELD_LABELS: Record<string, string>;
}

interface KoboActionRegistry {
  FIELD_SPECS: Record<string, { title: string }>;
  PERMISSIONS: Permission[];
  /** Kobo's permission hierarchy: base code -> every permission it implies. */
  PERMISSION_IMPLIES: Record<string, string[]>;
  FIELD_LABELS: Record<string, string>;
  register(id: string, entry: Action | ActionParams | KoboRecord): Action;
  get(value: string): Action | null;
  list(): string[];
  groups(): string[];
  permissionLabel(code: string): string;
  /** Collapses one user's expanded permission rows (what the API returns) back
   *  to the base code Kobo was originally asked for. Never escalates, never
   *  drops a code, passes unknown codes through. */
  reduceToBasePermissions(codes: string[]): string[];
  rowFor(std: ActionResult, base: KoboRecord): ReportRow;
  textOf(value: unknown): string;
  fieldsReady(required: string[], request: ActionRequest): boolean;
  ACTIONS: Action[];
}

interface ConfirmButtonGroup extends KoboRecord {}

interface KoboDomUtils {
  el(tag: string, attrs?: Record<string, unknown>, children?: unknown): HTMLElement;
}

interface ToastHandle {
  el: HTMLElement;
  dismiss(): void;
}

interface KoboUiComponents {
  PAGE_STYLES: string;
  showDialogInPage(message: string, hostEl?: HTMLElement | null): void;
  showConfirmDialogInPage(message: string, buttons: ConfirmButton[], hostEl?: HTMLElement | null, title?: string, details?: ConfirmDetails): Promise<unknown>;
  showToast(opts: string | ToastOptions): ToastHandle;
  dismissAllToasts(): void;
  showProgressToast(title: string): ProgressToastHandle;
  buildSpinner(size?: number): SVGSVGElement;
}

interface ProgressToastHandle {
  setTitle(text: string): void;
  setStep(text: string): void;
  setProgress(done: number, total: number): void;
  finish(): void;
}

/**
 * Centralized execution controls for one run. Owned by the execution layer
 * (core/execution/action.executor.ts) — actions describe WHAT to execute, they
 * never set timing or parallelism themselves. The executor resolves a single
 * policy per run from these defaults + the per-run `RunOptions.execution`
 * override, and applies it to every item loop (bulk AND account scans).
 *
 *   concurrency      max item operations executed concurrently (1 = strictly
 *                    sequential, the default and current behavior).
 *   itemDelayMs      pause between each successfully processed item (0 = none).
 *                    Replaces the old per-action `delayMs` knob.
 *   requestPacingMs  minimum gap between item START times, ms (0 = no pacing
 *                    beyond itemDelayMs). Rough request pacing for runs whose
 *                    items issue multiple requests (bulk: fetch+patch).
 */
interface KoboExecutionOptions {
  concurrency: number;
  itemDelayMs: number;
  requestPacingMs: number;
}

/** Config accepted by KE.actionExecutor.runItems — the generic per-item loop. */
interface RunItemsConfig<T, R> {
  items: T[];
  signal?: AbortSignal | null;
  execution?: KoboExecutionOptions;
  propagateAbort?: boolean;
  perItem: (item: T, index: number) => R | R[] | Promise<R | R[]> | null | undefined;
  onItemError?: (
    e: unknown,
    item: T,
    index: number
  ) =>
    | { rows?: R | R[]; action?: "continue" | "break" | "throw" }
    | Promise<{ rows?: R | R[]; action?: "continue" | "break" | "throw" }>
    | null
    | undefined;
  onAbort?: (remaining: T[]) => R | R[] | Promise<R | R[]> | null | undefined;
  /** Called (once per pause episode) when the loop parks on a pause, with the
   *  items still to process and the rows accumulated so far. */
  onPause?: (remaining: T[], processed: number, rows: R[]) => void;
  onProgress?: (done: number, total: number) => void;
}

/** The generic per-item loop, exposed where actions need to run sub-loops. */
interface KoboRunItems {
  <T, R>(config: RunItemsConfig<T, R>): Promise<{ processed: number; rows: R[]; stopped: boolean }>;
}

interface KoboActionExecutor {
  runItems: KoboRunItems;
  runAction(actionDef: Action | null | undefined, options: RunOptions): Promise<RunReport | AccountReport | void>;
  runBulkAction(actionDef: Action | null | undefined, options: RunOptions): Promise<RunReport | AccountReport | void>;
  abort(): void;
  /** Parks the active run between items (no-op when nothing is running). */
  pause(): void;
  /** Lifts a paused run so its loop continues where it parked. */
  resume(): void;
  /** True while the current run is parked on a pause. */
  isPaused(): boolean;
  setDefaultUi(ui: RunUiGateway): void;
  /** Adjusts the global execution defaults (concurrency/pacing) centrally. */
  setExecutionPolicy(policy: Partial<KoboExecutionOptions>): void;
  /** Returns a copy of the current global execution defaults. */
  getExecutionPolicy(): KoboExecutionOptions;
  /** Registers the run-history recorder; called after `onFinished` on every run. */
  setHistorySink(sink: (capture: RunHistoryCapture) => void): void;
}

interface RunOptions extends KoboRecord {
  ui?: RunUiGateway;
  /** Registered action id string (select value), resolved by the controller. */
  action?: string;
  wholeAccount?: boolean;
  uids?: UID[];
  source?: string;
  filterUrl?: string | null;
  resolveWholeAccount?: (signal: AbortSignal) => Promise<UID[]>;
  /** Per-run override of the centralized execution controls. Omitted fields fall back to the global defaults. */
  execution?: Partial<KoboExecutionOptions>;
  username?: string;
  users?: string[];
  permission?: string;
  templateId?: string;
  prefix?: string;
  suffix?: string;
  findText?: string;
  replaceText?: string;
  description?: string;
  countries?: CountryOption[];
  sectors?: SectorOption[];
  tags?: string[];
  tagsMode?: "append" | "remove" | "replace";
  sourceProject?: string;
  moveForms?: boolean;
  moveSubmissions?: boolean;
  transferReady?: boolean;
  onStarted?: (uids: UID[], def: Action) => void;
  onFinished?: (res: RunReport | AccountReport) => void;
  onProgress?: RunProgressHandler;
  onStatus?: (uid: UID, status: ProcessStatus, detail: string) => void;
  /** Called when the run loop parks on a pause (bulk runs). */
  onPaused?: (info: RunPauseInfo) => void;
  /** Skips the action's confirm dialog (used when resuming a previously confirmed paused run). */
  skipConfirm?: boolean;
  /** Progress offset for a resumed run: done/total counts of the pre-pause portion. */
  resumeOf?: { processed: number; total: number };
  /** Pre-pause accumulated report rows seeding a resumed run so the final report stays full. */
  seedRows?: ReportRow[];
}

interface RunUiGateway {
  alert(message: string): unknown;
  confirm(message: string, buttons: ConfirmButton[], title?: string, details?: ConfirmDetails): Promise<unknown>;
  toast(opts: string | ToastOptions): unknown;
}

interface KoboTagsColumn {
  refresh(...args: unknown[]): unknown;
  isVisible(): boolean;
  setVisible(visible: boolean): unknown;
  applyRunReport(report: ReportRow[]): void;
}

interface KoboFormSummaryTags {
  init(): void;
  render(...args: unknown[]): unknown;
}

interface KoboFormSummaryNotes {
  init(): void;
}

/** One grant inside a permission template: a user plus the single KoboToolbox
 *  permission code they should receive.
 *
 *  Kobo permissions are hierarchical — one code implies a set (see
 *  actionRegistry.PERMISSION_IMPLIES) — and its share UI stores only the base
 *  code, so a template stores the base code too. The assignment API answers
 *  with one row per IMPLIED permission (a "Manage project" user comes back as
 *  all eight rows), so the rows are reduced back to their base code before they
 *  reach a template: actionRegistry.reduceToBasePermissions(), called from the
 *  "create template from project" and JSON-import paths in ui/integration.ts. */
interface PermissionTemplateGrant {
  username: string;
  permission: string;
}

/** A reusable set of user→permission grants applied at run time. */
interface PermissionTemplate {
  id: string;
  name: string;
  grants: PermissionTemplateGrant[];
  updatedAt: number;
}

/** Persisted templates (localStorage) plus CRUD. */
interface KoboTemplatesService {
  list(): PermissionTemplate[];
  get(id: string): PermissionTemplate | null;
  save(tpl: PermissionTemplate): PermissionTemplate;
  create(name: string): PermissionTemplate;
  remove(id: string): void;
}

interface KoboIntegratedActions {
  readonly ACTIONS: Action[];
  readonly PERMISSIONS: Permission[];
  run(options: RunOptions): Promise<RunReport | AccountReport | void>;
  abort(): void;
}

interface KoboCollectForm {
  formID: string;
  name: string;
  majorMinorVersion: string;
  version: string;
  hash: string;
  descriptionText: string;
  downloadUrl: string;
  manifestUrl: string;
}

interface KoboCollectService {
  fetchFormList(username?: string, password?: string, signal?: AbortSignal): Promise<KoboCollectForm[]>;
  openPanel(): void;
}

/** Run history & audit log: persistence (features/history/history.store.ts)
 *  plus the modal panel (features/history/history.panel.ts). */
interface KoboRunHistoryService {
  /** Captures a finished run into the local log (user/ts/id are filled here). */
  record(capture: RunHistoryCapture): void;
  openPanel(): void;
  list(): RunHistoryEntry[];
  get(id: string): RunHistoryEntry | null;
  remove(id: string): void;
  clear(): void;
}

/** Pause & resume persistence (features/paused-run/paused-run.store.ts):
 *  a page-session snapshot in sessionStorage offered back as Resume on load. */
interface KoboPausedRunService {
  /** Persists the parked run's snapshot. Returns false when refused (too large / quota). */
  save(snapshot: PausedRunSnapshot | null | undefined): boolean;
  /** Reads the current page session's paused-run snapshot, or null. */
  load(): PausedRunSnapshot | null;
  /** Drops any saved paused-run snapshot for this page session. */
  clear(): void;
  /** True while the snapshot still belongs to this valid page session (same
   *  account + registered action + age within the session TTL). */
  valid(snapshot: PausedRunSnapshot | null | undefined): Promise<boolean>;
}

/** Internationalization (core/i18n/*).
 *
 *  The engine (core/i18n/i18n.ts) exposes KE.i18n; the English dictionary
 *  (core/i18n/locales/en.ts) is the source of truth for KEYS. `t()` is typed
 *  against EnDict, so any string used before it is added to the dictionary is
 *  a build error. Additional languages must be declared `LocaleDict`
 *  ({ [K in keyof EnDict]: string } & Record<string, string>), which makes a
 *  missing translation a compile error while still allowing the extra
 *  plural-form keys a richer language needs — adding a language = one locale
 *  file + one manifest line.
 *
 *  Key = the English template the code calls t() with (placeholders {name}).
 *  Plural forms read `${key}~${form}` via Intl.PluralRules per language
 *  (en/fr: ~one, ~other; ar adds ~zero ~two ~few ~many). */
interface EnDict {
  "Running... ({done}/{total})": string;
  "Paused — {done} of {total} done": string;
  "Paused": string;
  "{title}... running": string;
  "cancelled": string;
  "skipped": string;
  "run-shown~one": string;
  "run-shown~other": string;
  // core/actions/action-interface.ts — shared field/validation/confirm wording.
  "Enter a username.": string;
  "Add at least one user.": string;
  "Select a permission (required to share).": string;
  "Enter a prefix and/or a suffix.": string;
  "Enter the text to find.": string;
  "Enter the new description.": string;
  "Select at least one country.": string;
  "Select a sector.": string;
  "Enter at least one tag to append or remove.": string;
  "Enter or load a source project UID.": string;
  "Select or create a permission template.": string;
  "Complete the required field.": string;
  "Enter at least one valid project UID.": string;
  "No projects selected on the page.": string;
  "No projects to process.": string;
  "User not found": string;
  "Users not found": string;
  "Scope: Entire account (respecting current filters)": string;
  "Projects: {n}": string;
  "Confirm Bulk Action": string;
  "Run \"{label}\" on the entire account (respecting current filters)?": string;
  "Run \"{label}\" on {n} project(s)?": string;
  "Run on the entire account (respecting current filters)?": string;
  "Run on {n} selected project(s)?": string;
  "Cancel": string;
  "Run on entire account": string;
  "Run on {n}": string;
  "{label} stopped": string;
  "Stopped while preparing the project list.": string;
  "{label} failed": string;
  "{label} finished": string;
  "No projects found in the account (matching current filters).": string;
  "Completed": string;
  "Skipped": string;
  "Failed": string;
  "Cancelled": string;
  "No change made": string;
  "N/A": string;
  // core/execution/action.executor.ts — run-loop messages.
  "Select an action before running.": string;
  "Connection Lost": string;
  "stopped after {n} projects failed with HTTP {status}; this looks like an expired session, not a per-project problem": string;
  "Stopped by user": string;
  "{step}... ({done}/{total})": string;
  "{step}... ({done}/{total}) - {detail}": string;
  "submission ({n})": string;
  "The source project is archived, so the copy is archived too and cannot accept submissions": string;
  // core/scope/scope.service.ts — resolution progress.
  "Resolving projects... ({n})": string;
  "Fetching projects... ({n}/{total})": string;
  // core/actions/action-registry.ts — permission labels.
  "View form": string;
  "Edit form": string;
  "Manage project": string;
  "Add submissions": string;
  "View submissions": string;
  "Edit submissions": string;
  "Validate submissions": string;
  "Delete submissions": string;
  // S3 — action descriptor strings (labels, descriptions, groups, steps).
  "Permissions": string;
  "Project metadata": string;
  "Project status": string;
  "Settings": string;
  "Account tools": string;
  "Share with user(s)": string;
  "Remove user access": string;
  "Copy permissions from project": string;
  "Apply permission template": string;
  "Add prefix/suffix to names": string;
  "Replace text in names": string;
  "Update project country": string;
  "Update project sector": string;
  "Archive projects": string;
  "Unarchive projects": string;
  "Allow anonymous submissions": string;
  "Disallow anonymous submissions": string;
  "Update project description": string;
  "Manage tags": string;
  "Permission audit": string;
  "Check user access": string;
  "Country portfolio report": string;
  "Export project list": string;
  "Grant one or more users access to selected projects": string;
  "Revoke a user's access from selected projects": string;
  "Grant one project's collaborators onto the selected projects": string;
  "Grant a saved set of users their permissions on the selected projects": string;
  "Add a prefix and/or suffix to selected project names": string;
  "Find and replace text in selected project names": string;
  "Replace the country list on selected projects": string;
  "Set the sector on selected projects": string;
  "Deactivate selected projects and their deployments": string;
  "Reactivate selected archived projects": string;
  "Allow submitting to the selected projects without a username and password": string;
  "Require a username and password to submit to the selected projects": string;
  "Set or clear the description on selected projects": string;
  "Append, replace, or remove the tags on selected projects": string;
  "Review all permissions across your account's projects": string;
  "Scan your account for projects shared with a specific user": string;
  "Count projects per country across your account": string;
  "Export a CSV of your survey projects": string;
  "Sharing": string;
  "Removing access": string;
  "Copying permissions": string;
  "Applying permissions": string;
  "Renaming": string;
  "Replacing text": string;
  "Updating country": string;
  "Updating sector": string;
  "Archiving": string;
  "Unarchiving": string;
  "Saving setting": string;
  "Updating description": string;
  "Updating tags": string;
  "Auditing": string;
  "Checking access": string;
  "Reporting": string;
  "Exporting": string;
  "Running": string;
  "Fetching project list...": string;
  "Fetching projects...": string;
  "Text not found in name": string;
  "Countries already match selection": string;
  "Sector already matches selection": string;
  "Description unchanged": string;
  "Tags unchanged": string;
  "Enter a username to search for.": string;
  // S3 — per-action custom strings (confirmDetails, validate, execute messages).
  "Users: {users}": string;
  "Permission: {label}": string;
  "User: {username}": string;
  "Prefix: \"{value}\"": string;
  "Suffix: \"{value}\"": string;
  "Find: \"{value}\"": string;
  "Replace with: \"{value}\"": string;
  "Set countries: {values}": string;
  "Mode: Replace existing countries": string;
  "Set sector: {values}": string;
  "Mode: Replace existing sector": string;
  "Set description: \"{value}\"": string;
  "Clear description": string;
  "Mode: Archive (deactivate deployments)": string;
  "Mode: Unarchive (reactivate deployments)": string;
  "Mode: Allow anonymous submissions (on)": string;
  "Mode: Disallow anonymous submissions (off)": string;
  "Mode: Replace all existing tags": string;
  "Mode: Remove specified tags": string;
  "Mode: Append to existing tags": string;
  "Tags: {values}": string;
  "Source: {value}": string;
  "Collaborators: {n}": string;
  "Template: {name}": string;
  "Users: {n}": string;
  "Grants: {values}": string;
  "Grants: (empty)": string;
  "Source project not found": string;
  "The source project has no collaborators to copy.": string;
  "Source project skipped": string;
  "The selected permission template no longer exists.": string;
  "The template \"{name}\" has no users to share.": string;
  "No template grants to apply": string;
  "Already allowed": string;
  "Already disallowed": string;
  // S3 — account-scan reporting strings (progress, summaries, metrics).
  "Auditing permissions... ({done}/{total})": string;
  "Checking surveys... ({done}/{total})": string;
  "No surveys were found to audit.": string;
  "No surveys were found to check.": string;
  "No projects were found to report.": string;
  "Scanned": string;
  "Over-privileged": string;
  "Checked": string;
  "Shared": string;
  "Owned": string;
  "Countries": string;
  "Projects": string;
  "Errors": string;
  "Users": string;
  "Check user access — \"{username}\"": string;
  "Exported {n} project(s)": string;
  "{n} countries across {m} project(s)": string;
  "Export stopped.": string;
  "Export failed": string;
  // S4 — ui/integration.ts toolbar: buttons, tooltips, dialogs, field rows.
  "Show KoboCollect form list": string;
  "KoboCollect list is not available yet.": string;
  "KoboCollect survey list": string;
  "Select a bulk action to run": string;
  "Select action": string;
  "Run Action": string;
  "Run history and audit log": string;
  "Run history is not available yet.": string;
  "Run history": string;
  "Which projects to run the action on": string;
  "Selected projects": string;
  "By project UID(s)": string;
  "Entire account": string;
  "Run on the projects checked on this page": string;
  "Run on the project UIDs entered below": string;
  "Run on all projects in the account, respecting the current list filters": string;
  "Selected projects ({n})": string;
  "By project UID(s) ({n})": string;
  "Stop / Cancel": string;
  "Pause run": string;
  "Resume run": string;
  "Pause / Resume": string;
  "Download progress report": string;
  "Resume paused run": string;
  "Resume — {done} of {total} done": string;
  "Select or deselect all projects on this page": string;
  "Working...": string;
  "Resolving projects...": string;
  "Finished": string;
  "Download report": string;
  "Download {n} files": string;
  "This action is not available.": string;
  // S4 — field rows.
  "User:": string;
  "Username": string;
  "Users:": string;
  "Comma, space or line separated usernames": string;
  "Grant the permission to every listed user": string;
  "Permission:": string;
  "Permission": string;
  "e.g. \"SY | \"": string;
  "e.g. \" [ARCHIVED]\"": string;
  "Prefix:": string;
  "Suffix:": string;
  "Text to find": string;
  "Leave empty to remove": string;
  "Find:": string;
  "Replace with:": string;
  "Description:": string;
  "New description (replaces the current description)": string;
  "Tags:": string;
  "Append to, replace, or remove tags on selected projects": string;
  "Append": string;
  "Replace": string;
  "Remove": string;
  "Comma or line separated, e.g. meal, syria, cash. Empty in Replace mode removes all tags.": string;
  "Source project:": string;
  "Source project UID or form URL": string;
  "Permissions are copied from this project": string;
  "Use the UID of the single selected project": string;
  "Template:": string;
  "Saved permission template to apply": string;
  "Manage permission templates": string;
  "Create template from the selected project": string;
  "Country:": string;
  "Type to add countries...": string;
  "Type to search countries and click a suggestion to add it": string;
  "Sector:": string;
  "Select a sector...": string;
  "Select the project sector": string;
  "Project UID(s):": string;
  "Comma or line separated UIDs, e.g. aBCdEf1234, xYZqWs4567. Full form URLs are accepted.": string;
  "Loading...": string;
  "Remove {label}": string;
  "No sectors available": string;
  "Received no {noun} list from the server.": string;
  "Failed to load {noun}": string;
  "Could not load the {noun} list: {error}": string;
  "The project list filter is not valid.": string;
  // S4 — permission template manager.
  "Permission templates": string;
  "Save reusable user–permission sets, then apply them to many projects at once.": string;
  "No templates yet.": string;
  "New template": string;
  "Untitled template": string;
  "Import": string;
  "Export": string;
  "+ New template": string;
  "+ Add user": string;
  "Changes save automatically": string;
  "Stored in this browser": string;
  "Export or drop JSON to import": string;
  "Done": string;
  "Keep editing": string;
  "Discard changes": string;
  "Templates with no users": string;
  "Template with no users": string;
  "The templates {labels} have no users. Discard them, or keep editing?": string;
  "Template {labels} has no users. Discard it, or keep editing?": string;
  "Template name": string;
  "Delete template": string;
  "Delete template \"{name}\"? This cannot be undone.": string;
  "Delete": string;
  "Expand template": string;
  "Collapse template": string;
  "Remove user": string;
  "Duplicate user in this template": string;
  "Template renamed": string;
  "\"{name}\" was renamed to \"{saved}\" because the name is already in use.": string;
  "Select a template...": string;
  "No templates with users yet - create one to get started": string;
  "Import failed": string;
  "The selected file is not a valid templates JSON.": string;
  "Nothing to import": string;
  "No valid templates were found in the selected file.": string;
  "Templates imported": string;
  "Imported {count}.": string;
  "Imported {count}. {note}": string;
  "Rejected {count} (no valid permissions).": string;
  "count-users~one": string;
  "count-users~other": string;
  "count-templates~one": string;
  "count-templates~other": string;
  // S4 — template creation toasts.
  "No project selected": string;
  "Multiple projects selected": string;
  "Select exactly one project on the page to use as the source.": string;
  "Select exactly one project on the page to build a template from.": string;
  "No collaborators": string;
  "The selected project has no other collaborators to load into a template.": string;
  // S4 — pause / resume flow.
  "Too large to persist": string;
  "This pause can only be resumed in the current session; a page reload would lose it.": string;
  "No progress to download": string;
  "No projects have completed yet in this run.": string;
  "The run \"{label}\" was paused with {n} of {total} projects still to do. Continue it now?": string;
  "Resume": string;
  "Discard": string;
  "Resume \"{label}\" — {n} of {total} projects remain": string;
  "Paused run found": string;
  "\"{label}\" — {n} of {total} projects remain. Resume, download progress, or discard.": string;
  // S5 — shared components + feature panels (collect, history, notes, tags).
  "Download": string;
  "Dismiss": string;
  "Details": string;
  "Copy": string;
  "Copied": string;
  "Close": string;
  "Save": string;
  "Clear": string;
  "Notes": string;
  "Tags": string;
  "No surveys returned. Only deployed, collectable forms appear here.": string;
  "(untitled)": string;
  "Copy form name": string;
  "Version: {version}": string;
  "ID: {id}": string;
  "The surveys available to this account in the KoboCollect app.": string;
  "Leave username/password empty to use your own login.": string;
  "Account whose form list to load (empty = your own login)": string;
  "Password": string;
  "Password for the account above (empty = your own login)": string;
  "Reload list": string;
  "Loading the surveys...": string;
  "Fetching the KoboCollect form list...": string;
  "your account": string;
  "count-surveys~one": string;
  "count-surveys~other": string;
  "{count} loaded · account: {account}": string;
  "List is empty": string;
  "Load failed": string;
  "Could not load the form list.": string;
  "Sign-in failed": string;
  "Login as \"{user}\" was rejected. No list is shown.": string;
  "Could not load the KoboCollect list": string;
  "Session not authenticated for the KoboCollect endpoint.": string;
  "KoboCollect list request failed (HTTP {status}).": string;
  "Download the exact CSV of this run": string;
  "Every run of your bulk actions and account scans, recorded locally.": string;
  "Filter by action or user": string;
  "Filter the log by action name or user": string;
  "Delete all recorded runs": string;
  "Clear history": string;
  "Download log (CSV)": string;
  "No runs recorded yet · account: {user}": string;
  "No runs recorded yet": string;
  "No runs recorded yet. Run a bulk action or account scan to start the audit log.": string;
  "Delete all recorded runs? This cannot be undone.": string;
  "Delete all": string;
  "Clear run history": string;
  "Run history cleared": string;
  "All recorded runs were deleted.": string;
  "· account: {user}": string;
  "No note yet": string;
  "Edit note": string;
  "Add a note...": string;
  "Save note": string;
  "Clear note": string;
  "Cancel editing": string;
  "Discard unsaved changes to this note?": string;
  "Clear the note for this project? This cannot be undone.": string;
  "Could not determine the project UID": string;
  "Notes saved": string;
  "Saving note...": string;
  "Could not save notes": string;
  "Add a tag...": string;
  "Edit tags": string;
  "Remove {tag}": string;
  "No tags yet": string;
  "Tag \"{tag}\" already exists": string;
  "Saving tags...": string;
  "Tags saved": string;
  "Could not save tags": string;
  "Hide field": string;
  "Template name is required.": string;
  // Registry FIELD_SPECS titles (public metadata; keys so consumers can wrap).
  "target username": string;
  "permission": string;
  "prefix": string;
  "suffix": string;
  "text to find": string;
  "replacement text": string;
  "new description": string;
  "country selection": string;
  "sector selection": string;
  "tags": string;
  "source project UID or URL": string;
  "destination account": string;
  // Settings panel (toolbar gear button). The title reuses the "Settings"
  // key already declared above for the anonymous-submissions action group.
  "Language:": string;
  "Interface language": string;
  "Updates appear after a page refresh.": string;
  // Cross-account transfer (features/transfer/*).
  "Move projects to another account": string;
  "Copy projects and submissions into a second Kobo account": string;
  "Moving projects": string;
  "Destination account:": string;
  "Not set": string;
  "Set the destination account": string;
  "Form only": string;
  "Form + Submissions": string;
  "Move projects from {source} to {dest}": string;
  "Choose what to copy to the destination account.": string;
  "Destination account": string;
  "Enter the server and an API token for the account that will receive the copied projects.": string;
  "Server:": string;
  "Global": string;
  "EU": string;
  "API token:": string;
  "Paste the destination account's API token.": string;
  "Pick the server where the destination account is. Projects are copied to that account only.": string;
  "Save and test": string;
  "Testing the destination account...": string;
  "Destination account ready": string;
  "The token is never saved. You will be asked for it again each time you reload this page.": string;
  "Test and use": string;
  "Enter an API token.": string;
  "That is the token of the account you are signed in to. Enter the destination account's token instead.": string;
  "The API token was rejected.": string;
  "The destination server could not be reached.": string;
  "The extension background is unavailable. Reload the extension and try again.": string;
  "The destination server is not allowed.": string;
  "The test was cancelled.": string;
  "Could not use the destination account": string;
  "Set a destination account first.": string;
  "Select at least one of Forms or Submissions to copy.": string;
  "Submissions can only be copied into a project that already exists in the destination account.": string;
  "Destination: {dest}": string;
  "Copying: {what}": string;
  "Attachments are not copied.": string;
  "This project has no deployed form, so it cannot be copied.": string;
  "A project that was already moved is skipped instead of copied again.": string;
  "The destination account needs to be set up again before this can run.": string;
  "This project was already moved to {uid} on {date}.": string;
  "This project already exists in the destination as {name}; nothing was copied.": string;
  "This project was already moved to {uid}, but the destination could not be checked, so nothing was copied.": string;
  "This project has no form versions to copy.": string;
  "The destination project has no versions to deploy.": string;
  "The destination project has no deployed version.": string;
  "The destination project has no deployment ID.": string;
  "A project named {name} was created on the destination with ID {uid}.": string;
  "The incomplete project \"{name}\" was deleted from the destination.": string;
  " The incomplete project could not be deleted ({reason}); remove it manually.": string;
  "The destination project has no deployed version, so submissions cannot be copied.": string;
  "The source account's submission list did not end.": string;
  "The source account reported {count} submissions but none could be read.": string;
  "{versions} form versions deployed": string;
  "{versions} form versions copied, then archived to match the source": string;
  "The project could not be archived, so it is still live on the destination ({reason})": string;
  "{copied} media files copied": string;
  "{count} media files could not be copied: {names}": string;
  "{created} submissions copied": string;
  "{count} were already there": string;
  "{count} could not be copied": string;
  "Rejected submissions: {details}": string;
  "{count} submissions the source reported were never read": string;
  "Stopped copying submissions after {n} consecutive rejections ({status}). Re-run this project once that is fixed.": string;
  "The source listed {declared} and {read} were read": string;
  "This project was copied, but KoboEnhance could not remember that, so a re-run would copy it again.": string;
  // features/transfer/transfer.settings panel — source account + destination.
  "Transfer settings": string;
  "KoboEnhance copies projects between two Kobo accounts. Your source account is read from this page; the destination is set here.": string;
  "Source account (this page)": string;
  "Source account API token:": string;
  "Reading your API token...": string;
  "Show": string;
  "Hide": string;
  "Read again": string;
  "Show the source account token": string;
  "Read your API token again": string;
  "Read from your signed-in account. Transfers read the source with this token, so a run survives a session that ends mid-way. It is kept in memory only and is never saved.": string;
  "This Kobo server does not publish an API token, so KoboEnhance will use your signed-in session instead.": string;
  "Your signed-in session did not return an API token, so KoboEnhance will use the session itself instead.": string;
  "Your account returned an empty API token, so KoboEnhance will use your signed-in session instead.": string;
  "Your API token could not be read, so KoboEnhance will use your signed-in session instead.": string;
  // features/transfer/transfer.preflight.ts — the pre-run counts and allowance.
  "Checking what this run will copy...": string;
  "Counting the projects in this run...": string;
  "Resolving the projects in this view...": string;
  "Reading the projects in this run...": string;
  "Counting the submissions to copy...": string;
  "Counting the submissions to copy... ({done}/{total})": string;
  "Checking the destination's allowance...": string;
  "Checking the destination's projects...": string;
  "{count} project was already moved to this destination and will be skipped": string;
  "{count} projects were already moved to this destination and will be skipped": string;
  "{count} project already exists in the destination with the same name and will be skipped": string;
  "{count} projects already exist in the destination with the same name and will be skipped": string;
  "The destination's project list could not be read, so only projects remembered from earlier runs were checked.": string;
  "The destination's allowance could not be read ({reason}).": string;
  "The destination's allowance resets on {date}.": string;
  "The destination is already over its submission allowance for this period.": string;
  "The destination has less allowance than this run needs: {shortfall} submissions would be refused.": string;
  "Copying will continue and stop each project when the destination refuses submissions.": string;
  "KoboEnhance could not check the copy size or the destination's allowance.": string;
  // Confirm-dialog fact labels (label/value rows, so no trailing colon).
  "Destination": string;
  "Copying": string;
  "Projects to copy": string;
  "Submissions to copy": string;
  "Destination allowance": string;
  "Unlimited": string;
  "Not counted": string;
  "{remaining} of {limit} left": string;
  "The destination has used {used} of its {limit} submissions this period.": string;
  "No projects are in scope for this run.": string;
  "Every project here has already been moved to this account, so this run would copy nothing.": string;
  "The source's submission counts could not be read, so the copy could not be compared against the allowance.": string;
  // core/errors/guard.ts — startup failure and uncaught-error wording.
  "KoboEnhance could not start": string;
  "KoboEnhance hit an unexpected error. Reload the page to try again.": string;
  "Reload": string;
  "Copy diagnostics": string;
  "Diagnostics copied": string;
  "Could not copy diagnostics": string;
  "The error details stay in this browser. Nothing is sent anywhere.": string;
}

/** Any additional language dictionary: must cover every EnDict key. */
type LocaleDict = { [K in keyof EnDict]: string } & Record<string, string>;

interface KoboI18n {
  /** Current language code (always a registered locale). */
  readonly lang: string;
  getLang(): string;
  /** Switches the active dictionary, persists the choice (localStorage
   *  "ke:lang") and re-translates [data-i18n] nodes. No-op for an unknown
   *  (not yet registered) language. */
  setLang(lang: string): void;
  /** Every registered language code, in registration order. The Settings
   *  panel builds its language selector from this list. */
  locales(): string[];
  /** Registers a language dictionary; called once per locale module. */
  registerLocale(lang: string, dict: LocaleDict): void;
  /** Looks up a key in the active language, substituting {name} placeholders.
   *  Falls back to the key itself (the English template) when absent. */
  t(key: keyof EnDict, vars?: Record<string, string | number>): string;
  /** Plural-aware lookup: applies Intl.PluralRules(lang).select(n), reads
   *  `${key}~${form}` in the active language, falling back to the en forms
   *  then the key itself. */
  tP(key: string, n: number): string;
  /** Re-translates [data-i18n] text and [data-i18n-title] tooltips under
   *  root (whole document when omitted). */
  apply(root?: HTMLElement | Document | null): void;
}

/** The aggregate namespace carried by window.KoboEnhance. */
interface KoboEnhanceGlobal {
  i18n: KoboI18n;
  store: KoboStore;
  errors: KoboErrors;
  auth: KoboAuthService;
  apiClient: KoboApiClient;
  /** Builds additional clients (e.g. a token client for a second account).
   *  KE.apiClient is itself createApiClient({ mode: "session" }). */
  createApiClient: (config: KeClientConfig) => KoboApiClient;
  pagination: KoboPagination;
  apiAssets: KoboAssetsApi;
  apiPermissions: KoboPermissionsApi;
  apiUsers: KoboUsersApi;
  apiEnvironment: KoboEnvironmentApi;
  scraper: KoboScraper;
  exportSvc: KoboExportService;
  surveys: KoboSurveyCollections;
  scopeService: KoboScopeService;
  dom: KoboDomUtils;
  components: KoboUiComponents;
  actionInterface: KoboActionInterface;
  actionRegistry: KoboActionRegistry;
  actionExecutor: KoboActionExecutor;
  integratedActions: KoboIntegratedActions;
  tagsColumn: KoboTagsColumn;
  formSummaryTags: KoboFormSummaryTags;
  formSummaryNotes: KoboFormSummaryNotes;
  templates: KoboTemplatesService;
  transferTransport: KoboTransferTransport;
  transferState: KoboTransferStateBackend;
  transferDestination: KoboTransferDestinationStore;
  transferSourceAccount: KoboTransferSourceAccount;
  transferUsage: KoboTransferUsage;
  transferSource: KoboTransferSourceApi;
  transferDest: KoboTransferDestApi;
  transferSubmissionsXml: KoboTransferSubmissionsXml;
  transferMapping: KoboTransferMappingStore;
  transferPipeline: KoboTransferPipeline;
  transferPreflight: KoboTransferPreflight;
  transfer: KoboTransferPanelService;
  collect: KoboCollectService;
  history: KoboRunHistoryService;
  pausedRun: KoboPausedRunService;
  diagnostics: KoboDiagnostics;
  integration: { init(): void };
}
