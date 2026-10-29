"use strict";
/**
 * core/errors/guard.ts — last-resort error boundary for KoboEnhance.
 *
 * Two problems this solves:
 *
 *   1. A throw inside entry/main.ts's init() used to be an unhandled rejection:
 *      the toolbar silently never appeared, and the user got no message.
 *      showStartupFailure() records the error and mounts a standalone banner
 *      (independent of the toolbar and its styles) with Reload / Copy
 *      diagnostics.
 *
 *   2. Errors raised outside the init() promise chain — the MutationObserver
 *      callback, the postMessage bridge, a user click handler — were invisible.
 *      install() listens for window "error" and "unhandledrejection".
 *
 * Diagnostics are local only: a 20-entry, redacted ring buffer in
 * chrome.storage.local under "ke:diagnostics", which the About popup can copy
 * for a support report. Nothing is uploaded. See docs/privacy-policy.md.
 */
(function () {
    const KE = window.KoboEnhance;
    const STORAGE_KEY = "ke:diagnostics";
    const BANNER_ID = "ke-startup-error";
    const MAX_ENTRIES = 20;
    const MAX_MESSAGE = 400;
    const MAX_STACK = 2000;
    const MAX_URL = 500;
    const TOAST_INTERVAL_MS = 5000;
    const DUPLICATE_WINDOW_MS = 3000;
    const SAVE_DELAY_MS = 500;
    const buffer = [];
    let installed = false;
    let lastToastAt = 0;
    let lastKey = "";
    let lastMessageAt = 0;
    let saveTimer = null;
    /** The English template itself is the key; never let i18n failures hide the
     *  one message that explains something broke. */
    function t(key) {
        try {
            return KE.i18n.t(key);
        }
        catch {
            return key;
        }
    }
    function version() {
        try {
            if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getManifest === "function") {
                return String(chrome.runtime.getManifest().version || "unknown");
            }
        }
        catch {
            /* extension context invalidated */
        }
        return "unknown";
    }
    function lang() {
        try {
            return KE.i18n.getLang();
        }
        catch {
            return "en";
        }
    }
    /** Origin + path only: query strings can carry user-entered search text. */
    function pageUrl() {
        try {
            return (location.origin + location.pathname).slice(0, MAX_URL);
        }
        catch {
            return "";
        }
    }
    /** Strip anything that looks like a Kobo API token before persisting. Kobo
     *  tokens are 40 hex characters; headers and query parameters are covered
     *  too because a future error message might embed one. */
    function redact(value) {
        return value
            .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"',;}]+/gi, "$1[redacted]")
            .replace(/((?:token|api[_-]?key)\s*[:=]\s*)[^\s"',;}]+/gi, "$1[redacted]")
            .replace(/([?&](?:token|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]")
            .replace(/\b[0-9a-f]{40}\b/gi, "[redacted]");
    }
    function describe(error) {
        let message = "";
        let stack = "";
        try {
            // `instanceof Error` is false for errors from another realm (an iframe,
            // a rejected value created by a different script), so accept any object
            // that carries a string message.
            const errorLike = error;
            if (error instanceof Error ||
                (errorLike && typeof errorLike === "object" && typeof errorLike.message === "string")) {
                message = String(errorLike && errorLike.message ? errorLike.message : "") ||
                    String(errorLike && errorLike.name ? errorLike.name : "");
                stack = errorLike && typeof errorLike.stack === "string" ? errorLike.stack : "";
            }
            else if (typeof error === "string") {
                message = error;
            }
            else {
                const json = JSON.stringify(error);
                message = json === undefined ? String(error) : json;
            }
        }
        catch {
            message = String(error);
        }
        return {
            message: redact(message).slice(0, MAX_MESSAGE) || "Unknown error",
            stack: stack ? redact(stack).slice(0, MAX_STACK) : undefined,
        };
    }
    function write() {
        try {
            if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local)
                return;
            const payload = {
                version: version(),
                updatedAt: new Date().toISOString(),
                entries: buffer,
            };
            const result = chrome.storage.local.set({ [STORAGE_KEY]: payload });
            if (result && typeof result.catch === "function") {
                result.catch(function () {
                    /* quota or an invalidated context: diagnostics are best effort */
                });
            }
        }
        catch {
            /* never let diagnostics break the page */
        }
    }
    function persist(immediate) {
        if (immediate) {
            if (saveTimer !== null) {
                window.clearTimeout(saveTimer);
                saveTimer = null;
            }
            write();
            return;
        }
        if (saveTimer !== null)
            return;
        saveTimer = window.setTimeout(function () {
            saveTimer = null;
            write();
        }, SAVE_DELAY_MS);
    }
    function record(kind, error) {
        try {
            const described = describe(error);
            const now = Date.now();
            // The MutationObserver can throw on every DOM change; keep one copy.
            const key = kind + ":" + described.message;
            if (key === lastKey && now - lastMessageAt < DUPLICATE_WINDOW_MS)
                return;
            lastKey = key;
            lastMessageAt = now;
            buffer.unshift({
                time: new Date(now).toISOString(),
                kind,
                message: described.message,
                stack: described.stack,
                url: pageUrl(),
                lang: lang(),
                version: version(),
                userAgent: navigator.userAgent.slice(0, 300),
            });
            if (buffer.length > MAX_ENTRIES)
                buffer.length = MAX_ENTRIES;
            persist(kind === "startup");
        }
        catch {
            /* reporting must never throw */
        }
    }
    /** One toast per page load burst; the full details are in the buffer. */
    function toastOnce() {
        const now = Date.now();
        if (now - lastToastAt < TOAST_INTERVAL_MS)
            return;
        lastToastAt = now;
        try {
            if (document.body && KE.components && typeof KE.components.showToast === "function") {
                // Error toasts are sticky by design; the guard closes its own after a
                // few seconds so a burst cannot cover the page.
                const toast = KE.components.showToast({
                    type: "error",
                    title: t("KoboEnhance hit an unexpected error. Reload the page to try again."),
                });
                if (toast && typeof toast.dismiss === "function") {
                    window.setTimeout(function () {
                        try {
                            toast.dismiss();
                        }
                        catch {
                            /* already gone */
                        }
                    }, 8000);
                }
            }
        }
        catch {
            /* the toolbar may not exist yet */
        }
    }
    function toJSON() {
        try {
            return JSON.stringify({
                extension: "KoboEnhance",
                version: version(),
                generatedAt: new Date().toISOString(),
                page: pageUrl(),
                lang: lang(),
                userAgent: navigator.userAgent,
                entries: buffer,
            }, null, 2);
        }
        catch {
            return JSON.stringify({ extension: "KoboEnhance", version: version(), entries: buffer });
        }
    }
    async function copy() {
        const text = toJSON();
        try {
            await navigator.clipboard.writeText(text);
            return true;
        }
        catch {
            // Fallback for a document that is not focused (or a denied permission).
            try {
                const area = document.createElement("textarea");
                area.value = text;
                area.setAttribute("readonly", "true");
                area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
                document.body.appendChild(area);
                area.select();
                const ok = document.execCommand("copy");
                area.remove();
                return ok;
            }
            catch {
                return false;
            }
        }
    }
    function button(label, primary) {
        const el = document.createElement("button");
        el.type = "button";
        el.textContent = label;
        el.style.cssText = [
            "appearance:none",
            "border:1px solid " + (primary ? "#0086d6" : "#c9ced6"),
            "border-radius:6px",
            "padding:5px 10px",
            "font:600 12px 'Segoe UI', system-ui, -apple-system, sans-serif",
            "cursor:pointer",
            primary ? "background:#0086d6" : "background:#fff",
            primary ? "color:#fff" : "color:#2e2e2e",
        ].join(";");
        return el;
    }
    /**
     * Standalone failure banner: deliberately independent of the toolbar, its
     * stylesheet and the state store, because any of those may be what failed.
     */
    function showStartupFailure(error) {
        record("startup", error);
        toastOnce();
        try {
            if (document.getElementById(BANNER_ID))
                return;
            const host = document.body || document.documentElement;
            if (!host)
                return;
            const box = document.createElement("div");
            box.id = BANNER_ID;
            box.setAttribute("role", "alert");
            box.style.cssText = [
                "position:fixed",
                "right:16px",
                "bottom:16px",
                "z-index:2147483647",
                "width:min(400px, calc(100vw - 32px))",
                "box-sizing:border-box",
                "padding:14px 16px",
                "border:1px solid #e0a800",
                "border-radius:10px",
                "background:#fffdf5",
                "box-shadow:0 8px 28px rgba(0,0,0,.22)",
                "font:13px/1.45 'Segoe UI', system-ui, -apple-system, sans-serif",
                "color:#2e2e2e",
            ].join(";");
            const head = document.createElement("div");
            head.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin-bottom:6px";
            const title = document.createElement("div");
            title.textContent = t("KoboEnhance could not start");
            title.style.cssText = "flex:1;font-size:14px;font-weight:600;color:#8a5a00";
            head.appendChild(title);
            const close = document.createElement("button");
            close.type = "button";
            close.textContent = "\u00d7";
            close.setAttribute("aria-label", t("Dismiss"));
            close.style.cssText = [
                "appearance:none",
                "border:0",
                "background:transparent",
                "color:#8a5a00",
                "font:400 20px/1 'Segoe UI', system-ui, sans-serif",
                "padding:0 2px",
                "cursor:pointer",
            ].join(";");
            close.addEventListener("click", function () {
                box.remove();
            });
            head.appendChild(close);
            box.appendChild(head);
            const message = document.createElement("div");
            message.textContent = t("KoboEnhance hit an unexpected error. Reload the page to try again.");
            message.style.cssText = "margin-bottom:8px";
            box.appendChild(message);
            const detail = document.createElement("code");
            detail.textContent = describe(error).message;
            detail.style.cssText = [
                "display:block",
                "max-height:64px",
                "overflow:auto",
                "margin-bottom:10px",
                "padding:6px 8px",
                "border-radius:6px",
                "background:#f4f4f4",
                "color:#555",
                "font:11px/1.4 ui-monospace, Consolas, monospace",
                "white-space:pre-wrap",
                "word-break:break-word",
            ].join(";");
            box.appendChild(detail);
            const actions = document.createElement("div");
            actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
            const reload = button(t("Reload"), true);
            reload.addEventListener("click", function () {
                location.reload();
            });
            actions.appendChild(reload);
            const copyBtn = button(t("Copy diagnostics"), false);
            copyBtn.addEventListener("click", function () {
                void copy().then(function (ok) {
                    copyBtn.textContent = ok ? t("Diagnostics copied") : t("Could not copy diagnostics");
                    window.setTimeout(function () {
                        copyBtn.textContent = t("Copy diagnostics");
                    }, 2500);
                });
            });
            actions.appendChild(copyBtn);
            box.appendChild(actions);
            const note = document.createElement("div");
            note.textContent = t("The error details stay in this browser. Nothing is sent anywhere.");
            note.style.cssText = "margin-top:8px;color:#6b7280;font-size:11px";
            box.appendChild(note);
            host.appendChild(box);
        }
        catch {
            /* reporting must never throw */
        }
    }
    function install() {
        if (installed)
            return;
        installed = true;
        window.addEventListener("error", function (event) {
            // Resource-load failures surface here without an Error; ignore them.
            if (!event.error && !event.message)
                return;
            record("error", event.error || event.message);
            toastOnce();
        });
        window.addEventListener("unhandledrejection", function (event) {
            record("rejection", event.reason);
            toastOnce();
        });
    }
    KE.diagnostics = {
        install: install,
        record: record,
        showStartupFailure: showStartupFailure,
        entries: function () {
            return buffer.slice();
        },
        toJSON: toJSON,
        copy: copy,
    };
    install();
})();
