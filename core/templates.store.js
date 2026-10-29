"use strict";
/**
 * core/templates.store.ts — persisted permission templates.
 *
 * Templates are plain user→permission grant sets a data manager saves once and
 * reuses to share many projects. They live in localStorage under the Kobo
 * origin (keyed like the existing tags-column preference) because the whole
 * integration runs in the page context where chrome.storage is unreachable.
 * Templates stay "dumb": usernames are NOT resolved at save time — that happens
 * once per run, at action validation, matching the share action's contract.
 */
(function () {
    window.KoboEnhance = window.KoboEnhance || {};
    const { t } = window.KoboEnhance.i18n;
    const STORE_KEY = "ke:permissionTemplates";
    const MAX_TEMPLATES = 100;
    let cache = [];
    function newId() {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }
        return "tpl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }
    /** Trims names, drops empty rows, and keeps ONE grant per user — the
     *  template model stores a single base permission code, exactly like Kobo's
     *  own share UI (Kobo expands it server-side; see
     *  actionRegistry.PERMISSION_IMPLIES). Callers reduce the API's per-implied-
     *  permission rows to their base code before saving, so first-wins here is
     *  the correct dedupe, not a data loss.
     *
     *  A grant that somehow carries a legacy `permissions` array is read from its
     *  first entry so nothing already in localStorage is lost. */
    function normalize(tpl) {
        if (!tpl)
            return null;
        const name = String(tpl.name || "").trim();
        if (!name)
            return null;
        const seen = new Set();
        const grants = [];
        const raw = Array.isArray(tpl.grants) ? tpl.grants : [];
        for (const g of raw) {
            if (!g || typeof g !== "object")
                continue;
            const source = g;
            const username = String(source.username || "").trim();
            if (!username || seen.has(username))
                continue;
            let permission = String(source.permission || "").trim();
            if (!permission && Array.isArray(source.permissions)) {
                for (const c of source.permissions) {
                    const code = String(c || "").trim();
                    if (code) {
                        permission = code;
                        break;
                    }
                }
            }
            if (!permission)
                continue;
            seen.add(username);
            grants.push({ username, permission });
        }
        return {
            id: String(tpl.id || newId()),
            name,
            grants,
            updatedAt: typeof tpl.updatedAt === "number" ? tpl.updatedAt : Date.now(),
        };
    }
    function persist() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(cache));
        }
        catch (e) {
            /* storage full / blocked — templates just won't persist across reloads */
        }
    }
    function loadCache() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw)
                return [];
            const parsed = JSON.parse(raw);
            const out = [];
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    const ok = normalize(item);
                    if (ok)
                        out.push(ok);
                }
            }
            return out;
        }
        catch (e) {
            return [];
        }
    }
    /**
     * Ensures no other template shares the same name. Append " (2)", " (3)", …
     * until a free name is found so saved templates always stay unique.
     */
    function uniqueName(name, ignoreId) {
        let candidate = name;
        let n = 2;
        while (resolve().some((t) => t.id !== ignoreId && (t.name || "").toLowerCase() === candidate.toLowerCase())) {
            candidate = `${name} (${n++})`;
        }
        return candidate;
    }
    function resolve() {
        cache = loadCache();
        return cache;
    }
    /** Detached copy: the `permissions` array is copied too, so a caller mutating
     *  a returned grant can never reach back into the cache. */
    function copyTemplate(tpl) {
        return {
            ...tpl,
            grants: tpl.grants.map((g) => ({ ...g })),
        };
    }
    window.KoboEnhance.templates = {
        list() {
            return resolve().map(copyTemplate);
        },
        get(id) {
            const found = resolve().find((t) => t.id === id);
            if (!found)
                return null;
            return copyTemplate(found);
        },
        create(name) {
            const tpl = {
                id: newId(),
                name: uniqueName(String(name || "").trim() || t("New template"), ""),
                grants: [],
                updatedAt: Date.now(),
            };
            cache = [...resolve(), tpl].slice(0, MAX_TEMPLATES);
            persist();
            return { ...tpl, grants: [] };
        },
        save(input) {
            const tpl = normalize(input);
            if (!tpl)
                throw new Error(t("Template name is required."));
            tpl.name = uniqueName(tpl.name, tpl.id);
            tpl.updatedAt = Date.now();
            const current = resolve();
            const idx = current.findIndex((t) => t.id === tpl.id);
            if (idx >= 0) {
                current[idx] = tpl;
                cache = current.slice(0, MAX_TEMPLATES);
            }
            else {
                cache = [...current, tpl].slice(0, MAX_TEMPLATES);
            }
            persist();
            return copyTemplate(tpl);
        },
        remove(id) {
            cache = resolve().filter((t) => t.id !== id);
            persist();
        },
    };
})();
