/**
 * core/actions/action-registry.ts — the single source of truth for actions.
 *
 * Every action in the toolbar is registered here by a per-action module
 * (features/bulk-actions/actions/*.js and the account-scan feature modules).
 * Registration goes through the ACTION contract in
 * core/actions/action-interface.ts, which normalizes each descriptor into the
 * standard shape the shared controllers consume:
 *
 *   - identity   id, label, group, description, icon
 *   - kind       "bulk" (per-project execute) or "account" (whole-run scan)
 *   - config     toolbar fields (fields), validation requirements
 *                (requiredFields), progres wording (stepLabel/loadingStep)
 *   - flow       validate(context), confirm(context),
 *                execute(project | context), formatResult(result)
 *   - report     slug (filename stem), columns, summary(results)
 *
 * The toolbar/dropdown and row-2 field visibility are driven purely by the
 * ACTIONS list resolved from this registry — adding a new action only means
 * creating + registering a module.
 */
(function () {
  const KE = window.KoboEnhance;
  const { t } = KE.i18n;

  /** Shared toolbar field spec names (used by integration.js + action modules). */
  const FIELD_SPECS: Record<string, { title: string }> = {
    username: { title: "target username" },
    permission: { title: "permission" },
    prefix: { title: "prefix" },
    suffix: { title: "suffix" },
    find: { title: "text to find" },
    replace: { title: "replacement text" },
    description: { title: "new description" },
    countries: { title: "country selection" },
    sectors: { title: "sector selection" },
    tags: { title: "tags" },
    sourceProject: { title: "source project UID or URL" },
    transfer: { title: "destination account" },
  };

  const PERMISSIONS: Permission[] = [
    { code: "view_asset", label: "View form" },
    { code: "change_asset", label: "Edit form" },
    { code: "manage_asset", label: "Manage project" },
    { code: "add_submissions", label: "Add submissions" },
    { code: "view_submissions", label: "View submissions" },
    { code: "change_submissions", label: "Edit submissions" },
    { code: "validate_submissions", label: "Validate submissions" },
    { code: "delete_submissions", label: "Delete submissions" },
  ];

  /**
   * Kobo's permission hierarchy: assigning one code implicitly grants the whole
   * set listed here, which is why the API answers with one row PER IMPLIED
   * PERMISSION rather than per assignment. A user holding "Manage project"
   * comes back as all eight rows, "Edit form" as two.
   *
   * The share UI stores the single base code and lets Kobo expand it, so that is
   * what a permission template must record too — see reduceToBasePermissions.
   */
  const PERMISSION_IMPLIES: Record<string, string[]> = {
    view_asset: ["view_asset"],
    add_submissions: ["add_submissions"],
    view_submissions: ["view_asset", "view_submissions"],
    change_submissions: ["add_submissions", "change_submissions", "view_asset", "view_submissions"],
    validate_submissions: ["validate_submissions", "view_asset", "view_submissions"],
    delete_submissions: ["delete_submissions", "view_asset", "view_submissions"],
    change_asset: ["change_asset", "view_asset"],
    manage_asset: [
      "view_asset",
      "change_asset",
      "manage_asset",
      "add_submissions",
      "view_submissions",
      "change_submissions",
      "validate_submissions",
      "delete_submissions",
    ],
  };

  const sameSet = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) return false;
    const left = a.slice().sort();
    const right = b.slice().sort();
    return left.every((code, i) => code === right[i]);
  };

  /**
   * Collapses one user's EXPANDED permission rows back to the base code(s) that
   * Kobo would have been asked for — the inverse of PERMISSION_IMPLIES.
   *
   *   [manage×8 rows]  -> ["manage_asset"]
   *   [change, view]   -> ["change_asset"]
   *   [view, view_sub] -> ["view_submissions"]
   *
   * Never escalates and never drops a code:
   *   1. an exact match wins (the normal case — every base code round-trips);
   *   2. otherwise the SMALLEST covering base is used, so a partial set is
   *      never widened (manage_asset covers every known code, so one always
   *      exists);
   *   3. codes outside the table are passed through untouched, keeping legacy
   *      or imported permissions intact.
   */
  function reduceToBasePermissions(codes: string[]): string[] {
    const out: string[] = [];
    const known: string[] = [];
    const unknown: string[] = [];
    for (const raw of codes || []) {
      const code = String(raw || "").trim();
      if (!code || out.indexOf(code) !== -1 || known.indexOf(code) !== -1 || unknown.indexOf(code) !== -1) continue;
      if (PERMISSION_IMPLIES[code]) known.push(code);
      else unknown.push(code);
    }
    if (!known.length) return unknown;
    for (const code of PERMISSIONS) {
      if (sameSet(PERMISSION_IMPLIES[code.code], known)) {
        out.push(code.code);
        return out.concat(unknown);
      }
    }
    let best: string | null = null;
    let bestSize = Infinity;
    for (const code of PERMISSIONS) {
      const implies = PERMISSION_IMPLIES[code.code];
      if (!implies || implies.length >= bestSize) continue;
      if (known.every((c) => implies.indexOf(c) !== -1)) {
        best = code.code;
        bestSize = implies.length;
      }
    }
    out.push(best || known[0]);
    return out.concat(unknown);
  }

  const actionsByValue: Record<string, Action> = {};
  const order: string[] = [];

  function register(id: string, entry: Action | ActionParams | KoboRecord): Action {
    if (!id || actionsByValue[id]) {
      throw new Error("KoboEnhance action already registered: " + id);
    }
    // Every descriptor goes through the standard ACTION contract
    // (core/actions/action-interface.ts) so shared controllers only ever see
    // the normalized shape: identity, kind, fields, validate/confirm/execute,
    // and the report summary.
    const def = KE.actionInterface.normalizeAction(entry, id);
    actionsByValue[id] = def;
    order.push(id);
    return def;
  }

  function get(value: string): Action | null {
    return actionsByValue[value] || null;
  }

  function list(): string[] {
    return order.slice();
  }

  function groups(): string[] {
    const out: string[] = [];
    const seen: Record<string, boolean> = {};
    for (const id of order) {
      const g = actionsByValue[id].group;
      if (g && !seen[g]) {
        seen[g] = true;
        out.push(g);
      }
    }
    return out;
  }

  function permissionLabel(code: string): string {
    const p = PERMISSIONS.find((x) => x.code === code);
    return p ? t(p.label as keyof EnDict) : code;
  }

  /**
   * Shared report columns of every bulk (per-UID) action, built from a
   * standardized result ({ uid, projectName, status, message, error, data }).
   * The stable base columns are always emitted first (so the CSV keeps a
   * common leading set), then the action-specific `data` keys are merged in —
   * their union across rows becomes the extra CSV columns.
   */
  function rowFor(std: ActionResult | KoboRecord | null | undefined, base: KoboRecord | null | undefined): ReportRow {
    const s = (std || {}) as KoboRecord;
    const status = (s.status as string) || "";
    let detail = (s.error as string) || "";
    if (!detail && (status === "skipped" || status === "cancelled")) detail = (s.message as string) || "";
    const row: ReportRow = {
      Project_UID: (s.uid as string) || "",
      Project_Name: (s.projectName as string) || "",
      Action: (base && (base.actionLabel as string)) || "",
      Permission: (base && (base.permissionOut as string)) || "",
      Target_User: (base && (base.targetUserOut as string)) || "",
      Final_Status: status,
      Error_Details: detail,
      Timestamp: new Date().toISOString(),
    };
    const data = (s.data as Record<string, unknown> | undefined) || {};
    for (const k in data) row[k] = data[k];
    return row;
  }

  /** Resolves a request field into a printable string (arrays → comma-joined labels). */
  function textOf(v: unknown): string {
    if (v == null) return "";
    if (Array.isArray(v)) {
      return v
        .map((x: unknown) => {
          const r = x as KoboRecord;
          if (!r) return "";
          const label = r.label ? String(r.label) : r.value !== undefined ? String(r.value) : "";
          return label;
        })
        .filter(Boolean)
        .join(", ");
    }
    return String(v);
  }

  /** True when the required field set is complete for the given request. */
  function fieldsReady(required: string[], request: ActionRequest | KoboRecord | null | undefined): boolean {
    const r = (request || {}) as KoboRecord;
    return required.every((f: string) => {
      const v = r[f];
      if (f === "prefix_suffix") return Boolean(String((r.prefix || "") as string).trim() || String((r.suffix || "") as string).trim());
      if (f === "countries") return Array.isArray(v) && v.length > 0;
      if (f === "sectors") return Array.isArray(v) && v.length > 0;
      if (f === "find") return Boolean(String((r.findText || "") as string).trim());
      // Gate flag only: the destination token is read from the store at run time.
      if (f === "transfer") return r.transferReady === true;
      if (f === "tags") {
        const mode = r.tagsMode === "replace" ? "replace" : r.tagsMode === "remove" ? "remove" : "append";
        return mode === "replace" || Boolean((Array.isArray(r.tags) ? r.tags : []).length);
      }
      return Boolean(v);
    });
  }

  window.KoboEnhance.actionRegistry = {
    FIELD_SPECS,
    PERMISSIONS,
    PERMISSION_IMPLIES,
    // Shared field wording lives in core/actions/action-interface.ts; expose
    // it here for legacy callers without duplicating it (registry -> interface
    // only, so the two modules never reference each other).
    get FIELD_LABELS(): Record<string, string> {
      return KE.actionInterface.FIELD_LABELS;
    },
    register,
    get,
    list,
    groups,
    permissionLabel,
    reduceToBasePermissions,
    rowFor,
    textOf,
    fieldsReady,
    get ACTIONS(): Action[] {
      // Live, ordered view of every registered action (the toolbar's source of truth).
      return order.map((id) => actionsByValue[id]);
    },
  };
})();