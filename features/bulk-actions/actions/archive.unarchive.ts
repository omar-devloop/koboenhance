/**
 * features/bulk-actions/actions/archive.unarchive.ts — Archive / Unarchive projects.
 *
 * Toggles the asset's deployment active flag via PATCH deployment endpoint.
 * Always reports success (never "unchanged").
 */
(function () {
  const KE = window.KoboEnhance;
  const A = KE.actionRegistry;
  const { t } = KE.i18n;

  function make(active: boolean): ActionParams {
    return {
      label: active ? "Archive projects" : "Unarchive projects",
      group: "Project status",
      description: active
        ? "Deactivate selected projects and their deployments"
        : "Reactivate selected archived projects",
      icon: active ? "archive" : "unarchive",
      fields: [],
      requiredFields: [],
      stepLabel: active ? "Archiving" : "Unarchiving",
      reportFields: [],
      confirmDetails() {
        return [active ? t("Mode: Archive (deactivate deployments)") : t("Mode: Unarchive (reactivate deployments)")];
      },
      execute(ctx: ItemContext | AccountExecuteContext) {
        return (ctx as ItemContext).runtime.api.assets.setAssetActive((ctx as ItemContext).uid, !active, ctx.signal).then(() => ({
          unchanged: false,
        }));
      },
    };
  }

  A.register("archive", make(true));
  A.register("unarchive", make(false));
})();