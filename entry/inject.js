"use strict";
/**
 * entry/inject.js — runs in the MAIN world (page context) at document_start.
 * Hooks native fetch/XHR to observe requests to /api/v2/assets/ so the
 * in-page integration can learn the "active filter" query the user is
 * currently browsing with (search, ordering, collection, etc.) and use it
 * to paginate through matching projects for the "Import via Filters" feature.
 *
 * Also captures the signed-in username from Kobo's own API responses and
 * forwards it to the isolated-world content script over postMessage.
 */
(function () {
    const CHANNEL = "__koboenhance__";
    const ASSET_LIST_RE = /\/api\/v2\/assets\/(\?|$)/;
    const ASSET_DETAIL_RE = /\/api\/v2\/assets\/([a-zA-Z0-9]+)\/$/;
    const USER_RE = /\/api\/v2\/users\/?(\?|$)/;
    const ME_RE = /\/me\/(\?|$)/;
    function report(url) {
        try {
            const u = new URL(url, window.location.origin);
            const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
            if (ASSET_LIST_RE.test(path)) {
                window.postMessage({ channel: CHANNEL, type: "asset-list-request", url: u.toString() }, window.location.origin);
            }
        }
        catch (e) {
            /* ignore malformed URLs */
        }
    }
    function extractUsername(body) {
        if (!body || typeof body !== "object")
            return;
        if (body.username && typeof body.username === "string" && body.username !== "me") {
            postUsername(body.username, "me");
        }
    }
    function postUsername(username, source) {
        window.postMessage({ channel: CHANNEL, type: "username", source: source || "me", username: username }, window.location.origin);
    }
    /** Posts the tags from Kobo's own asset-list response (no extra API call). */
    function postAssets(url, body) {
        try {
            const u = new URL(url, window.location.origin);
            const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
            if (!ASSET_LIST_RE.test(path))
                return;
            const results = ((body && body.results) || []);
            if (!results.length)
                return;
            const assets = [];
            for (const a of results) {
                const uid = a && a.uid;
                if (!uid)
                    continue;
                const s = a && a.settings;
                const t = (s && s.extra_metadata && s.extra_metadata.tags);
                assets.push({
                    uid: uid,
                    tags: Array.isArray(t) ? t.filter((x) => typeof x === "string") : [],
                });
            }
            if (assets.length) {
                window.postMessage({ channel: CHANNEL, type: "asset-list-detail", url: u.toString(), assets: assets }, window.location.origin);
            }
        }
        catch (e) { /* ignore malformed payloads */ }
    }
    /** Posts tags and notes from a single-asset detail response (form summary page). */
    function postAssetDetail(url, body) {
        try {
            const u = new URL(url, window.location.origin);
            const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
            const m = path.match(/\/api\/v2\/assets\/([a-zA-Z0-9]+)\/$/);
            if (!m || !body || typeof body !== "object")
                return;
            const uid = m[1];
            const s = body.settings;
            const em = (s && s.extra_metadata) || null;
            const t = em && em.tags;
            const n = em && em.notes;
            window.postMessage({
                channel: CHANNEL,
                type: "asset-detail",
                uid: uid,
                tags: Array.isArray(t) ? t.filter((x) => typeof x === "string") : [],
                notes: typeof n === "string" ? n : null,
            }, window.location.origin);
        }
        catch (e) { /* ignore */ }
    }
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        report(url);
        return nativeFetch.apply(this, arguments).then(function (res) {
            try {
                const u = new URL(url, window.location.origin);
                const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
                if (USER_RE.test(path) || ME_RE.test(path)) {
                    res.clone().json().then(extractUsername).catch(function () { });
                }
                else if (ASSET_LIST_RE.test(path)) {
                    res.clone().json().then(function (body) { postAssets(url, body); }).catch(function () { });
                }
                else if (ASSET_DETAIL_RE.test(path)) {
                    res.clone().json().then(function (body) { postAssetDetail(url, body); }).catch(function () { });
                }
            }
            catch (e) { /* ignore */ }
            return res;
        });
    };
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.__ke_url = url;
        report(url);
        return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        this.addEventListener("load", function () {
            try {
                const u = new URL(this.__ke_url || "", window.location.origin);
                const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
                const text = this.responseText;
                if (USER_RE.test(path) || ME_RE.test(path)) {
                    extractUsername(JSON.parse(text));
                }
                else if (ASSET_LIST_RE.test(path) && text) {
                    postAssets(this.__ke_url, JSON.parse(text));
                }
                else if (ASSET_DETAIL_RE.test(path) && text) {
                    postAssetDetail(this.__ke_url, JSON.parse(text));
                }
            }
            catch (e) { /* ignore */ }
        });
        return nativeSend.apply(this, arguments);
    };
})();
