/**
 * entry/inject.js — runs in the MAIN world (page context) at document_start.
 * Hooks native fetch/XHR to observe requests to /api/v2/assets/ so the
 * in-page integration can learn the "active filter" query the user is
 * currently browsing with (search, ordering, collection, etc.) and use it
 * to paginate through matching projects for the "Import via Filters" feature.
 *
 * Also captures the signed-in username from Kobo's own API responses
 * and exposes it via a global variable for the content script.
 */
(function () {
  const CHANNEL = "__koboenhance__";
  const ASSET_LIST_RE = /\/api\/v2\/assets\/(\?|$)/;
  const ASSET_DETAIL_RE = /\/api\/v2\/assets\/([a-zA-Z0-9]+)\/$/;
  const USER_RE = /\/api\/v2\/users\/?(\?|$)/;
  const ME_RE = /\/me\/(\?|$)/;

  window.__ke_username = window.__ke_username || null;

  function report(url: string): void {
    try {
      const u = new URL(url, window.location.origin);
      const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
      if (ASSET_LIST_RE.test(path)) {
        window.postMessage(
          { channel: CHANNEL, type: "asset-list-request", url: u.toString() },
          window.location.origin
        );
        // The asset-list filter carries the signed-in user when browsing
        // "my projects" (q=owner__username=me). Store it for instant,
        // network-free username resolution in download filenames.
        if (!window.__ke_username) {
          const q = u.searchParams.get("q") || "";
          const m = q.match(/(?:^|[(\s,])owner__username\s*(?:=|%3[Dd]|:)\s*([^)\s&,%]+)/);
          if (m && m[1]) window.__ke_username = m[1];
        }
      }
    } catch (e) {
      /* ignore malformed URLs */
    }
  }

  function extractUsername(body: unknown): void {
    if (!body || typeof body !== "object") return;
    if ((body as Record<string, unknown>).username && typeof (body as Record<string, unknown>).username === "string" && (body as Record<string, unknown>).username !== "me") {
      window.__ke_username = (body as Record<string, unknown>).username as string;
      postUsername((body as Record<string, unknown>).username as string, "me");
    }
  }

  function postUsername(username: string, source?: string): void {
    window.postMessage(
      { channel: CHANNEL, type: "username", source: source || "me", username: username },
      window.location.origin
    );
  }

  /** Posts the tags from Kobo's own asset-list response (no extra API call). */
  function postAssets(url: string, body: unknown): void {
    try {
      const u = new URL(url, window.location.origin);
      const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
      if (!ASSET_LIST_RE.test(path)) return;
      const results = ((body && (body as Record<string, unknown>).results) || []) as Array<Record<string, unknown>>;
      if (!results.length) return;
      const assets: Array<{ uid: unknown; tags: unknown[] }> = [];
      for (const a of results) {
        const uid = a && a.uid;
        if (!uid) continue;
        const s = a && a.settings;
        const t = (s && (s as { extra_metadata?: { tags?: unknown } }).extra_metadata && (s as { extra_metadata?: { tags?: unknown } }).extra_metadata!.tags);
        assets.push({
          uid: uid,
          tags: Array.isArray(t) ? (t as unknown[]).filter((x: unknown) => typeof x === "string") : [],
        });
      }
      if (assets.length) {
        window.postMessage(
          { channel: CHANNEL, type: "asset-list-detail", url: u.toString(), assets: assets },
          window.location.origin
        );
      }
    } catch (e) { /* ignore malformed payloads */ }
  }

  /** Posts tags and notes from a single-asset detail response (form summary page). */
  function postAssetDetail(url: string, body: unknown): void {
    try {
      const u = new URL(url, window.location.origin);
      const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
      const m = path.match(/\/api\/v2\/assets\/([a-zA-Z0-9]+)\/$/);
      if (!m || !body || typeof body !== "object") return;
      const uid = m[1];
      const s = (body as Record<string, unknown>).settings;
      const em = (s && (s as { extra_metadata?: { tags?: unknown; notes?: unknown } }).extra_metadata) || null;
      const t = em && (em as { tags?: unknown }).tags;
      const n = em && (em as { notes?: unknown }).notes;
      window.postMessage(
        {
          channel: CHANNEL,
          type: "asset-detail",
          uid: uid,
          tags: Array.isArray(t) ? (t as unknown[]).filter((x: unknown) => typeof x === "string") : [],
          notes: typeof n === "string" ? (n as string) : null,
        },
        window.location.origin
      );
    } catch (e) { /* ignore */ }
  }

  const nativeFetch = window.fetch;
  window.fetch = function (this: void, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : (input && (input as { url?: string }).url) || "";
    report(url);
    return (nativeFetch as any).apply(this, arguments).then(function (res: Response) {
      try {
        const u = new URL(url, window.location.origin);
        const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
        if (USER_RE.test(path) || ME_RE.test(path)) {
          res.clone().json().then(extractUsername).catch(function () {});
        } else if (ASSET_LIST_RE.test(path)) {
          res.clone().json().then(function (body) { postAssets(url, body); }).catch(function () {});
        } else if (ASSET_DETAIL_RE.test(path)) {
          res.clone().json().then(function (body) { postAssetDetail(url, body); }).catch(function () {});
        }
      } catch (e) { /* ignore */ }
      return res;
    });
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
    (this as { __ke_url?: string }).__ke_url = url as string;
    report(url as string);
    return (nativeOpen as any).apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest) {
    this.addEventListener("load", function () {
      try {
        const u = new URL((this as { __ke_url?: string }).__ke_url || "", window.location.origin);
        const path = u.pathname + (u.pathname.endsWith("/") ? "" : "/");
        const text = (this as XMLHttpRequest).responseText;
        if (USER_RE.test(path) || ME_RE.test(path)) {
          extractUsername(JSON.parse(text));
        } else if (ASSET_LIST_RE.test(path) && text) {
          postAssets((this as { __ke_url?: string }).__ke_url as string, JSON.parse(text));
        } else if (ASSET_DETAIL_RE.test(path) && text) {
          postAssetDetail((this as { __ke_url?: string }).__ke_url as string, JSON.parse(text));
        }
      } catch (e) { /* ignore */ }
    });
    return (nativeSend as any).apply(this, arguments);
  };
})();