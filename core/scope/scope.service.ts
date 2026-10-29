/**
 * core/scope/scope.service.ts — SCOPE concept: "which projects are affected".
 *
 * A bulk operation targets either an explicit project list (the live checkbox
 * selection or manual UIDs) or the entire account (respecting the current list
 * filter). Everything that turns a scope into concrete project data lives
 * here, so no feature (bulk actions, check-access, audits, exports, portfolio)
 * re-implements scope resolution.
 *
 * - resolveUids()  -> list of project UIDs (whole-account path filters to
 *                     "survey" assets, matching the toolbar actions).
 * - collect()      -> list of survey assets (or every asset when raw=true,
 *                     for callers that need non-survey assets too).
 * Both report progress via onProgress(msg, done, total) and are abortable
 * through signal (they propagate AbortError for the caller to own the
 * stop semantics).
 */
(function () {
  const KE = window.KoboEnhance;
  const { t } = KE.i18n;

  function isSurvey(asset: Project | KoboRecord | null | undefined): asset is Project {
    return !!asset && (asset.asset_type || "survey") === "survey";
  }

  function defaultFilterUrl(): string {
    return `${KE.auth.getBaseUrl()}/api/v2/assets/`;
  }

  function normalizeUids(list: UID[] | null | undefined): UID[] {
    return (list || []).filter(Boolean);
  }

  interface ResolveOptions {
    uids?: UID[] | null;
    filterUrl?: string | null;
    signal?: AbortSignal;
    onProgress?: RunProgressHandler;
  }

  interface CollectOptions {
    uids?: UID[] | null;
    filterUrl?: string | null;
    signal?: AbortSignal;
    onProgress?: RunProgressHandler;
    raw?: boolean;
  }

  /** Resolves the UIDs a scope targets. Explicit lists pass through; the
   *  whole account is paginated (survey assets only), same as the toolbar. */
  async function resolveUids(options: ResolveOptions): Promise<UID[]> {
    const { uids, filterUrl, signal, onProgress } = options;
    const explicit = normalizeUids(uids);
    if (explicit.length) return explicit;

    const out: UID[] = [];
    await KE.pagination.fetchAllAssets(
      filterUrl || defaultFilterUrl(),
      (page) => {
        for (const asset of (page && page.results) || []) {
          if (isSurvey(asset) && asset.uid) out.push(asset.uid);
        }
        if (typeof onProgress === "function") {
          onProgress(
            t("Resolving projects... ({n})", { n: out.length }),
            out.length,
            (page && page.count) || out.length
          );
        }
      },
      signal
    );
    return out;
  }

  /** Collects the asset items a scope targets. Explicit lists fetch each
   *  asset; the whole account is paginated. Surveys only by default; pass
   *  raw=true to keep every asset type. */
  async function collect(options: CollectOptions): Promise<Project[]> {
    const { uids, filterUrl, signal, onProgress, raw } = options;
    const explicit = normalizeUids(uids);
    const keep = raw ? function (): boolean { return true; } : isSurvey;
    const items: Project[] = [];

    if (explicit.length) {
      for (const uid of explicit) {
        const asset = await KE.apiAssets.fetchAsset(uid, signal);
        if (asset && keep(asset)) items.push(asset);
        if (typeof onProgress === "function") {
          onProgress(t("Fetching projects... ({n}/{total})", { n: items.length, total: explicit.length }), items.length, explicit.length);
        }
      }
      return items;
    }

    await KE.pagination.fetchAllAssets(
      filterUrl || defaultFilterUrl(),
      (page) => {
        const total = (page && page.count) || items.length;
        for (const asset of (page && page.results) || []) {
          if (asset && keep(asset)) items.push(asset);
        }
        if (typeof onProgress === "function") {
          onProgress(t("Fetching projects... ({n}/{total})", { n: items.length, total }), items.length, total);
        }
      },
      signal
    );
    return items;
  }

  window.KoboEnhance.scopeService = { normalizeUids, resolveUids, collect };
})();