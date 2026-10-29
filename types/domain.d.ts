/**
 * types/domain.d.ts — the KoboEnhance domain model.
 *
 * Global (ambient) declarations usable by every extension script without any
 * import, because the extension ships as classic content scripts attached to
 * the window.KoboEnhance namespace (see types/global.d.ts). Runtime shapes are
 * defined once here and referenced across the API layer, the action contract,
 * the executor, and the report/export layer.
 *
 * Kobo's own API responses are dynamic; known fields are typed explicitly and
 * everything else stays `unknown` (see KoboRecord), so consumers must narrow
 * with type guards instead of assuming data shape.
 */

/** A Kobo asset UID ("a" + ~22 base62-ish characters). */
type UID = string;

/** Open JSON surface returned by Kobo APIs. Unknown fields stay `unknown`. */
interface KoboRecord {
  [key: string]: unknown;
}

type AssetKind = "survey" | "asset" | "template" | "block" | "question" | "collection";

interface CountryOption extends KoboRecord {
  value: string;
  label?: string;
}

interface SectorOption extends KoboRecord {
  value: string;
  label?: string;
}

interface ExtraMetadata extends KoboRecord {
  tags?: string[];
  notes?: string;
}

/** The `settings` object a Project carries on Kobo API v2. */
interface ProjectSettings extends KoboRecord {
  name?: string;
  description?: string;
  country?: CountryOption[];
  sector?: SectorOption;
  extra_metadata?: ExtraMetadata;
}

/** A Kobo survey project. */
interface Project extends KoboRecord {
  uid: UID;
  url?: string;
  name?: string;
  asset_type?: AssetKind | string;
  owner__username?: string;
  owner?: { username?: string } | null;
  date_created?: string;
  date_modified?: string;
  settings?: ProjectSettings;
}

/** A Kobo account user. */
interface User extends KoboRecord {
  url?: string;
  username?: string;
  email?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
}

/** One entry in Kobo's permission catalog (code + human label). */
interface Permission extends KoboRecord {
  code: string;
  label: string;
}

/** Normalized collaborator pair from a permission-assignment payload. */
interface PermissionAssignment extends KoboRecord {
  id?: string;
  username: string;
  permissionCode: string;
}

/** A paginated Kobo list response. */
interface Page<T> extends KoboRecord {
  count: number;
  next?: string | null;
  previous?: string | null;
  results: T[];
}

/** /api/v2/environment/ response. Country/sector choices come as [value, label] pairs. */
interface EnvironmentResponse extends KoboRecord {
  country_choices?: Array<Array<string>>;
  sector_choices?: Array<Array<string>>;
}

/** The navigation/selection context KE.store keeps for the current page. */
interface PageContext {
  currentProjectUid?: UID | null;
  selectedUids?: UID[];
  lastFilterUrl?: string | null;
  filterParams?: Record<string, string>;
}

/** In-memory state returned/exposed by KE.store. */
interface KoboStoreState {
  pageContext: PageContext;
}

// ---------------------------------------------------------------------------
// Action contract (core/actions/action-interface.js)
// ---------------------------------------------------------------------------

type ActionKind = "bulk" | "account" | "panel";

/** Standardized outcome status of one processed project / an action run. */
type ActionStatus = "success" | "skipped" | "failed" | "cancelled";

/** Live per-project status shown by the toolbar during a run. */
type ProcessStatus = ActionStatus | "idle" | "running";

/** Which projects an action targets. */
type ActionScope = "selected" | "whole_account";

/**
 * Upper bound for an action's configuration/input type parameter (TConfig).
 * Feature modules declare a lean, action-specific TConfig that narrows the
 * request to exactly the fields the action reads.
 */
type ActionConfig = object;

/**
 * Upper bound for an action's result-data type parameter (TData).
 * Bulk actions use it for the per-project `data` payload (its keys become the
 * extra CSV report columns); account scans use it for their whole run result.
 */
