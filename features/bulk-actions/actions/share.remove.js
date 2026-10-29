"use strict";
/**
 * features/bulk-actions/actions/share.remove.ts — Share with user / Remove user access.
 */
(function () {
    const KE = window.KoboEnhance;
    const A = KE.actionRegistry;
    const { t } = KE.i18n;
    A.register("share", {
        label: "Share with user(s)",
        group: "Permissions",
        description: "Grant one or more users access to selected projects",
        icon: "user-plus",
        fields: ["users", "permission"],
        requiredFields: ["users", "permission"],
        stepLabel: "Sharing",
        reportFields: [],
        confirmDetails(context) {
            return [
                t("Users: {users}", { users: (context.request.usernames || []).join(", ") }),
                t("Permission: {label}", { label: A.permissionLabel(context.request.permission) }),
            ];
        },
        // The report's Permission column shows the permission granted by this action.
        permissionOut(request) {
            return request.permission;
        },
        async execute(ctx) {
            const c = ctx;
            const users = (c.request.usernames || []).slice();
            if (users.length === 1) {
                return c.runtime.api.permissions.shareAsset(c.uid, users[0], c.request.permission, c.signal).then(() => ({ unchanged: false }));
            }
            const failures = [];
            for (const username of users) {
                try {
                    await c.runtime.api.permissions.shareAsset(c.uid, username, c.request.permission, c.signal);
                }
                catch (e) {
                    const err = (e || {});
                    failures.push(`${username}: ${(err.detail || err.message || String(e))}`);
                }
            }
            if (failures.length) {
                throw new Error(failures.join("; "));
            }
            return { unchanged: false };
        },
    });
    A.register("remove", {
        label: "Remove user access",
        group: "Permissions",
        description: "Revoke a user's access from selected projects",
        icon: "user-minus",
        fields: ["username"],
        requiredFields: ["username"],
        stepLabel: "Removing access",
        reportFields: [],
        confirmDetails(context) {
            return [t("User: {username}", { username: context.request.username })];
        },
        execute(ctx) {
            const c = ctx;
            return c.runtime.api.permissions.removePermission(c.uid, c.request.username, c.signal).then(() => ({
                unchanged: false,
            }));
        },
    });
})();
