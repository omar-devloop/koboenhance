/**
 * core/transfer/destination.store.ts — the destination account, and the
 * "can we actually reach it?" test that gates the transfer action.
 *
 * The destination is the ONLY credential KoboEnhance ever holds, and it is the
 * one thing the existing auth model cannot provide: core/auth/auth.service.ts
 * derives everything from the signed-in session, which is by definition the
 * *source* account. So the destination is stored separately and used only by the
 * cross-account transfer feature.
 *
 * STORAGE — nothing account-identifying is ever persisted.
 *  - The API token is held IN MEMORY ONLY, in this module's closure. It is never
 *    written to any storage, never put in an ActionRequest (that would snapshot
 *    it into run history), and never logged. The user asked to be asked for it
 *    each time, so a page reload clears it.
 *  - The destination account (server + resolved username) is ALSO memory-only.
 *    Persisting it was wrong twice over. A content script's `localStorage` is the
 *    PAGE's storage, so an uninstall never cleared it and the row kept reading
 *    "Move projects from a to b @ EU" after a full remove-and-reinstall; and
 *    `chrome.storage.local`, while correctly cleared on uninstall, kept the
 *    account label alive across sessions for no benefit — the token that makes
 *    the destination usable is gone anyway, so a remembered label could only
 *    ever be misleading. The label is now drawn only from state validated during
 *    this page's lifetime, which makes it impossible for it to outlive the page.
 *  - The only persisted value is `ke:transfer:server`, a bare enum ("global" |
 *    "eu") used to preselect the server dropdown. It identifies no account and
 *    cannot produce a destination label on its own.
 */