type ActionResultData = object;

/**
 * The per-run input the executor assembles for an action (the union of every
 * toolbar field). It is the default TConfig of the SHARED (erased) descriptors;
 * feature actions see only their own narrowed config type.
 */
interface ActionRequest extends KoboRecord {
  username: string;
  usernames: string[];
  permission?: string;
  templateId: string;
  prefix: string;
  suffix: string;
  findText: string;
  replaceText: string;
  description: string;
  countries: CountryOption[];
  sectors: SectorOption[];
  tags: string[];
  tagsMode: "append" | "remove" | "replace";
  sourceProject?: string;
  /** Cross-account transfer: what the user chose to copy. */
  moveForms?: boolean;
  moveSubmissions?: boolean;
  /**
   * True when a destination account has been validated and stored. Used only to
   * gate the Run button and the run summary. The destination token is
   * deliberately NOT part of the request: it stays in the destination store
   * (session storage) and is read at execution time.
   */
  transferReady?: boolean;
}

type RunProgressHandler = (message: string, done: number, total: number) => void;

/**
 * The curated runtime an action consumes during execution. The executor
 * assembles it ONCE per run from the shared services and hands it to every
 * context (validate/confirm/execute). It deliberately carries ONLY the
 * capabilities actions actually call at run time — it is NOT the whole
 * window.KoboEnhance namespace and must not grow into a service locator:
 * add an entry here only when one of the actions demonstrably needs it
 * while executing.
 */
interface ActionRuntime {
  /** The platform APIs actions write through. */
  api: {
    assets: KoboAssetsApi;
    permissions: KoboPermissionsApi;
    users: KoboUsersApi;
  };
  /** Scope resolution/collection (account scans, whole-account runs). */
  scope: KoboScopeService;
  /** Paginated asset listing (whole-account export/report loops). */
  pagination: KoboPagination;
  /** Own-account details needed by scans/exports. */
  auth: {
    baseUrl: string;
    getUsername(): Promise<string>;
  };
  /** The permission catalog (code -> label lookups while reporting). */
  permissions: Permission[];
  /**
   * The resolved execution policy for THIS run (concurrency + pacing), decided
   * centrally by the executor. Sub-loops should not set their own timing.
   */
  execution: KoboExecutionOptions;
  /** The shared per-item execution loop (account scans). */
  runItems: KoboRunItems;
  /** Reporting helpers consumed while building export rows. */
  report: {
    scalarFields(obj: Project | KoboRecord): Record<string, string | number | boolean | null>;
  };
}

/** Execution context passed to validate/confirm (and, for account kind, to execute). */
interface ActionContext<
  TConfig extends ActionConfig = ActionRequest,
  TResultData extends ActionResultData = KoboRecord
> {
  def: Action<TConfig, TResultData>;
  action: string;
  source: string;
  wholeAccount: boolean;
  uids: UID[];
  filterUrl?: string | null;
  resolveWholeAccount?: (signal: AbortSignal) => Promise<UID[]>;
  request: TConfig;
  signal?: AbortSignal;
  runtime: ActionRuntime;
}

/** Per-project context handed to a bulk action's execute(ctx). */
interface ItemContext<TConfig extends ActionConfig = ActionRequest> {
  uid: UID;
  signal: AbortSignal;
  request: TConfig;
  runtime: ActionRuntime;
  /**
   * Publishes a short progress detail for the project being processed, appended
   * to the run's step line (e.g. "Moving projects... (0/3) - submission (42)").
   * Called as often as useful during a long inner loop, so the toast keeps
   * moving. Optional: most actions never need it.
   */
  onStep?: (detail: string) => void;
}

/** Whole-run context handed to an account-kind action's execute(context). */
interface AccountExecuteContext<
  TConfig extends ActionConfig = ActionRequest,
  TResultData extends ActionResultData = KoboRecord
