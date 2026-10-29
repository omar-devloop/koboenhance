"use strict";
/**
 * features/bulk-actions/actions/name.actions.ts — Add prefix/suffix +
 * Find-and-replace text in project names.
 */
(function () {
    const KE = window.KoboEnhance;
    const A = KE.actionRegistry;
    const { t } = KE.i18n;
    function escapeRegExp(str) {
        return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
        confirmDetails(context) {
            const lines = [];
            if ((context.request.prefix || "").trim())
                lines.push(t("Prefix: \"{value}\"", { value: context.request.prefix }));
            if ((context.request.suffix || "").trim())
                lines.push(t("Suffix: \"{value}\"", { value: context.request.suffix }));
            return lines;
        },
        execute(ctx) {
            const c = ctx;
            const { prefix, suffix } = c.request;
            return c.runtime.api.assets.fetchAsset(c.uid, c.signal).then((asset) => {
                const oldName = (asset && (asset.name || (asset.settings && asset.settings.name))) || "";
                const newName = `${prefix || ""}${oldName}${suffix || ""}`;
                const data = { Old_Name: oldName, New_Name: newName };
                return newName === oldName
                    ? { unchanged: true, projectName: newName, data }
                    : c.runtime.api.assets.renameAsset(c.uid, newName, c.signal).then(() => ({
                        unchanged: false,
                        projectName: newName,
                        data,
                    }));
            });
        },
    });
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
        confirmDetails(context) {
            return [t("Find: \"{value}\"", { value: context.request.findText }), t("Replace with: \"{value}\"", { value: context.request.replaceText || "" })];
        },
        execute(ctx) {
            const c = ctx;
            const { findText, replaceText } = c.request;
            return c.runtime.api.assets.fetchAsset(c.uid, c.signal).then((asset) => {
                const oldName = (asset && (asset.name || (asset.settings && asset.settings.name))) || "";
                const newName = oldName.replace(new RegExp(escapeRegExp(findText), "g"), replaceText || "");
                const data = { Old_Name: oldName, New_Name: newName };
                return newName === oldName
                    ? { unchanged: true, projectName: newName, data }
                    : c.runtime.api.assets.renameAsset(c.uid, newName, c.signal).then(() => ({
                        unchanged: false,
                        projectName: newName,
                        data,
                    }));
            });
        },
    });
})();
