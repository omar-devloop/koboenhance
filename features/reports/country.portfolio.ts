/**
 * features/reports/country.portfolio.ts — country portfolio report.
 *
 * Counts survey projects per country across the account (or a selection),
 * folding countries without a value into "Unspecified". Returns aggregated
 * { counts, rows, scanned, outcome, files } where `files` declares the export
 * rows + columns; CSV formatting happens in the report stage
 * (exportSvc.buildCsvFiles).
 *
 * Scope resolution and the per-item/whole-account loops come from the
 * action's execution context runtime (runtime.scope / runtime.runItems /
 * runtime.pagination); CSV formatting is handled by the report stage
 * (exportSvc.buildCsvFiles). This module keeps the aggregation + report
 * shaping + finished-toolbar UI (report.summary).
 */
(function () {
  const KE = window.KoboEnhance;
  const { t } = KE.i18n;

  interface CountryRow extends KoboRecord {
    Country: string;
    Project_Count: number;
  }

  interface CountryPortfolioResult extends KoboRecord {
    counts: Record<string, number>;
    rows: CountryRow[];
    scanned: number;
    outcome: string;
    error?: string;
    /** Declared export data; the report stage materializes it into CSV. */
    files?: ReportFileSpec[];
  }

  function normalizeCountryName(entry: CountryOption | string | null | undefined): string {
    if (!entry) return "";
    if (typeof entry === "string") return entry.trim();
    const raw = (entry && (entry.label || entry.value)) || "";
    return String(raw).replace(/\s*\(@@other\)\s*$/, "").trim();
  }

  function countryRows(counts: Record<string, number>): CountryRow[] {
    return Object.keys(counts)
      .map((name) => ({
        Country: name,
        Project_Count: counts[name],
      }))
      .sort((a, b) => {
        const ua = a.Country === "Unspecified" ? 1 : 0;
        const ub = b.Country === "Unspecified" ? 1 : 0;
        return (ua - ub) || (b.Project_Count - a.Project_Count) || a.Country.localeCompare(b.Country);
      });
  }

  async function run(opts: {
    uidList?: UID[] | null;
    filterUrl?: string | null;
    signal?: AbortSignal;
    onProgress?: RunProgressHandler;
    runtime: ActionRuntime;
  }): Promise<CountryPortfolioResult> {
    const uidList = opts.uidList;
    const filterUrl = opts.filterUrl;
    const signal = opts.signal;
    const onProgress = opts.onProgress;
    const runtime = opts.runtime;

    const url = filterUrl || `${runtime.auth.baseUrl}/api/v2/assets/`;

    const counts: Record<string, number> = {};
    let scanned = 0;
    let totalCount = 0;

    const countAsset = (asset: Project | null | undefined) => {
      if (!asset || (asset.asset_type || "survey") !== "survey") return;
      scanned++;
      const countries = (asset.settings && Array.isArray(asset.settings.country))
        ? asset.settings.country
        : [];
      const names = countries.map(normalizeCountryName).filter(Boolean);
      if (names.length === 0) {
        counts["Unspecified"] = (counts["Unspecified"] || 0) + 1;
      } else {
        for (const name of new Set(names)) {
          counts[name] = (counts[name] || 0) + 1;
        }
      }
    };

    const finish = (outcome: string): CountryPortfolioResult => {
      const rows = countryRows(counts);
      // Declared export intent only — CSV is formatted by the report stage.
      return {
        counts,
        rows,
        scanned,
        outcome,
        files: [{ filename: "kobo-country-portfolio-report", columns: ["Country", "Project_Count"], rows }],
      };
    };

    if (uidList && uidList.length) {
      totalCount = uidList.length;
      const res = await runtime.runItems<UID, null>({
        items: uidList,
        signal,
        perItem: async (uid) => {
          const asset = await runtime.api.assets.fetchAsset(uid, signal);
          countAsset(asset);
          return null;
        },
        onAbort: () => null,
        onProgress: () => {
          if (typeof onProgress === "function") {
            onProgress(t("Fetching projects... ({n}/{total})", { n: scanned, total: totalCount }), scanned, totalCount);
          }
        },
      });
      return finish(res.stopped ? "stopped" : "done");
    }

    try {
      await runtime.pagination.fetchAllAssets(
        url,
        (page) => {
          totalCount = (page && page.count) || 0;
          for (const asset of page.results || []) countAsset(asset);
          if (typeof onProgress === "function") {
            onProgress(t("Fetching projects... ({n}/{total})", { n: scanned, total: totalCount }), scanned, totalCount);
          }
        },
        signal
      );
    } catch (e) {
      if ((e as KoboRecord) && (e as KoboRecord).name === "AbortError") {
        return finish("stopped");
      }
      throw e;
    }

    return finish("done");
  }

  /**
   * Registers the account-kind action. report.summary turns the finished scan
   * into the exact dialog/toast/file the toolbar used to render by hand.
   */
  if (KE.actionRegistry && KE.actionInterface) {
    KE.actionRegistry.register("country_portfolio", {
      kind: "account",
      label: "Country portfolio report",
      group: "Account tools",
      description: "Count projects per country across your account",
      icon: "chart",
      fields: [],
      requiredFields: [],
      stepLabel: "Reporting",
      loadingStep: "Fetching project list...",
      async execute(context: ItemContext<ActionRequest> | AccountExecuteContext<ActionRequest, CountryPortfolioResult>) {
        const c = context as AccountExecuteContext<ActionRequest, CountryPortfolioResult>;
        return (await run({
          uidList: c.uidList,
          filterUrl: c.filterUrl,
          signal: c.signal,
          onProgress: c.onProgress,
          runtime: c.runtime,
        })) || ({} as CountryPortfolioResult);
      },
      report: {
        summary(res) {
          const r = res as CountryPortfolioResult;
          if (r.error) {
            return { dialog: String(r.error) };
          }
          const rows = r.rows || [];
          if (r.outcome === "stopped") {
            if (!rows.length) return null;
          } else if (!rows.length) {
            return { dialog: t("No projects were found to report.") };
          }
          const files = (((r.files as unknown) || []) as UiFile[]).filter(Boolean);
          return {
            type: r.outcome === "stopped" ? "warning" : "success",
            title: t("Country portfolio report"),
            description: t("{n} countries across {m} project(s)", { n: rows.length, m: r.scanned }),
            metrics: [
              { label: t("Countries"), value: rows.length },
              { label: t("Projects"), value: r.scanned },
            ],
            files,
          };
        },
      },
    } as ActionParams<ActionRequest, CountryPortfolioResult>);
  }
})();