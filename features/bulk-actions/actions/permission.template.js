"use strict";
/**
 * features/bulk-actions/actions/permission.template.ts — Apply permission template.
 *
 * Grants every user→permission pair of ONE saved template onto each selected
 * project. The template is fetched once per run (in validate) and reused by
 * every target execute. Like Copy permissions, the apply is additive and
 * non-destructive: an existing user keeps their current permission and is
 * reported as skipped (a differing permission is still skipped, but shown).
 *
 * Templates are saved via the toolbar's manage dialog and persist in
 * localStorage (core/templates.store.ts).
 */
(function () {
    const KE = window.KoboEnhance;
    const A = KE.actionRegistry;
    const { t } = KE.i18n;
    // Fetched once per run in validate() and reused by every target execute().
    let activeTemplate = null;
    A.register("apply-permission-template", {
        label: "Apply permission template",
        group: "Permissions",
        description: "Grant a saved set of users their permissions on the selected projects",
        icon: "users",
        fields: ["template"],
        requiredFields: ["template"],
        stepLabel: "Applying permissions",
        reportFields: ["Template", "Copied_Users", "Copied", "Skipped_Users"],
        confirmDetails(context) {
            if (!activeTemplate)
                return [];
            const perms = new Map();
            for (const g of activeTemplate.grants)
                perms.set(g.permission, (perms.get(g.permission) || 0) + 1);
            const summaries = Array.from(perms.entries()).map(([code, count]) => `${count} \u00D7 ${A.permissionLabel(code)}`);
            return [
                t("Template: {name}", { name: activeTemplate.name }),
                t("Users: {n}", { n: activeTemplate.grants.length }),
                summaries.length ? t("Grants: {values}", { values: summaries.join(", ") }) : t("Grants: (empty)"),
            ];
        },
        // The report's Permission column reflects that several permissions are granted.
        permissionOut() {
            return "multiple";
        },
        async validate(context) {
            const base = await KE.actionInterface.validateBase(context.def, context);
            if (base)
                return base;
            activeTemplate = KE.templates.get(context.request.templateId);
            if (!activeTemplate) {
                return { message: t("The selected permission template no longer exists.") };
            }
            if (!activeTemplate.grants.length) {
                return { message: t("The template \"{name}\" has no users to share.", { name: activeTemplate.name }) };
            }
            const list = activeTemplate.grants.map((g) => g.username);
            const missing = [];
            await Promise.all(list.map(async (username) => {
                try {
                    await context.runtime.api.users.lookupUser(username);
                }
                catch (e) {
                    const err = (e || {});
                    const reason = (String(err.detail || "") || "").trim()
                        || (String(err.message || "") || "").trim()
                        || String(e);
                    missing.push(reason ? `${username} (${reason})` : username);
                }
            }));
            if (missing.length) {
                return {
                    toast: {
                        type: "warning",
                        title: missing.length === 1 ? t("User not found") : t("Users not found"),
                        description: missing.join("\n"),
                    },
                };
            }
            return null;
        },
        execute(ctx) {
            const c = ctx;
            const tpl = activeTemplate || KE.templates.get(c.request.templateId);
            if (!tpl || !tpl.grants.length) {
                return Promise.resolve({ unchanged: true, message: t("No template grants to apply") });
            }
            return c.runtime.api.permissions.getPermissionAssignments(c.uid, c.signal).then((existing) => {
                const have = new Map();
                for (const a of existing)
                    have.set(a.username, a.permissionCode);
                const toAdd = [];
                const conflicts = [];
                const same = [];
                for (const g of tpl.grants) {
                    if (!have.has(g.username))
                        toAdd.push(g);
                    else if (have.get(g.username) !== g.permission)
                        conflicts.push(g.username);
                    else
                        same.push(g.username);
                }
                // The owner's permissions cannot be assigned explicitly, so skip the
                // target project's owner and grant everyone else.
                const base = {
                    Template: tpl.name,
                    Copied_Users: toAdd.length,
                    Copied: toAdd.map((g) => `${g.username} (${A.permissionLabel(g.permission)})`).join("; "),
                    Skipped_Users: conflicts.concat(same).join("; "),
                };
                if (!toAdd.length)
                    return { unchanged: true, data: base };
                return c.runtime.api.assets.fetchAsset(c.uid, c.signal).then((asset) => {
                    const owner = (asset.owner__username || (asset.owner && asset.owner.username) || "").toLowerCase();
                    const targets = [];
                    const ownerSkips = [];
                    for (const g of toAdd) {
                        if (owner && g.username.toLowerCase() === owner)
                            ownerSkips.push(g.username);
                        else
                            targets.push(g);
                    }
                    let chain = Promise.resolve();
                    const failed = [];
                    for (const g of targets) {
                        chain = chain
                            .then(() => c.runtime.api.permissions.shareAsset(c.uid, g.username, g.permission, c.signal))
                            .catch(() => {
                            failed.push(g.username);
                        });
                    }
                    return chain.then(() => {
                        const skipped = conflicts.concat(same, ownerSkips.map((u) => `${u} (owner)`), failed.map((u) => `${u} (failed)`));
                        const data = {
                            Template: tpl.name,
                            Copied_Users: targets.length - failed.length,
                            Copied: targets
                                .filter((g) => !failed.includes(g.username))
                                .map((g) => `${g.username} (${A.permissionLabel(g.permission)})`)
                                .join("; "),
                            Skipped_Users: skipped.join("; "),
                        };
                        return { unchanged: targets.length - failed.length === 0, data };
                    });
                });
            });
        },
    });
})();
