"use strict";
/**
 * features/bulk-actions/actions/tags.actions.ts — Manage tags (append / replace / remove).
 */
(function () {
    const KE = window.KoboEnhance;
    const A = KE.actionRegistry;
    const { t } = KE.i18n;
    A.register("add_tags", {
        label: "Manage tags",
        group: "Project metadata",
        description: "Append, replace, or remove the tags on selected projects",
        icon: "tag",
        fields: ["tags"],
        requiredFields: ["tags"],
        stepLabel: "Updating tags",
        reportFields: ["Tag_Action", "Input_Tags", "Old_Tags", "New_Tags"],
        reportSlug: "manage_tags",
        skipReason: "Tags unchanged",
        confirmDetails(context) {
            const mode = context.request.tagsMode === "replace" ? "replace" : context.request.tagsMode === "remove" ? "remove" : "append";
            const modeLine = mode === "replace" ? t("Mode: Replace all existing tags") : mode === "remove" ? t("Mode: Remove specified tags") : t("Mode: Append to existing tags");
            const tagsText = (context.request.tags || [])
                .map((x) => String(x || "").trim())
                .filter(Boolean)
                .join(", ");
            return [t("Tags: {values}", { values: tagsText }), modeLine];
        },
        execute(ctx) {
            const c = ctx;
            const { tags, tagsMode } = c.request;
            const inputTags = (tags || []).map((t) => String(t || "").trim()).filter(Boolean);
            const tagMode = tagsMode === "replace" ? "replace" : tagsMode === "remove" ? "remove" : "append";
            return c.runtime.api.assets.fetchAsset(c.uid, c.signal).then((asset) => {
                const projectName = (asset && (asset.name || (asset.settings && asset.settings.name))) || "";
                const currentExtra = ((asset && asset.settings && asset.settings.extra_metadata) || {});
                const currentTags = Array.isArray(currentExtra.tags)
                    ? currentExtra.tags.filter((x) => typeof x === "string")
                    : [];
                const oldStr = currentTags.map((t) => t.trim()).filter(Boolean).join(", ");
                let nextTags;
                if (tagMode === "replace") {
                    nextTags = inputTags.slice();
                }
                else if (tagMode === "remove") {
                    const removeSet = new Set(inputTags.map((t) => String(t).trim()));
                    nextTags = currentTags
                        .map((t) => String(t).trim())
                        .filter((v) => v && !removeSet.has(v));
                }
                else {
                    const seen = new Set();
                    nextTags = [];
                    for (const t of currentTags.concat(inputTags)) {
                        const v = String(t).trim();
                        if (v && !seen.has(v)) {
                            seen.add(v);
                            nextTags.push(v);
                        }
                    }
                }
                const data = {
                    Tag_Action: tagMode,
                    Input_Tags: inputTags.join(", "),
                    Old_Tags: oldStr,
                    New_Tags: nextTags.join(", "),
                };
                const unchanged = currentTags.map((t) => t.trim()).filter(Boolean).join(",") === nextTags.join(",");
                return unchanged
                    ? { unchanged: true, projectName, data }
                    : c.runtime.api.assets.updateAssetTags(c.uid, Object.assign({}, currentExtra, { tags: nextTags }), c.signal).then(() => ({ unchanged: false, projectName, data }));
            });
        },
    });
})();
