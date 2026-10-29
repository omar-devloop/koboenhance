/**
 * features/history/history.store.ts — run history and audit log persistence.
 *
 * Records a compact summary of every executed run (bulk + account) in
 * localStorage under the Kobo origin (same approach as core/templates.store.ts):
 * action, timestamp, signed-in user, project count, success/error/cancelled/
 * skipped counts, and the sanitized settings snapshot. Only identifiers and
 * counts are stored — never credentials, and never the finished `ui` payload.
 *
 * The recorder is injected into the executor through
 * KE.actionExecutor.setHistorySink (DI, like setDefaultUi), so auditing needs
 * no change in UI or feature code and can never break or delay a run.
 */
(function () {
  const KE = window.KoboEnhance;

  const STORE_KEY = "ke:runHistory";
  const MAX_ENTRIES = 200;
  /** The exact bulk-run CSV (entry.details) is kept only while the whole log
   *  stays under this byte budget; oldest details are dropped first. */
  const DETAILS_BUDGET = 1500 * 1024;
  /** Row cap per stored details set (the on-screen report is already exact). */
  const DETAILS_MAX_ROWS = 2000;

  const OUTCOMES: RunHistoryOutcome[] = ["success", "error", "stopped", "empty"];

  let cache: RunHistoryEntry[] | null = null;

  function newId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function cloneEntry(e: RunHistoryEntry): RunHistoryEntry {
    return JSON.parse(JSON.stringify(e)) as RunHistoryEntry;
  }

  /** Guards stored rows so corrupted localStorage can never crash the panel. */
  function normalize(raw: RunHistoryEntry | null | undefined): RunHistoryEntry | null {
    if (!raw || typeof raw !== "object" || !String((raw as { action?: unknown }).action || "").trim()) return null;
    const out: RunHistoryEntry = {
      id: String(raw.id || newId()),
      ts: typeof raw.ts === "number" && raw.ts > 0 ? raw.ts : Date.now(),
      action: String(raw.action),
      actionLabel: String(raw.actionLabel || raw.action),
      kind: raw.kind === "account" ? "account" : "bulk",
      user: String(raw.user || ""),
      outcome: raw.outcome && OUTCOMES.indexOf(raw.outcome) >= 0 ? raw.outcome : "success",
      settings: (raw.settings && typeof raw.settings === "object" ? raw.settings : {}) as ActionRequest,
    };
    if (raw.source) out.source = String(raw.source);
    if (raw.error) out.error = String(raw.error);
    if (raw.scope && typeof raw.scope === "object") {
      out.scope = {
        projectCount: Math.max(0, raw.scope.projectCount | 0),
        wholeAccount: !!raw.scope.wholeAccount,
      };
    }
    if (raw.counts && typeof raw.counts === "object") {
      const c = raw.counts;
      out.counts = {
        success: Math.max(0, c.success | 0),
        failed: Math.max(0, c.failed | 0),
        cancelled: Math.max(0, c.cancelled | 0),
        skipped: Math.max(0, c.skipped | 0),
      };
    }
    if (raw.details && typeof raw.details === "object") {
      const d = raw.details;
      if (typeof d.csv === "string" && Array.isArray(d.headers) && Array.isArray(d.rows)) {
        out.details = {
          headers: (d.headers as unknown[]).map((h) => String(h)),
          rows: (d.rows as unknown[])
            .filter((r): r is Record<string, string> => !!r && typeof r === "object")
            .slice(0, DETAILS_MAX_ROWS),
          csv: d.csv,
        };
      }
    }
    return out;
  }

  function byteLength(list: RunHistoryEntry[]): number {
    try {
      return JSON.stringify(list).length;
    } catch (e) {
      return Infinity;
    }
  }

  /** Strips `details` from oldest entries until the log fits the budget. */
  function enforceBudget(list: RunHistoryEntry[]): RunHistoryEntry[] {
    if (byteLength(list) <= DETAILS_BUDGET) return list;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e && e.details) {
        delete e.details;
        if (byteLength(list) <= DETAILS_BUDGET) break;
      }
    }
    return list;
  }

  function persist(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cache));
    } catch (e) {
      /* storage full / blocked — the log just won't persist across reloads */
    }
  }

  function loadCache(): RunHistoryEntry[] {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out: RunHistoryEntry[] = [];
      for (const item of parsed) {
        const ok = normalize(item);
        if (ok) out.push(ok);
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  function resolve(): RunHistoryEntry[] {
    if (cache === null) cache = loadCache();
    return cache;
  }

  /** Captures a finished run. The executor calls this through the sink. */
  function record(capture: RunHistoryCapture): void {
    void (async () => {
      let user = "";
      try {
        user = await KE.auth.getUsername();
      } catch (e) {
        user = "";
      }
      const entry = normalize(Object.assign({}, capture, { id: newId(), ts: Date.now(), user: user || "" }) as RunHistoryEntry);
      if (!entry) return;
      const list = resolve();
      list.unshift(entry);
      cache = enforceBudget(list.slice(0, MAX_ENTRIES));
      persist();
    })();
  }

  function list(): RunHistoryEntry[] {
    return resolve().map(cloneEntry);
  }

  function get(id: string): RunHistoryEntry | null {
    const found = resolve().find((e) => e.id === id);
    return found ? cloneEntry(found) : null;
  }

  function remove(id: string): void {
    cache = resolve().filter((e) => e.id !== id);
    persist();
  }

  function clear(): void {
    cache = [];
    persist();
  }

  window.KoboEnhance.history = {
    record,
    list,
    get,
    remove,
    clear,
    // Replaced by features/history/history.panel.ts. Kept as a safe no-op so
    // the toolbar button never throws before that module is loaded.
    openPanel(): void {},
  };

  if (typeof KE.actionExecutor.setHistorySink === "function") {
    KE.actionExecutor.setHistorySink(record);
  }
})();