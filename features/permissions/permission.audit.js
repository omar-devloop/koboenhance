"use strict";
/**
 * features/permissions/permission.audit.ts — account-wide permission review.
 *
 * For every survey in scope it records owner + each assignment's permission
 * per user, then returns the structured rows for two export files (user
 * overview, per-project detail) plus the list of users considered
 * over-privileged (Manage on >= 3 projects).
 *
 * Scope resolution (runtime.scope.collect) and the per-item loop
 * (runtime.runItems) are supplied through the action's execution context
 * runtime; CSV formatting happens in the report stage (exportSvc.buildCsvFiles);
 * this module keeps the aggregation + report shaping + finished-toolbar UI
 * (report.summary).
 */
(function () {
    const KE = window.KoboEnhance;
    const { t } = KE.i18n;
    const OVERPRIVILEGED_MANAGE_MIN = 3;
    const USER_AUDIT_HEADERS = [
        "Username",
        "Projects_Accessible",
        "Owned_Projects",
        "Shared_Projects",
        "View",
        "Change",
        "Manage",
        "View_Submissions",
        "Edit_Submissions",
        "Delete_Submissions",
        "Validate_Submissions",
        "Add_Submissions",
    ];
    const PROJECT_AUDIT_HEADERS = [
        "Project_UID",
        "Project_Name",
        "Owner",
        "Username",
        "Permission_Code",
        "Permission_Label",
    ];
    function permissionLabel(permissions, code) {
        const list = permissions || [];
        const p = list.find((x) => x.code === code);
        return p ? t(p.label) : code;
    }
    function permissionAuditUserRows(users) {
        const rows = [];
        for (const username of Object.keys(users)) {
            const u = users[username];
            const perms = u.perms;
            rows.push({
                Username: username,
                Projects_Accessible: u.accessible.size,
                Owned_Projects: u.owned.size,
                Shared_Projects: u.accessible.size - u.owned.size,
                View: (perms.view_asset || new Set()).size,
                Change: (perms.change_asset || new Set()).size,
                Manage: (perms.manage_asset || new Set()).size,
                View_Submissions: (perms.view_submissions || new Set()).size,
                Edit_Submissions: (perms.change_submissions || new Set()).size,
                Delete_Submissions: (perms.delete_submissions || new Set()).size,
                Validate_Submissions: (perms.validate_submissions || new Set()).size,
                Add_Submissions: (perms.add_submissions || new Set()).size,
            });
        }
        return rows.sort((a, b) => b.Projects_Accessible - a.Projects_Accessible || a.Username.localeCompare(b.Username));
    }
    function ensureAuditUser(users, username) {
        if (!users[username]) {
            users[username] = { accessible: new Set(), owned: new Set(), perms: {} };
        }
        return users[username];
    }
    function buildResult(users, projectRows, outcome, surveysScanned, failedProjects) {
        const userRows = permissionAuditUserRows(users);
        const overPrivileged = userRows
            .filter((r) => r.Manage >= OVERPRIVILEGED_MANAGE_MIN)
            .map((r) => r.Username);
        return {
            userRows,
            projectRows,
            overPrivileged,
            outcome,
            surveysScanned,
            failedProjects,
            // Declared export intent only — CSV is formatted by the report stage.
            files: [
                { filename: "kobo-permission-audit-users", columns: USER_AUDIT_HEADERS, rows: userRows },
                { filename: "kobo-permission-audit-projects", columns: PROJECT_AUDIT_HEADERS, rows: projectRows },
            ],
        };
    }
    async function run(opts) {
        const uidList = opts.uidList;
        const filterUrl = opts.filterUrl;
        const signal = opts.signal;
        const onProgress = opts.onProgress;
        const runtime = opts.runtime;
        let ownUsername = "";
        try {
            ownUsername = await runtime.auth.getUsername();
        }
        catch (e) {
            ownUsername = "";
        }
        const users = {};
        const projectRows = [];
        let failedProjects = 0;
        let surveys = [];
        try {
            surveys = await runtime.scope.collect({ uids: uidList, filterUrl, signal, onProgress });
        }
        catch (e) {
            if (e && e.name === "AbortError") {
                return buildResult(users, projectRows, "stopped", surveys.length, failedProjects);
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
                try {
                    if (owner) {
                        const u = ensureAuditUser(users, owner);
                        u.owned.add(uid);
                        u.accessible.add(uid);
                        projectRows.push({
                            Project_UID: uid,
                            Project_Name: name,
                            Owner: owner,
                            Username: owner,
                            Permission_Code: "owner",
                            Permission_Label: "Owner",
                        });
                    }
                    const assignments = await runtime.api.permissions.getPermissionAssignments(uid, signal);
                    for (const a of assignments) {
                        if (!a.username)
                            continue;
                        const u = ensureAuditUser(users, a.username);
                        if (!u.perms[a.permissionCode])
                            u.perms[a.permissionCode] = new Set();
                        u.perms[a.permissionCode].add(uid);
                        u.accessible.add(uid);
                        projectRows.push({
                            Project_UID: uid,
                            Project_Name: name,
                            Owner: owner,
                            Username: a.username,
                            Permission_Code: a.permissionCode,
                            Permission_Label: permissionLabel(runtime.permissions, a.permissionCode),
                        });
                    }
                }
                catch (e) {
                    if (e.name === "AbortError")
                        throw e;
                    failedProjects++;
                    projectRows.push({
                        Project_UID: uid,
                        Project_Name: name,
                        Owner: owner,
                        Username: "",
                        Permission_Code: "error",
                        Permission_Label: (e.detail || e.message).slice(0, 200),
                    });
                }
                done++;
                return null;
            },
            onAbort: () => null,
            onProgress: () => {
                if (typeof onProgress === "function") {
                    onProgress(t("Auditing permissions... ({done}/{total})", { done, total: surveys.length }), done, surveys.length);
                }
            },
        });
        return buildResult(users, projectRows, res.stopped ? "stopped" : "done", surveys.length, failedProjects);
    }
    /**
     * Registers the account-kind action. report.summary turns the finished scan
     * into the exact dialog/toast/files the toolbar used to render by hand.
     */
    if (KE.actionRegistry && KE.actionInterface) {
        KE.actionRegistry.register("permission_audit", {
            kind: "account",
            label: "Permission audit",
            group: "Account tools",
            description: "Review all permissions across your account's projects",
            icon: "shield-check",
            fields: [],
            requiredFields: [],
            stepLabel: "Auditing",
            loadingStep: "Fetching project list...",
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
                    if (r.error) {
                        return { dialog: String(r.error) };
                    }
                    const userRows = r.userRows || [];
                    const projectRows = r.projectRows || [];
                    if (!userRows.length && !projectRows.length) {
                        if (r.outcome === "stopped")
                            return null;
                        return { dialog: t("No surveys were found to audit.") };
                    }
                    const overPrivileged = r.overPrivileged || [];
                    const files = (r.files || []).filter(Boolean);
                    return {
                        type: r.outcome === "stopped" ? "warning" : "success",
                        title: t("Permission audit"),
                        metrics: [
                            { label: t("Scanned"), value: r.surveysScanned },
                            { label: t("Users"), value: userRows.length, tone: userRows.length > 0 ? "success" : "" },
                            { label: t("Errors"), value: r.failedProjects, tone: r.failedProjects > 0 ? "error" : "" },
                            { label: t("Over-privileged"), value: overPrivileged.length, tone: overPrivileged.length > 0 ? "warning" : "" },
                        ],
                        files,
                    };
                },
            },
        });
    }
})();
