/**
 * types/transfer.d.ts — types shared by the cross-account transfer feature.
 *
 * These are ambient declarations (never emitted), so the service worker
 * (core/transfer/transport.sw.ts) and the content-script-side callers
 * (core/transfer/*.ts, features/transfer/*.ts) share one contract even though
 * neither can import from the other: the project compiles with "module": "none"
 * and the worker runs in a separate global scope.
 *
 * The service worker exists because Kobo sends no Access-Control-Allow-Origin on
 * the KC host, so a cross-origin POST of submission XML from the page (or from an
 * MV3 content script) is impossible. A background service worker with
 * host_permissions is not bound by CORS. Verified 2026-09-30; see the README
 * section "Move projects to another account".
 */

// ---------------------------------------------------------------------
// Destination account
// ---------------------------------------------------------------------

/** The two official KoboToolbox servers we support in v1. */
type TransferServerId = "global" | "eu";

interface TransferServerInfo {
  id: TransferServerId;
  /** kf host: assets, deployments, form media, submission data. */
  kfUrl: string;
  /** kc host: OpenRosa submission endpoint (a different origin from kf). */
  kcUrl: string;
  label: string;
}

/** Non-secret description of the destination account. The API token is never
 *  part of this object and never goes into run history. */
interface TransferDestination {
  server: TransferServerId;
  kfUrl: string;
  kcUrl: string;
  /** Username resolved from the token at validation time, for the row-2 label. */
  username: string;
  /** Epoch ms of the last successful validation. */
  validatedAt: number;
}

/** What the user chose to move. v1 has no attachments option by design. */
interface TransferOptions {
  moveForms: boolean;
  moveSubmissions: boolean;
}

/** Per-project outcome, surfaced as the bulk action's report row data. */
interface TransferCounters {
  destUid: UID;
  /** Versions written AND activated on the destination. Zero for an archived
   *  copy, which is written but deliberately not activated. */
  versionsDeployed: number;
  /** Versions written to the destination, activated or not. */
  versionsWritten: number;
  /** True when the source had no live form, so the copy is archived at the end of
   *  the transfer to match it. */
  isArchivedCopy: boolean;
  /** True when that final archive step was refused. The copy itself succeeded —
   *  only the last state change did not apply. */
  archiveFailed: boolean;
  /** Why the archive was refused, for the report. */
  archiveError?: string;
  formMediaFiles: number;
  submissionsCreated: number;
  submissionsDuplicate: number;
  submissionsFailed: number;
  /** Up to five rejected submissions as "<instanceId> (HTTP <status>: <reason>)",
   *  so a partial copy explains itself instead of only counting failures. */
  submissionFailures: string[];
  /** Set when the source's own `<count>` was higher than the number of rows the
   *  walk actually read, meaning submissions were dropped before posting. */
  submissionReadShortfall?: number;
  /** The source's own `<count>` from data.xml, and how many rows the walk
   *  actually produced. Always reported, because "declared 8 / read 8 / posted
   *  6" and "declared 8 / read 6 / posted 6" are indistinguishable from the
   *  other counters and need opposite fixes. */
  submissionsDeclared?: number;
  submissionsRead?: number;
  /** True when the submissions walk was abandoned because the same rejection
   *  repeated too many times in a row — a condition that will not improve, so
   *  continuing would only generate more failed rows. The form itself is still a
   *  success. */
  submissionsAborted?: boolean;
  submissionAbortStatus?: string;
  submissionAbortReason?: string;
}

/** Why a destination could not be used. Codes, not sentences — the panel maps
 *  these to localized text, so the store stays free of i18n. */
type TransferValidationFailure =
  | "token-empty"
  | "token-is-source"
  | "token-rejected"
  | "host-blocked"
  | "unreachable"
  | "no-background"
  | "cancelled"
  | "unknown";

interface TransferValidationResult {
  ok: boolean;
  /** Present only on success; already normalized (URLs re-derived from server). */
  destination?: TransferDestination;
  failure?: TransferValidationFailure;
  httpStatus?: number;
}

/**
 * Shared storage for the transfer feature's non-secret state.
 *
 * Backed by `chrome.storage.local`, which is extension-scoped and cleared when
 * the extension is uninstalled — unlike a content script's `localStorage`, which
 * belongs to the page's origin and survives an uninstall. Reads are synchronous
 * off an in-memory cache; `ready()` must be awaited before the first render.
 */
