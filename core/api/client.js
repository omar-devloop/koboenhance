"use strict";
/**
 * core/api/client.ts — centralized HTTP/API client factory (KE.apiClient).
 *
 * Every Kobo API request in KoboEnhance flows through a client from this
 * module. Two modes are supported, because the cross-account transfer feature
 * has to talk to a *second* Kobo account on a possibly *different* server:
 *
 *   mode "session" (the default, KE.apiClient) — the current page/session.
 *     Requests run in-page (same-origin) so the user's session cookie is
 *     attached automatically and the CSRF header is filled from the session
 *     cookie by auth.buildHeaders. No API keys/tokens are stored anywhere.
 *
 *   mode "token" — a second account addressed by API token, on its own base
 *     URL. Used only by the cross-account transfer feature. Sends
 *     "Authorization: Token <token>" and NOTHING else: no session cookie
 *     (credentials "omit", so the signed-in account's cookie can never leak
 *     into the other account's requests) and no X-CSRFToken (meaningless to the
 *     other account, and a non-simple header that would force a CORS preflight).
 *
 * The two modes differ ONLY in base URL, credentials mode, and header building.
 * Everything else — the retry policy, error normalization, abort handling — is
 * shared, so there is exactly one implementation of each behaviour.
 *
 * Common HTTP behavior consolidated here:
 *  - verb methods: get / post / patch / delete
 *  - base URL handling (paths resolved against the client's own base URL)
 *  - request headers (Accept default + per-request extras, then auth/Authorization)
 *  - JSON body serialization is left to callers; response JSON is parsed here
 *  - HTTP error handling -> consistent ApiError objects (with status + detail)
 *  - 403 retry-once for state-changing (non-GET) requests
 *  - centralized retry policy: transient failures only (temporary network
 *    failures + 408/429/5xx), bounded retries with exponential backoff,
 *    a 429's "Retry-After" honoured (capped), cancel-aware, original error
 *    preserved on exhaustion
 *  - 204 -> null, empty body -> null
 *  - AbortSignal support threaded through to fetch (bulk runs cancel this way)
 */
