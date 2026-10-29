/**
 * core/transfer/source.account.ts — the SOURCE account's own API token.
 *
 * WHY THE SOURCE NEEDS A TOKEN TOO
 * Every source read used to ride the page session. That works, but it expires:
 * Kobo's session cookie is re-issued on activity and is not guaranteed to
 * survive a long run, and an observed 50-project transfer died at project 32
 * because the session ended mid-way. The source account has its own API token
 * and it can be READ from the signed-in session, so there is no reason for a
 * transfer to depend on the cookie staying alive for an hour.
 *
 * WHERE IT COMES FROM
 * GET {kf}/token/ — the same endpoint the account settings page uses, and the
 * only one that exists: verified against the live schema and by hand on
 * 2026-10-19 (401 unauthenticated, i.e. the route is real and TokenAuth-
 * protected; /api/v2/token/ is a 404). It answers {"token": "<hex>"}.
 *
 * WHY IT IS NOT PERSISTED
 * Same rule as the destination token: a credential lives in memory for the
 * lifetime of this page and nowhere else. It is never written to any storage,
 * never put in an ActionRequest (that would snapshot it into run history), and
 * never logged. The page reloads and it is read again — automatically, from the
 * session the user is already signed in with.
 *
 * FALLBACK, WHICH IS THE POINT
 * If the token cannot be read (an older server without the route, a session
 * that is already gone), source reads keep working on the session cookie. That
 * is strictly better than refusing to run, and the settings panel says which of
 * the two is in effect so the user is never guessing.
 *
 * A 401/403 while the token is attached is treated the same way: the token is
 * dropped and the request is retried once on the cookie. Kobo's DRF stack
 * fails the whole request on a bad token rather than falling through to session
 * auth, so without this one stale token would turn into a dead run.
 */
(function () {
  const KE = window.KoboEnhance;
  const { auth } = KE;

  const TOKEN_PATH = "/token/";
  const REQUEST_TIMEOUT_MS = 8000;

  /**
   * Why the last read failed, as a CODE. The panel maps these to sentences, so
   * this module stays free of i18n.
   *   ""            — never failed, or succeeded
   *   "unavailable" — the endpoint does not exist on this server
   *   "unauthorized"— the session or the token was refused
   *   "unreachable" — network / extension background problem
   *   "empty"       — answered, but with no token
   */
  type SourceTokenFailure = "" | "unavailable" | "unauthorized" | "unreachable" | "empty";

  /** In memory only. See the file header. */
  let memoryToken = "";
  let fetchedAt = 0;
  let failure: SourceTokenFailure = "";

  /** A read already in flight, so a panel opening and a run starting at the
   *  same moment do not ask twice. */
  let inflight: Promise<string> | null = null;

  function getToken(): string {
    return memoryToken;
  }

  function hasToken(): boolean {
    return memoryToken.length > 0;
  }

  function getState(): TransferSourceTokenState {
    return { token: memoryToken, fetchedAt, failure };
  }

  function clearToken(reason?: string): void {
    memoryToken = "";
    fetchedAt = 0;
    failure = (reason as SourceTokenFailure) || "unauthorized";
  }

  /** The Authorization header for a source read, or nothing when the source
   *  falls back to the page session. */
  function authHeaders(): Record<string, string> {
    return memoryToken ? { Authorization: `Token ${memoryToken}` } : {};
  }

  /**
   * The token out of a response body, or "".
   *
   * Tolerant because the endpoint's exact shape has moved around: the documented
   * body is `{"token": "..."}`, and a bare quoted string is accepted too. What
   * it will NOT do is guess — a body with no recognisable token field is
   * treated as "no token", which degrades to the session rather than sending
   * something wrong.
   */
  function extractToken(body: string): string {
    const trimmed = String(body || "").trim();
    if (!trimmed) return "";

    if (trimmed.charAt(0) === "{") {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object") {
          const record = parsed as KoboRecord;
          for (const key of ["token", "api_token", "key"]) {
            const value = record[key];
            if (typeof value === "string" && value.trim()) return value.trim();
          }
        }
        return "";
      } catch (e) {
        return "";
      }
    }

    // A bare JSON string, e.g. "abc123...".
    if (trimmed.charAt(0) === "\"") {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return typeof parsed === "string" ? parsed.trim() : "";
      } catch (e) {
        return "";
      }
    }

    // Kobo's token is 40 hex characters; anything else is a page, not a token.
    return /^[0-9a-f]{20,}$/i.test(trimmed) ? trimmed : "";
  }

  /** Reads the source account's token from the signed-in session. */
  async function readOnce(signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const relay = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        return "";
      }
      signal.addEventListener("abort", relay, { once: true });
    }

    try {
      // The plain cookie read: this call is what BOOTSTRAPS the token, so it
      // cannot use it.
      const res = await fetch(`${auth.getBaseUrl()}${TOKEN_PATH}`, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (res.status === 404 || res.status === 410) {
        failure = "unavailable";
        return "";
      }
      if (res.status === 401 || res.status === 403) {
        failure = "unauthorized";
        return "";
      }
      if (!res.ok) {
        failure = "unreachable";
        return "";
      }

      const token = extractToken(await res.text());
      failure = token ? "" : "empty";
      return token;
    } catch (e) {
      // A timeout aborts our own controller, so it is reported as "unreachable"
      // rather than being confused with the user stopping a run.
      failure = "unreachable";
      return "";
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", relay);
    }
  }

  async function fetchToken(signal?: AbortSignal): Promise<string> {
    if (inflight) return inflight;
    inflight = (async (): Promise<string> => {
      const token = await readOnce(signal);
      if (token) {
        memoryToken = token;
        fetchedAt = Date.now();
      } else if (memoryToken) {
        // A failed refresh must not silently demote a token we already hold.
        memoryToken = "";
        fetchedAt = 0;
      }
      return memoryToken;
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  async function ensureToken(signal?: AbortSignal): Promise<string> {
    if (memoryToken) return memoryToken;
    return fetchToken(signal);
  }

  /**
   * A source read that prefers the token and never dies of a bad one.
   *
   * One retry, and only for 401/403 with a token attached: Kobo refuses the
   * whole request when the token is not accepted rather than falling through to
   * the session, so a single stale token would otherwise fail every remaining
   * project in a long run. The token is dropped on the way through, so the rest
   * of the run uses the session without re-hitting this path.
   *
   * Resolves for every HTTP status; only a network or abort failure throws.
   */
  async function fetchSource(url: string, signal?: AbortSignal): Promise<Response> {
    const sentToken = hasToken();
    const res = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: Object.assign({ Accept: "*/*" }, authHeaders()),
      signal,
    });

    if (sentToken && (res.status === 401 || res.status === 403)) {
      clearToken("unauthorized");
      return fetch(url, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "*/*" },
        signal,
      });
    }
    return res;
  }

  window.KoboEnhance.transferSourceAccount = {
    getToken,
    hasToken,
    getState,
    fetchToken,
    ensureToken,
    clearToken,
    authHeaders,
    fetchSource,
  };
})();