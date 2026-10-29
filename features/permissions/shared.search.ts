/**
 * features/permissions/shared.search.ts — "Check user access" account scan.
 *
 * Collects the survey projects under scope (selection or whole account) and
 * reports, per project, whether the target username can access it and with
 * which permissions.
 *
 * Scope resolution (runtime.scope.collect) and the per-item loop
 * (runtime.runItems) are supplied to the action through its execution
 * context runtime; this module keeps only the per-survey business logic, the
 * report shape, and the finished-toolbar UI (report.summary).
 */
(function () {
  const KE = window.KoboEnhance;
  const { t } = KE.i18n;

  const SHARED_HEADERS = [
    "Project_UID",
    "Project_Name",
    "Owner",
    "Target_User",
    "Access",
    "Permissions",
    "Status",
    "Timestamp",
  ];

  interface SharedRow extends KoboRecord {
    Project_UID?: string;
    Project_Name?: string;
    Owner?: string;
    Target_User?: string;
    Access?: string;
    Permissions?: string;
    Status?: string;
    Timestamp?: string;
  }

  interface SharedSearchResult extends KoboRecord {
    rows: SharedRow[];
    outcome?: string;
    username?: string;
    error?: string;
    stopped?: boolean;
    /** Declared export data; the report stage materializes it into CSV. */
    files?: ReportFileSpec[];
  }

  /** Config the execute context carries for this scan: the username to look up. */
  interface FindSharedConfig extends KoboRecord {
    username: string;
  }

  function permissionLabel(permissions: Permission[], code: string): string {
    const list = permissions || [];
    const p = list.find((x) => x.code === code);
    return p ? t(p.label as keyof EnDict) : code;
  }

  function makeStoppedRow(asset: Project, username: string): SharedRow {
    return {
      Project_UID: asset && asset.uid,
      Project_Name: (asset && (asset.name || (asset.settings && asset.settings.name))) || (asset && asset.uid),
      Owner: (asset && (asset.owner__username || (asset.owner && asset.owner.username))) || "",
      Target_User: username,
      Access: "stopped",
      Permissions: "",
      Status: "stopped",
      Timestamp: new Date().toISOString(),
    };
  }

  async function run(opts: {
    uidList?: UID[] | null;
    username?: string;
    filterUrl?: string | null;
    signal?: AbortSignal;
    onProgress?: RunProgressHandler;
    runtime: ActionRuntime;
  }): Promise<SharedSearchResult> {
    const uidList = opts.uidList;
    const username = opts.username || "";
    const filterUrl = opts.filterUrl;
    const signal = opts.signal;
    const onProgress = opts.onProgress;
    const runtime = opts.runtime;

    let surveys: Project[] = [];
    try {
      surveys = await runtime.scope.collect({ uids: uidList, filterUrl, signal, onProgress });
    } catch (e) {
      if ((e as KoboRecord).name === "AbortError") {
        return { rows: [], outcome: "stopped", username, files: [] };
      }
      throw e;
    }

    let done = 0;

    const res = await runtime.runItems<Project, SharedRow | null>({
      items: surveys,
      signal,
      perItem: async (asset) => {
        const uid = asset && asset.uid;
        if (!uid) return null;
        const name = (asset && (asset.name || (asset.settings && asset.settings.name))) || uid;
        const owner = asset.owner__username || (asset.owner && asset.owner.username) || "";
        let access = "none";
        let perms: string[] = [];
        let status = "ok";
        let error = "";
        try {
          const assignments = await runtime.api.permissions.getPermissionAssignments(uid, signal);
          const matched = assignments.filter(
            (a) => String(a.username).toLowerCase() === String(username).toLowerCase()
          );
          perms = matched.map((a) => permissionLabel(runtime.permissions, a.permissionCode)).filter(Boolean);
          if (String(owner).toLowerCase() === String(username).toLowerCase()) {
            access = "owner";
          } else if (matched.length > 0) {
            access = "shared";
          }
        } catch (e) {
          if ((e as KoboRecord).name === "AbortError") throw e;
          access = "error";
          status = "error";
          error = ((e as KoboRecord).detail || (e as KoboRecord).message) as string;
        }
        done++;
        return {
          Project_UID: uid,
          Project_Name: name,
          Owner: owner,
          Target_User: username,
          Access: access,
          Permissions: [...new Set(perms)].join("; "),
          Status: status + (error ? ` — ${error}` : ""),
          Timestamp: new Date().toISOString(),
        };
      },
      onAbort: (remaining) => remaining.map((asset) => makeStoppedRow(asset, username)),
      onProgress: () => {
        if (typeof onProgress === "function") {
          onProgress(t("Checking surveys... ({done}/{total})", { done, total: surveys.length }), done, surveys.length);
        }
      },
    });

    const rows = (res.rows || []) as SharedRow[];
    return {
      rows,
      outcome: res.stopped ? "stopped" : "done",
      username,
      // Declared export intent only — CSV is formatted by the report stage.
      files: [{ filename: "kobo-shared-projects", columns: SHARED_HEADERS, rows }],
    };
  }

  /**
   * Registers the account-kind action. Validation looks the username up
   * through the execution context runtime (like the legacy toolbar) before
   * the run may confirm; report.summary turns the finished scan into the
   * exact dialog/toast/file the toolbar used to render by hand.
   */
  if (KE.actionRegistry && KE.actionInterface) {
    KE.actionRegistry.register("find_shared", {
      kind: "account",
      label: "Check user access",
      group: "Account tools",
      description: "Scan your account for projects shared with a specific user",
      icon: "user-search",
      fields: ["username"],
      requiredFields: ["username"],
      fieldMessages: { username: "Enter a username to search for." },
      stepLabel: "Checking access",
      loadingStep: "Fetching project list...",
      async validate(context: ActionContext<FindSharedConfig, SharedSearchResult>) {
        const base = KE.actionInterface.validateAccount(context.def, context);
        if (base) return base;
        try {
          await context.runtime.api.users.lookupUser(context.request.username);
        } catch (e) {
          return { toast: { type: "warning", title: t("User not found"), description: ((e as KoboRecord).detail || (e as KoboRecord).message) as string } };
        }
        return null;
      },
      async execute(context: ItemContext<FindSharedConfig> | AccountExecuteContext<FindSharedConfig, SharedSearchResult>) {
        const c = context as AccountExecuteContext<FindSharedConfig, SharedSearchResult>;
        const res = (await run({
          uidList: c.uidList,
          username: c.request.username,
          filterUrl: c.filterUrl,
          signal: c.signal,
          onProgress: c.onProgress,
          runtime: c.runtime,
        })) || ({} as SharedSearchResult);
        res.username = c.request.username;
        return res;
      },
      report: {
        slug: "kobo-shared-projects",
        summary(res) {
          const r = res as SharedSearchResult;
          if (r.error) {
            return { dialog: String(r.error) };
          }
          const rows = r.rows || [];
          if (r.outcome === "stopped") {
            if (!rows.length) return null;
            return sharedToast(r, rows);
          }
          if (!rows.length) {
            return { dialog: t("No surveys were found to check.") };
          }
          return sharedToast(r, rows);
        },
      },
    } as ActionParams<FindSharedConfig, SharedSearchResult>);
  }

  function sharedToast(res: SharedSearchResult, rows: SharedRow[]): ToastOptions {
    const shared = rows.filter((r) => r.Access === "shared").length;
    const owners = rows.filter((r) => r.Access === "owner").length;
    const errors = rows.filter((r) => r.Access === "error").length;
    const files = (((res.files as unknown) || []) as UiFile[]).filter(Boolean);
    return {
      type: res.outcome === "stopped" ? "warning" : "success",
      title: t("Check user access — \"{username}\"", { username: res.username || "" }),
      metrics: [
        { label: t("Checked"), value: rows.length },
        { label: t("Shared"), value: shared, tone: shared > 0 ? "success" : "" },
        { label: t("Owned"), value: owners, tone: owners > 0 ? "success" : "" },
        { label: t("Errors"), value: errors, tone: errors > 0 ? "error" : "" },
      ],
      files,
    };
  }
})();