(function () {
    const KE = window.KoboEnhance;
    const { auth } = KE;
    const { ApiError } = KE.errors;
    // ---------------------------------------------------------------------
    // Centralized retry policy (bounded retries, transient failures only).
    // Every request made through any client shares this policy; individual
    // actions must not implement their own retry loops.
    //   - retryable: temporary network failures (fetch-level TypeError) and
    //     transient server responses (408, 429, 500, 502, 503, 504)
    //   - NEVER retried: validation (4xx), auth (401), permission (403), not
    //     found (404), any other permanent failure, and user cancellation
    //     (AbortError) — cancellation stops waiting immediately
    //   - the original (first) error is thrown once retries are exhausted, so
    //     callers still see the root cause untouched
    // ---------------------------------------------------------------------
    const RETRY_MAX = 3; // total attempts: 1 initial + 2 retries
    const RETRYABLE_STATUS = { 408: true, 429: true, 500: true, 502: true, 503: true, 504: true };
    const RETRY_BASE_DELAY_MS = 500;
    const RETRY_JITTER_MS = 250;
    /** Longest Retry-After honoured, so a bad header cannot stall a run. */
    const MAX_RETRY_AFTER_MS = 60000;
    /**
     * How long the server asked us to wait, in milliseconds, or null when it did
     * not say. "Retry-After" is either a number of seconds or an HTTP date.
     *
     * A throttled destination that answers "retry after 60s" must not be
     * retried earlier than that, so the value wins over the exponential backoff.
     */
    function retryAfterMs(res) {
        const h = res.headers.get("Retry-After");
        if (!h)
            return null;
        const secs = Number(h);
        if (Number.isFinite(secs))
            return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_AFTER_MS);
        const t = Date.parse(h);
        return Number.isNaN(t) ? null : Math.min(Math.max(t - Date.now(), 0), MAX_RETRY_AFTER_MS);
    }
    function isRetryableError(e) {
        const err = (e || {});
        if (err.name === "AbortError")
            return false;
        // Known-offline failures burn nothing: retrying an unreachable network is
        // pointless, the caller handles the offline case immediately.
        if (typeof navigator !== "undefined" && navigator.onLine === false)
            return false;
        if (typeof err.status === "number")
            return RETRYABLE_STATUS[err.status] === true;
        // No status means a fetch-level network failure (e.g. TypeError
        // "Failed to fetch") — exactly the temporary failure we want to retry.
        return true;
    }
    /** Abort-aware backoff sleep: resolving in `ms` or rejecting immediately on abort. */
    function retryDelay(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                reject(new DOMException("The operation was aborted.", "AbortError"));
                return;
            }
            let timer;
            const onAbort = () => {
                clearTimeout(timer);
                reject(new DOMException("The operation was aborted.", "AbortError"));
            };
            timer = setTimeout(() => {
                if (signal)
                    signal.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            if (signal)
                signal.addEventListener("abort", onAbort, { once: true });
        });
    }
    /** Builds the request headers for a client. The Authorization/CSRF decision
     *  is the ONLY behavioural difference between the two modes. Authorization
     *  is applied last so a caller can never accidentally strip it. */
    function buildHeaders(config, extra) {
        if (config.mode === "token") {
            return Object.assign({
                Accept: "application/json",
            }, extra || {}, { Authorization: `Token ${config.token || ""}` });
        }
        return auth.buildHeaders(extra);
    }
    /** Creates a client. `baseUrl` defaults to the current page origin (session
     *  mode only); token clients must be given an explicit base URL. */
    function createClient(config) {
        const cfg = {
            mode: config.mode,
            baseUrl: config.baseUrl || (config.mode === "session" ? auth.getBaseUrl() : ""),
            token: config.token || "",
        };
        /** The API base URL this client resolves paths against. */
        function clientBaseUrl() {
            return cfg.baseUrl || auth.getBaseUrl();
        }
        /** Resolves a path (or absolute URL) against this client's base URL. */
        function resolveUrl(path) {
            const value = String(path == null ? "" : path);
            return new URL(value, clientBaseUrl()).toString();
        }
        /**
         * Low-level request core. Callers pass a fully-resolved URL plus fetch-style
         * options ({ headers, method, body, signal, ... }). Normalizes the shared
         * response/error conventions for every request.
         */
        async function request(url, options = {}, retried = false) {
            let attempt = 0;
            let originalError = null;
            while (true) {
                let failure;
                try {
                    const res = await fetch(url, {
                        // Token clients must NOT carry the signed-in account's cookie.
                        credentials: cfg.mode === "session" ? "same-origin" : "omit",
                        method: options.method,
                        headers: buildHeaders(cfg, options.headers),
                        body: options.body === undefined ? null : options.body,
                        signal: options.signal,
                    });
                    if (res.status === 403 && !retried && options.method && options.method !== "GET") {
                        return request(url, options, true);
                    }
                    if (!res.ok) {
                        let detail = "";
                        try {
                            const body = (await res.json());
                            detail = body && typeof body.detail === "string" ? body.detail : JSON.stringify(body);
                        }
                        catch (e) {
                            detail = res.statusText;
                        }
                        const error = new ApiError(`HTTP ${res.status}`, res.status, detail);
                        // A 429 usually says how long to wait; carry it so the retry loop
                        // can honour it instead of guessing with the backoff.
                        const retryAfter = retryAfterMs(res);
                        if (retryAfter !== null)
                            error.retryAfterMs = retryAfter;
                        throw error;
                    }
                    if (res.status === 204)
                        return null;
                    const text = await res.text();
                    return text ? JSON.parse(text) : null;
                }
                catch (e) {
                    failure = e;
                }
                if (originalError === null)
                    originalError = failure;
                if (!isRetryableError(failure) || attempt >= RETRY_MAX - 1) {
                    // Exhausted (or permanent): surface the ORIGINAL error untouched.
                    throw originalError;
                }
                attempt++;
                const exponentialDelay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * RETRY_JITTER_MS);
                const serverDelay = failure?.retryAfterMs;
                const wait = typeof serverDelay === "number" ? Math.max(exponentialDelay, serverDelay) : exponentialDelay;
                await retryDelay(wait, options.signal);
            }
        }
        /** GET with optional query params and an AbortSignal. */
        function get(url, options = {}) {
            const { headers, params, signal } = options;
            const query = params || {};
            const target = new URL(resolveUrl(url));
            for (const key of Object.keys(query)) {
                const value = query[key];
                if (value !== undefined && value !== null)
                    target.searchParams.set(key, String(value));
            }
            return request(target.toString(), { headers, signal });
        }
        /** POST with optional headers, JSON body, and an AbortSignal. */
        function post(url, options = {}) {
            const { headers, body, signal } = options;
            return request(resolveUrl(url), { method: "POST", headers, body, signal });
        }
        /** PATCH with optional headers, body, and an AbortSignal. */
        function patch(url, options = {}) {
            const { headers, body, signal } = options;
            return request(resolveUrl(url), { method: "PATCH", headers, body, signal });
        }
        /** DELETE with optional headers, body, and an AbortSignal. */
        function del(url, options = {}) {
            const { headers, body, signal } = options;
            return request(resolveUrl(url), { method: "DELETE", headers, body, signal });
        }
        return {
            mode: cfg.mode,
            baseUrl: clientBaseUrl,
            resolveUrl,
            request,
            get,
            post,
            patch,
            delete: del,
        };
    }
    // The default client is instance 0: the current page/session, unchanged from
    // before the factory existed. Every existing call site keeps working.
    const apiClient = createClient({ mode: "session" });
    window.KoboEnhance.apiClient = apiClient;
    window.KoboEnhance.createApiClient = createClient;
})();
