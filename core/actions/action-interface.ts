/**
 * core/actions/action-interface.ts — the ACTION contract.
 *
 * Every KoboEnhance action — the 11 project-modification (bulk) actions and the
 * 4 account-level scans/reports (kind: "account") — is described by ONE
 * normalized descriptor with this shape:
 *
 *   identity        id, label, group, description, icon
 *   kind            "bulk"    -> execute(project, context) per project
 *                   "account" -> execute(context) : whole-run scan/report
 *   ui              fields (row-2 toolbar fields), requiredFields (Run gate),
 *                   stepLabel / loadingStep (progress wording)
 *   report          { slug: filename stem, columns, summary(results) -> ui }
 *   flow            validate(context), confirm(context), execute(...),
 *                   formatResult(result, ctx) -> standardized result model
 *                   { uid, projectName, status, message, error, data } where
 *                   status is success | skipped | failed | cancelled and the
 *                   action-specific fields live in `data` (their keys become
 *                   the extra CSV report columns)
 *   presentation    permissionOut / targetUserOut (report row base values),
 *                   confirmDetails(context) (extra confirm lines) or
 *                   confirmDetailsBlock(context) (the same detail structured as
 *                   facts / warnings / notes)
 *
 * The Action<TConfig, TResultData> descriptor is GENERIC: TConfig is the
 * action's configuration/input type (what the executor hands validate /
 * confirm / execute) and TResultData is the action's result-data type (the
 * per-project `data` payload for bulk actions, the whole-run scan result for
 * account actions). Feature modules narrow BOTH when they author a descriptor
 * via ActionParams<TConfig, TResultData>; the registry and the executor type
 * every descriptor as the erased base Action<ActionRequest, KoboRecord> so any
 * registered action runs without knowing its specific types.
 *
 * Shared controllers (the executor and the toolbar UI) read ONLY this
 * normalized descriptor plus a couple of generic helpers:
 *
 *   - validate(context)  -> null when OK, else { message } (dialog)
 *                           or { toast } (toast) or a plain string (dialog)
 *   - confirm(context)   -> { message, buttons, title } rendered by the
 *                           caller through its shared confirm UI
 *   - report.summary(r)  -> { dialog } | { type,title,description?,metrics?,
 *                           files:[{filename,csv}] } | null (nothing to show)
 *
 * Adding a new action = one self-contained module that calls
 * KE.actionRegistry.register(id, descriptor). Nothing else needs touching.
 */
