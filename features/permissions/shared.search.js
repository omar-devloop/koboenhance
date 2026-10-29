"use strict";
/**
 * features/permissions/shared.search.ts — "Check user access" account scan.
 *
 * Collects the survey projects under scope (selection or whole account) and
 * reports, per project, whether the target username can access it and with
 * which permissions.
 *
 * Scope resolution (runtime.scope.collect) and the per-item loop
 * (runtime.runItems) are supplied to the action through its execution
 * context runtime; this module keeps only the per-survey business logic, the
 * report shape, and the finished-toolbar UI (report.summary).
 */
(function () {
    const KE = window.KoboEnhance;
    const { t } = KE.i18n;
    const SHARED_HEADERS = [
        "Project_UID",
        "Project_Name",
        "Owner",
        "Target_User",
        "Access",
        "Permissions",
        "Status",
        "Timestamp",
    ];
    function permissionLabel(permissions, code) {
        const list = permissions || [];
        const p = list.find((x) => x.code === code);
        return p ? t(p.label) : code;
    }
    function makeStoppedRow(asset, username) {
        return {
            Project_UID: asset && asset.uid,
            Project_Name: (asset && (asset.name || (asset.settings && asset.settings.name))) || (asset && asset.uid),
            Owner: (asset && (asset.owner__username || (asset.owner && asset.owner.username))) || "",
            Target_User: username,
            Access: "stopped",
            Permissions: "",
            Status: "stopped",
            Timestamp: new Date().toISOString(),
        };
    }
    async function run(opts) {
        const uidList = opts.uidList;
        const username = opts.username || "";
        const filterUrl = opts.filterUrl;
        const signal = opts.signal;
        const onProgress = opts.onProgress;
        const runtime = opts.runtime;
        let surveys = [];
        try {
            surveys = await runtime.scope.collect({ uids: uidList, filterUrl, signal, onProgress });
        }
        catch (e) {
            if (e.name === "AbortError") {
                return { rows: [], outcome: "stopped", username, files: [] };
            }
            throw e;
        }
        let done = 0;
        const res = await runtime.runItems({
            items: surveys,
            signal,
            perItem: async (asset) => {
                const uid = asset && asset.uid;
                if (!uid)
                    return null;
                const name = (asset && (asset.name || (asset.settings && asset.settings.name))) || uid;
                const owner = asset.owner__username || (asset.owner && asset.owner.username) || "";
                let access = "none";
                let perms = [];
                let status = "ok";
                let error = "";
                try {
                    const assignments = await runtime.api.permissions.getPermissionAssignments(uid, signal);
                    const matched = assignments.filter((a) => String(a.username).toLowerCase() === String(username).toLowerCase());
                    perms = matched.map((a) => permissionLabel(runtime.permissions, a.permissionCode)).filter(Boolean);
                    if (String(owner).toLowerCase() === String(username).toLowerCase()) {
                        access = "owner";
                    }
                    else if (matched.length > 0) {
                        access = "shared";
                    }
                }
                catch (e) {
                    if (e.name === "AbortError")
                        throw e;
                    access = "error";
                    status = "error";
                    error = (e.detail || e.message);
                }
                done++;
                return {
                    Project_UID: uid,
                    Project_Name: name,
                    Owner: owner,
                    Target_User: username,
                    Access: access,
                    Permissions: [...new Set(perms)].join("; "),
                    Status: status + (error ? ` — ${error}` : ""),
                    Timestamp: new Date().toISOString(),
                };
            },
            onAbort: (remaining) => remaining.map((asset) => makeStoppedRow(asset, username)),
            onProgress: () => {
                if (typeof onProgress === "function") {
                    onProgress(t("Checking surveys... ({done}/{total})", { done, total: surveys.length }), done, surveys.length);
                }
            },
        });
        const rows = (res.rows || []);
        return {
            rows,
            outcome: res.stopped ? "stopped" : "done",
            username,
            // Declared export intent only — CSV is formatted by the report stage.
            files: [{ filename: "kobo-shared-projects", columns: SHARED_HEADERS, rows }],
        };
    }
    /**
     * Registers the account-kind action. Validation looks the username up
     * through the execution context runtime (like the legacy toolbar) before
     * the run may confirm; report.summary turns the finished scan into the
     * exact dialog/toast/file the toolbar used to render by hand.
     */
    if (KE.actionRegistry && KE.actionInterface) {
        KE.actionRegistry.register("find_shared", {
            kind: "account",
            label: "Check user access",
            group: "Account tools",
            description: "Scan your account for projects shared with a specific user",
            icon: "user-search",
            fields: ["username"],
            requiredFields: ["username"],
            fieldMessages: { username: "Enter a username to search for." },
            stepLabel: "Checking access",
            loadingStep: "Fetching project list...",
            async validate(context) {
                const base = KE.actionInterface.validateAccount(context.def, context);
                if (base)
                    return base;
                try {
                    await context.runtime.api.users.lookupUser(context.request.username);
                }
                catch (e) {
                    return { toast: { type: "warning", title: t("User not found"), description: (e.detail || e.message) } };
                }
                return null;
            },
            async execute(context) {
                const c = context;
                const res = (await run({
                    uidList: c.uidList,
                    username: c.request.username,
                    filterUrl: c.filterUrl,
                    signal: c.signal,
                    onProgress: c.onProgress,
                    runtime: c.runtime,
                })) || {};
                res.username = c.request.username;
                return res;
            },
            report: {
                slug: "kobo-shared-projects",
                summary(res) {
                    const r = res;
                    if (r.error) {
                        return { dialog: String(r.error) };
                    }
                    const rows = r.rows || [];
                    if (r.outcome === "stopped") {
                        if (!rows.length)
                            return null;
                        return sharedToast(r, rows);
                    }
                    if (!rows.length) {
                        return { dialog: t("No surveys were found to check.") };
                    }
                    return sharedToast(r, rows);
                },
            },
        });
    }
    function sharedToast(res, rows) {
        const shared = rows.filter((r) => r.Access === "shared").length;
        const owners = rows.filter((r) => r.Access === "owner").length;
        const errors = rows.filter((r) => r.Access === "error").length;
        const files = (res.files || []).filter(Boolean);
        return {
            type: res.outcome === "stopped" ? "warning" : "success",
            title: t("Check user access — \"{username}\"", { username: res.username || "" }),
            metrics: [
                { label: t("Checked"), value: rows.length },
                { label: t("Shared"), value: shared, tone: shared > 0 ? "success" : "" },
                { label: t("Owned"), value: owners, tone: owners > 0 ? "success" : "" },
                { label: t("Errors"), value: errors, tone: errors > 0 ? "error" : "" },
            ],
            files,
        };
    }
})();