> {
  uidList: UID[] | null;
  filterUrl?: string | null;
  signal: AbortSignal;
  onProgress?: RunProgressHandler;
  request: TConfig;
  def: Action<TConfig, TResultData>;
  runtime: ActionRuntime;
}

/**
 * The standardized result model of one processed project, returned by a bulk
 * action's execute AND its formatResult. Every field here is SHARED by all
 * actions:
 *
 *   - uid / projectName    which project was processed
 *   - unchanged / status   success/failure information
 *   - message / error      human-readable outcome details
 *   - data?: TData         the action-specific result payload
 *
 * TData holds ONLY the action-specific result information (e.g. the changed
 * metadata of a metadata action, the share/remove outcome of a permission
 * action, or a report's own structured rows). Its keys become the extra CSV
 * report columns (see core/actions/action-registry.ts rowFor).
 *
 * ActionResult describes execution/business results only. Presentation is a
 * separate stage: bulk reports are flattened by the executor + rowFor and
 * formatted to CSV by exportSvc; account scans declare export intent as
 * ReportFileSpec[] (rows + columns) that the executor materializes via
 * exportSvc.buildCsvFiles before report.summary builds the finished UI
 * (toasts, dialogs, downloadable files).
 */
interface ActionResult<TData extends ActionResultData = KoboRecord> extends KoboRecord {
  uid?: UID;
  projectName?: string;
  /** True when the project was already in the requested state (mapped to status "skipped"). */
  unchanged?: boolean;
  status?: ActionStatus;
  message?: string;
  error?: string;
  data?: TData;
}

/** Result object returned by an account-kind scan. */
interface ScanResult extends KoboRecord {
  stopped?: boolean;
  error?: string | null;
  /**
   * Declared export data of the scan (rows + the columns to emit). This is
   * EXECUTION intent only — it contains no CSV formatting. The report stage
   * (core/export/export.service.js buildCsvFiles) materializes each spec into
   * a CSV `UiFile` before the action's report.summary builds the UI.
   */
  files?: ReportFileSpec[];
}

interface ValidationIssue extends KoboRecord {
  message?: string;
  toast?: ToastOptions;
}

interface ConfirmButton {
  label: string;
  value: unknown;
  primary?: boolean;
  destructive?: boolean;
}

/** One label/value row of a confirm dialog's fact block. */
interface ConfirmFact {
  label: string;
  value: string;
}

/**
 * The detail under a confirm dialog's question, STRUCTURED.
 *
 * A bulk run's detail is a handful of numbers the user scans before saying yes
 * ("3 projects, 12,000 submissions, 4,378 of 5,000 allowance left"), plus the
 * caveats that apply. Handing the dialog a string list and letting CSS add
 * newlines between them — which is what it used to do — renders all of that as
 * one undifferentiated paragraph: the numbers stop being scannable and the
 * warnings stop looking like warnings.
 *
 * So the parts are named:
 *   facts     label -> value rows, rendered as an aligned grid
 *   warnings  what the run will refuse or cannot do, rendered as alert rows
 *   notes     standing conditions ("attachments are not copied")
 */
interface ConfirmDetails {
  facts?: ConfirmFact[];
  warnings?: string[];
  notes?: string[];
}

interface ConfirmOptions {
  message: string;
  buttons: ConfirmButton[];
  title: string;
  /** Structured detail; when present the dialog renders it as a styled block. */
  details?: ConfirmDetails;
}

// ---------------------------------------------------------------------------
// Reports & UI payloads (core/export/export.service.js + ui/components.js)
// ---------------------------------------------------------------------------

/** A flattened CSV report row (stable base columns + action data columns). */
interface ReportRow extends KoboRecord {
  Project_UID?: string;
  Project_Name?: string;
  Action?: string;
  Permission?: string;
  Target_User?: string;
  Final_Status?: string;
  Error_Details?: string;
  Timestamp?: string;
}

