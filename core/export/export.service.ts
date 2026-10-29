/**
 * core/export/export.service.ts — the REPORT/EXPORT stage.
 *
 * Consumes EXECUTION results and turns them into presentation artifacts:
 *   - toCSV / buildCsvFiles materialize structured rows into CSV text
 *     (future JSON/Excel formats can reuse the same ReportFileSpec input),
 *   - download / makeFilename deliver the files in the browser (the
 *     object-URL + anchor approach needs no extra permission, so the
 *     extension asks for none: "downloads" was removed in 1.0.0).
 *
 * Actions declare their export intent as ReportFileSpec ({ filename, rows,
 * columns }) and never format CSV themselves; the executor hands those specs
 * to buildCsvFiles and the produced UiFile[] flows into report.summary -> UI.
 */
(function () {
  /**
   * Characters a spreadsheet treats as the start of a FORMULA, so a cell
   * beginning with one is executed instead of displayed.
   */
  const FORMULA_START = /^[=+\-@\t\r]/;

  /**
   * Escapes one CSV cell.
   *
   * FORMULA INJECTION: a project name like `=1+1` (or `+cmd|…`, `-2+3`, `@…`)
   * would be run as a formula by Excel/LibreOffice/Sheets when the report is
   * opened. Such a value is prefixed with an apostrophe, which the spreadsheet
   * reads as "the next cell is text" and then does not display.
   *
   * The guard is applied to STRINGS ONLY: a real negative number (`-12`) is a
   * number, not an injected formula, and must stay a number. A non-string
   * value that happens to stringify to something starting with `-` is
   * therefore left alone.
   */
  function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return "";
    let str = String(value);
    if (typeof value === "string" && FORMULA_START.test(str)) str = "'" + str;
    // A quoted field may contain a comma, a quote or a line break; \r was
    // missing before, so a CRLF cell could break the row apart.
    if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  function toCSV(rows: Array<Record<string, unknown>>, headers?: string[]): string {
    const cols = headers || (rows[0] ? Object.keys(rows[0]) : []);
    const lines = [cols.join(",")];
    for (const row of rows) {
      lines.push(cols.map((c) => csvEscape(row[c])).join(","));
    }
    return "\uFEFF" + lines.join("\n");
  }

  /** Returns only top-level scalar fields; nested objects and arrays are dropped.
   *  Also extracts tags from settings.extra_metadata.tags as a comma-separated string. */
  function scalarFields(obj: Project | KoboRecord): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    for (const k of Object.keys(obj || {})) {
      const v = obj[k];
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    }
    const settings = obj && (obj.settings as KoboRecord | undefined);
    const extra = settings && (settings.extra_metadata as ExtraMetadata | undefined);
    const tags = extra && extra.tags;
    if (Array.isArray(tags)) {
      out.Tags = tags.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim()).join(", ");
    }
    return out;
  }

  /** All keys found across any row, preserving first-seen order. */
  function unionKeys(rows: Array<Record<string, unknown>>): string[] {
    const seen: string[] = [];
    const map: Record<string, boolean> = {};
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!map[k]) {
          map[k] = true;
          seen.push(k);
        }
      }
    }
    return seen;
  }

  /**
   * The report stage: materializes declared export specs ({ filename, rows,
   * columns }) into CSV UiFile[]s. Every CSV inside the extension is formatted
   * here — actions only declare what to export, never how to format it.
   */
  function buildCsvFiles(specs: Array<ReportFileSpec | null | undefined> | null | undefined): UiFile[] {
    return (specs || []).filter(Boolean).map((s) => {
      const spec = s as ReportFileSpec;
      return {
        filename: spec.filename,
        csv: toCSV(spec.rows || [], spec.columns || (spec.rows ? unionKeys(spec.rows) : [])),
      };
    });
  }

  function download(filename: string, content: string, mime = "text/csv;charset=utf-8;"): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function timestamp(): string {
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  /** Builds a download filename including the signed-in username, e.g.
   *  `kobo-all-projects-<user>-20260914-1530.csv`. */
  async function makeFilename(prefix: string, ext = "csv"): Promise<string> {
    let username = "";
    try {
      username = await window.KoboEnhance.auth.getUsername();
    } catch (e) {
      username = "";
    }
    const us = username && username !== "me" ? `-${username}` : "";
    return `${prefix}${us}-${timestamp()}.${ext}`;
  }

  window.KoboEnhance.exportSvc = {
    toCSV,
    buildCsvFiles,
    scalarFields,
    unionKeys,
    download,
    timestamp,
    makeFilename,
  };
})();