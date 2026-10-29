"use strict";
/**
 * core/collections/surveys.ts — shared survey-collection helpers used by
 * bulk-action whole-account runs and by the account-scan features
 * (check access, permission audit, exports). Pure data access over the
 * focused core/api modules (assets + pagination); reports progress via
 * onProgress(msg, done, total) and is abortable via signal.
 */
(function () {
    const { apiAssets, pagination } = window.KoboEnhance;
    const { t } = window.KoboEnhance.i18n;
    function resolveFilterUrl(filterUrl) {
        return filterUrl || `${window.KoboEnhance.auth.getBaseUrl()}/api/v2/assets/`;
    }
    function isSurvey(asset) {
        return !!asset && (asset.asset_type || "survey") === "survey";
    }
    /**
     * Resolves the UIDs of every "survey" asset under the current filter.
     * Used to resolve the project list for whole-account modify runs.
     */
    async function resolveUids(options) {
        const { filterUrl, onProgress, signal } = options;
        const uids = [];
        await pagination.fetchAllAssets(resolveFilterUrl(filterUrl), (page) => {
            for (const asset of (page && page.results) || []) {
                if (isSurvey(asset) && asset.uid)
                    uids.push(asset.uid);
            }
            if (typeof onProgress === "function") {
                onProgress(t("Resolving projects... ({n})", { n: uids.length }), uids.length, (page && page.count) || uids.length);
            }
        }, signal);
        return uids;
    }
    /**
     * Gathers "survey" assets for a scoped operation:
     *  - uidList given → fetches each asset individually (selected / custom UIDs)
     *  - otherwise → the whole account, respecting the current list filter.
     */
    async function collect(options) {
        const { uidList, filterUrl, onProgress, signal } = options;
        if (uidList && uidList.length) {
            const assets = [];
            for (const uid of uidList) {
                assets.push(await apiAssets.fetchAsset(uid, signal));
                if (typeof onProgress === "function") {
                    onProgress(t("Fetching projects... ({n}/{total})", { n: assets.length, total: uidList.length }), assets.length, uidList.length);
                }
            }
            return assets.filter(isSurvey);
        }
        const allAssets = [];
        await pagination.fetchAllAssets(resolveFilterUrl(filterUrl), (page) => {
            allAssets.push(...(page.results || []));
            if (typeof onProgress === "function") {
                onProgress(t("Fetching projects... ({n}/{total})", { n: allAssets.length, total: page.count || allAssets.length }), allAssets.length, page.count || allAssets.length);
            }
        }, signal);
        return allAssets.filter(isSurvey);
    }
    window.KoboEnhance.surveys = { resolveUids, collect };
})();