/**
 * Declared export intent of an execution result: structured rows plus the
 * columns to emit. Contains NO presenting/formatting logic — the report stage
 * (exportSvc.buildCsvFiles) materializes this into a CSV `UiFile`, and future
 * JSON/Excel exporters could consume the same spec.
 */
interface ReportFileSpec extends KoboRecord {
  /** Download filename stem (the UI stamps it with user + timestamp). */
  filename: string;
  rows: Array<Record<string, unknown>>;
  /** Explicit header order; defaults to the union of row keys. */
  columns?: string[];
}

interface UiMetric {
  label: string;
  value: number;
  tone?: string;
}

interface UiFile {
  filename: string;
  csv: string;
}

/** Toast payload understood by KE.components.showToast. */
interface ToastOptions extends KoboRecord {
  type?: string;
  title?: string;
  description?: string;
  duration?: number;
  metrics?: UiMetric[];
  action?: { label?: string; onClick?: () => unknown } | null;
}

/** The `ui` produced by an action's report.summary and rendered by integration. */
interface UiToast extends ToastOptions {
  files?: UiFile[];
}

interface UiDialog {
  dialog?: unknown;
  type?: string;
  title?: string;
  description?: string;
  metrics?: UiMetric[];
  files?: UiFile[];
}

type RunFinishedUi = UiDialog | UiToast | null;

/** The finished payload a bulk run hands to onRunFinished. */
interface RunReport {
  action: string;
  actionLabel: string;
  kind: ActionKind;
  successCount?: number;
  failCount?: number;
  cancelCount?: number;
  skipCount?: number;
  report?: ReportRow[];
  csv?: string;
  ui: RunFinishedUi;
  stopped?: boolean;
  empty?: boolean;
  error?: string | null;
}

/** An account scan's own result, summarized by its report.summary. */
interface AccountReport {
  action: string;
  actionLabel: string;
  kind: "account";
  report?: ScanResult;
  ui: RunFinishedUi;
  stopped?: boolean;
  empty?: boolean;
  error?: string | null;
}

/**
 * A registered feature action. TConfig is the action's input/config type (what
 * the executor hands validate/confirm/execute); TResultData is the action's
 * result-data type (per-project `data` payload for bulk actions, the whole-run
 * result for account scans).
 *
 * The registry and the executor type this as the erased base
 * Action<ActionRequest, KoboRecord> so any registered action can run without
 * knowing its specific types.
 */
interface Action<
  TConfig extends ActionConfig = ActionRequest,
  TResultData extends ActionResultData = KoboRecord
> extends KoboRecord {
  id: string;
  value: string;
  kind: ActionKind;
  group: string;
  label: string;
  description: string;
  tip: string;
  icon: string;
  fields: string[];
  uiFields: string[];
  requiredFields: string[];
  stepLabel: string;
  loadingStep: string;
  skipReason: string | null;
  report?: {
    slug?: string;
    columns?: string[];
    summary?: (res: KoboRecord | TResultData, def?: Action<TConfig, TResultData>) => RunFinishedUi;
  };
  validate: (context: ActionContext<TConfig, TResultData>) => Promise<ValidationIssue | string | null> | ValidationIssue | string | null;
  confirm: (context: ActionContext<TConfig, TResultData>) => Promise<ConfirmOptions> | ConfirmOptions;
  execute: (ctx: ItemContext<TConfig> | AccountExecuteContext<TConfig, TResultData>) => Promise<ActionResult<TResultData> | ScanResult> | ActionResult<TResultData> | ScanResult;
  readAction?: Action<TConfig, TResultData>["execute"];
  formatResult: (result: ActionResult<TResultData> | ScanResult, ctx?: ItemContext<TConfig>) => ActionResult<TResultData>;
  permissionOut: (request: TConfig) => string;
  targetUserOut: (request: TConfig) => string;
  confirmDetails?: (context: ActionContext<TConfig, TResultData>) => string[];
  /**
   * The SAME detail as `confirmDetails`, structured for the dialog: facts,
   * warnings and notes. When an action provides this it is what the dialog
   * renders, and `confirmDetails` is ignored (the two describe one thing; this
   * is the richer form). Actions that only know how to produce a line list keep
   * working exactly as before.
   */
  confirmDetailsBlock?: (context: ActionContext<TConfig, TResultData>) => ConfirmDetails | null;
  reportSlug?: string;
  reportFields?: string[];
  fieldMessages?: Record<string, string>;
}

