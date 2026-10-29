/**
 * features/bulk-actions/actions/anonymous.submissions.ts — Toggle anonymous
 * submissions on surveys.
 *
 * "Allow submissions to this form without a username and password" is not a
 * deployment field on this Kobo version: the UI toggles it by granting
 * `add_submissions` to the `AnonymousUser` collaborator (POST a new
 * permission-assignment to turn on, DELETE the existing row to turn off).
 * This action mirrors that exact API behaviour for the selected projects.
 */
(function () {
  const KE = window.KoboEnhance;
  const A = KE.actionRegistry;
  const { t } = KE.i18n;

  const ANON = "AnonymousUser";
  const PERM = "add_submissions";

  /** Returns { changed } once the AnonymousUser assignment reflects `enabled`. */
  function applyAnonymousSubmission(uid: UID, enabled: boolean, signal?: AbortSignal): Promise<{ changed: boolean }> {
    return KE.apiPermissions.getPermissionAssignments(uid, signal).then((assignments) => {
      const rows = assignments.filter(
        (a) => a.username.toLowerCase() === ANON.toLowerCase() && a.permissionCode === PERM
      );
      if (enabled) {
        if (rows.length) return { changed: false };
        return KE.apiPermissions.shareAsset(uid, ANON, PERM, signal).then(() => ({ changed: true }));
      }
      if (!rows.length) return { changed: false };
      let chain: Promise<unknown> = Promise.resolve();
      for (const row of rows) {
        if (!row.id) return Promise.reject(new Error("AnonymousUser assignment has no id to delete."));
        chain = chain.then(() => KE.apiPermissions.removePermissionAssignment(uid, row.id as string, signal));
      }
      return chain.then(() => ({ changed: true }));
    });
  }

  function make(enabled: boolean): ActionParams {
    return {
      label: enabled ? "Allow anonymous submissions" : "Disallow anonymous submissions",
      group: "Settings",
      description: enabled
        ? "Allow submitting to the selected projects without a username and password"
        : "Require a username and password to submit to the selected projects",
      icon: enabled ? "unlock" : "lock",
      fields: [],
      requiredFields: [],
      stepLabel: "Saving setting",
      reportFields: [],
      confirmDetails() {
        return [enabled ? t("Mode: Allow anonymous submissions (on)") : t("Mode: Disallow anonymous submissions (off)")];
      },
      execute(ctx: ItemContext | AccountExecuteContext) {
        const c = ctx as ItemContext;
        return applyAnonymousSubmission(c.uid, enabled, c.signal).then((r) =>
          r.changed ? { unchanged: false } : { unchanged: true, message: enabled ? t("Already allowed") : t("Already disallowed") }
        );
      },
    };
  }

  A.register("anonymous-submissions-on", make(true));
  A.register("anonymous-submissions-off", make(false));
})();