(function () {
  const KE = window.KoboEnhance;
  const { t } = KE.i18n;

  /** Shared field wording (same source the toolbar Run gate uses). */
  const FIELD_LABELS: Record<string, string> = {
    username: "Enter a username.",
    users: "Add at least one user.",
    permission: "Select a permission (required to share).",
    prefix_suffix: "Enter a prefix and/or a suffix.",
    find: "Enter the text to find.",
    description: "Enter the new description.",
    countries: "Select at least one country.",
    sectors: "Select a sector.",
    tags: "Enter at least one tag to append or remove.",
    sourceProject: "Enter or load a source project UID.",
    template: "Select or create a permission template.",
    transfer: "Set a destination account first.",
  };

  /** True when a required field is fully satisfied by the run request. */
  function fieldSatisfied<TConfig extends ActionConfig = ActionRequest>(field: string, request: TConfig | null | undefined): boolean {
    const r = (request || {}) as unknown as KoboRecord;
    if (field === "username") return Boolean(r.username);
    if (field === "users") return Array.isArray(r.usernames) && r.usernames.length > 0;
    if (field === "template") return Boolean(r.templateId);
    // The destination token never lives in the request, only the gate flag.
    if (field === "transfer") return r.transferReady === true;
    if (field === "permission") return Boolean(r.permission);
    if (field === "prefix_suffix") return Boolean(String((r.prefix || "") as string).trim() || String((r.suffix || "") as string).trim());
    if (field === "find") return Boolean(String((r.findText || "") as string).trim());
    if (field === "countries") return Array.isArray(r.countries) && r.countries.length > 0;
    if (field === "sectors") return Array.isArray(r.sectors) && r.sectors.length > 0;
    if (field === "tags") {
      const mode = r.tagsMode === "replace" ? "replace" : r.tagsMode === "remove" ? "remove" : "append";
      return mode === "replace" || (Array.isArray(r.tags) && r.tags.length > 0);
    }
    return Boolean(r[field]);
  }

  /** Shared field wording (same source the toolbar Run gate uses). */
  function fieldMessage(field: string): string {
    return t((FIELD_LABELS[field] || "Complete the required field.") as keyof EnDict);
  }

  /**
   * Empty-target backstop wording. Bulk actions say "No projects to process.";
   * account scans keep the legacy manual/selected wording.
   */
  function emptyTargetMessage<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    context: ActionContext<TConfig, TResultData> | null | undefined,
    account: boolean
  ): string | null {
    if (!context || context.wholeAccount) return null;
    const uids = context.uids || [];
    if (uids.length > 0) return null;
    if (account) {
      return (context.source || "selected") === "manual"
        ? t("Enter at least one valid project UID.")
        : t("No projects selected on the page.")
    }
    return t("No projects to process.");
  }

  /** Searches the target user once when the action requires a username. */
  async function lookupUsername<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    context: ActionContext<TConfig, TResultData>
  ): Promise<{ toast: ToastOptions } | null> {
    try {
      await context.runtime.api.users.lookupUser((context.request as unknown as ActionRequest).username);
    } catch (e) {
      const err = (e || {}) as KoboRecord;
      return { toast: { type: "warning", title: t("User not found"), description: (err.detail || err.message) as string | undefined } };
    }
    return null;
  }

  /**
   * Resolves every requested user once when the action requires multiple
   * users. Collects the missing usernames and reports them in a single
   * warning toast (run aborted before anything is touched).
   */
  async function lookupUsers<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    context: ActionContext<TConfig, TResultData>
  ): Promise<{ toast: ToastOptions } | null> {
    const list = (context.request as unknown as ActionRequest).usernames || [];
    const missing: string[] = [];
    await Promise.all(
      list.map(async (username) => {
        try {
          await context.runtime.api.users.lookupUser(username);
        } catch (e) {
          const err = (e || {}) as KoboRecord;
          const reason = (String((err as { detail?: unknown }).detail || "") || "").trim()
            || (String((err as { message?: unknown }).message || "") || "").trim()
            || String(e);
          missing.push(reason ? `${username} (${reason})` : username);
        }
      })
    );
    if (!missing.length) return null;
    return {
      toast: {
        type: "warning",
        title: missing.length === 1 ? t("User not found") : t("Users not found"),
        description: missing.join("\n"),
      },
    };
  }

  /**
   * Default validation for bulk (per-project) actions: field checks (which
   * fields depends on `requiredFields`), username lookup when a username is
   * required, then the empty-target backstop. Returns null when OK.
   */
  async function validateBase<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    def: Action<TConfig, TResultData>,
    context: ActionContext<TConfig, TResultData>
  ): Promise<ValidationIssue | string | null> {
    const ENFORCED: Record<string, boolean> = { username: true, users: true, template: true, prefix_suffix: true, find: true, countries: true, sectors: true, tags: true, sourceProject: true };
    for (const f of def.requiredFields || []) {
      if (!ENFORCED[f]) continue;
      if (!fieldSatisfied(f, context.request)) return { message: fieldMessage(f) };
    }
    if ((def.requiredFields || []).indexOf("username") !== -1) {
      const notFound = await lookupUsername(context);
      if (notFound) return notFound;
    }
    if ((def.requiredFields || []).indexOf("users") !== -1) {
      const notFound = await lookupUsers(context);
      if (notFound) return notFound;
    }
    const empty = emptyTargetMessage(context, false);
    if (empty) return { message: empty };
    return null;
  }

  /**
   * Default validation for account scans: every required field + the
   * empty-target wording those tools historically used.
   */
  function validateAccount<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    def: Action<TConfig, TResultData>,
    context: ActionContext<TConfig, TResultData>
  ): ValidationIssue | string | null {
    for (const f of def.requiredFields || []) {
      if (!fieldSatisfied(f, context.request)) {
        const specific = def.fieldMessages && def.fieldMessages[f];
        return { message: specific ? t(specific as keyof EnDict) : fieldMessage(f) };
      }
    }
    const empty = emptyTargetMessage(context, true);
    if (empty) return { message: empty };
    return null;
  }

  /** Per-action confirm details come from `confirmDetailsBlock` (structured) or
   *  the older `confirmDetails` (a line list). */
  function defaultDetails<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    def: Action<TConfig, TResultData>,
    context: ActionContext<TConfig, TResultData>
  ): { lines: string[]; details: ConfirmDetails | null } {
    const n = (context.uids || []).length;
    const heading = context.wholeAccount ? t("Scope: Entire account (respecting current filters)") : t("Projects: {n}", { n });

    // The structured form wins when an action provides it: it carries the same
    // information with the parts named, so the dialog can align the numbers and
    // mark the warnings instead of printing one paragraph of newlines.
    if (typeof def.confirmDetailsBlock === "function") {
      const details = def.confirmDetailsBlock(context);
      if (details) return { lines: [], details };
    }

    const lines = [heading];
    if (typeof def.confirmDetails === "function") {
      lines.push.apply(lines, def.confirmDetails(context) || []);
    }
    return { lines, details: null };
  }

  /** Default confirm dialog shape for bulk actions. */
  function confirmBulk<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    def: Action<TConfig, TResultData>,
    context: ActionContext<TConfig, TResultData>
  ): ConfirmOptions {
    const n = (context.uids || []).length;
    const { lines, details } = defaultDetails(def, context);
    const detail = lines.length ? `\n\n${lines.join("\n")}` : "";
    const message = context.wholeAccount
      ? t("Run \"{label}\" on the entire account (respecting current filters)?", { label: t(def.label as keyof EnDict) }) + detail
      : t("Run \"{label}\" on {n} project(s)?", { label: t(def.label as keyof EnDict), n }) + detail;
    const buttons = context.wholeAccount
      ? [{ label: t("Cancel"), value: false }, { label: t("Run on entire account"), value: true, primary: true }]
      : [{ label: t("Cancel"), value: false }, { label: t("Run on {n}", { n }), value: true, primary: true }];
    const options: ConfirmOptions = { message, buttons, title: t("Confirm Bulk Action") };
    if (details) options.details = details;
    return options;
  }

  /** Default confirm dialog shape for account scans. */
  function confirmAccount<TConfig extends ActionConfig = ActionRequest, TResultData extends ActionResultData = KoboRecord>(
    def: Action<TConfig, TResultData>,
    context: ActionContext<TConfig, TResultData>
  ): ConfirmOptions {
    const n = (context.uids || []).length;
    const message = context.wholeAccount
      ? t("Run on the entire account (respecting current filters)?")
      : t("Run on {n} selected project(s)?", { n });
    const buttons = context.wholeAccount
      ? [{ label: t("Cancel"), value: false }, { label: t("Run on entire account"), value: true, primary: true }]
      : [{ label: t("Cancel"), value: false }, { label: t("Run on {n}", { n }), value: true, primary: true }];
    return { message, buttons, title: t(def.label as keyof EnDict) };
  }

  /**
   * Default summary for bulk actions — maps the executor's finished payload
   * (counts + csv, or the resolution stopped/error/empty cases) into UI.
   */
  function bulkSummary(def: Action, res: RunReport | KoboRecord | null | undefined): UiToast {
    const k = (res || {}) as RunReport;
    const slug = (def.report && def.report.slug) || def.reportSlug || def.id;
    if (k.stopped) {
      return { type: "warning", title: t("{label} stopped", { label: t(def.label as keyof EnDict) }), description: t("Stopped while preparing the project list.") };
    }
    if (k.error) {
      return { type: "error", title: t("{label} failed", { label: t(def.label as keyof EnDict) }), description: String(k.error) };
    }
    if (k.empty) {
      return { type: "warning", title: t(def.label as keyof EnDict), description: t("No projects found in the account (matching current filters).") };
    }
    const failed = k.failCount || 0;
    return {
      type: failed === 0 ? "success" : k.successCount === 0 ? "error" : "warning",
      title: t("{label} finished", { label: t((k.actionLabel || def.label) as keyof EnDict) }),
      metrics: [
        { label: t("Completed"), value: (k.successCount || 0) as number, tone: "success" },
        { label: t("Skipped"), value: k.skipCount || 0 },
        { label: t("Failed"), value: failed, tone: failed > 0 ? "error" : "" },
        { label: t("Cancelled"), value: k.cancelCount || 0, tone: (k.cancelCount || 0) > 0 ? "warning" : "" },
      ],
      files: [{ filename: `kobo-bulk-${slug}-report`, csv: k.csv || "" }],
    };
  }

  /** Default result -> standardized result model for one processed project.
   *  Every bulk flow produces the same shape:
   *    { uid, projectName, unchanged, status, message, error, data }
   *  status is one of "success" | "skipped" | "failed" | "cancelled".
   *  Action-specific fields live in `data`; their keys become the extra CSV
   *  report columns (see core/actions/action-registry.ts rowFor). */
  function formatResultDefault<TData extends ActionResultData = KoboRecord>(
    def: Action,
    result: ActionResult<TData> | ScanResult | KoboRecord | null | undefined,
    ctx?: ItemContext | null
  ): ActionResult<TData> {
    const r = (result || {}) as KoboRecord;
    const unchanged = !!r.unchanged;
    return {
      uid: (ctx && ctx.uid) || ((r.uid as string) || ""),
      projectName: (r.projectName as string) || "",
      status: unchanged ? "skipped" : ((r.status as ActionStatus) || "success"),
      message: (r.message as string | undefined) || (unchanged ? t((def.skipReason || "No change made") as keyof EnDict) : ""),
      error: (r.error as string | undefined) || "",
      data: (r.data && typeof r.data === "object" ? r.data : {}) as unknown as TData,
    };
  }

  /**
   * Turns a raw registration descriptor into the complete normalized ACTION.
   * Every shared controller reads the result of this function. TConfig and
   * TResultData flow through unchanged (feature descriptors keep their types);
   * internally the descriptor is built against the erased base so the shared
   * fields stay homogeneous across every kind of action.
   */
  function normalizeAction<
    TConfig extends ActionConfig = ActionRequest,
    TResultData extends ActionResultData = KoboRecord
  >(input: Action<TConfig, TResultData> | ActionParams<TConfig, TResultData> | KoboRecord | null | undefined, id: string): Action<TConfig, TResultData> {
    const def = Object.assign({}, input || {}) as unknown as Action;
    def.id = id;
    def.value = id; // legacy alias (toolbar <option value> uses the id)
    def.group = def.group || "";
    def.kind = def.kind === "account" ? "account" : def.kind === "panel" ? "panel" : "bulk";
    def.label = def.label || id;
    def.description = def.description || def.tip || "";
    def.tip = def.tip || def.description; // legacy alias (dropdown tooltip)
    def.icon = def.icon || "";
    def.fields = (def.fields || def.uiFields || []).slice();
    def.uiFields = def.fields.slice(); // legacy alias (row-2 visibility)
    def.requiredFields = (def.requiredFields || []).slice();
    def.stepLabel = def.stepLabel || "Running";
    def.loadingStep = def.loadingStep || "Fetching project list...";
    def.skipReason = def.skipReason || null;

    const report = (def.report = def.report || {});
    report.slug = report.slug || def.reportSlug || id;
    report.columns = report.columns || def.reportFields || [];
    report.summary = def.report.summary || function (res: KoboRecord) { return bulkSummary(def, res as unknown as RunReport); };

    def.validate = def.validate || ((context: ActionContext) => {
      if (def.kind === "account") return validateAccount(def, context);
      return validateBase(def, context);
    });
    def.confirm = def.confirm || ((context: ActionContext) => {
      if (def.kind === "account") return confirmAccount(def, context);
      return confirmBulk(def, context);
    });
    def.execute = def.execute || def.readAction; // readAction is the legacy name
    def.formatResult = def.formatResult || ((result: ActionResult | ScanResult, ctx?: ItemContext) => formatResultDefault(def, result, ctx));

    def.permissionOut = def.permissionOut || (function () { return t("N/A"); });
    def.targetUserOut = def.targetUserOut || (function (request: ActionRequest) {
      const req = def.requiredFields || [];
      if (req.indexOf("username") !== -1) return (request && request.username) || "";
      if (req.indexOf("users") !== -1) return ((request && request.usernames) || []).join(", ");
      return t("N/A");
    });

    return def as unknown as Action<TConfig, TResultData>;
  }

  /**
   * Authoring convenience: builds a fully normalized Action from a partial
   * descriptor. The descriptor must supply an id (or the legacy `value`) so
   * normalizeAction can stamp identity fields.
   */
  function define<
    TConfig extends ActionConfig = ActionRequest,
    TResultData extends ActionResultData = KoboRecord
  >(params: ActionParams<TConfig, TResultData>): Action<TConfig, TResultData> {
    const raw = (params || {}) as KoboRecord;
    const id = (raw.id || raw.value) as string | undefined;
    if (!id) {
      throw new Error("KoboEnhance action define requires an id");
    }
    return normalizeAction(params, id);
  }

  window.KoboEnhance.actionInterface = {
    normalizeAction,
    define,
    validateBase,
    validateAccount,
    confirmBulk,
    confirmAccount,
    bulkSummary,
    fieldMessage,
    fieldSatisfied,
    FIELD_LABELS,
  };
})();