(function () {
  const KE = window.KoboEnhance;
  const { transferTransport } = KE;

  /** The ONLY persisted key: a bare server enum, so the panel can preselect the
   *  server dropdown. It carries no account identity. */
  const SERVER_PREF_KEY = "ke:transfer:server";
  const USERNAME_TIMEOUT_MS = 8000;

  /** The two official KoboToolbox servers supported in v1. The kf/kc split is
   *  not cosmetic: kc is a different origin from kf, which is exactly why the
   *  background service worker exists. */
  const SERVERS: Record<TransferServerId, TransferServerInfo> = {
    global: {
      id: "global",
      kfUrl: "https://kf.kobotoolbox.org",
      kcUrl: "https://kc.kobotoolbox.org",
      label: "Global",
    },
    eu: {
      id: "eu",
      kfUrl: "https://eu.kobotoolbox.org",
      kcUrl: "https://kc-eu.kobotoolbox.org",
      label: "EU",
    },
  };

  /**
   * EU is the default.
   *
   * The two servers are indistinguishable by name alone — "Global" and "EU" say
   * nothing about where an account actually lives — so the panel now shows the
   * host next to each option and explains the choice. EU is preselected because
   * that is the instance this transfer feature was built and tested against; a
   * user on Global will see the host and change it, whereas defaulting to the
   * wrong instance silently sends projects to an account the user did not choose.
   */
  const DEFAULT_SERVER: TransferServerId = "eu";

  /**
   * The API token, in memory only.
   *
   * It is deliberately NOT persisted anywhere. The user asked to be asked for it
   * every time, so the token lives only in this closure: it dies on a page
   * reload, is never written to localStorage, never written to
   * chrome.storage.session, and never leaves this module except by being handed
   * to the service worker for a single request. That also means there is no
   * stored copy to leak, and no "reuse the saved token" path that could
   * silently use a stale or revoked credential.
   */
  let memoryToken: string | null = null;

  function serverInfo(server: TransferServerId): TransferServerInfo {
    return SERVERS[server] || SERVERS.global;
  }

  function isServerId(value: unknown): value is TransferServerId {
    return value === "global" || value === "eu";
  }

  // -------------------------------------------------------------------
  // Token (memory only — never persisted)
  // -------------------------------------------------------------------

  /** The token validated earlier in this page's lifetime, or "". */
  async function getToken(): Promise<string> {
    return memoryToken || "";
  }

  async function setToken(token: string): Promise<void> {
    memoryToken = token.trim() || null;
  }

  async function clearToken(): Promise<void> {
    memoryToken = null;
  }

  // -------------------------------------------------------------------
  // Destination metadata (not secret)
  // -------------------------------------------------------------------

  /**
   * Page keys written by earlier builds. They lived in the PAGE's localStorage,
   * so an uninstall/reinstall never removed them and the old destination kept
   * reappearing. They are deleted on hydration, which is also what clears the
   * stale value for users upgrading in place.
   */
  const LEGACY_KEYS = ["ke:transfer:destination", "ke:transfer:mappings", "ke:transfer:map", "ke:transfer:ignore"];

  function dropLegacyKeys(): void {
    // Only when extension storage is actually in use. In the page-storage
    // fallback these very keys are the live store, and deleting them here would
    // destroy the user's own data.
    if (KE.transferState.name() !== "extension") return;
    try {
      for (const key of LEGACY_KEYS) window.localStorage.removeItem(key);
    } catch (e) {
      /* localStorage may be unavailable; the extension backend still wins */
    }
  }

  /**
   * The destination validated during this page's lifetime, or null.
   *
   * Memory-only by design, so this can never be populated by anything that
   * outlives the page. That is what makes the row-2 label unable to survive a
   * reload or a remove-and-reinstall.
   */
  let memoryDestination: TransferDestination | null = null;

  /**
   * Hydrates the one persisted value (the server enum) and clears the page-scoped
   * keys older builds wrote. Idempotent; the UI awaits it before its first paint.
   */
  function ready(): Promise<void> {
    return KE.transferState.ready([SERVER_PREF_KEY]).then(() => {
      dropLegacyKeys();
    });
  }

  /** The server to preselect in the panel. Identifies no account. */
  function getLastServer(): TransferServerId {
    const stored = KE.transferState.read(SERVER_PREF_KEY);
    return isServerId(stored) ? stored : DEFAULT_SERVER;
  }

  function getDestination(): TransferDestination | null {
    return memoryDestination;
  }

  function setDestination(dest: TransferDestination): void {
    const info = serverInfo(dest.server);
    // Normalise on the way in rather than on the way out, so the values used by
    // a transfer are always the ones derived from the server id and can never be
    // influenced by anything outside this module.
    memoryDestination = {
      server: info.id,
      kfUrl: info.kfUrl,
      kcUrl: info.kcUrl,
      username: typeof dest.username === "string" ? dest.username : "",
      validatedAt: typeof dest.validatedAt === "number" ? dest.validatedAt : Date.now(),
    };
    void KE.transferState.write(SERVER_PREF_KEY, info.id);
  }

  async function clearDestination(): Promise<void> {
    memoryDestination = null;
    await clearToken();
  }

  /** True when the action may run: a destination is configured AND a token was
   *  validated during this page's lifetime. After a reload the metadata
   *  survives but the token does not, so the user is asked for it again — which
   *  is the intended behaviour, not a bug. */
  async function isReady(): Promise<boolean> {
    const dest = getDestination();
    if (!dest) return false;
    const token = await getToken();
    return token.length > 0;
  }

  // -------------------------------------------------------------------
  // Validation — the "Test connection" the panel runs on confirm
  // -------------------------------------------------------------------

  /** Best-effort username lookup. Kobo has moved this endpoint around across
   *  versions, so a failure here is NOT fatal: the user still gets a working
   *  destination, just labelled by server instead of by account. */
  async function resolveUsername(token: string, kfUrl: string, signal?: AbortSignal): Promise<string> {
    const candidates = [`${kfUrl}/api/v2/users/me/`, `${kfUrl}/me/`, `${kfUrl}/api/v2/me/`];
    for (const url of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), USERNAME_TIMEOUT_MS);
      const onOuterAbort = (): void => controller.abort();
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          return "";
        }
        signal.addEventListener("abort", onOuterAbort, { once: true });
      }
      try {
        const res = await transferTransport.getJson(token, url, undefined, controller.signal);
        if (res.ok && res.data && typeof res.data === "object") {
          const body = res.data as KoboRecord;
          if (typeof body.username === "string" && body.username && body.username !== "me") return body.username;
          if (typeof body.email === "string" && body.email) {
            const name = body.email.split("@")[0];
            if (name) return name;
          }
        }
      } catch (e) {
        /* try the next candidate */
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onOuterAbort);
      }
    }
    return "";
  }

  /**
   * Verifies a destination server + token before it is saved. On success the
   * token and metadata are persisted and the row-2 label can be rendered; on
   * failure nothing is written.
   */
  async function validateDestination(
    server: TransferServerId,
    token: string,
    signal?: AbortSignal
  ): Promise<TransferValidationResult> {
    const trimmed = String(token || "").trim();
    if (!trimmed) return { ok: false, failure: "token-empty" };

    // The destination must be a DIFFERENT account.
    //
    // Pasting the token of the account you are signed in to used to be accepted,
    // because it is a perfectly valid token — just for the wrong side. The run
    // then copied every project back into the account it came from. Ask the
    // source module for its token; the panel usually read it when it opened, and
    // `ensureToken` covers the case where that read has not finished yet. When
    // the source token cannot be read there is nothing to compare against, and
    // the run falls back to the page session exactly as before.
    const sourceAccount = KE.transferSourceAccount;
    if (sourceAccount) {
      let sourceToken = "";
      try {
        sourceToken = sourceAccount.getToken();
        // No signal: cancelling the destination test must not abort the source
        // token read, which the panel reuses for the run.
        if (!sourceToken) sourceToken = await sourceAccount.ensureToken();
      } catch (e) {
        sourceToken = "";
      }
      if (sourceToken && sourceToken === trimmed) {
        return { ok: false, failure: "token-is-source" };
      }
    }

    const info = serverInfo(server);

    let res: KeSwResponse;
    try {
      res = await transferTransport.checkAccount(trimmed, info.kfUrl, signal);
    } catch (e) {
      const err = (e || {}) as { name?: string; message?: string };
      if (err.name === "AbortError") return { ok: false, failure: "cancelled" };
      if (err.message === "no-background") return { ok: false, failure: "no-background" };
      return { ok: false, failure: "unreachable" };
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, failure: "token-rejected", httpStatus: res.status };
      if (res.error && res.error.indexOf("not allowed") !== -1) return { ok: false, failure: "host-blocked" };
      return { ok: false, failure: "unreachable", httpStatus: res.status };
    }

    let username = "";
    try {
      username = await resolveUsername(trimmed, info.kfUrl, signal);
    } catch (e) {
      username = "";
    }

    const destination: TransferDestination = {
      server: info.id,
      kfUrl: info.kfUrl,
      kcUrl: info.kcUrl,
      username,
      validatedAt: Date.now(),
    };

    try {
      await setToken(trimmed);
    } catch (e) {
      return { ok: false, failure: "no-background" };
    }
    setDestination(destination);

    return { ok: true, destination };
  }

  window.KoboEnhance.transferDestination = {
    SERVERS,
    /** Display order for the panel's selector. */
    SERVER_KEYS: ["global", "eu"] as TransferServerId[],
    serverInfo,
    ready,
    getLastServer,
    getDestination,
    setDestination,
    clearDestination,
    getToken,
    setToken,
    clearToken,
    isReady,
    validateDestination,
  };
})();
