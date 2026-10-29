/**
 * features/bulk-actions/actions/name.actions.ts — Add prefix/suffix +
 * Find-and-replace text in project names.
 */
(function () {
  const KE = window.KoboEnhance;
  const A = KE.actionRegistry;
  const { t } = KE.i18n;

  function escapeRegExp(str: string): string {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Config for prefix/suffix renaming: the texts to add around the name. */
  interface RenameConfig extends KoboRecord {
    prefix: string;
    suffix: string;
  }

  /** Per-project result data: the before/after name reported to the CSV. */
  interface RenameData extends KoboRecord {
    Old_Name?: string;
    New_Name?: string;
  }

  /** Config for find-and-replace: the source + replacement text. */
  interface ReplaceConfig extends KoboRecord {
    findText: string;
    replaceText: string;
  }

  /** Per-project result data: the before/after name reported to the CSV. */
  interface ReplaceData extends KoboRecord {
    Old_Name?: string;
    New_Name?: string;
  }

  A.register("rename_prefix_suffix", {
    label: "Add prefix/suffix to names",
    group: "Project metadata",
    description: "Add a prefix and/or suffix to selected project names",
    icon: "type",
    fields: ["prefix", "suffix"],
    requiredFields: ["prefix_suffix"],
    stepLabel: "Renaming",
    reportFields: ["Old_Name", "New_Name"],
    confirmDetails(context: ActionContext<RenameConfig>) {
      const lines: string[] = [];
      if ((context.request.prefix || "").trim()) lines.push(t("Prefix: \"{value}\"", { value: context.request.prefix }));
      if ((context.request.suffix || "").trim()) lines.push(t("Suffix: \"{value}\"", { value: context.request.suffix }));
      return lines;
    },
    execute(ctx: ItemContext<RenameConfig> | AccountExecuteContext<RenameConfig, RenameData>) {
      const c = ctx as ItemContext<RenameConfig>;
      const { prefix, suffix } = c.request;
      return c.runtime.api.assets.fetchAsset(c.uid, c.signal).then((asset) => {
        const oldName = (asset && (asset.name || (asset.settings && asset.settings.name))) || "";
        const newName = `${prefix || ""}${oldName}${suffix || ""}`;
        const data: RenameData = { Old_Name: oldName, New_Name: newName };
        return newName === oldName
          ? { unchanged: true, projectName: newName, data }
          : c.runtime.api.assets.renameAsset(c.uid, newName, c.signal).then(() => ({
              unchanged: false,
              projectName: newName,
              data,
            }));
      });
    },
  } as ActionParams<RenameConfig, RenameData>);

  A.register("replace_text", {
    label: "Replace text in names",
    group: "Project metadata",
    description: "Find and replace text in selected project names",
    icon: "find",
    fields: ["find", "replace"],
    requiredFields: ["find"],
    stepLabel: "Replacing text",
    reportFields: ["Old_Name", "New_Name"],
    skipReason: "Text not found in name",
    confirmDetails(context: ActionContext<ReplaceConfig>) {
      return [t("Find: \"{value}\"", { value: context.request.findText }), t("Replace with: \"{value}\"", { value: context.request.replaceText || "" })];
    },
    execute(ctx: ItemContext<ReplaceConfig> | AccountExecuteContext<ReplaceConfig, ReplaceData>) {
      const c = ctx as ItemContext<ReplaceConfig>;
      const { findText, replaceText } = c.request;
      return c.runtime.api.assets.fetchAsset(c.uid, c.signal).then((asset) => {
        const oldName = (asset && (asset.name || (asset.settings && asset.settings.name))) || "";
        const newName = oldName.replace(new RegExp(escapeRegExp(findText), "g"), replaceText || "");
        const data: ReplaceData = { Old_Name: oldName, New_Name: newName };
        return newName === oldName
          ? { unchanged: true, projectName: newName, data }
          : c.runtime.api.assets.renameAsset(c.uid, newName, c.signal).then(() => ({
              unchanged: false,
              projectName: newName,
              data,
            }));
      });
    },
  } as ActionParams<ReplaceConfig, ReplaceData>);
})();