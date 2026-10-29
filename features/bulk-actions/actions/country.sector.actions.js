"use strict";
/**
 * features/bulk-actions/actions/country.sector.actions.ts — Update project
 * country / sector (both replace the current value).
 */
(function () {
    const KE = window.KoboEnhance;
    const A = KE.actionRegistry;
    const { t } = KE.i18n;
    A.register("update_country", {
        label: "Update project country",
        group: "Project metadata",
        description: "Replace the country list on selected projects",
        icon: "globe",
        fields: ["countries"],
        requiredFields: ["countries"],
        stepLabel: "Updating country",
        reportFields: ["Old_Countries", "New_Countries"],
        skipReason: "Countries already match selection",
        confirmDetails(context) {
            return [t("Set countries: {values}", { values: A.textOf(context.request.countries) }), t("Mode: Replace existing countries")];
        },
        execute(ctx) {
            const c = ctx;
            const countries = c.request.countries || [];
            return c.runtime.api.assets.fetchAsset(c.uid, c.signal).then((asset) => {
                const projectName = (asset && (asset.name || (asset.settings && asset.settings.name))) || "";
                const cur = (asset && asset.settings && Array.isArray(asset.settings.country))
                    ? asset.settings.country
                    : [];
                const oldStr = cur
                    .map((c) => (c && (c.label || c.value)) || "")
                    .filter(Boolean)
                    .join(", ");
                const next = countries
                    .filter((c) => c && c.value)
                    .map((c) => ({ label: c.label || c.value, value: c.value }));
                const newStr = next.map((c) => c.label).join(", ");
                const data = { Old_Countries: oldStr, New_Countries: newStr };
                const unchanged = cur.map((c) => c && c.value).join(",") === next.map((c) => c.value).join(",");
                return unchanged
                    ? { unchanged: true, projectName, data }
                    : c.runtime.api.assets.updateAssetCountry(c.uid, next, c.signal).then(() => ({
                        unchanged: false,
                        projectName,
                        data,
                    }));
            });
        },
    });
    A.register("update_sector", {
        label: "Update project sector",
        group: "Project metadata",
        description: "Set the sector on selected projects",
        icon: "target",
        fields: ["sectors"],
        requiredFields: ["sectors"],
        stepLabel: "Updating sector",
        reportFields: ["Old_Sector", "New_Sector"],
        skipReason: "Sector already matches selection",
        confirmDetails(context) {
            return [t("Set sector: {values}", { values: A.textOf(context.request.sectors) }), t("Mode: Replace existing sector")];
        },
        execute(ctx) {
            const c = ctx;
            const sectors = c.request.sectors || [];
            const next = sectors[0] || null;
            return c.runtime.api.assets.fetchAsset(c.uid, c.signal).then((asset) => {
                const projectName = (asset && (asset.name || (asset.settings && asset.settings.name))) || "";
                const cur = ((asset && asset.settings && asset.settings.sector) || {});
                const oldStr = (cur && (cur.label || cur.value)) || "";
                const newStr = next ? next.label || next.value : "";
                const data = { Old_Sector: oldStr, New_Sector: newStr };
                const unchanged = !!next && (cur && cur.value) === next.value;
                return unchanged
                    ? { unchanged: true, projectName, data }
                    : c.runtime.api.assets.updateAssetSector(c.uid, next || {}, c.signal).then(() => ({
                        unchanged: false,
                        projectName,
                        data,
                    }));
            });
        },
    });
})();
