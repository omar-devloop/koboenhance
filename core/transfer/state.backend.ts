/**
 * core/transfer/state.backend.ts — where the transfer feature keeps its
 * non-secret state, and why it is not the page's localStorage.
 *
 * THE BUG THIS FIXES
 * A content script's `localStorage` is the PAGE's storage, not the extension's.
 * `window.localStorage` inside a content script on kf.kobotoolbox.org resolves to
 * https://kf.kobotoolbox.org's own origin storage. That has two consequences,
 * both of which bit us:
 *
 *   1. Removing and reinstalling the extension does NOT clear it. Uninstalling
 *      an extension drops the extension's own storage, not the website's. So a
 *      saved destination account kept coming back after a clean reinstall — the
 *      row still read "Move projects from a to b @ EU".
 *   2. Kobo's own page scripts can read it. Anything we put there is visible to
 *      the site, which is the wrong place for account metadata at all.
 *
 * `chrome.storage.local` has neither problem: it is scoped to the extension and
 * Chrome clears it on uninstall. The `storage` permission is already declared in
 * manifest.json, so this needs no new permission.
 *
 * WHY READS STAY SYNCHRONOUS
 * `getDestination()` and the mapping lookups are called from synchronous render
 * and validation paths. Chrome's storage API is promise-based, so turning every
 * read into a promise would ripple through ui/integration.ts and the panel. This
 * backend therefore keeps an in-memory cache: `ready()` hydrates it once, reads
 * come from the cache, and writes go through to storage. The first paint can
 * happen before hydration lands, so callers that render must await `ready()`
 * (integration.ts does) — the same pattern the file already uses for
 * `getUsername()`.
 *
 * WRITE ORDERING
 * Mutations are read-modify-write. Two overlapping `set` calls could each read
 * the same base table and the second write would drop the first, so every write
 * is chained onto a single queue and awaited in order.
 *
 * FALLBACK
 * If `chrome.storage` is genuinely unreachable, the backend falls back to the
 * page's localStorage so the feature still works, and says so via `backendName`.
 * In that mode the original persistence behaviour applies, but the legacy keys
 * are still cleaned up so an uninstall/reinstall cycle does not resurrect them.
 */
(function () {
  const KE = window.KoboEnhance;

  type KeBackendName = "extension" | "page";

  function extensionArea(): KeChromeStorageArea | null {
    try {
      if (typeof chrome === "undefined") return null;
      if (!chrome.storage || !chrome.storage.local) return null;
      if (typeof chrome.storage.local.get !== "function") return null;
      return chrome.storage.local;
    } catch (e) {
      return null;
    }
  }

  /** The single contract is declared once, in types/transfer.d.ts. */
  function createStateBackend(): KoboTransferStateBackend {
    const area = extensionArea();
    const backend: KeBackendName = area ? "extension" : "page";
    const cache = new Map<string, unknown>();
    const loaded = new Set<string>();
    let queue: Promise<unknown> = Promise.resolve();

    /** Serialises writes so read-modify-write cycles cannot interleave. */
    function enqueue<T>(job: () => Promise<T>): Promise<T> {
      const next = queue.then(job, job);
      queue = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    }

    /**
     * Hydration is tracked PER KEY, not with one flag. Both stores share this
     * backend instance, so a single `hydrated` boolean would mean whichever store
     * hydrated first starved the other: the mapping table would never load, every
     * project would look unmapped, and a re-run would duplicate the whole account.
     */
    function ready(keys: string[]): Promise<void> {
      const wanted = keys.filter((key) => !loaded.has(key));
      if (wanted.length === 0) return Promise.resolve();
      // Marked up front so two concurrent callers cannot both fetch the same key.
      for (const key of wanted) loaded.add(key);
      return enqueue(async () => {
        if (!area) {
          // Page-storage fallback. It still has to READ, otherwise the fallback
          // would only ever be able to write and would look like data loss.
          for (const key of wanted) {
            if (cache.has(key)) continue;
            try {
              const raw = window.localStorage.getItem(key);
              if (raw !== null) cache.set(key, JSON.parse(raw) as unknown);
            } catch (e) {
              /* ignore an unreadable entry */
            }
          }
          return;
        }
        try {
          const got = await area.get(wanted);
          for (const key of wanted) {
            // Never clobber a value this page already wrote: a write that landed
            // before hydration would otherwise be overwritten by the older copy
            // still sitting in storage.
            if (cache.has(key)) continue;
            if (Object.prototype.hasOwnProperty.call(got, key)) cache.set(key, got[key]);
          }
        } catch (e) {
          // Allow one later retry rather than caching a failed load forever.
          for (const key of wanted) loaded.delete(key);
        }
      });
    }

    function read(key: string): unknown {
      return cache.get(key);
    }

    function write(key: string, value: unknown): Promise<boolean> {
      return enqueue(async () => {
        cache.set(key, value);
        try {
          if (area) {
            await area.set({ [key]: value });
            return true;
          }
          window.localStorage.setItem(key, JSON.stringify(value));
          return true;
        } catch (e) {
          // The value is still in the cache, so this session behaves correctly;
          // the caller is told persistence failed so it can warn.
          return false;
        }
      });
    }

    function remove(key: string): Promise<void> {
      return enqueue(async () => {
        cache.delete(key);
        try {
          if (area) {
            await area.remove(key);
            return;
          }
          window.localStorage.removeItem(key);
        } catch (e) {
          /* nothing to clear */
        }
      });
    }

    return { read, ready, write, remove, name: () => backend };
  }

  KE.transferState = createStateBackend();
})();
