/**
 * core/auth/auth.service.ts — dynamically derives the API base URL and
 * CSRF token from the current page/session. No manual API key entry.
 */
(function () {
  function getBaseUrl(): string {
    return window.location.origin;
  }

  function getCookie(name: string): string | null {
    const match = document.cookie.match(
      new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)")
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function getCsrfToken(): string | null {
    return getCookie("csrftoken");
  }

  function buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = Object.assign(
      {
        Accept: "application/json",
      },
      extra || {}
    );
    const csrf = getCsrfToken();
    if (csrf) headers["X-CSRFToken"] = csrf;
    return headers;
  }

  function isAuthError(status: number): boolean {
    return status === 401 || status === 403;
  }

  let cachedUsername: string | null = null;

  const GENERIC_USERNAMES = new Set([
    "me", "user", "users", "admin", "account", "profile",
    "settings", "forms", "projects", "home",
  ]);

  function isValidUsername(name: unknown): boolean {
    if (!name || typeof name !== "string") return false;
    const value = name.trim();
    if (!value || GENERIC_USERNAMES.has(value.toLowerCase())) return false;
    return /^[A-Za-z][A-Za-z0-9_.-]{1,}$/.test(value);
  }

  function usernameFromEmail(email: unknown): string {
    if (!email || typeof email !== "string") return "";
    const m = email.match(/^\s*([^@\s]+)@/);
    return m && isValidUsername(m[1]) ? m[1] : "";
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data as KoboRecord | null;
    if (!d) return;
    if (d.channel === "__koboenhance__" && d.type === "username" && d.source === "me" && isValidUsername(d.username)) {
      cachedUsername = d.username as string;
    }
  });

  function scrapeUsernameFromDom(): string {
    try {
      const bootstrap = document.getElementById("bootstrap");
      if (bootstrap && bootstrap.textContent) {
        try {
          const parsed = JSON.parse(bootstrap.textContent) as unknown;
          const stack: Array<Record<string, unknown>> = [parsed as Record<string, unknown>];
          while (stack.length) {
            const v = stack.pop();
            if (!v) continue;
            for (const [k, val] of Object.entries(v)) {
              if (typeof val === "string" && /user|account|login/i.test(k) && isValidUsername(val)) return val;
              if (val && typeof val === "object") stack.push(val as Record<string, unknown>);
            }
          }
        } catch (e) {
          /* not JSON */
        }
      }
      const candidates: string[] = [];
      const selectors = [
        'header [data-username]',
        'header [class*="avatar-module__fullName"]',
        'nav [data-username]',
        'nav [class*="avatar-module__fullName"]',
        '[data-username]',
        '[class*="avatar-module__fullName"]',
        '[class*="user-menu"]',
        '[class*="userMenu"]',
      ];
      for (const sel of selectors) {
        const node = document.querySelector(sel);
        if (!node) continue;
        const attr =
          node.getAttribute &&
          (node.getAttribute("data-username") || node.getAttribute("title"));
        if (attr) candidates.push(attr);
        const text = (node.textContent || "").trim();
        if (text) candidates.push(text);
      }
      for (const c of candidates) {
        const emailName = usernameFromEmail(c);
        if (emailName) return emailName;
        if (isValidUsername(c)) return c;
      }
    } catch (e) {
      /* ignore */
    }
    return "";
  }

  async function fetchUsernameFromApi(): Promise<string> {
    const base = getBaseUrl();

    for (const url of [`${base}/me/`, `${base}/api/v2/users/me/`, `${base}/api/v2/me/`]) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      try {
        const res = await fetch(url, {
          credentials: "same-origin",
          headers: buildHeaders({ Accept: "application/json" }),
          signal: ctrl.signal,
        });
        if (!res.ok) continue;
        const text = await res.text();
        const body = JSON.parse(text) as KoboRecord;
        if (body && typeof body.username === "string" && body.username !== "me") return body.username;
        const emailName = usernameFromEmail(body && body.email);
        if (emailName) return emailName;
        if (body && typeof body.url === "string") {
          const m = body.url.match(/\/users\/([^/]+)\/?$/);
          if (m && m[1] && m[1] !== "me") return m[1];
        }
      } catch (e) {
        /* ignore */
      } finally {
        clearTimeout(timer);
      }
    }

    return "";
  }

  function cacheUsername(name: string): boolean {
    if (isValidUsername(name)) {
      cachedUsername = name;
      return true;
    }
    return false;
  }

  /** Extracts the signed-in username from a Kobo asset-list filter URL, e.g.
   *  `/api/v2/assets/?q=owner__username%3Dalice` — no extra network request. */
  function usernameFromFilterUrl(url: string): string {
    try {
      const u = new URL(url);
      const candidates = [u.searchParams.get("q") || "", u.search.slice(1)];
      for (const s of candidates) {
        const m = s.match(/(?:^|[(\s,])owner__username\s*(?:=|%3[Dd]|:)\s*([^)\s&,%]+)/);
        if (m && m[1]) return m[1];
      }
    } catch (e) {
      /* ignore malformed URLs */
    }
    return "";
  }

  async function getUsername(): Promise<string> {
    if (cachedUsername !== null) return cachedUsername;
    // Resolve quickly (cache/DOM/inject sources first); never block the caller
    // on the slow network path for more than ~1.5s.
    const budget: Promise<string> = new Promise((resolve) => setTimeout(() => resolve(""), 1500));
    const found = await Promise.race([
      (async () => {
        const api = await fetchUsernameFromApi();
        if (api) return api;
        return scrapeUsernameFromDom();
      })(),
      budget,
    ]);
    if (isValidUsername(found)) {
      cachedUsername = found as string;
      return cachedUsername;
    }
    return "";
  }

  window.KoboEnhance.auth = {
    getBaseUrl,
    getCsrfToken,
    buildHeaders,
    isAuthError,
    getUsername,
    cacheUsername,
    usernameFromFilterUrl,
  };
})();