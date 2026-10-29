"use strict";
/**
 * core/transfer/transport.ts — content-script client for the background service
 * worker (core/transfer/transport.sw.ts).
 *
 * Every request that crosses the server boundary to the DESTINATION account
 * goes through here, because the destination is a second Kobo account on a
 * different origin and the browser will not let the page read such responses.
 * Source-account requests do NOT come here — they use the ordinary session
 * client (KE.apiClient) and are already same-origin.
 *
 * This file owns:
 *  - correlation ids, so a response can be matched to its request
 *  - wiring an AbortSignal to the worker's cancel op, so stopping a bulk run
 *    actually aborts the in-flight network request
 *  - translating a missing/errored background into a typed failure code rather
 *    than a raw chrome.runtime error
 *
 * The token is always passed in explicitly by the caller (the destination
 * store owns it). It is never read from storage here and never logged.
 */
(function () {
    const KE = window.KoboEnhance;
    const SEND_TIMEOUT_MS = 180000;
    function newId() {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
            return crypto.randomUUID();
        return `ke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    /** Raw round-trip to the service worker. Resolves with the worker's response,
     *  or rejects with a short reason the caller can map to a message. */
    function send(req) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                reject(new Error("no-background"));
            }, SEND_TIMEOUT_MS);
            try {
                chrome.runtime.sendMessage(req, function (response) {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        reject(new Error("no-background"));
                        return;
                    }
                    if (!response || typeof response !== "object") {
                        reject(new Error("no-background"));
                        return;
                    }
                    resolve(response);
                });
            }
            catch (e) {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                // Thrown when the extension context was invalidated (e.g. reloaded).
                reject(new Error("no-background"));
            }
        });
    }
    /** Sends a request and, if the caller's signal fires, asks the worker to
     *  abort the matching in-flight request before rejecting. */
    async function run(req, signal) {
        if (signal && signal.aborted)
            throw new DOMException("Aborted", "AbortError");
        let onAbort = null;
        if (signal) {
            onAbort = () => {
                const cancel = { ke: "koboenhance-transfer", op: "cancel", id: req.id };
                try {
                    chrome.runtime.sendMessage(cancel, function () {
                        void chrome.runtime.lastError;
                    });
                }
                catch (e) {
                    /* context gone; nothing to cancel */
                }
            };
            signal.addEventListener("abort", onAbort, { once: true });
        }
        try {
            return await send(req);
        }
        finally {
            if (signal && onAbort)
                signal.removeEventListener("abort", onAbort);
        }
    }
    function base(token, id) {
        return { ke: "koboenhance-transfer", id, token };
    }
    function checkAccount(token, kfUrl, signal) {
        const req = Object.assign(base(token, newId()), {
            op: "checkAccount",
            url: `${kfUrl}/api/v2/`,
        });
        return run(req, signal);
    }
    function getJson(token, url, params, signal) {
        const req = Object.assign(base(token, newId()), {
            op: "getJson",
            url,
            params,
        });
        return run(req, signal);
    }
    function mutateJson(token, url, method, payload, signal) {
        const req = Object.assign(base(token, newId()), {
            op: "mutateJson",
            url,
            method,
            payload,
        });
        return run(req, signal);
    }
    function postForm(token, url, fields, signal) {
        const req = Object.assign(base(token, newId()), {
            op: "postForm",
            url,
            fields,
        });
        return run(req, signal);
    }
    function patchForm(token, url, fields, signal) {
        const req = Object.assign(base(token, newId()), {
            op: "patchForm",
            url,
            fields,
        });
        return run(req, signal);
    }
    function submitXml(token, url, xml, submissionId, signal) {
        const req = Object.assign(base(token, newId()), {
            op: "submitXml",
            url,
            xml,
            submissionId,
        });
        return run(req, signal);
    }
    window.KoboEnhance.transferTransport = {
        checkAccount,
        getJson,
        mutateJson,
        postForm,
        patchForm,
        submitXml,
    };
})();