/**
 * The partial descriptor feature modules pass to actionInterface.define /
 * actionRegistry.register before normalizeAction fills the defaults. TConfig
 * and TResultData mirror the action the module is authoring.
 */
type ActionParams<
  TConfig extends ActionConfig = ActionRequest,
  TResultData extends ActionResultData = KoboRecord
> = Partial<Action<TConfig, TResultData>> & KoboRecord;

// ---------------------------------------------------------------------------
// Run history & audit log (features/history/history.store.ts + history.panel.ts)
// ---------------------------------------------------------------------------

type RunHistoryOutcome = "success" | "error" | "stopped" | "empty";

/**
 * One recorded run in the local audit log. Index rows are always kept (action,
 * time, user, counts, settings); the exact bulk-run CSV is only kept for the
 * most recent entries (dropped oldest-first under the storage budget). Never
 * contains credentials or the finished `ui` payload.
 */
interface RunHistoryEntry extends KoboRecord {
  id: string;
  /** Milliseconds since epoch. */
  ts: number;
  /** Registered action id. */
  action: string;
  actionLabel: string;
  kind: "bulk" | "account";
  /** Signed-in username at run time. */
  user: string;
  source?: string;
  scope?: { projectCount: number; wholeAccount: boolean };
  /** Bulk-only outcome counts (undefined for scans and bare early returns). */
  counts?: { success: number; failed: number; cancelled: number; skipped: number };
  outcome: RunHistoryOutcome;
  error?: string;
  /** Sanitized `ActionRequest` snapshot (identifiers only, no credentials). */
  settings: ActionRequest;
  /** Exact bulk-run CSV columns + rows, kept only while the budget allows. */
  details?: { headers: string[]; rows: Array<Record<string, string>>; csv: string };
}

/** What a run recording needs at capture time (executor provides it). */
type RunHistoryCapture = Omit<RunHistoryEntry, "id" | "ts" | "user">;

// ---------------------------------------------------------------------------
// Pause & resume (core/execution/action.executor.ts + features/paused-run)
// ---------------------------------------------------------------------------

/** Progress info handed to RunOptions.onPaused while a run is parked. */
interface RunPauseInfo {
  /** Items still to process (the currently in-flight one is excluded). */
  remaining: UID[];
  /** Items already completed (mirrors rows.length for bulk runs). */
  processed: number;
  /** Total items of the run. */
  total: number;
  /** Flattened report rows accumulated so far — a strict prefix of the final report (items run in order). */
  rows: ReportRow[];
}

/**
 * A parked run's page-session snapshot (sessionStorage["ke:pausedRun"]), written
 * when the loop parks and read back on the next page load to offer Resume while
 * the tab session is still valid. settings is the sanitized run request (no
 * credentials by construction); rows seed the resumed run so the final report
 * stays the full report "as if never paused".
 */
interface PausedRunSnapshot extends KoboRecord {
  /** Snapshot format version (must be 1). */
  v: 1;
  /** Milliseconds since epoch. */
  ts: number;
  /** Signed-in username at pause time (empty string if unknown then). */
  user: string;
  /** Kobo base URL at pause time. */
  baseUrl: string;
  /** Registered action id. */
  action: string;
  source: string;
  wholeAccount?: boolean;
  filterUrl?: string | null;
  settings: ActionRequest;
  remaining: UID[];
  processed: number;
  total: number;
  rows: ReportRow[];
}