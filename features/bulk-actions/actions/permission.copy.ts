/**
 * features/bulk-actions/actions/permission.copy.ts — Copy permissions.
 *
 * Grants every collaborator of ONE source project onto each selected project.
 * The copy is additive and non-destructive: users already present on a target
 * are left untouched (a differing permission is skipped and reported). The
 * source collaborator list is fetched ONCE per run (in validate) and reused by
 * every target execute.
 */
(function () {
  const KE = window.KoboEnhance;
  const A = KE.actionRegistry;
  const { t } = KE.i18n;

  /** Config for the copy action: the source project UID/URL. */
  interface CopyConfig extends KoboRecord {
    sourceProject: string;
  }

  /** Per-target result payload (its keys become extra CSV report columns). */
  interface CopyResultData {
    Source_Project: string;
    Copied_Users: number;
    Copied: string;
    Skipped_Users: string;
  }

  // Fetched once per run in validate() and reused by every target execute().
  let sourceUid = "";
  let sourceAssignments: PermissionAssignment[] = [];

  /** Accepts a bare UID or a full form URL and returns the UID. */
  function uidFromInput(value: string): string {
    const raw = String(value || "").trim();
    const m = raw.match(/\/forms\/([a-zA-Z0-9]+)/);
    if (m && m[1]) return m[1];
    return raw.split(/[/?#\s]+/).filter(Boolean).pop() || "";
  }

  A.register("copy-permissions", {
    label: "Copy permissions from project",
    group: "Permissions",
    description: "Grant one project's collaborators onto the selected projects",
    icon: "copy",
    fields: ["sourceProject"],
    requiredFields: ["sourceProject"],
    stepLabel: "Copying permissions",
    reportFields: ["Source_Project", "Copied_Users", "Copied", "Skipped_Users"],
    confirmDetails(context: ActionContext<CopyConfig>) {
      return [
        t("Source: {value}", { value: sourceUid || context.request.sourceProject }),
        t("Collaborators: {n}", { n: sourceAssignments.length }),
      ];
    },
    // The report's Permission column reflects that several permissions were copied.
    permissionOut() {
      return "multiple";
    },
    async validate(context: ActionContext<CopyConfig>) {
      const base = await KE.actionInterface.validateBase(context.def, context);
      if (base) return base;

      sourceUid = uidFromInput(context.request.sourceProject);
      try {
        sourceAssignments = await context.runtime.api.permissions.getPermissionAssignments(sourceUid, context.signal);
      } catch (e) {
        const err = (e || {}) as KoboRecord;
        return {
          toast: {
            type: "error",
            title: t("Source project not found"),
            description: (err.detail || err.message) as string | undefined,
          },
        };
      }
      if (!sourceAssignments.length) {
        return { message: t("The source project has no collaborators to copy.") };
      }
      return null;
    },
    execute(ctx: ItemContext<CopyConfig> | AccountExecuteContext<CopyConfig>) {
      const c = ctx as ItemContext<CopyConfig>;
      if (c.uid === sourceUid) {
        return Promise.resolve({ unchanged: true, message: t("Source project skipped") });
      }
      return c.runtime.api.permissions.getPermissionAssignments(c.uid, c.signal).then((existing) => {
        const have = new Map<string, string>();
        for (const a of existing) have.set(a.username, a.permissionCode);

        const toAdd: PermissionAssignment[] = [];
        const conflicts: string[] = [];
        for (const a of sourceAssignments) {
          if (!have.has(a.username)) toAdd.push(a);
          else if (have.get(a.username) !== a.permissionCode) conflicts.push(a.username);
        }

        const data: CopyResultData = {
          Source_Project: sourceUid,
          Copied_Users: toAdd.length,
          Copied: toAdd.map((a) => `${a.username} (${A.permissionLabel(a.permissionCode)})`).join("; "),
          Skipped_Users: conflicts.join("; "),
        };

        if (!toAdd.length) return { unchanged: true, data };

        let chain: Promise<unknown> = Promise.resolve();
        for (const a of toAdd) {
          chain = chain.then(() => c.runtime.api.permissions.shareAsset(c.uid, a.username, a.permissionCode, c.signal));
        }
        return chain.then(() => ({ unchanged: false, data }));
      });
    },
  } as ActionParams<CopyConfig>);
})();
