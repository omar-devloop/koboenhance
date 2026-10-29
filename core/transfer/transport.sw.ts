/**
 * core/transfer/transport.sw.ts — background service worker for cross-account
 * transfer. Compiles in place to transport.sw.js, which manifest.json registers
 * as the background service worker.
 *
 * WHY THIS EXISTS
 * Kobo sends no Access-Control-Allow-Origin header on the KC host, so a
 * cross-origin POST of submission XML from the page — or from an MV3 content
 * script — cannot be read. This was verified empirically (2026-09-30): a fetch
 * from eu.kobotoolbox.org to kc-eu.kobotoolbox.org fails with a CORS error and
 * a 401, proving the endpoint is reachable but not CORS-enabled. A service
 * worker with host_permissions is not bound by CORS, so it is the only way to
 * POST submissions to the other account's server. See the README section
 * "Move projects to another account".
 *
 * SCOPE — this worker handles DESTINATION traffic only. Source-account requests
 * stay in the content script and use the ordinary session client (KE.apiClient),
 * which already works same-origin. Everything crossing the server boundary goes
 * through here, which is also why the destination token lives here and in the
 * content script's memory only.
 *
 * SECURITY
 *  - Every URL is checked against an explicit allow-list of the four official
 *    Kobo hosts AND an allow-list of the API paths the transfer uses. Anything
 *    else is refused before a request is made.
 *  - The message sender is checked too: only this extension's own content
 *    scripts, running on one of the four hosts, may drive the worker.
 *  - credentials "omit": the signed-in account's cookie can never be sent on a
 *    destination request.
 *  - redirects are refused (redirect: "error"), so a request can never be
 *    followed off the allow-list.
 *  - No CSRF header (meaningless to the destination, and it would force a
 *    preflight).
 *  - Tokens are never logged and never appear in an error message.
 *
 * DELIBERATE DUPLICATION
 * The retry policy below mirrors core/api/client.ts on purpose. The project
 * compiles with "module": "none" and this worker runs in a separate global
 * scope, so it cannot import that file. The two must keep the same semantics.
 *
 * LIFECYCLE
 * The worker holds no durable state — mappings and checkpoints live in the
 * content script's localStorage — so Chrome terminating it between messages
 * mid-transfer is harmless.
 */
