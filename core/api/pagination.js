"use strict";
/**
 * core/api/pagination.ts — reusable paginated API handling for Kobo list
 * endpoints. Both helpers follow the `next` pagination URL returned by the
 * API, perform each page request through KE.apiClient, and stay abortable via
 * an AbortSignal threaded through every request.
 */
(function () {
    const KE = window.KoboEnhance;
    const { apiClient } = KE;
    const { t } = KE.i18n;
    /** Longest filter URL accepted. A real Kobo asset-list URL is far shorter. */
    const MAX_FILTER_URL_LENGTH = 4096;
    /** Kobo's asset-list endpoint, with or without the trailing slash. */
    const ASSET_LIST_PATH = "/api/v2/assets";
    /**
     * Validates a filter URL before it is stored or fetched.
     *
     * The filter URL arrives from the page (the MAIN-world bridge posts the
     * asset-list URL Kobo itself requested) and is later used to page through
     * the account. Without a check, a crafted value could point the pagination
     * at a different origin or at an arbitrary path on the Kobo host.
     *
     * Accepted: a string that resolves to the API client's own origin AND to
     * the asset-list endpoint. Everything else is refused.
     *
     * Returns the normalized absolute URL, or null when the value is not usable.
     */
    function sanitizeFilterUrl(raw) {
        if (typeof raw !== "string" || !raw || raw.length > MAX_FILTER_URL_LENGTH)
            return null;
        let u;
        try {
            u = new URL(raw, apiClient.baseUrl());
        }
        catch (e) {
            return null;
        }
        let base;
        try {
            base = new URL(apiClient.baseUrl());
        }
        catch (e) {
            return null;
        }
        if (u.origin !== base.origin)
            return null;
        if (u.pathname !== ASSET_LIST_PATH && !u.pathname.startsWith(ASSET_LIST_PATH + "/"))
            return null;
        return u.toString();
    }
    /**
     * True when a `next` pagination URL stays on the API client's own origin.
     * A `next` link pointing anywhere else is not followed.
     */
    function isSameOrigin(raw) {
        if (typeof raw !== "string" || !raw)
            return false;
        try {
            const base = new URL(apiClient.baseUrl());
            return new URL(raw, apiClient.baseUrl()).origin === base.origin;
        }
        catch (e) {
            return false;
        }
    }
    /** The single reason a filter URL is refused, as a user-facing sentence. */
    function invalidFilterUrl() {
        return new Error(t("The project list filter is not valid."));
    }
    /** Follows the `next` pagination URL, forcing limit=100, calling onPage(results) as it goes. */
    async function fetchAllByFilter(filterUrl, onPage, signal) {
        // The stored filter URL is re-validated here, so a value that slipped
        // into the store (from an older page, a bookmarked state or a tampered
        // message) can never be fetched.
        const safe = sanitizeFilterUrl(filterUrl);
        if (!safe)
            throw invalidFilterUrl();
        let url;
        try {
            url = new URL(safe);
        }
        catch (e) {
            url = new URL(safe, apiClient.baseUrl());
        }
        url.searchParams.set("limit", "100");
        let nextUrl = url.toString();
        const collected = [];
        while (nextUrl) {
            const page = await apiClient.get(nextUrl, { signal });
            const results = (page && page.results) || [];
            collected.push(...results);
            if (typeof onPage === "function")
                onPage(results);
            nextUrl = page && page.next && isSameOrigin(page.next) ? page.next : null;
        }
        return collected;
    }
    /** Fetches all pages from a URL, passing the full page object (with count, results, next) to onPage. */
    async function fetchAllAssets(url, onPage, signal) {
        // Same guard as fetchAllByFilter: this is the path a whole-account run
        // actually takes with the stored filter URL, so it must be validated too.
        // An unusable filter URL is refused rather than silently widened to
        // "every project" — a bulk action must not run on projects the user
        // filtered out.
        const safe = sanitizeFilterUrl(url);
        if (!safe)
            throw invalidFilterUrl();
        let nextUrl;
        try {
            nextUrl = new URL(safe);
        }
        catch (e) {
            nextUrl = new URL(safe, apiClient.baseUrl());
        }
        nextUrl.searchParams.set("limit", "3000");
        let current = nextUrl.toString();
        while (current) {
            const page = await apiClient.get(current, { signal });
            if (typeof onPage === "function")
                onPage(page);
            current = page && page.next && isSameOrigin(page.next) ? page.next : null;
        }
    }
    window.KoboEnhance.pagination = { fetchAllByFilter, fetchAllAssets, sanitizeFilterUrl };
})();
