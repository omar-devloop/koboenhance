"use strict";
/**
 * entry/main.js — isolated-world entry point. Loads state and starts the
 * in-page integration once the page is ready.
 */
(function () {
    const KE = window.KoboEnhance;
    // Wiring: inject the page UI gateway into the (core) action executor so
    // core stays UI-agnostic. `components` is loaded from the ui layer; entry
    // is the only place allowed to connect the two.
    KE.actionExecutor.setDefaultUi({
        alert(message) {
            KE.components.showDialogInPage(message, document.body);
        },
        confirm(message, buttons, title, details) {
            return KE.components.showConfirmDialogInPage(message, buttons, document.body, title, details);
        },
        toast(opts) {
            KE.components.showToast(opts);
        },
    });
    async function init() {
        await KE.store.load();
        KE.integration.init();
        if (KE.formSummaryTags && typeof KE.formSummaryTags.init === "function") {
            KE.formSummaryTags.init();
        }
        if (KE.formSummaryNotes && typeof KE.formSummaryNotes.init === "function") {
            KE.formSummaryNotes.init();
        }
    }
    /** Starts the extension; a failure is reported by the guard module instead
     *  of becoming an unhandled rejection that leaves the page silently bare. */
    function start() {
        init().catch(function (error) {
            try {
                KE.diagnostics.showStartupFailure(error);
            }
            catch {
                /* if even the guard is unavailable, do not mask the original error */
            }
        });
    }
    if (document.readyState === "complete" || document.readyState === "interactive") {
        start();
    }
    else {
        document.addEventListener("DOMContentLoaded", start);
    }
})();