(function () {
  const ALLOWED_HOSTS: Record<string, boolean> = {
    "kf.kobotoolbox.org": true,
    "eu.kobotoolbox.org": true,
    "kc.kobotoolbox.org": true,
    "kc-eu.kobotoolbox.org": true,
  };

  /**
   * Paths the worker may touch EXACTLY:
   *   "/api/v2/"              the destination API root — checkAccount requests
   *                            it to prove that a token works
   *   "/api/v2/users/me/",    the username lookup (destination.store)
   *   "/api/v2/me/", "/me/"   the other username-lookup shapes Kobo serves
   *   "/api/v2/token/", "/token/"  the account's own token
   */
  const ALLOWED_EXACT_PATHS: Record<string, boolean> = {
    "/api/v2/": true,
    "/api/v2/users/me/": true,
    "/api/v2/me/": true,
    "/me/": true,
    "/api/v2/token/": true,
    "/token/": true,
  };

  /**
   * Path prefixes the worker may touch. Every entry is an endpoint the
   * transfer code actually calls:
   *   /api/v2/assets/         create/read/update a destination project, its
   *                            media, its deployment and its versions
   *   /api/v2/service_usage/  the destination's remaining submission allowance
   *   /api/v2/schema/         the account schema
   *   /api/v2/asset_usage/    read-only account statistics
   *   /api/v2/asset_versions/ read-only version statistics
   *   /submission             the OpenRosa submission endpoint on the KC host
   */
  const ALLOWED_PATH_PREFIXES: string[] = [
    "/api/v2/assets/",
    "/api/v2/asset_usage/",
    "/api/v2/asset_versions/",
    "/api/v2/service_usage/",
    "/api/v2/schema/",
    "/submission",
  ];

  const MAX_ATTEMPTS = 3; // 1 initial + 2 retries
  const RETRYABLE_STATUS: Record<number, boolean> = { 408: true, 429: true, 500: true, 502: true, 503: true, 504: true };
  const RETRY_BASE_DELAY_MS = 500;
  const RETRY_JITTER_MS = 250;
  const REQUEST_TIMEOUT_MS = 120000;
  /** Longest Retry-After the worker will honour. */
  const MAX_RETRY_AFTER_MS = 60000;

  /** In-flight requests, keyed by correlation id, so a cancelled bulk run can
   *  actually abort the network request rather than just abandoning it. */
  const inFlight = new Map<string, AbortController>();

  /**
   * HOST check only: is this URL on one of the four official KoboToolbox
   * hosts? Used for the message sender, whose URL is a PAGE url (for example
   * https://eu.kobotoolbox.org/project/settings/aBc123) and therefore must
   * not be held to the API path allow-list below.
   */
  function isAllowedHost(raw: unknown): URL | null {
    if (typeof raw !== "string" || !raw) return null;
    let u: URL;
    try {
      u = new URL(raw);
    } catch (e) {
      return null;
    }
    if (u.protocol !== "https:") return null;
    // Credentials in the URL (https://user:pass@host/...) are never legitimate
    // here and are a classic way of smuggling a different origin.
    if (u.username || u.password) return null;
    return ALLOWED_HOSTS[u.hostname] === true ? u : null;
  }

  /**
   * HOST check + the API path allow-list. Used for every outgoing request:
   * a URL on an allowed host but outside the known API paths is refused.
   */
  function isAllowedUrl(raw: unknown): URL | null {
    const u = isAllowedHost(raw);
    if (!u) return null;
    if (!ALLOWED_EXACT_PATHS[u.pathname] && !ALLOWED_PATH_PREFIXES.some((p) => u.pathname.startsWith(p))) return null;
    return u;
  }

  /**
   * How long the server asked us to wait, in milliseconds, or null when it did
   * not say. "Retry-After" is either a number of seconds or an HTTP date; a
   * broken or hostile value is capped so it cannot stall a run.
   */
  function retryAfterMs(res: Response): number | null {
    const h = res.headers.get("Retry-After");
    if (!h) return null;
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_AFTER_MS);
    const t = Date.parse(h);
    return Number.isNaN(t) ? null : Math.min(Math.max(t - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }

  function isRetryableStatus(status: number): boolean {
    return RETRYABLE_STATUS[status] === true;
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  interface FetchSpec {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: BodyInit | null;
    token: string;
    /** Caller-owned signal; aborting it aborts the real request. */
    externalSignal: AbortSignal;
  }

  interface FetchOutcome {
    status: number;
    text: string;
    contentType: string;
    /** Echoed back so a failure can name the request that produced it. */
    method: string;
    url: string;
    /** What the server asked us to wait (ms), when it sent a Retry-After. */
    retryAfterMs: number | null;
  }

  /**
   * One logical operation: a host-checked fetch carrying the destination token,
   * with the same bounded retry policy as the content-script client.
   *
   * A response is RETURNED even for 4xx/5xx — the caller decides what a given
   * status means (Kobo's submission endpoint uses 201 vs 202 to signal
   * created vs duplicate, which is not an error). Only a fetch-level network
   * failure throws, and only after retries are exhausted.
   */
  async function runWithRetry(spec: FetchSpec): Promise<FetchOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const relay = (): void => controller.abort();
    if (spec.externalSignal.aborted) controller.abort();
    else spec.externalSignal.addEventListener("abort", relay, { once: true });

    const headers: Record<string, string> = Object.assign({}, spec.headers, { Authorization: `Token ${spec.token}` });

    let attempt = 0;
    try {
      while (true) {
        let failure: unknown = null;
        let outcome: FetchOutcome | null = null;

        try {
          const res = await fetch(spec.url, {
            method: spec.method,
            headers,
            body: spec.body,
            credentials: "omit",
            // A redirect is never followed: it could point at a host that is
            // not on the allow-list, and the browser would drop the
            // Authorization header on the way but still make the request.
            redirect: "error",
            signal: controller.signal,
          });
          // Defence in depth: the response must still be on an allowed URL.
          // With redirect: "error" this always holds, but it keeps the
          // guarantee if the redirect mode is ever changed.
          if (!isAllowedUrl(res.url)) {
            const blocked = new Error("The destination answered from an address that is not allowed.") as Error & { name: string };
            blocked.name = "KoboEnhanceBlockedUrl";
            throw blocked;
          }
          const text = await res.text();
          outcome = {
            status: res.status,
            text,
            contentType: res.headers.get("Content-Type") || "",
            method: spec.method,
            url: spec.url,
            retryAfterMs: retryAfterMs(res),
          };
        } catch (e) {
          failure = e;
        }

        if (outcome) {
          // Transient server-side statuses are retried; everything else (2xx,
          // and permanent 4xx such as 401/403/404) is returned to the caller.
          if (!isRetryableStatus(outcome.status) || attempt >= MAX_ATTEMPTS - 1) return outcome;
        } else {
          const err = (failure || {}) as { name?: string };
          // A cancelled or timed-out request is never retried. They are
          // reported differently: only a caller abort is "cancelled", while
          // the worker's own 120 s deadline is a timeout the user did not
          // cause (and the content-script client waits longer than this).
          if (err.name === "AbortError") {
            if (timedOut) {
              const timeout = new Error(
                `The request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)} s. The destination may be slow or unreachable.`
              ) as Error & { name: string };
              timeout.name = "KoboEnhanceTimeout";
              throw timeout;
            }
            throw failure;
          }
          // A refused URL is permanent: retrying would be refused again.
          if (err.name === "KoboEnhanceBlockedUrl") throw failure;
          if (attempt >= MAX_ATTEMPTS - 1) throw failure;
        }

        attempt++;
        // A Retry-After on a 429 wins over the exponential backoff, so a
        // throttled destination is not hammered before it says it is ready.
        const exponentialDelay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * RETRY_JITTER_MS);
        const wait = outcome && outcome.retryAfterMs !== null ? Math.max(exponentialDelay, outcome.retryAfterMs) : exponentialDelay;
        await sleep(wait, controller.signal);
      }
    } finally {
      clearTimeout(timer);
      spec.externalSignal.removeEventListener("abort", relay);
    }
  }

  /** Parses a JSON body when the response is JSON, so callers get `data`.
   *
   *  The RAW body is always returned as `text` (truncated), including for JSON
   *  responses. It used to be dropped for JSON bodies, which is how a bare
   *  "HTTP 500" reached the user with no explanation: the failure carried no
   *  detail string, and the only remaining text was the generic status label.
   *  The request's method and URL are echoed back too, so an error can name which
   *  call actually failed instead of leaving it to be inferred. */
  function toResponse(id: string, outcome: FetchOutcome, ok: boolean, error?: string): KeSwResponse {
    const isJson = outcome.contentType.indexOf("json") !== -1;
    let data: unknown;
    let detail: string | undefined;
    if (isJson && outcome.text) {
      try {
        data = JSON.parse(outcome.text);
      } catch (e) {
        data = undefined;
      }
    }
    if (data && typeof data === "object") {
      const d = (data as KoboRecord).detail;
      if (typeof d === "string") detail = d;
      else if (d && typeof d === "object") detail = JSON.stringify(d).slice(0, 300);
      // Kobo's validation failures use "error", not "detail" — the deployer
      // rejecting a form answers {"error": "Invalid question name ..."} or
      // {"error": "ODK Validate Errors: ..."}. Without this the most useful text
      // in the whole response only reached the user as a raw JSON blob buried in
      // the middle of a sentence.
      if (!detail) {
        const e = (data as KoboRecord).error;
        if (typeof e === "string" && e) detail = e;
      }
    }
    return {
      ke: "koboenhance-transfer",
      id,
      ok,
      status: outcome.status,
      data,
      text: outcome.text ? outcome.text.slice(0, 600) : undefined,
      error,
      detail,
      method: outcome.method,
      url: outcome.url,
    };
  }

  function errorResponse(id: string, message: string): KeSwResponse {
    return { ke: "koboenhance-transfer", id, ok: false, error: message };
  }

  function isSuccess(status: number): boolean {
    return status >= 200 && status < 300;
  }

  function withParams(url: URL, params: Record<string, unknown> | undefined): string {
    if (params) {
      for (const key of Object.keys(params)) {
        const value = params[key];
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async function handle(req: KeSwRequest, signal: AbortSignal): Promise<KeSwResponse> {
    const id = req.id;

    switch (req.op) {
      case "checkAccount": {
        const u = isAllowedUrl(req.url);
        if (!u) return errorResponse(id, "Destination address is not allowed.");
        const outcome = await runWithRetry({
          url: u.toString(),
          method: "GET",
          headers: { Accept: "application/json" },
          body: null,
          token: req.token,
          externalSignal: signal,
        });
        if (outcome.status === 401 || outcome.status === 403) {
          return errorResponse(id, "The API token was rejected.");
        }
        if (!isSuccess(outcome.status)) {
          return errorResponse(id, `Destination returned HTTP ${outcome.status}.`);
        }
        return toResponse(id, outcome, true);
      }

      case "getJson": {
        const u = isAllowedUrl(req.url);
        if (!u) return errorResponse(id, "Destination address is not allowed.");
        const outcome = await runWithRetry({
          url: withParams(u, req.params),
          method: "GET",
          headers: { Accept: "application/json" },
          body: null,
          token: req.token,
          externalSignal: signal,
        });
        return toResponse(id, outcome, isSuccess(outcome.status), `HTTP ${outcome.status}`);
      }

      case "mutateJson": {
        const u = isAllowedUrl(req.url);
        if (!u) return errorResponse(id, "Destination address is not allowed.");
        const outcome = await runWithRetry({
          url: u.toString(),
          method: req.method,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: req.payload === undefined ? null : JSON.stringify(req.payload),
          token: req.token,
          externalSignal: signal,
        });
        return toResponse(id, outcome, isSuccess(outcome.status), `HTTP ${outcome.status}`);
      }

      case "postForm": {
        const u = isAllowedUrl(req.url);
        if (!u) return errorResponse(id, "Destination address is not allowed.");
        const outcome = await runWithRetry({
          url: u.toString(),
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(req.fields).toString(),
          token: req.token,
          externalSignal: signal,
        });
        return toResponse(id, outcome, isSuccess(outcome.status), `HTTP ${outcome.status}`);
      }

      case "patchForm": {
        // Archiving a project, captured from Kobo's own UI:
        //   PATCH /api/v2/assets/{uid}/deployment/   active=false
        // sent as application/x-www-form-urlencoded, not JSON. Same endpoint the
        // JSON deployment call uses — only the encoding and the flag differ.
        const u = isAllowedUrl(req.url);
        if (!u) return errorResponse(id, "Destination address is not allowed.");
        const outcome = await runWithRetry({
          url: u.toString(),
          method: "PATCH",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(req.fields).toString(),
          token: req.token,
          externalSignal: signal,
        });
        return toResponse(id, outcome, isSuccess(outcome.status), `HTTP ${outcome.status}`);
      }

      case "submitXml": {
        const u = isAllowedUrl(req.url);
        if (!u) return errorResponse(id, "Destination address is not allowed.");
        const form = new FormData();
        // Kobo expects the field name "xml_submission_file" and the submission
        // UUID as the filename (transfer/xml.py:61-62 in the reference tool).
        // Content-Type is deliberately NOT set: FormData must generate the
        // multipart boundary itself.
        form.append("xml_submission_file", new Blob([req.xml], { type: "text/xml" }), req.submissionId);
        const outcome = await runWithRetry({
          url: u.toString(),
          method: "POST",
          headers: {},
          body: form,
          token: req.token,
          externalSignal: signal,
        });
        // 201 = created, 202 = duplicate/rejected-but-accepted. Both are
        // successes; the caller counts them separately.
        return toResponse(id, outcome, outcome.status === 201 || outcome.status === 202, `HTTP ${outcome.status}`);
      }

      default:
        return errorResponse(id, "Unsupported operation.");
    }
  }

  // -------------------------------------------------------------------
  // Message plumbing
  // -------------------------------------------------------------------
  function isRequest(value: unknown): value is KeSwRequest {
    if (!value || typeof value !== "object") return false;
    // A loose local shape: the union's `Partial<>` distributes, so a common
    // property lookup across all variants is not directly available here.
    const v = value as { ke?: unknown; op?: unknown; id?: unknown; token?: unknown };
    if (v.ke !== "koboenhance-transfer") return false;
    if (v.op === "cancel") return typeof v.id === "string";
    if (typeof v.id !== "string" || typeof v.token !== "string") return false;
    switch (v.op) {
      case "checkAccount":
      case "getJson":
      case "mutateJson":
      case "postForm":
      case "patchForm":
      case "submitXml":
        return true;
      default:
        return false;
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    // Only this extension's own content scripts may drive the worker, and
    // only when they run on one of the four official KoboToolbox hosts.
    // `sender.url` is the page the content script runs in; it is always set
    // for a content script, unlike `sender.tab.url`.
    if (sender.id !== chrome.runtime.id || !isAllowedHost(sender.url)) return undefined;
    if (!isRequest(message)) return undefined;

    if (message.op === "cancel") {
      const controller = inFlight.get(message.id);
      if (controller) {
        controller.abort();
        inFlight.delete(message.id);
      }
      sendResponse({ ke: "koboenhance-transfer", id: message.id, ok: true });
      return true;
    }

    const id = message.id;
    const controller = new AbortController();
    inFlight.set(id, controller);

    handle(message, controller.signal).then(
      function (response) {
        inFlight.delete(id);
        sendResponse(response);
      },
      function (e: unknown) {
        inFlight.delete(id);
        const err = (e || {}) as { name?: string; message?: string };
        const aborted = err.name === "AbortError";
        sendResponse(errorResponse(id, aborted ? "Request cancelled." : err.message || "Request failed."));
      }
    );

    // Keep the message channel open for the async response above.
    return true;
  });
})();