interface KoboTransferStateBackend {
  read(key: string): unknown;
  ready(keys: string[]): Promise<void>;
  write(key: string, value: unknown): Promise<boolean>;
  remove(key: string): Promise<void>;
  name(): "extension" | "page";
}

/** Content-script client for the background service worker. Every method takes
 *  the destination token explicitly; the store owns the token, not this. */
interface KoboTransferTransport {
  checkAccount(token: string, kfUrl: string, signal?: AbortSignal): Promise<KeSwResponse>;
  getJson(
    token: string,
    url: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<KeSwResponse>;
  mutateJson(
    token: string,
    url: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    payload: unknown,
    signal?: AbortSignal
  ): Promise<KeSwResponse>;
  postForm(
    token: string,
    url: string,
    fields: Record<string, string>,
    signal?: AbortSignal
  ): Promise<KeSwResponse>;
  /** Form-encoded PATCH, which is how Kobo's own UI archives a deployment. */
  patchForm(
    token: string,
    url: string,
    fields: Record<string, string>,
    signal?: AbortSignal
  ): Promise<KeSwResponse>;
  submitXml(
    token: string,
    url: string,
    xml: string,
    submissionId: string,
    signal?: AbortSignal
  ): Promise<KeSwResponse>;
}

interface KoboTransferDestinationStore {
  SERVERS: Record<TransferServerId, TransferServerInfo>;
  /** Display order for the panel's selector, so the UI does not hardcode the
   *  list and can go out of step with SERVERS. */
  SERVER_KEYS: TransferServerId[];
  serverInfo(server: TransferServerId): TransferServerInfo;
  ready(): Promise<void>;
  getLastServer(): TransferServerId;
  getDestination(): TransferDestination | null;
  setDestination(dest: TransferDestination): void;
  clearDestination(): Promise<void>;
  getToken(): Promise<string>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  isReady(): Promise<boolean>;
  validateDestination(
    server: TransferServerId,
    token: string,
    signal?: AbortSignal
  ): Promise<TransferValidationResult>;
}

// ---------------------------------------------------------------------
// Source account credential (core/transfer/source.account.ts)
//
// The SOURCE account is the one the user is signed in to, and it has an API
// token of its own, readable from the signed-in session at GET /token/. It is
// held in memory only, exactly like the destination's token.
// ---------------------------------------------------------------------

/** What is known about the source account's own API token right now. */
interface TransferSourceTokenState {
  /** The in-memory token, or "" when it has not been read / was refused. */
  token: string;
  /** Epoch ms the token was read, or 0. */
  fetchedAt: number;
  /** Why the last read failed ("" when it never has), for the settings panel. */
  failure: string;
}

interface KoboTransferSourceAccount {
  /**
   * The token in memory, or "" when unavailable. Synchronous on purpose: every
   * source read needs it and none of them may await a network call to find out
   * whether one is worth sending.
   */
  getToken(): string;
  hasToken(): boolean;
  getState(): TransferSourceTokenState;
  /** Reads the token from the signed-in account. Never persisted. */
  fetchToken(signal?: AbortSignal): Promise<string>;
  /** fetchToken, but the cached token is returned when there already is one. */
  ensureToken(signal?: AbortSignal): Promise<string>;
  clearToken(reason?: string): void;
  /**
   * Authorization header for a source read: the token when known, empty when the
   * source falls back to the page session.
   */
  authHeaders(): Record<string, string>;
  /**
   * Same-origin fetch that prefers the token and degrades to the page session
   * when the token is refused. Resolves for ANY HTTP status — only network and
   * abort failures throw — so callers keep their own error wording.
   */
  fetchSource(url: string, signal?: AbortSignal): Promise<Response>;
}

// ---------------------------------------------------------------------
// Account usage / allowances (core/transfer/usage.api.ts)
// ---------------------------------------------------------------------

/**
 * One account's submission allowance, as Kobo reports it.
 *
 * Read from GET /api/v2/service_usage/. The billing period is the
 * ORGANIZATION's, so it is not necessarily a calendar month, and an account
 * with no cap reports a null balance — which is why `unlimited` is explicit
 * rather than being inferred from a missing limit.
 *
 *   balances.submission = { effective_limit, balance_value, balance_percent,
 *                           exceeded }
 * where balance_value is limit - usage (i.e. what is LEFT) and balance_percent
 * is how much of the limit is already USED.
 */
interface TransferUsage {
  /** Submissions already made in the current billing period. */
  usedCurrentPeriod?: number;
  /** Submissions made on the account, all time. */
  usedAllTime?: number;
  /** The allowance for the current period; absent when the account is capped
   *  and absent when it is not. */
  limit?: number;
  /** Allowance left (limit - usage). Absent when unlimited. */
  remaining?: number;
  /** The account has already used more than its allowance this period. */
  exceeded: boolean;
  /** No cap at all, so no submission can be refused for quota. */
  unlimited: boolean;
  periodStart?: string;
  periodEnd?: string;
  /** Set when the endpoint could not be read. The run continues: an unreadable
   *  allowance is a warning, not a reason to refuse to copy. */
  error?: string;
}

/** Per-project submission counts on the SOURCE account. */
interface TransferSourceAssetUsage {
  name: string;
  /** Submissions the project holds now — what a copy would upload. */
  allTime: number;
}

/** One project the DESTINATION account has right now. */
interface TransferDestinationProject {
  uid: UID;
  name: string;
  /** `name` normalized for the "is this the same project?" comparison. */
  key: string;
}

/**
 * The destination account's projects, read fresh for every preflight and every
 * run.
 *
 * This — not the mapping store — is what "already moved" is decided from. A
 * mapping is a claim written by an earlier run, and it survives the destination
 * project being deleted; a list read from the destination cannot be stale.
 */
interface TransferDestinationIndex {
  projects: TransferDestinationProject[];
}

/** A destination project that already stands for a source project. */
interface TransferExistingProject {
  uid: UID;
  name: string;
  /** "mapping" = a recorded destination UID still exists, so a renamed copy is
   *  still recognised. "name" = a destination project carries the same name. */
  how: "mapping" | "name";
}

interface KoboTransferUsage {
  /** Turns a /api/v2/service_usage/ body into a TransferUsage, or null when the
   *  body is not that endpoint's shape. Accepts both the single object and the
   *  documented array, because the endpoint has shipped as both. */
  readUsage(data: unknown): TransferUsage | null;
  /** The DESTINATION account's allowance, through the service worker. */
  fetchDestinationUsage(ctx: TransferDestContext, signal?: AbortSignal): Promise<TransferUsage>;
  /** The SOURCE (signed-in) account's allowance, same-origin. */
  fetchSourceUsage(signal?: AbortSignal): Promise<TransferUsage>;
  /**
   * Submission counts for the given SOURCE projects, in as few requests as
   * possible (one paginated pass over /api/v2/assets/, reading
   * deployment__submission_count, not one request per project). Returns a
   * uid-keyed map; a project absent from the map is counted as zero, and a pass
   * that matches none of them throws rather than reporting 0.
   */
  fetchSourceAssetCounts(
    uids: UID[],
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void
  ): Promise<Record<UID, TransferSourceAssetUsage>>;
}

// ---------------------------------------------------------------------
// Source-side reading (core/transfer/source.api.ts)
//
// The source is the account the user is signed in to, so these are ordinary
// same-origin reads. They do NOT go through the service worker (the source is
// the page's own origin); they carry the source account's API token when one is
// known, and fall back to the page session when it is not.
// ---------------------------------------------------------------------

/** One deployed form version on the SOURCE project, read from the project
 *  detail payload's `deployed_versions`. */
interface TransferSourceVersion extends KoboRecord {
  uid: UID;
  /** GET this URL to obtain the version record; its `content` field holds the
   *  form (see TransferVersionContent). */
  versionUrl: string;
  /** Kobo's own version number, if present. Read from `version_key` or
   *  `version_number`, which Kobo uses interchangeably. */
  versionKey?: number;
  date_deployed?: string;
  /** The form's content hash, from the payload. Two versions with the same hash
   *  are the same form and only need copying once. */
  contentHash?: string;
  /** True when this version is (or was) live on the source. Only these may be
   *  activated on the destination; drafts are copied but left inactive. */
  deployed?: boolean;
}

/**
 * A version's form, exactly as the source account returned it.
 *
 * This is deliberately opaque. Kobo serves the form either as XForm XML (older
 * projects) or as a structured form definition — an object with `schema`,
 * `survey`, `choices`, `settings`, `translated`, `translations` (the form-builder
 * format). Both are valid and both are written to the destination unchanged, so
 * the value is passed through rather than interpreted.
 *
 * It is JSON-encoded EXACTLY ONCE, at the destination, because that is what the
 * API expects: the reference tool does `json={"content": json.dumps(value)}`
 * (transfer/asset.py:59,66) and works for both shapes.
 * Encoding earlier — or encoding a value that is already a JSON string — produces
 * a doubly-encoded body and a silently empty form on the destination.
 */
type TransferVersionContent = string | KoboRecord;

/** One form-media attachment on the SOURCE project, read from the project
 *  detail payload's `files`. */
interface TransferSourceMedia extends KoboRecord {
  id: string;
  name?: string;
  /** The download URL. This is the entry's `content` field, not `url`. */
  url: string;
  contentType?: string;
  /** Forwarded to the destination upload verbatim — Kobo keys the uploaded
   *  file off this object, so it is never rebuilt. */
  metadata?: KoboRecord;
}

interface KoboTransferSourceApi {
  baseUrl(): string;
  /** Full detail payload for one source project. Carries the version history
   *  and the form media list, so a transfer needs this one request for both. */
  fetchAssetDetail(uid: UID, signal?: AbortSignal): Promise<Project>;
  /** The deployed versions of that payload, OLDEST FIRST. This is the only
   *  version list the reference uses (asset.py:19), so drafts are not copied. */
  fetchVersions(asset: Project): TransferSourceVersion[];
  /** The form XML of one version, exactly as Kobo stored it. */
  fetchVersionContent(
    version: TransferSourceVersion,
    signal?: AbortSignal
  ): Promise<TransferVersionContent>;
  /** Form-media attachments only; submission attachments are excluded. */
  fetchFormMedia(asset: Project): TransferSourceMedia[];
  /** One attachment's bytes. */
  fetchMediaBytes(media: TransferSourceMedia, signal?: AbortSignal): Promise<ArrayBuffer>;
  /** The bytes as the base64 data URL Kobo's form-media endpoint expects. */
  fetchMediaDataUrl(media: TransferSourceMedia, signal?: AbortSignal): Promise<string>;
  /** Page size used when walking the source project's submissions. */
  readonly SUBMISSION_PAGE_SIZE: number;
  /** Entry point for the submission walk: the URL of the first page. */
  firstSubmissionsPageUrl(uid: UID): string;
  /** One page of submission XML. The URL is used exactly as given. */
  fetchSubmissionsPage(url: string, signal?: AbortSignal): Promise<TransferSubmissionsPage>;
}

// ---------------------------------------------------------------------
// Destination-side writing (core/transfer/dest.api.ts)
// ---------------------------------------------------------------------

/** A project that now exists on the destination account. */
interface TransferDestProject extends KoboRecord {
  uid: UID;
  name?: string;
  /** Absolute URL of the latest deployed version. */
  deployedVersionUrl?: string;
  /** UID of the latest deployed version — the value a submission's
   *  version="" attribute must reference. */
  deployedVersionUid?: string;
  deploymentUuid?: string;
  /** "(count) (date)" exactly as the reference tool formats it. */
  versionLabel?: string;
}

interface KoboTransferDestApi {
  createAsset(
    ctx: TransferDestContext,
    payload: { name: string; settings: KoboRecord; asset_type: string },
    signal?: AbortSignal
  ): Promise<{ uid: UID; deploymentUuid: string }>;
  uploadFormMedia(
    ctx: TransferDestContext,
    destUid: UID,
    media: { name: string; dataUrl: string; contentType: string; metadata: KoboRecord },
    signal?: AbortSignal
  ): Promise<void>;
  /** Writes a version's XML and returns the version UID the destination
   *  minted for it. The XML is JSON-encoded into the `content` field. */
  setVersionContent(
    ctx: TransferDestContext,
    destUid: UID,
    content: TransferVersionContent,
    signal?: AbortSignal
  ): Promise<UID>;
  /** Archives a deployed project, so an archived source yields an archived
   *  destination. Form-encoded PATCH of `active=false`, as Kobo's UI does it. */
  archiveDeployment(ctx: TransferDestContext, destUid: UID, signal?: AbortSignal): Promise<void>;
  /** Asks the destination whether a remembered project still exists, so a stale
   *  mapping cannot block a re-copy. "unknown" means the destination could not be
   *  reached and the mapping must be left alone. */
  checkProject(
    ctx: TransferDestContext,
    destUid: UID,
    signal?: AbortSignal
  ): Promise<"exists" | "missing" | "unknown">;
  /** Deletes a project THIS transfer created, to clean up after a failed run.
   *  Never used on a project that holds real content. */
  deleteProject(ctx: TransferDestContext, destUid: UID, signal?: AbortSignal): Promise<boolean>;
  /** Deploys a version. The FIRST deployment is a POST and the rest are
   *  PATCHes; a PATCH as the first call creates no deployment. */
  deployVersion(
    ctx: TransferDestContext,
    destUid: UID,
    versionUid: UID,
    isFirst: boolean,
    signal?: AbortSignal
  ): Promise<void>;
  /** Re-reads the destination project: deployment UUID + deployed version. */
  fetchProject(ctx: TransferDestContext, destUid: UID, signal?: AbortSignal): Promise<TransferDestProject>;
  /**
   * The destination's submission allowance for the current billing period.
   * Never throws: an unreadable allowance comes back as a TransferUsage whose
   * `error` explains why, so a run is never blocked by a warning.
   */
  fetchUsage(ctx: TransferDestContext, signal?: AbortSignal): Promise<TransferUsage>;
  /**
   * Every project the destination account has, read fresh.
   *
   * Returns null when the list could not be read. Callers must NOT read that as
   * "the destination is empty": they fall back to the recorded copies instead,
   * because treating an unreachable destination as empty would duplicate a whole
   * account on the next run.
   */
  fetchProjectIndex(
    ctx: TransferDestContext,
    signal?: AbortSignal
  ): Promise<TransferDestinationIndex | null>;
  /** Normalizes a project name for comparison: trimmed, inner whitespace
   *  collapsed, case-folded. */
  nameKey(name: string): string;
  /**
   * The destination project that already stands for `sourceName`, or null.
   *
   * A recorded `mappedDestUid` wins when the destination still has it (that is
   * what recognises a copy the user renamed later). Otherwise a destination
   * project with the same normalized name is used. `used` marks projects already
   * matched to another source project, so two source projects sharing a name
   * cannot both be skipped against one destination project.
   */
  findExisting(
    index: TransferDestinationIndex,
    sourceName: string,
    mappedDestUid: string,
    used: Record<UID, boolean>
  ): TransferExistingProject | null;
}

/** Everything a destination call needs, assembled once per run so the token is
 *  read from storage a single time and never travels further than necessary. */
interface TransferDestContext {
  destination: TransferDestination;
  token: string;
}

// ---------------------------------------------------------------------
// Submission XML (core/transfer/submission.xml.ts)
// ---------------------------------------------------------------------

/** One page of the source account's submission XML. */
interface TransferSubmissionsPage {
  /** Total submissions on the source project, from the <count> element. */
  count: number;
  /** URL of the next page, or null when this was the last one. */
  next: string | null;
  /** One entry per submission, already serialised from the source document. */
  items: TransferSourceSubmission[];
}

/** A single submission, as it exists in the source XML tree. */
interface TransferSourceSubmission {
  /** The source instanceID UUID (without the "uuid:" prefix). */
  instanceId: string;
  /** Source document's serialization; rewritten before it is submitted. */
  xml: string;
}

interface KoboTransferSubmissionsXml {
  /** Path of the OpenRosa submission endpoint on the KC host. */
  readonly SUBMISSION_PATH: string;
  /** Parses one data.xml page. Throws on a body it cannot read. */
  parsePage(body: string, url: string): TransferSubmissionsPage;
  /** Rewrites a submission for the destination project. */
  rewrite(
    source: TransferSourceSubmission,
    target: { destUid: UID; versionUid: string; versionLabel: string; formhubUuid: string }
  ): { xml: string; instanceId: string };
  /** "2021-03-29T19:40:28.123456+00:00" -> "2021-03-29 19:40:28". */
  formatVersionDate(iso: string): string;
}

// ---------------------------------------------------------------------
// Idempotency (core/transfer/mapping.store.ts)
// ---------------------------------------------------------------------

/** "This source project is already on that server as destUid." Never holds a
 *  secret, and never holds a URL — the server id re-derives those. */
interface TransferMapping {
  sourceUid: UID;
  destUid: UID;
  destName: string;
  at: number;
}

interface KoboTransferMappingStore {
  ready(): Promise<void>;
  get(server: TransferServerId, sourceUid: UID): TransferMapping | null;
  set(server: TransferServerId, mapping: TransferMapping): Promise<boolean>;
  remove(server: TransferServerId, sourceUid: UID): Promise<void>;
  list(server: TransferServerId): TransferMapping[];
  count(server: TransferServerId): number;
  clear(server: TransferServerId): Promise<void>;
}

// ---------------------------------------------------------------------
// Pipeline (features/transfer/transfer.pipeline.ts)
// ---------------------------------------------------------------------

/** One project's completed transfer, flattened into the report row. */
interface TransferProjectResult extends TransferCounters {
  /** The destination project as read back after deployment. Carried out of
   *  copyForm so the submissions step does not have to re-read it. */
  deployedProject: TransferDestProject;
  destinationProjectName: string;
  /** Form-media files that could not be uploaded, by name. The project itself
   *  is still copied — this is a warning, not a failure. */
  formMediaFailed: string[];
  /** True when the mapping could not be persisted (copy still succeeded). */
  mappingNotSaved: boolean;
  /** Human-readable, already-localized, for the report's message column. */
  summary: string;
}

interface KoboTransferPipeline {
  /** Consecutive identical submission failures the walk tolerates before
   *  abandoning. Exposed so the report names the same number. */
  MAX_CONSECUTIVE_SUBMISSION_FAILURES: number;
  /** Creates the destination project, copies media, replays every version. */
  copyForm<TConfig extends ActionConfig>(
    ctx: ItemContext<TConfig>,
    source: Project,
    destination: TransferDestination,
    token: string
  ): Promise<TransferProjectResult>;
  /** Form media on its own, exposed for the report's warning path. */
  copyFormMedia(
    dest: TransferDestContext,
    destUid: UID,
    sourceMedia: TransferSourceMedia[],
    signal: AbortSignal
  ): Promise<{ copied: number; failed: string[] }>;
  /** Copies the source project's submissions into an existing destination
   *  project. Only called after copyForm has deployed at least one version. */
  copySubmissions<TConfig extends ActionConfig>(
    ctx: ItemContext<TConfig>,
    destProject: TransferDestProject,
    sourceUid: UID,
    destination: TransferDestination,
    token: string
  ): Promise<TransferCounters>;
  /** Archives the copy when the source was archived. LAST step of a transfer,
   *  after submissions: an archived project does not collect, so archiving first
   *  would make the destination reject every submission. No-op returning false
   *  for a normal project. Throws if the destination refuses. */
  archiveCopy(
    result: TransferProjectResult,
    destination: TransferDestination,
    token: string,
    signal?: AbortSignal
  ): Promise<boolean>;
}

// ---------------------------------------------------------------------
// Preflight (features/transfer/transfer.preflight.ts)
// ---------------------------------------------------------------------

/** What the preflight needs to answer "how much is about to be copied, and can
 *  the destination take it?". */
interface TransferPreflightInput {
  /** Explicitly selected projects; empty for a whole-account run. */
  uids: UID[];
  wholeAccount: boolean;
  /** The list filter URL a whole-account run would resolve against. */
  filterUrl?: string | null;
  /** Resolver for a whole-account run, injected by the action. */
  resolveWholeAccount?: (signal: AbortSignal) => Promise<UID[]>;
  /** False for a form-only run, which costs the destination no allowance. */
  moveSubmissions: boolean;
  destination: TransferDestination;
  /** The destination token, for the allowance read. */
  token: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/** The answer the confirm dialog is built from. */
interface TransferPreflightResult {
  /** Projects in scope. */
  projectCount: number;
  /** Of those, how many already exist on the destination (they will be skipped). */
  alreadyMoved: number;
  /** How many of `alreadyMoved` were recognised by NAME rather than by a
   *  recorded destination UID. The dialog names the reason, because "skipped"
   *  without one is what made a wrong skip so confusing. */
  matchedByName: number;
  /** False when the destination's project list could not be read, so existence
   *  could only be checked for projects a previous run recorded. The dialog says
   *  so rather than presenting an unchecked count as a fact. */
  destinationChecked: boolean;
  /** Projects this run will actually copy. */
  projectsToCopy: number;
  /** Submissions that will be uploaded, summed over those projects. */
  submissionsToCopy: number;
  /** Whether THIS run copies submissions at all. `submissionsToCopy` of 0 is a
   *  fact for a form + submissions run and noise for a form-only one, and only
   *  the input knows which it is. */
  copySubmissions: boolean;
  /** False when the per-project counts could not be read; `submissionsToCopy` is
   *  then a floor of zero rather than a fact, and the dialog says so. */
  countsKnown: boolean;
  /** The destination's allowance. */
  usage: TransferUsage;
  /** Submissions over the remaining allowance; 0 when uncapped or when it fits. */
  shortfall: number;
  /** The destination cannot take every submission this run would send. */
  overAllowance: boolean;
}

interface KoboTransferPreflight {
  run(input: TransferPreflightInput): Promise<TransferPreflightResult>;
  /**
   * The result as the confirm dialog's structured detail: the counts and the
   * allowance as label/value facts, what the run cannot do as warnings, and the
   * standing conditions as notes. Localized here so the action only has to add
   * its own account lines.
   */
  summarize(result: TransferPreflightResult): ConfirmDetails;
}

// ---------------------------------------------------------------------
// Destination panel (features/transfer/transfer.panel.ts)
// ---------------------------------------------------------------------

/**
 * The row-2 destination panel, exposed on the global namespace as KE.transfer.
 *
 * The toolbar owns the row itself (it owns every row in ToolbarRefs) and calls
 * openPanel() from the gear button; the panel owns the modal and the store. The
 * subscribe() callback is how a successful validation reaches the toolbar so it
 * can repaint the row and re-gate the Run button — a plain callback instead of a
 * DOM event so neither side has to know about the other's internals.
 */
interface KoboTransferPanelService {
  openPanel(): void;
  /** Registers a change listener. Returns an unsubscribe function. */
  subscribe(onChange: (destination: TransferDestination | null) => void): () => void;
  /** Test-only seam: pushes an externally-produced destination into the store. */
  setValidatedDestination(dest: TransferDestination): void;
}

// ---------------------------------------------------------------------
// Service worker message protocol
//
// Chrome serialises runtime messages as JSON, so everything here is plain JSON.
// The worker validates every message at runtime and returns a response tagged
// with the same correlation id.
// ---------------------------------------------------------------------

const KE_SW_CHANNEL: string;

type KeSwOp = "checkAccount" | "getJson" | "mutateJson" | "postForm" | "submitXml" | "cancel";

interface KeSwRequestBase {
  ke: typeof KE_SW_CHANNEL;
  id: string;
  /** Destination API token. Used only for allow-listed hosts. */
  token: string;
}

interface KeSwRequestCheckAccount extends KeSwRequestBase {
  op: "checkAccount";
  url: string;
}

interface KeSwRequestGetJson extends KeSwRequestBase {
  op: "getJson";
  url: string;
  params?: Record<string, unknown>;
}

interface KeSwRequestMutateJson extends KeSwRequestBase {
  op: "mutateJson";
  url: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  payload?: unknown;
}

interface KeSwRequestPostForm extends KeSwRequestBase {
  op: "postForm";
  url: string;
  /** Sent as application/x-www-form-urlencoded (form media upload). */
  fields: Record<string, string>;
}

interface KeSwRequestPatchForm extends KeSwRequestBase {
  op: "patchForm";
  url: string;
  /** Sent as application/x-www-form-urlencoded. Kobo's own UI archives a
   *  project with `active=false` on the deployment endpoint in this encoding. */
  fields: Record<string, string>;
}

interface KeSwRequestSubmitXml extends KeSwRequestBase {
  op: "submitXml";
  url: string;
  /** The rewritten submission XML. */
  xml: string;
  /** Used as the multipart filename — Kobo expects the submission UUID. */
  submissionId: string;
}

interface KeSwRequestCancel {
  ke: typeof KE_SW_CHANNEL;
  op: "cancel";
  id: string;
}

type KeSwRequest =
  | KeSwRequestCheckAccount
  | KeSwRequestGetJson
  | KeSwRequestMutateJson
  | KeSwRequestPostForm
  | KeSwRequestPatchForm
  | KeSwRequestSubmitXml
  | KeSwRequestCancel;

interface KeSwResponse {
  ke: typeof KE_SW_CHANNEL;
  id: string;
  ok: boolean;
  status?: number;
  /** Parsed JSON body, when the response was JSON. */
  data?: unknown;
  /** Raw body, used for the XML/HTML paths and for error details. */
  text?: string;
  /** Human-readable failure reason. Never contains the token. */
  error?: string;
  detail?: string;
  /** Echo of the request that produced this response, so a failure can name it. */
  method?: string;
  url?: string;
}

