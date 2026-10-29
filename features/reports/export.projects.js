"use strict";
/**
 * features/reports/export.projects.ts — "Export project list" account scan.
 *
 * Collects every survey project (selection or whole account) into structured
 * scalar rows. CSV formatting happens in the report stage
 * (exportSvc.buildCsvFiles), not here. Non-survey assets (templates, blocks,
 * questions, collections) are skipped, matching how every other scan in the
 * extension scopes itself. AbortError is intentionally NOT caught inside the
 * scan: the executor routes it to a stable { stopped } result and the
 * action's report.summary shows the "Export stopped." warning while this
 * long-poll fetch unwinds.
 *
 * The per-UID fetch loop uses runtime.runItems
 * (propagateAbort keeps the top-level stop wording in the caller).
 */
(function () {
    const KE = window.KoboEnhance;
    const { t } = KE.i18n;
    function isSurvey(asset) {
        return !!asset && (asset.asset_type || "survey") === "survey";
    }
    async function run(opts) {
        const uidList = opts.uidList;
        const filterUrl = opts.filterUrl;
        const signal = opts.signal;
        const onProgress = opts.onProgress;
        const runtime = opts.runtime;
        const url = filterUrl || `${runtime.auth.baseUrl}/api/v2/assets/`;
        const rows = [];
        let totalCount = 0;
        const flash = (msg, done, total) => {
            if (typeof onProgress === "function")
                onProgress(msg, done, total);
        };
        if (uidList && uidList.length) {
            totalCount = uidList.length;
            let fetched = 0;
            const res = await runtime.runItems({
                items: uidList,
                signal,
                propagateAbort: true,
                perItem: async (uid) => {
                    const asset = await runtime.api.assets.fetchAsset(uid, signal);
                    if (isSurvey(asset) && asset.uid) {
                        fetched++;
                        return runtime.report.scalarFields(asset);
                    }
                    return null;
                },
                onProgress: () => flash(t("Fetching projects... ({n}/{total})", { n: fetched, total: totalCount }), fetched, totalCount),
            });
            rows.push(...res.rows);
        }
        else {
            await runtime.pagination.fetchAllAssets(url, (page) => {
                totalCount = page.count;
                for (const asset of page.results) {
                    if (isSurvey(asset) && asset.uid)
                        rows.push(runtime.report.scalarFields(asset));
                }
                flash(t("Fetching projects... ({n}/{total})", { n: rows.length, total: totalCount }), rows.length, totalCount);
            }, signal);
        }
        // Declared export intent only — CSV is formatted by the report stage
        // (columns default to the union of the row keys).
        return { rows, files: [{ filename: "kobo-all-projects", rows }] };
    }
    /**
     * Registers the account-kind action. The loader toast wording and the
     * finished dialog/toast/file come from the action descriptor's
     * loadingStep + report.summary, so the toolbar stays fully generic.
     */
    if (KE.actionRegistry && KE.actionInterface) {
        KE.actionRegistry.register("export_all", {
            kind: "account",
            label: "Export project list",
            group: "Account tools",
            description: "Export a CSV of your survey projects",
            icon: "download",
            fields: [],
            requiredFields: [],
            stepLabel: "Exporting",
            loadingStep: "Fetching projects...",
            async execute(context) {
                const c = context;
                return (await run({
                    uidList: c.uidList,
                    filterUrl: c.filterUrl,
                    signal: c.signal,
                    onProgress: c.onProgress,
                    runtime: c.runtime,
                })) || {};
            },
            report: {
                summary(res) {
                    const r = res;
                    if (r.stopped) {
                        return { type: "warning", title: t("Export project list"), description: t("Export stopped.") };
                    }
                    if (r.error) {
                        return { type: "error", title: t("Export failed"), description: String(r.error) };
                    }
                    const rows = r.rows || [];
                    const files = (r.files || []).filter(Boolean);
                    return {
                        type: "success",
                        title: t("Export project list"),
                        description: t("Exported {n} project(s)", { n: rows.length }),
                        metrics: [{ label: t("Projects"), value: rows.length }],
                        files,
                    };
                },
            },
        });
    }
})();
