/**
 * features/bulk-actions/actions/description.actions.ts — Update project description.
 *
 * The description field opens its own row in the toolbar; it is intentionally
 * NOT a required field (an empty input means "clear the description"), so the
 * action only needs the project scope to run.
 */
(function () {
  const KE = window.KoboEnhance;
  const A = KE.actionRegistry;
  const { t } = KE.i18n;

  /** Config for the description action: the new description (empty = clear). */
  interface DescriptionConfig extends KoboRecord {
    description: string;
  }

  /** Per-project result data: the before/after description reported to the CSV. */
  interface DescriptionData extends KoboRecord {
    Old_Description?: string;
    New_Description?: string;
  }

  A.register("update_description", {
    label: "Update project description",
    group: "Project metadata",
    description: "Set or clear the description on selected projects",
    icon: "align-left",
    fields: ["description"],
    requiredFields: [],
    stepLabel: "Updating description",
    reportFields: ["Old_Description", "New_Description"],
    skipReason: "Description unchanged",
    confirmDetails(context: ActionContext<DescriptionConfig>) {
      const trimmed = (context.request.description || "").trim();
      return [trimmed ? t("Set description: \"{value}\"", { value: trimmed }) : t("Clear description")];
    },
    execute(ctx: ItemContext<DescriptionConfig> | AccountExecuteContext<DescriptionConfig, DescriptionData>) {
      const c = ctx as ItemContext<DescriptionConfig>;
      const { description } = c.request;
      return c.runtime.api.assets.fetchAsset(c.uid, c.signal).then((asset) => {
        const projectName = (asset && (asset.name || (asset.settings && asset.settings.name))) || "";
        const oldDescription = (asset && asset.settings && asset.settings.description) || "";
        const newDescription = description || "";
        const data: DescriptionData = { Old_Description: oldDescription, New_Description: newDescription };
        return newDescription === oldDescription
          ? { unchanged: true, projectName, data }
          : c.runtime.api.assets.updateAssetDescription(c.uid, newDescription, c.signal).then(() => ({
              unchanged: false,
              projectName,
              data,
            }));
      });
    },
  } as ActionParams<DescriptionConfig, DescriptionData>);
})();