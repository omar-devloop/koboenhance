/**
 * features/paused-run/paused-run.store.ts — Pause & resume persistence.
 *
 * When a bulk run is paused (core/execution/action.executor.ts parks its
 * loop), the toolbar writes the pending UID list + accumulated rows to this
 * module. The snapshot lives in sessionStorage — the browser's idea of "this
 * tab's page session": it survives a page reload, dies with the tab, and is
 * never shared across tabs/accounts. On the next load, ui/integration.ts asks
 * `KE.pausedRun.valid()` whether the snapshot still belongs to the current
 * session (same account, same base, action still registered, age within the
 * TTL) and, if so, offers Resume.
 *
 * storage shape: { ke:pausedRun }
 */
(function () {
  const KE = window.KoboEnhance;

  const KEY = "ke:pausedRun";
  /** A snapshot older than this is never offered back (session TTL guard). */
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
  /** Refuse snapshots whose remaining UID list is unreasonably large. */
  const MAX_REMAINING = 25000;
  /** Refuse snapshots whose serialized size would risk the 5MB session quota. */
  const MAX_BYTES = 3.5 * 1024 * 1024;

  function save(snapshot: PausedRunSnapshot | null | undefined): boolean {
    if (!snapshot || !Array.isArray(snapshot.remaining) || !Array.isArray(snapshot.rows)) return false;
    if (snapshot.remaining.length > MAX_REMAINING) return false;
    let raw: string;
    try {
      raw = JSON.stringify(snapshot);
    } catch (e) {
      return false;
    }
    if (raw.length > MAX_BYTES) return false;
    try {
      sessionStorage.setItem(KEY, raw);
      return true;
    } catch (e) {
      return false;
    }
  }

  function isSnapshot(s: PausedRunSnapshot | (KoboRecord & object) | null | undefined): s is PausedRunSnapshot {
    if (!s || typeof s !== "object") return false;
    const r = s as KoboRecord;
    if (r.v !== 1) return false;
    if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return false;
    if (typeof r.action !== "string" || !r.action) return false;
    if (typeof r.user !== "string") return false;
    if (typeof r.baseUrl !== "string") return false;
    if (typeof r.processed !== "number" || !Number.isFinite(r.processed)) return false;
    if (typeof r.total !== "number" || !Number.isFinite(r.total)) return false;
    const settings = r.settings as KoboRecord | null | undefined;
    if (!settings || typeof settings !== "object") return false;
    if (!Array.isArray(r.remaining) || !r.remaining.every((u) => typeof u === "string")) return false;
    if (!Array.isArray(r.rows) || r.rows.length > MAX_REMAINING + 1e4) return false;
    return true;
  }

  function load(): PausedRunSnapshot | null {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PausedRunSnapshot | (KoboRecord & object);
      if (!isSnapshot(parsed)) {
        clear();
        return null;
      }
      return parsed;
    } catch (e) {
      clear();
      return null;
    }
  }

  async function valid(snapshot: PausedRunSnapshot | null | undefined): Promise<boolean> {
    if (!isSnapshot(snapshot)) return false;
    if (Date.now() - snapshot.ts > SESSION_TTL_MS) return false;
    const registry = KE.actionRegistry;
    if (!registry || typeof registry.get !== "function" || !registry.get(snapshot.action)) return false;
    let user = "";
    try {
      user = await KE.auth.getUsername();
    } catch (e) {
      user = "";
    }
    // A snapshot whose pause-time user matched the current login is valid even
    // when the user couldn't be resolved again; an EMPTY snapshot user is
    // accepted only when neither side could resolve a name.
    if (snapshot.user && user && snapshot.user.toLowerCase() !== user.toLowerCase()) return false;
    try {
      if (KE.auth && typeof KE.auth.getBaseUrl === "function" && snapshot.baseUrl && snapshot.baseUrl !== KE.auth.getBaseUrl()) return false;
    } catch (e) {
      return false;
    }
    return true;
  }

  function clear(): void {
    try {
      sessionStorage.removeItem(KEY);
    } catch (e) {
      /* ignore */
    }
  }

  window.KoboEnhance.pausedRun = { save, load, clear, valid };
})();