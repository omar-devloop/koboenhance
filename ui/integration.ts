/**
 * ui/integration.js — in-page integration for the Projects list.
 *
 * Injects the bulk-action toolbar directly into Kobo's page toolbar, BEFORE the
 * native Archive/Share/Delete buttons:
 *   Row 1: selected count + action selector + Run Action + Export All (icon).
 *   Row 2: action-specific fields (username / users / permission / template…), right-aligned.
 * Adds a Kobo-style checkbox to the table header for select all / deselect all.
 * While an action runs, each row's checkbox is replaced with a status icon
 * (pending / done / error); statuses are restored once the run finishes and the
 * report has been downloaded. Works against the LIVE checkbox selection.
 *
 * Runs every registered action (bulk AND account scans) through the single
 * shared facade KE.integratedActions.run -> the action executor. Nothing here
 * knows which action it is: the descriptor's kind/fields/step wording drive
 * the toolbar, and the action's report.summary produces the finished UI
 * (dialog or toast + downloadable file(s)).
 */
(function () {
  const KE = window.KoboEnhance;
  const { PAGE_STYLES, showDialogInPage, showToast } = KE.components;
  const { el } = KE.dom;
  const { t, tP } = KE.i18n;

  // Wording for the selected-count label ("project" or "survey").
  const WORD = "project";
  const plural = (n: number) => `${n} ${n === 1 ? WORD : WORD + "s"}`;

  interface ToolbarRefs {
    toolbar: HTMLElement | null;
    row2: HTMLElement | null;
    manualRow: HTMLElement | null;
    actionSelect: HTMLSelectElement | null;
    sourceSelect: HTMLSelectElement | null;
    usernameRow: HTMLElement | null;
    usernameInput: HTMLInputElement | null;
    usersRow: HTMLElement | null;
    usersInput: HTMLInputElement | null;
    permSelect: HTMLSelectElement | null;
    permLabel: HTMLElement | null;
    renameRow: HTMLElement | null;
    prefixInput: HTMLInputElement | null;
    suffixInput: HTMLInputElement | null;
    replaceRow: HTMLElement | null;
    findInput: HTMLInputElement | null;
    replaceInput: HTMLInputElement | null;
    manualInput: HTMLTextAreaElement | null;
    descriptionRow?: HTMLElement | null;
    descriptionInput: HTMLTextAreaElement | null;
    tagsRow: HTMLElement | null;
    tagsModeSelect: HTMLSelectElement | null;
    tagsInput: HTMLInputElement | null;
    sourceProjectRow: HTMLElement | null;
    sourceProjectInput: HTMLInputElement | null;
    sourceProjectBtn: HTMLButtonElement | null;
    sourceProjectName: HTMLElement | null;
    templateRow: HTMLElement | null;
    templateSelect: HTMLSelectElement | null;
    templateBtn: HTMLButtonElement | null;
    templateFromProjectBtn: HTMLButtonElement | null;
    transferRow: HTMLElement | null;
    transferSummary: HTMLElement | null;
    transferBtn: HTMLButtonElement | null;
    transferScope: HTMLSelectElement | null;
    runBtn: HTMLButtonElement | null;
    historyBtn: HTMLButtonElement | null;
    collectBtn: HTMLButtonElement | null;
    settingsBtn: HTMLButtonElement | null;
    pauseBtn: HTMLButtonElement | null;
    pauseDlBtn: HTMLButtonElement | null;
    pauseDlWrap: HTMLElement | null;
    pauseTipWrap: HTMLElement | null;
    resumeBtn: HTMLButtonElement | null;
    runWrap: HTMLElement | null;
    pauseWrap: HTMLElement | null;
    resumeWrap: HTMLElement | null;
    stopBtn: HTMLButtonElement | null;
    stopWrap: HTMLElement | null;
    selectAllInput: HTMLInputElement | null;
  }

  const refs: ToolbarRefs = {
    toolbar: null,
    row2: null,
    manualRow: null,
    actionSelect: null,
    sourceSelect: null,
    usernameRow: null,
    usernameInput: null,
    usersRow: null,
    usersInput: null,
    permSelect: null,
    permLabel: null,
    renameRow: null,
    prefixInput: null,
    suffixInput: null,
    replaceRow: null,
    findInput: null,
    replaceInput: null,
    manualInput: null,
    descriptionInput: null,
    tagsRow: null,
    tagsModeSelect: null,
    tagsInput: null,
    sourceProjectRow: null,
    sourceProjectInput: null,
    sourceProjectBtn: null,
    sourceProjectName: null,
    templateRow: null,
    templateSelect: null,
    templateBtn: null,
    templateFromProjectBtn: null,
    transferRow: null,
    transferSummary: null,
    transferBtn: null,
    transferScope: null,
    runBtn: null,
    historyBtn: null,
    collectBtn: null,
    settingsBtn: null,
    pauseBtn: null,
    pauseDlBtn: null,
    pauseDlWrap: null,
    pauseTipWrap: null,
    resumeBtn: null,
    runWrap: null,
    pauseWrap: null,
    resumeWrap: null,
    stopBtn: null,
    stopWrap: null,
    selectAllInput: null,
  };

  const rowBoxes: Record<string, Element | null> = {};
  const statusIcons: Record<string, HTMLElement | null> = {};
  let selectAllBox: HTMLElement | null = null;
  let selectAllIcon: HTMLElement | null = null;
  const selectedUidsVar: { uids: UID[] } = { uids: [] };
  let runningUids: UID[] = [];
  let lastFilterUrl: string | null = null;
  let running = false;
  let runToast: ProgressToastHandle | null = null;
  let currentRunTitle = "";
  // Pause & resume state (executor parks the loop between items while paused).
  let paused = false;
  let pausedInfo: RunPauseInfo | null = null;
  let pausedAction = "";
  let pausedUser = "";
  let idleSnapshot: PausedRunSnapshot | null = null;
  let envDataCache: EnvironmentResponse | null = null;
  let envDataLoading: Promise<EnvironmentResponse> | null = null;
  let sourceNameTimer: ReturnType<typeof setTimeout> | null = null;
  let sourceNameReq = 0;
  let countryPicker: TagPickerHandle | null = null;
  let sectorPicker: SelectPickerHandle | null = null;
  let actionDropdown: SelectDropdownHandle | null = null;
  let scopeDropdown: SelectDropdownHandle | null = null;
  /** Whether a validated destination account is available in this tab.
   *  Kept as a cached flag because the store's isReady() is async (it reads the
   *  in-memory token) while the Run gate is synchronous. Because the token is
   *  never persisted, this flag starts false on every page load and only becomes
   *  true after the user re-enters and re-validates the token in the panel. */
  let transferReady = false;
  /** Whether the destination store's async hydration has already been kicked
   *  off, so the row-2 label repaints exactly once when the cache lands. */
  let transferRowHydrated = false;
  /** Signed-in account name, for the row-2 "from ... to ..." summary. */
  let transferSourceName = "";

  // ---------- Kobo-style SVG status icons ----------

  const NS = "http://www.w3.org/2000/svg";
  const STATUS_SPEC: Record<string, Array<{ tag: string; attrs: Record<string, string> }>> = {
    pending: [
      { tag: "circle", attrs: { cx: "12", cy: "12", r: "9" } },
      { tag: "line", attrs: { x1: "12", y1: "12", x2: "12", y2: "8" } },
    ],
    success: [
      { tag: "path", attrs: { d: "M20 6L9 17l-5-5" } },
    ],
    failed: [
      { tag: "circle", attrs: { cx: "12", cy: "12", r: "9" } },
      { tag: "line", attrs: { x1: "9", y1: "9", x2: "15", y2: "15" } },
      { tag: "line", attrs: { x1: "15", y1: "9", x2: "9", y2: "15" } },
    ],
    cancelled: [
      { tag: "circle", attrs: { cx: "12", cy: "12", r: "9" } },
      { tag: "line", attrs: { x1: "9", y1: "12", x2: "15", y2: "12" } },
    ],
    skipped: [
      { tag: "circle", attrs: { cx: "12", cy: "12", r: "9" } },
      { tag: "line", attrs: { x1: "8", y1: "12", x2: "16", y2: "12" } },
    ],
  };

  // ---------- dropdown option icons ----------

  const ICON_SPECS: Record<string, Array<{ tag: string; attrs: Record<string, string> }>> = {
    "user-plus": [
      { tag: "path", attrs: { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" } },
      { tag: "circle", attrs: { cx: "10", cy: "7", r: "4" } },
      { tag: "line", attrs: { x1: "19", y1: "8", x2: "19", y2: "12" } },
      { tag: "line", attrs: { x1: "17", y1: "10", x2: "21", y2: "10" } },
    ],
    "user-minus": [
      { tag: "path", attrs: { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" } },
      { tag: "circle", attrs: { cx: "10", cy: "7", r: "4" } },
      { tag: "line", attrs: { x1: "17", y1: "10", x2: "21", y2: "10" } },
    ],
    copy: [
      { tag: "rect", attrs: { x: "9", y: "9", width: "13", height: "13", rx: "2", ry: "2" } },
      { tag: "path", attrs: { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" } },
    ],
    archive: [
      { tag: "line", attrs: { x1: "3", y1: "8", x2: "21", y2: "8" } },
      { tag: "path", attrs: { d: "M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" } },
      { tag: "line", attrs: { x1: "10", y1: "12", x2: "14", y2: "12" } },
    ],
    unarchive: [
      { tag: "path", attrs: { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" } },
      { tag: "path", attrs: { d: "M7 8l5-5 5 5" } },
      { tag: "line", attrs: { x1: "12", y1: "3", x2: "12", y2: "15" } },
    ],
    type: [
      { tag: "path", attrs: { d: "M4 7V5h16v2" } },
      { tag: "line", attrs: { x1: "12", y1: "5", x2: "12", y2: "19" } },
      { tag: "line", attrs: { x1: "9", y1: "19", x2: "15", y2: "19" } },
    ],
    find: [
      { tag: "circle", attrs: { cx: "11", cy: "11", r: "7" } },
      { tag: "line", attrs: { x1: "21", y1: "21", x2: "16.5", y2: "16.5" } },
      { tag: "line", attrs: { x1: "8", y1: "9", x2: "14", y2: "9" } },
      { tag: "line", attrs: { x1: "8", y1: "13", x2: "11", y2: "13" } },
    ],
    "align-left": [
      { tag: "line", attrs: { x1: "3", y1: "6", x2: "21", y2: "6" } },
      { tag: "line", attrs: { x1: "3", y1: "12", x2: "21", y2: "12" } },
      { tag: "line", attrs: { x1: "3", y1: "18", x2: "12", y2: "18" } },
    ],
    globe: [
      { tag: "circle", attrs: { cx: "12", cy: "12", r: "9" } },
      { tag: "line", attrs: { x1: "3", y1: "12", x2: "21", y2: "12" } },
      { tag: "path", attrs: { d: "M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" } },
    ],
    target: [
      { tag: "circle", attrs: { cx: "12", cy: "12", r: "9" } },
      { tag: "circle", attrs: { cx: "12", cy: "12", r: "5" } },
      { tag: "circle", attrs: { cx: "12", cy: "12", r: "1" } },
    ],
    tag: [
      { tag: "path", attrs: { d: "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" } },
      { tag: "line", attrs: { x1: "7", y1: "7", x2: "7.01", y2: "7" } },
    ],
    "user-search": [
      { tag: "circle", attrs: { cx: "9", cy: "7", r: "4" } },
      { tag: "path", attrs: { d: "M2 21v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1" } },
      { tag: "circle", attrs: { cx: "17.5", cy: "17.5", r: "3.5" } },
      { tag: "line", attrs: { x1: "20.5", y1: "20.5", x2: "23", y2: "23" } },
    ],
    users: [
      { tag: "path", attrs: { d: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" } },
      { tag: "circle", attrs: { cx: "9", cy: "7", r: "4" } },
      { tag: "path", attrs: { d: "M23 21v-2a4 4 0 0 0-3-3.87" } },
      { tag: "path", attrs: { d: "M16 3.13a4 4 0 0 1 0 7.75" } },
    ],
    settings: [
      { tag: "circle", attrs: { cx: "12", cy: "12", r: "3" } },
      { tag: "path", attrs: { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" } },
    ],
    trash: [
      { tag: "path", attrs: { d: "M3 6h18" } },
      { tag: "path", attrs: { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" } },
      { tag: "path", attrs: { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" } },
      { tag: "line", attrs: { x1: "10", y1: "11", x2: "10", y2: "17" } },
      { tag: "line", attrs: { x1: "14", y1: "11", x2: "14", y2: "17" } },
    ],
    "shield-check": [
      { tag: "path", attrs: { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" } },
      { tag: "path", attrs: { d: "M9 12l2 2 4-4" } },
    ],
    lock: [
      { tag: "rect", attrs: { x: "3", y: "11", width: "18", height: "11", rx: "2" } },
      { tag: "path", attrs: { d: "M7 11V7a5 5 0 0 1 10 0v4" } },
    ],
    unlock: [
      { tag: "rect", attrs: { x: "3", y: "11", width: "18", height: "11", rx: "2" } },
      { tag: "path", attrs: { d: "M7 11V7a5 5 0 0 1 9.9-1" } },
    ],
    chart: [
      { tag: "line", attrs: { x1: "12", y1: "20", x2: "12", y2: "10" } },
      { tag: "line", attrs: { x1: "18", y1: "20", x2: "18", y2: "4" } },
      { tag: "line", attrs: { x1: "6", y1: "20", x2: "6", y2: "14" } },
      { tag: "line", attrs: { x1: "3", y1: "20", x2: "21", y2: "20" } },
    ],
    download: [
      { tag: "path", attrs: { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" } },
      { tag: "path", attrs: { d: "M7 10l5 5 5-5" } },
      { tag: "line", attrs: { x1: "12", y1: "15", x2: "12", y2: "3" } },
    ],
    "check-square": [
      { tag: "path", attrs: { d: "M3 3h18v18H3z" } },
      { tag: "path", attrs: { d: "M9 12l2 2 4-4" } },
    ],
    hash: [
      { tag: "line", attrs: { x1: "4", y1: "9", x2: "20", y2: "9" } },
      { tag: "line", attrs: { x1: "4", y1: "15", x2: "20", y2: "15" } },
      { tag: "line", attrs: { x1: "10", y1: "3", x2: "8", y2: "21" } },
      { tag: "line", attrs: { x1: "16", y1: "3", x2: "14", y2: "21" } },
    ],
    layers: [
      { tag: "path", attrs: { d: "M12 2L2 7l10 5 10-5-10-5z" } },
      { tag: "path", attrs: { d: "M2 17l10 5 10-5" } },
      { tag: "path", attrs: { d: "M2 12l10 5 10-5" } },
    ],
    "chevron-down": [
      { tag: "path", attrs: { d: "M6 9l6 6 6-6" } },
    ],
    smartphone: [
      { tag: "rect", attrs: { x: "5", y: "2", width: "14", height: "20", rx: "2", ry: "2" } },
      { tag: "line", attrs: { x1: "12", y1: "18", x2: "12.01", y2: "18" } },
    ],
  };

  function buildIcon(name: string, size?: number): SVGSVGElement | null {
    const spec = ICON_SPECS[name];
    if (!spec) return null;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size || 16));
    svg.setAttribute("height", String(size || 16));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const s of spec) {
      const n = document.createElementNS(NS, s.tag);
      for (const [k, v] of Object.entries(s.attrs)) n.setAttribute(k, v);
      svg.appendChild(n);
    }
    return svg;
  }

  function buildStatusSvg(status: string): SVGSVGElement {
    if (status === "running") return KE.components.buildSpinner(18);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const spec of STATUS_SPEC[status] || STATUS_SPEC.pending) {
      const n = document.createElementNS(NS, spec.tag);
      for (const [k, v] of Object.entries(spec.attrs)) n.setAttribute(k, v);
      svg.appendChild(n);
    }
    return svg;
  }

  // ---------- small DOM helpers ----------

  function findActionsHost(): HTMLElement | null {
    return document.querySelector('[class*="projectViews-module__actions"]') as HTMLElement | null;
  }
  function findActionsRoot(): HTMLElement | null {
    const host = findActionsHost();
    if (!host) return null;
    return host.querySelector('[class*="projectActions-module__root"]') as HTMLElement || host;
  }
  function findTableRoot(): HTMLElement | null {
    return document.querySelector('[class*="projectsTable-module__root"]') as HTMLElement | null;
  }
  function findHeaderRow(): Element | null {
    const t = findTableRoot();
    if (!t) return null;
    return t.querySelector('[class*="projectsTableRow-module__rowTypeHeader"]');
  }
  function findBodyRows(): Element[] | null {
    const t = findTableRoot();
    if (!t) return null;
    const rows = Array.from(t.querySelectorAll('[class*="projectsTableRow-module__row"]'));
    return rows.filter((r) => !Array.from(r.classList).some((c) => c.includes("rowTypeHeader")));
  }

  // ---------- lifecycle ----------

  function injectStyles(): void {
    if (document.getElementById("ke-page-styles")) return;
    const s = document.createElement("style");
    s.id = "ke-page-styles";
    s.textContent = PAGE_STYLES;
    (document.head || document.documentElement).appendChild(s);
  }

  type ScheduleFn = (() => void) & { timer?: ReturnType<typeof setTimeout> };

  function schedule(): void {
    clearTimeout((schedule as ScheduleFn).timer);
    (schedule as ScheduleFn).timer = setTimeout(refresh, 200);
  }

  function observe(): void {
    const target = document.body || document.documentElement;
    const obs = new MutationObserver(schedule);
    obs.observe(target, { childList: true, subtree: true });
    const poller = setInterval(() => {
      if (findActionsRoot()) refresh();
    }, 2000);
    window.addEventListener(
      "pagehide",
      () => {
        clearInterval(poller);
        obs.disconnect();
      },
      { once: true }
    );
  }

  function refresh(): void {
    ensureToolbar();
    ensureRow2();
    ensureHeaderSelectAll();
    bindTableEvents();
    syncSelection();
    if (KE.tagsColumn && typeof KE.tagsColumn.refresh === "function") KE.tagsColumn.refresh();
  }

  function init(): void {
    injectStyles();
    // Warm the username lookup in the background so report download filenames
    // (makeFilename -> auth.getUsername) resolve instantly when clicked.
    if (KE.auth && typeof KE.auth.getUsername === "function") {
      KE.auth.getUsername().catch(() => {});
    }
    window.addEventListener("message", (event) => {
      // Only a message from THIS page (same window, same origin) may set the
      // filter context. Without the origin check, any frame or script able to
      // post a message could inject a URL that the account-wide pagination
      // would later fetch.
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (data && data.channel === "__koboenhance__" && data.type === "asset-list-request") {
        // The URL is validated before it is stored: it must be this origin's
        // asset-list endpoint (core/api/pagination.ts -> sanitizeFilterUrl).
        const safe = KE.pagination.sanitizeFilterUrl(data.url);
        if (!safe) return;
        lastFilterUrl = safe;
        KE.store.setPageContext({ lastFilterUrl: safe });
        if (KE.auth && typeof KE.auth.cacheUsername === "function") {
          KE.auth.cacheUsername(KE.auth.usernameFromFilterUrl(safe));
        }
      }
    });
    observe();
    refresh();
    checkPausedSnapshot();
  }

  // ---------- toolbar: row 1 (count, action select, run, export icon) ----------

  function getActions(): KoboIntegratedActions {
    return KE.integratedActions || { ACTIONS: [], PERMISSIONS: [] };
  }

  function getActionDef(value: string): Action | null {
    const A = getActions();
    const entry = A.ACTIONS.find((a) => a.value === value);
    return entry || null;
  }

  function svgPlayIcon(): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const poly = document.createElementNS(ns, "polygon");
    poly.setAttribute("points", "6 4 20 12 6 20");
    poly.setAttribute("fill", "currentColor");
    poly.setAttribute("stroke", "none");
    svg.appendChild(poly);
    return svg;
  }

  function svgHistoryIcon(): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "10");
    svg.appendChild(circle);
    const poly = document.createElementNS(ns, "polyline");
    poly.setAttribute("points", "12 6 12 12 16 14");
    svg.appendChild(poly);
    return svg;
  }

  function svgStopIcon(): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", "6");
    rect.setAttribute("y", "6");
    rect.setAttribute("width", "12");
    rect.setAttribute("height", "12");
    rect.setAttribute("rx", "1");
    rect.setAttribute("fill", "currentColor");
    rect.setAttribute("stroke", "none");
    svg.appendChild(rect);
    return svg;
  }

  function svgPauseIcon(): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const x of ["6", "14"]) {
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", "5");
      rect.setAttribute("width", "4");
      rect.setAttribute("height", "14");
      rect.setAttribute("rx", "1");
      rect.setAttribute("fill", "currentColor");
      rect.setAttribute("stroke", "none");
      svg.appendChild(rect);
    }
    return svg;
  }

  function buildToolbar(): HTMLElement {
    const A = getActions();
    const block = el("div", { "data-ke-toolbar": "1", class: "ke-actions" });

    // Toolbar buttons: [Settings], [KoboCollect list] and [Run history] before
    // the action selector, then [Run/Stop] after the selects — all styled like
    // Kobo's secondary icon buttons.
    refs.settingsBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon",
      type: "button",
      title: t("Settings"),
      "aria-label": t("Settings"),
      onclick: openSettingsPanel,
    }, [buildIcon("settings", 16)]) as HTMLButtonElement;
    const settingsWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Settings"),
      "aria-label": t("Settings"),
    }, [refs.settingsBtn]);

    refs.collectBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon",
      type: "button",
      title: t("Show KoboCollect form list"),
      "aria-label": t("Show KoboCollect form list"),
      onclick: () => {
        if (KE.collect && typeof KE.collect.openPanel === "function") {
          KE.collect.openPanel();
        } else {
          showDialogInPage(t("KoboCollect list is not available yet."), document.body);
        }
      },
    }, [buildIcon("smartphone", 16)]) as HTMLButtonElement;
    const collectWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("KoboCollect survey list"),
      "aria-label": t("KoboCollect survey list"),
    }, [refs.collectBtn]);

    refs.actionSelect = el("select", { class: "ke-select", title: t("Select a bulk action to run") }) as HTMLSelectElement;
    refs.actionSelect.appendChild(el("option", { value: "", text: t("Select action") }));
    let groupEl: HTMLOptGroupElement | null = null;
    let lastGroup = "";
    for (const a of A.ACTIONS) {
      const g = a.group || "";
      if (!groupEl || lastGroup !== g) {
        lastGroup = g;
        groupEl = el("optgroup", { label: g ? t(g as keyof EnDict) : "" }) as HTMLOptGroupElement;
        refs.actionSelect.appendChild(groupEl);
      }
      const opt = el("option", { value: a.value, text: t(a.label as keyof EnDict) });
      if (a.tip) opt.setAttribute("title", t(a.tip as keyof EnDict));
      groupEl.appendChild(opt);
    }
    refs.actionSelect.addEventListener("change", () => {
      syncFields();
      syncSelection();
    });

    refs.runBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon",
      type: "button",
      disabled: true,
      onclick: onRunClick,
    }, [svgPlayIcon()]) as HTMLButtonElement;
    const runWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Run Action"),
      "aria-label": t("Run Action"),
    }, [refs.runBtn]);
    refs.runWrap = runWrap;

    refs.historyBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon",
      type: "button",
      title: t("Run history and audit log"),
      onclick: () => {
        if (KE.history && typeof KE.history.openPanel === "function") {
          KE.history.openPanel();
        } else {
          showDialogInPage(t("Run history is not available yet."), document.body);
        }
      },
    }, [svgHistoryIcon()]) as HTMLButtonElement;
    const historyWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Run history"),
      "aria-label": t("Run history"),
    }, [refs.historyBtn]);

    refs.sourceSelect = el("select", {
      class: "ke-select",
      title: t("Which projects to run the action on"),
    }) as HTMLSelectElement;
    const selOpt = el("option", { value: "selected", text: t("Selected projects"), title: t("Run on the projects checked on this page") });
    const manOpt = el("option", { value: "manual", text: t("By project UID(s)"), title: t("Run on the project UIDs entered below") });
    const allOpt = el("option", { value: "all", text: t("Entire account"), title: t("Run on all projects in the account, respecting the current list filters") });
    refs.sourceSelect.appendChild(selOpt);
    refs.sourceSelect.appendChild(manOpt);
    refs.sourceSelect.appendChild(allOpt);
    refs.sourceSelect.addEventListener("change", () => {
      syncFields();
      updateScopeLabels();
      updateRunBtn();
    });
    refs.stopBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon ke-stop-btn",
      type: "button",
      onclick: () => getActions().abort(),
    }, [svgStopIcon()]) as HTMLButtonElement;
    const stopWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Stop / Cancel"),
      "aria-label": t("Stop / Cancel"),
      style: "display:none;",
    }, [refs.stopBtn]);
    refs.stopWrap = stopWrap;

    actionDropdown = createSelectDropdown(refs.actionSelect!, actionIconResolver);
    scopeDropdown = createSelectDropdown(refs.sourceSelect!, SCOPE_ICON_KEYS);

    // Pause / Resume between the scope selector and Run/Stop. Same button
    // shape as Run but orange-on-light-orange; only visible while a run is
    // active. Its neighbor ("Download progress report") appears only while the
    // run is parked, saving the CSV of what completed so far.
    refs.pauseBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon ke-pause-btn",
      type: "button",
      title: t("Pause run"),
      onclick: onPauseClick,
    }, [svgPauseIcon()]) as HTMLButtonElement;
    refs.pauseDlBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon",
      type: "button",
      title: t("Download progress report"),
      onclick: downloadPartialReport,
    }, [buildIcon("download", 16)]) as HTMLButtonElement;
    const pauseDlWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Download progress report"),
      "aria-label": t("Download progress report"),
    }, [refs.pauseDlBtn]);
    refs.pauseDlWrap = pauseDlWrap;
    const pauseBtnWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Pause run"),
      "aria-label": t("Pause run"),
    }, [refs.pauseBtn]);
    refs.pauseTipWrap = pauseBtnWrap;
    const pauseWrap = el("span", {
      "aria-label": t("Pause / Resume"),
      style: "display:none; align-items:center; gap:6px;",
    }, [pauseDlWrap, pauseBtnWrap]);
    refs.pauseWrap = pauseWrap;

    // Idle rescue button: shown only when a valid paused-run snapshot exists
    // (i.e. a run was paused and the page reloaded), so it can be resumed with
    // its saved UID list + progress report instead of restarted from scratch.
    refs.resumeBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon",
      type: "button",
      title: t("Resume paused run"),
      onclick: onResumeClick,
    }, [svgPlayIcon()]) as HTMLButtonElement;
    const resumeWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Resume paused run"),
      "aria-label": t("Resume paused run"),
      style: "display:none;",
    }, [refs.resumeBtn]);
    refs.resumeWrap = resumeWrap;

    block.appendChild(settingsWrap);
    block.appendChild(el("span", { class: "ke-sep", "aria-hidden": "true" }));
    block.appendChild(collectWrap);
    block.appendChild(historyWrap);
    block.appendChild(el("span", { class: "ke-sep", "aria-hidden": "true" }));
    block.appendChild(actionDropdown.wrap);
    block.appendChild(scopeDropdown.wrap);
    block.appendChild(resumeWrap);
    block.appendChild(pauseWrap);
    block.appendChild(runWrap);
    block.appendChild(stopWrap);
    block.appendChild(el("span", { class: "ke-sep", "aria-hidden": "true" }));
    return block;
  }

  function ensureToolbar(): void {
    const root = findActionsRoot();
    if (!root) return;
    const existing = root.querySelector("[data-ke-toolbar]");
    if (existing && existing.isConnected) {
      refs.toolbar = existing as HTMLElement;
      return;
    }
    if (refs.toolbar) {
      if (!refs.toolbar.isConnected || refs.toolbar.parentElement !== root) {
        root.insertBefore(refs.toolbar, root.firstChild);
      }
      return;
    }
    const block = buildToolbar();
    root.insertBefore(block, root.firstChild);
    refs.toolbar = block;
    syncSelection();
  }

  // ---------- settings panel ----------

  /** A language's display name in `locale` (falls back to the bare code). */
  function displayName(locale: string, code: string): string {
    try {
      const names = new Intl.DisplayNames([locale], { type: "language" });
      return names.of(code) || code;
    } catch (e) {
      return code;
    }
  }

  /** Selector label: English name plus the language's own name, e.g.
   *  "English (English)", "French (Français)", "Arabic (العربية)". Both halves
   *  come from Intl.DisplayNames, so a new locale file needs no config here;
   *  the native name is capitalized because it heads a list item. */
  function languageLabel(code: string): string {
    const native = displayName(code, code);
    const own = native.charAt(0).toUpperCase() + native.slice(1);
    return `${displayName("en", code)} (${own})`;
  }

  /** Modal settings panel. One section per setting; today that is just the
   *  interface language, fed by the locales each locale module registered. */
  function openSettingsPanel(): void {
    const overlay = el("div", { class: "ke-alert-overlay" });
    const dialog = el("div", { class: "ke-alert-dialog ke-tpl-dialog ke-collect-dialog" });

    let closed = false;
    function close(): void {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onEsc);
      overlay.remove();
    }
    function onEsc(e: KeyboardEvent): void {
      if (e.key === "Escape") close();
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    dialog.appendChild(
      el("div", { class: "ke-collect-header" }, [
        el("div", { class: "ke-alert-title", text: t("Settings") }),
        el("button", {
          type: "button",
          class: "ke-collect-close",
          title: t("Close"),
          "aria-label": t("Close"),
          onclick: close,
        }, [el("span", { text: "\u2715" })]),
      ])
    );

    dialog.appendChild(
      el("p", {
        class: "ke-alert-desc",
        text: t("Updates appear after a page refresh."),
      })
    );

    const body = el("div", { class: "ke-tpl-body ke-settings-body" });
    const langRow = el("div", { class: "ke-row" });
    const langSelect = el("select", {
      class: "ke-input ke-settings-lang",
      title: t("Interface language"),
    }) as HTMLSelectElement;
    for (const code of KE.i18n.locales()) {
      langSelect.appendChild(el("option", { value: code, text: languageLabel(code) }));
    }
    langSelect.value = KE.i18n.getLang();
    langRow.appendChild(el("label", { class: "ke-field-label", text: t("Language:") }));
    langRow.appendChild(langSelect);
    body.appendChild(langRow);
    dialog.appendChild(body);

    langSelect.addEventListener("change", () => {
      const next = langSelect.value;
      if (!next || running) return;
      // Persist the choice only. The page stays as it is — every surface
      // renders its strings when it is built, so the new language shows up on
      // the next manual refresh rather than yanking the page out from under a
      // run that may be in flight.
      KE.i18n.setLang(next);
    });

    overlay.appendChild(dialog);
    document.addEventListener("keydown", onEsc);
    document.body.appendChild(overlay);
  }

  // ---------- toolbar: row 2 (username / permission + download report) ----------

  function ensureRow2(): void {
    const host = findActionsHost();
    if (!host) return;
    let row = host.querySelector("[data-ke-toolbar-row2]");
    let manualRow = host.querySelector("[data-ke-toolbar-manual]");
    if (row && row.isConnected && manualRow && manualRow.isConnected) {
      refs.row2 = row as HTMLElement;
      refs.manualRow = manualRow as HTMLElement;
      return;
    }
    if (refs.row2) {
      if (!refs.row2.isConnected || refs.row2.parentElement !== host) {
        host.appendChild(refs.row2);
      }
      if (refs.manualRow) {
        if (!refs.manualRow.isConnected || refs.manualRow.parentElement !== host) {
          host.appendChild(refs.manualRow);
        }
      }
      if (host.style.flexWrap !== "wrap") host.style.flexWrap = "wrap";
      if (refs.row2.isConnected && refs.manualRow && refs.manualRow.isConnected) {
        return;
      }
    }
    if (row) row.remove();
    if (manualRow) manualRow.remove();

    row = el("div", { "data-ke-toolbar-row2": "1", class: "ke-actions-row2" });

    refs.usernameRow = el("div", { class: "ke-row ke-user-row" });
    const userLabel = el("label", { class: "ke-field-label", text: t("User:") });
    refs.usernameInput = el("input", { type: "text", class: "ke-input", placeholder: t("Username") }) as HTMLInputElement;
    refs.usernameInput.addEventListener("input", updateRunBtn);
    refs.usernameRow.appendChild(userLabel);
    refs.usernameRow.appendChild(refs.usernameInput);

    refs.usersRow = el("div", { class: "ke-row ke-users-row" });
    const usersLabel = el("label", { class: "ke-field-label", text: t("Users:") });
    refs.usersInput = el("input", {
      type: "text",
      class: "ke-input",
      placeholder: t("Comma, space or line separated usernames"),
      title: t("Grant the permission to every listed user"),
    }) as HTMLInputElement;
    refs.usersInput.addEventListener("input", updateRunBtn);
    refs.permLabel = el("label", { class: "ke-field-label", text: t("Permission:") });
    refs.permSelect = el("select", { class: "ke-input ke-perm", title: t("Permission") }) as HTMLSelectElement;
    for (const p of getActions().PERMISSIONS) {
      refs.permSelect.appendChild(el("option", { value: p.code, text: t(p.label as keyof EnDict) }));
    }
    refs.usersRow.appendChild(usersLabel);
    refs.usersRow.appendChild(refs.usersInput);
    refs.usersRow.appendChild(refs.permLabel);
    refs.usersRow.appendChild(refs.permSelect);

    refs.renameRow = el("div", { class: "ke-row" });
    refs.prefixInput = el("input", {
      type: "text",
      class: "ke-input",
      placeholder: t('e.g. "SY | "'),
    }) as HTMLInputElement;
    refs.suffixInput = el("input", {
      type: "text",
      class: "ke-input",
      placeholder: t('e.g. " [ARCHIVED]"'),
    }) as HTMLInputElement;
    for (const input of [refs.prefixInput!, refs.suffixInput!]) {
      input.addEventListener("input", updateRunBtn);
    }
    const preField = el("div", { class: "ke-field" }, [
      el("label", { class: "ke-field-label", text: t("Prefix:") }),
      refs.prefixInput,
    ]);
    const sufField = el("div", { class: "ke-field" }, [
      el("label", { class: "ke-field-label", text: t("Suffix:") }),
      refs.suffixInput,
    ]);
    refs.renameRow.appendChild(preField);
    refs.renameRow.appendChild(sufField);

    refs.replaceRow = el("div", { class: "ke-row" });
    refs.findInput = el("input", { type: "text", class: "ke-input", placeholder: t("Text to find") }) as HTMLInputElement;
    refs.replaceInput = el("input", {
      type: "text",
      class: "ke-input",
      placeholder: t("Leave empty to remove"),
    }) as HTMLInputElement;
    for (const input of [refs.findInput!, refs.replaceInput!]) {
      input.addEventListener("input", updateRunBtn);
    }
    const findField = el("div", { class: "ke-field" }, [
      el("label", { class: "ke-field-label", text: t("Find:") }),
      refs.findInput,
    ]);
    const repField = el("div", { class: "ke-field" }, [
      el("label", { class: "ke-field-label", text: t("Replace with:") }),
      refs.replaceInput,
    ]);
    refs.replaceRow.appendChild(findField);
    refs.replaceRow.appendChild(repField);

    refs.descriptionRow = el("div", { class: "ke-row ke-description-row" });
    const descLabel = el("label", { class: "ke-field-label", text: t("Description:") });
    refs.descriptionInput = el("textarea", {
      class: "ke-input ke-description-input",
      rows: 1,
      placeholder: t("New description (replaces the current description)"),
      spellcheck: "false",
    }) as HTMLTextAreaElement;
    refs.descriptionInput.addEventListener("input", updateRunBtn);
    refs.descriptionRow.appendChild(descLabel);
    refs.descriptionRow.appendChild(refs.descriptionInput);

    refs.tagsRow = el("div", { class: "ke-row ke-tags-row" });
    const tagsLabel = el("label", { class: "ke-field-label", text: t("Tags:") });
    refs.tagsModeSelect = el("select", {
      class: "ke-select ke-tags-mode",
      title: t("Append to, replace, or remove tags on selected projects"),
    }) as HTMLSelectElement;
    refs.tagsModeSelect.appendChild(el("option", { value: "append", text: t("Append") }));
    refs.tagsModeSelect.appendChild(el("option", { value: "replace", text: t("Replace") }));
    refs.tagsModeSelect.appendChild(el("option", { value: "remove", text: t("Remove") }));
    refs.tagsModeSelect.addEventListener("change", updateRunBtn);
    refs.tagsInput = el("input", {
      type: "text",
      class: "ke-input",
      placeholder: t("Comma or line separated, e.g. meal, syria, cash. Empty in Replace mode removes all tags."),
    }) as HTMLInputElement;
    refs.tagsInput.addEventListener("input", updateRunBtn);
    refs.tagsRow.appendChild(tagsLabel);
    refs.tagsRow.appendChild(refs.tagsModeSelect);
    refs.tagsRow.appendChild(refs.tagsInput);

    refs.sourceProjectRow = el("div", { class: "ke-row ke-source-project-row" });
    const sourceLabel = el("label", { class: "ke-field-label", text: t("Source project:") });
    refs.sourceProjectInput = el("input", {
      type: "text",
      class: "ke-input",
      placeholder: t("Source project UID or form URL"),
      title: t("Permissions are copied from this project"),
    }) as HTMLInputElement;
    refs.sourceProjectInput.addEventListener("input", onSourceProjectInput);
    refs.sourceProjectBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon",
      type: "button",
      onclick: onUseSelectedSource,
    }, [buildIcon("target", 16)]) as HTMLButtonElement;
    const sourceBtnWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Use the UID of the single selected project"),
      "aria-label": t("Use the UID of the single selected project"),
    }, [refs.sourceProjectBtn]);
    refs.sourceProjectName = el("span", {
      class: "ke-source-project-name",
      style: "display:none;",
    });
    refs.sourceProjectRow.appendChild(sourceLabel);
    refs.sourceProjectRow.appendChild(refs.sourceProjectInput);
    refs.sourceProjectRow.appendChild(refs.sourceProjectName);
    refs.sourceProjectRow.appendChild(sourceBtnWrap);

    refs.templateRow = el("div", { class: "ke-row ke-template-row" });
    const templateLabel = el("label", { class: "ke-field-label", text: t("Template:") });
    refs.templateSelect = el("select", {
      class: "ke-input ke-template-select",
      title: t("Saved permission template to apply"),
    }) as HTMLSelectElement;
    refs.templateSelect.addEventListener("change", updateRunBtn);
    refs.templateBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon",
      type: "button",
      onclick: openTemplatesManager,
    }, [buildIcon("settings", 16)]) as HTMLButtonElement;
    const templateBtnWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Manage permission templates"),
      "aria-label": t("Manage permission templates"),
    }, [refs.templateBtn]);
    refs.templateRow.appendChild(templateLabel);
    refs.templateRow.appendChild(refs.templateSelect);
    refs.templateFromProjectBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon",
      type: "button",
      onclick: onCreateTemplateFromProject,
    }, [buildIcon("target", 16)]) as HTMLButtonElement;
    const tplFromProjectWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Create template from the selected project"),
      "aria-label": t("Create template from the selected project"),
    }, [refs.templateFromProjectBtn]);
    refs.templateRow.appendChild(tplFromProjectWrap);
    refs.templateRow.appendChild(templateBtnWrap);
    refreshTemplates();

    // ---- cross-account transfer row -----------------------------------
    // Shown when the transfer action is selected. Layout is
    // [scope dropdown] .......... [destination text] [gear]:
    // the scope picker leads on the left, while the destination identity and
    // its settings button are grouped flush right, which is where the user
    // looks after a transfer. The actual destination credential lives in the
    // destination store, never in the DOM or the run request.
    refs.transferRow = el("div", { class: "ke-row ke-transfer-row" });
    refs.transferSummary = el("span", { class: "ke-transfer-summary is-empty", text: t("Not set") });
    refs.transferBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon",
      type: "button",
      onclick: openTransferPanel,
    }, [buildIcon("settings", 16)]) as HTMLButtonElement;
    const transferBtnWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Transfer settings"),
      "aria-label": t("Transfer settings"),
    }, [refs.transferBtn]);
    refs.transferScope = el("select", {
      class: "ke-input ke-transfer-scope",
      title: t("Choose what to copy to the destination account."),
    }) as HTMLSelectElement;
    refs.transferScope.appendChild(el("option", { value: TRANSFER_SCOPE_FORMS, text: t("Form only") }));
    refs.transferScope.appendChild(el("option", { value: TRANSFER_SCOPE_BOTH, text: t("Form + Submissions") }));
    // Form + submissions is the default. "Form only" looked like the safe
    // default but silently leaves the data behind, which is the half of a
    // migration people usually forget they wanted; the smaller choice is now the
    // one you have to go and pick.
    refs.transferScope.value = TRANSFER_SCOPE_BOTH;
    refs.transferScope.addEventListener("change", updateRunBtn);
    refs.transferRow.appendChild(refs.transferScope);
    refs.transferRow.appendChild(refs.transferSummary);
    refs.transferRow.appendChild(transferBtnWrap);
    // A destination configured in a previous tab/session must be reflected
    // before the first paint, so seed the summary synchronously and re-check
    // the session token asynchronously (isReady() is async by design).
    KE.transfer.subscribe(refreshTransferRow);

    row.appendChild(refs.usernameRow);
    row.appendChild(refs.usersRow);
    row.appendChild(refs.renameRow);
    row.appendChild(refs.replaceRow);
    row.appendChild(refs.descriptionRow);
    row.appendChild(refs.tagsRow);
    row.appendChild(refs.sourceProjectRow);
    row.appendChild(refs.templateRow);
    row.appendChild(refs.transferRow);
    countryPicker = createTagPicker({
      multi: true,
      label: t("Country:"),
      noun: "country",
      placeholder: t("Type to add countries..."),
      title: t("Type to search countries and click a suggestion to add it"),
      extractChoices: (env) =>
        env && Array.isArray(env.country_choices) ? env.country_choices : [],
    });
    row.appendChild(countryPicker.row);
    sectorPicker = createSelectPicker({
      label: t("Sector:"),
      noun: "sector",
      placeholder: t("Select a sector..."),
      title: t("Select the project sector"),
      extractChoices: (env) =>
        env && Array.isArray(env.sector_choices) ? env.sector_choices : [],
    });
    row.appendChild(sectorPicker.row);

    manualRow = el("div", { "data-ke-toolbar-manual": "1", class: "ke-actions-manual" });
    const label = el("label", { class: "ke-field-label", text: t("Project UID(s):") });
    refs.manualInput = el("textarea", {
      class: "ke-input",
      rows: 1,
      placeholder: t("Comma or line separated UIDs, e.g. aBCdEf1234, xYZqWs4567. Full form URLs are accepted."),
    }) as HTMLTextAreaElement;
    refs.manualInput.addEventListener("input", () => {
      updateScopeLabels();
      updateRunBtn();
    });
    manualRow.appendChild(label);
    manualRow.appendChild(refs.manualInput);

    host.appendChild(row);
    host.appendChild(manualRow);
    // Force the rows onto their own lines even if the host is a flex row.
    if (host.style.flexWrap !== "wrap") host.style.flexWrap = "wrap";
    refs.row2 = row as HTMLElement;
    refs.manualRow = manualRow as HTMLElement;
    syncFields();
  }

  function syncFields(): void {
    updateSourceEnabled();
    const action = refs.actionSelect ? refs.actionSelect.value : "";
    const def = action ? getActionDef(action) : null;
    const ui = (def && def.uiFields) || [];
    const has = (k: string) => ui.indexOf(k) !== -1;
    const showRow = has("username") || has("permission") || has("users");
    const showRenameRow = has("prefix") || has("suffix");
    const showDescriptionRow = has("description");
    const showReplaceRow = has("find") || has("replace");
    const showCountryRow = has("countries");
    const showSectorRow = has("sectors");
    const showTagsRow = has("tags");
    const showSourceRow = has("sourceProject");
    const showTemplateRow = has("template");
    const showTransferRow = has("transfer");
    const source = refs.sourceSelect ? refs.sourceSelect.value : "selected";
    if (refs.row2) refs.row2.style.display = showRow || showRenameRow || showDescriptionRow || showReplaceRow || showCountryRow || showSectorRow || showTagsRow || showSourceRow || showTemplateRow || showTransferRow ? "" : "none";
    if (refs.manualRow) refs.manualRow.style.display = source === "manual" && action ? "" : "none";
    const showPerm = has("permission");
    if (refs.usernameRow) refs.usernameRow.style.display = has("username") ? "" : "none";
    if (refs.usersRow) refs.usersRow.style.display = has("users") ? "" : "none";
    if (refs.permLabel) refs.permLabel.style.display = showPerm ? "" : "none";
    if (refs.permSelect) refs.permSelect.style.display = showPerm ? "" : "none";
    if (refs.renameRow) refs.renameRow.style.display = showRenameRow ? "" : "none";
    if (refs.replaceRow) refs.replaceRow.style.display = showReplaceRow ? "" : "none";
    if (refs.descriptionRow) refs.descriptionRow.style.display = showDescriptionRow ? "" : "none";
    if (refs.tagsRow) refs.tagsRow.style.display = showTagsRow ? "" : "none";
    if (refs.sourceProjectRow) refs.sourceProjectRow.style.display = showSourceRow ? "" : "none";
    if (refs.templateRow) refs.templateRow.style.display = showTemplateRow ? "" : "none";
    if (refs.transferRow) refs.transferRow.style.display = showTransferRow ? "" : "none";
    if (showTransferRow) refreshTransferRow();
    if (showTemplateRow) refreshTemplates();
    if (countryPicker) countryPicker.row.style.display = showCountryRow ? "" : "none";
    if (sectorPicker) sectorPicker.row.style.display = showSectorRow ? "" : "none";
    if (showCountryRow && countryPicker) countryPicker.ensureLoaded();
    if (showSectorRow && sectorPicker) sectorPicker.ensureLoaded();
    updateSourceEnabled();
  }

  // ---------- shared environment data (country + sector choices) ----------

  async function ensureEnvData(): Promise<EnvironmentResponse> {
    if (envDataCache) return envDataCache;
    if (envDataLoading) return envDataLoading;
    envDataLoading = (async () => {
      try {
        const env = await KE.apiEnvironment.fetchEnvironment();
        envDataCache = env;
        return env;
      } finally {
        envDataLoading = null;
      }
    })();
    return envDataLoading;
  }

  // ---------- reusable tag/chip picker (country = multi, sector = single) ----------

  interface TagPickerOptions {
    multi?: boolean;
    label: string;
    noun: string;
    placeholder: string;
    title: string;
    extractChoices: (env: EnvironmentResponse | null) => Array<Array<string>>;
  }

  interface TagPickerHandle {
    row: HTMLElement;
    ensureLoaded(): Promise<void>;
    hasSelection(): boolean;
    selected(): Array<{ value: string; label: string }>;
    setDisabled(d: boolean): void;
  }

  interface SelectPickerOptions {
    label: string;
    noun: string;
    placeholder: string;
    title: string;
    extractChoices: (env: EnvironmentResponse | null) => Array<Array<string>>;
  }

  interface SelectPickerHandle {
    row: HTMLElement;
    ensureLoaded(): Promise<void>;
    hasSelection(): boolean;
    selected(): Array<{ value: string; label: string }>;
    setDisabled(d: boolean): void;
  }

  interface SelectDropdownHandle {
    wrap: HTMLElement;
    update(): void;
    closeMenu(): void;
  }

  function createTagPicker(opts: TagPickerOptions): TagPickerHandle {
    const state: {
      choices: Array<Array<string>>;
      selected: Record<string, { value: string; label: string }>;
      activeIndex: number;
      loaded: boolean;
      loading: boolean;
    } = {
      choices: [],
      selected: {},
      activeIndex: -1,
      loaded: false,
      loading: false,
    };

    const row = el("div", { class: "ke-row ke-country-row" });
    const labelEl = el("label", { class: "ke-field-label", text: opts.label });
    const tagsInput = el("div", { class: "ke-tags-input", title: opts.title });
    const tagText = el("input", {
      type: "text",
      class: "ke-tags-text",
      placeholder: t("Loading..."),
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const dropdown = el("div", { class: "ke-tags-dropdown", style: "display:none;" });
    tagsInput.appendChild(tagText);
    tagsInput.appendChild(dropdown);
    row.appendChild(labelEl);
    row.appendChild(tagsInput);

    function filtered(): Array<Array<string>> {
      const q = tagText.value.trim().toLowerCase();
      return state.choices.filter((pair) => {
        const code = pair && pair[0];
        const name = pair && pair[1];
        if (!code || !name) return false;
        if (state.selected[code]) return false;
        return !q || name.toLowerCase().includes(q);
      });
    }

    function renderTags(): void {
      tagsInput.querySelectorAll(".ke-tag").forEach((c) => c.remove());
      for (const code of Object.keys(state.selected)) {
        const item = state.selected[code];
        const chip = el("span", { class: "ke-tag", text: item.label });
        const x = el("button", {
          type: "button",
          class: "ke-tag-x",
          "aria-label": t("Remove {label}", { label: item.label }),
          text: "\u00D7",
        });
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          remove(code);
        });
        chip.appendChild(x);
        tagsInput.insertBefore(chip, tagText);
      }
    }

    function renderDropdown(): void {
      const list = filtered();
      const focused = document.activeElement === tagText;
      if (!focused || list.length === 0) {
        dropdown.style.display = "none";
        return;
      }
      if (state.activeIndex < 0 || state.activeIndex >= list.length) state.activeIndex = 0;
      dropdown.innerHTML = "";
      for (let i = 0; i < list.length; i++) {
        const code = list[i][0];
        const name = list[i][1];
        const opt = el("div", {
          class: "ke-tags-option" + (i === state.activeIndex ? " ke-active" : ""),
          text: name,
        });
        opt.addEventListener("mousedown", (e) => {
          e.preventDefault();
          add(code, name);
        });
        dropdown.appendChild(opt);
      }
      dropdown.style.display = "";
    }

    function add(code: string, name: string): void {
      if (!code || !name) return;
      if (opts.multi === false) state.selected = {};
      if (!state.selected[code]) {
        state.selected[code] = { value: code, label: name };
        renderTags();
      }
      tagText.value = "";
      state.activeIndex = -1;
      renderDropdown();
      updateRunBtn();
    }

    function remove(code: string): void {
      delete state.selected[code];
      renderTags();
      state.activeIndex = -1;
      renderDropdown();
      updateRunBtn();
    }

    function scrollActive(): void {
      const active = dropdown.querySelector(".ke-active");
      if (active) active.scrollIntoView({ block: "nearest" });
    }

    function onKeydown(e: KeyboardEvent): void {
      const list = filtered();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (list.length) {
          state.activeIndex = state.activeIndex < list.length - 1 ? state.activeIndex + 1 : 0;
          renderDropdown();
          scrollActive();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (list.length) {
          state.activeIndex = state.activeIndex > 0 ? state.activeIndex - 1 : list.length - 1;
          renderDropdown();
          scrollActive();
        }
      } else if (e.key === "Enter") {
        if (list.length && state.activeIndex >= 0) {
          e.preventDefault();
          add(list[state.activeIndex][0], list[state.activeIndex][1]);
        }
      } else if (e.key === "Escape") {
        dropdown.style.display = "none";
      } else if (e.key === "Backspace" && !tagText.value) {
        const codes = Object.keys(state.selected);
        if (codes.length) remove(codes[codes.length - 1]);
      }
    }

    tagsInput.addEventListener("click", (e) => {
      const t = e.target;
      if (t !== dropdown && !(t instanceof Node && dropdown.contains(t))) tagText.focus();
    });
    tagText.addEventListener("input", () => {
      state.activeIndex = filtered().length ? 0 : -1;
      renderDropdown();
    });
    tagText.addEventListener("focus", () => {
      state.activeIndex = filtered().length ? 0 : -1;
      renderDropdown();
    });
    tagText.addEventListener("keydown", onKeydown);
    document.addEventListener("mousedown", (e) => {
      const t = e.target;
      if (!(t instanceof Node && tagsInput.contains(t))) dropdown.style.display = "none";
    });

    return {
      row,
      ensureLoaded: async () => {
        if (state.loaded || state.loading) return;
        state.loading = true;
        try {
          const env = await ensureEnvData();
          state.choices = opts.extractChoices(env) || [];
          state.loaded = true;
          tagText.placeholder = opts.placeholder;
          if (!state.choices.length) {
            showDialogInPage(t("Received no {noun} list from the server.", { noun: opts.noun }), document.body);
          }
        } catch (e) {
          tagText.placeholder = t("Failed to load {noun}", { noun: opts.noun });
          showDialogInPage(t("Could not load the {noun} list: {error}", {
            noun: opts.noun,
            error: ((e as KoboRecord).detail as string) || ((e as Error).message),
          }), document.body);
        } finally {
          state.loading = false;
        }
      },
      hasSelection: () => Object.keys(state.selected).length > 0,
      selected: () => Object.values(state.selected),
      setDisabled: (d: boolean) => {
        tagText.disabled = d;
      },
    };
  }

  // ---------- single-select dropdown picker (sector) ----------

  function createSelectPicker(opts: SelectPickerOptions): SelectPickerHandle {
    const state: { choices: Array<Array<string>>; loaded: boolean; loading: boolean } = { choices: [], loaded: false, loading: false };
    const row = el("div", { class: "ke-row ke-country-row" });
    const labelEl = el("label", { class: "ke-field-label", text: opts.label });
    const selectEl = el("select", {
      class: "ke-select ke-sector-select",
      title: opts.title,
    }) as HTMLSelectElement;
    const placeholderOpt = el("option", { value: "", text: opts.placeholder });
    selectEl.appendChild(placeholderOpt);
    selectEl.addEventListener("change", () => updateRunBtn());
    row.appendChild(labelEl);
    row.appendChild(selectEl);

    function populate(): void {
      selectEl.innerHTML = "";
      const ph = el("option", { value: "", text: state.choices.length ? opts.placeholder : t("No sectors available") });
      (ph as HTMLOptionElement).selected = true;
      selectEl.appendChild(ph);
      for (const pair of state.choices) {
        const code = pair && pair[0];
        const name = pair && pair[1];
        if (!code || !name) continue;
        selectEl.appendChild(el("option", { value: code, text: name }));
      }
    }

    return {
      row,
      ensureLoaded: async () => {
        if (state.loaded || state.loading) return;
        state.loading = true;
        try {
          const env = await ensureEnvData();
          state.choices = opts.extractChoices(env) || [];
          state.loaded = true;
          populate();
          if (!state.choices.length) {
            showDialogInPage(t("Received no {noun} list from the server.", { noun: opts.noun }), document.body);
          }
        } catch (e) {
          state.choices = [];
          populate();
          showDialogInPage(t("Could not load the {noun} list: {error}", {
            noun: opts.noun,
            error: ((e as KoboRecord).detail as string) || ((e as Error).message),
          }), document.body);
        } finally {
          state.loading = false;
        }
      },
      hasSelection: () => selectEl.selectedIndex > 0,
      selected: () => {
        const idx = selectEl.selectedIndex;
        if (idx <= 0) return [];
        const opt = selectEl.options[idx];
        return [{ value: opt.value, label: opt.textContent as string }];
      },
      setDisabled: (d: boolean) => {
        selectEl.disabled = d;
      },
    };
  }

  function updateSourceEnabled(): void {
    if (!refs.sourceSelect) return;
    refs.sourceSelect.disabled = running;
  }

  // ---------- permission template manager ----------

  /**
   * Builds template grants from a project's collaborator rows.
   *
   * The API returns one row per IMPLIED permission, so a user with "Manage
   * project" arrives as all eight rows. Kobo's share UI only ever stores the
   * one base code and expands it server-side, so each user's rows are grouped
   * and reduced back to that base code here — otherwise the template would keep
   * one grant per row and collapse to an arbitrary permission on save.
   */
  function grantsFromAssignments(assignments: PermissionAssignment[]): PermissionTemplateGrant[] {
    return reduceGrantsByUser(
      (assignments || []).map((a) => ({
        username: String((a && a.username) || ""),
        codes: [String((a && a.permissionCode) || "")],
      }))
    );
  }

  function permOptionEl(code: string, label: string, selected: boolean): HTMLOptionElement {
    const opt = el("option", { value: code, text: label }) as HTMLOptionElement;
    opt.selected = selected;
    return opt;
  }

  /**
   * Reduces flat (user, permission) rows into ONE grant per user holding the
   * single base permission code that user has. The permission-assignment API
   * answers with one row per IMPLIED permission, so a user with "Manage
   * project" arrives as all eight rows; keeping the first one (as this used to)
   * silently dropped the rest. `valid` drops unknown codes (JSON import).
   */
  function reduceGrantsByUser(
    items: Array<{ username: string; codes: string[] }>,
    valid?: (code: string) => boolean
  ): PermissionTemplateGrant[] {
    const order: string[] = [];
    const byUser = new Map<string, string[]>();
    for (const item of items) {
      const username = String((item && item.username) || "").trim();
      if (!username) continue;
      for (const raw of (item && item.codes) || []) {
        const code = String(raw || "").trim();
        if (!code || (valid && !valid(code))) continue;
        let list = byUser.get(username);
        if (!list) {
          list = [];
          byUser.set(username, list);
          order.push(username);
        }
        if (list.indexOf(code) === -1) list.push(code);
      }
    }
    const out: PermissionTemplateGrant[] = [];
    for (const username of order) {
      for (const permission of KE.actionRegistry.reduceToBasePermissions(byUser.get(username) as string[])) {
        out.push({ username, permission });
      }
    }
    return out;
  }

  /** Permission select options for one grant row (keeps the current choice). */
  function permSelectOptions(selected: string): HTMLOptionElement[] {
    const perms = getActions().PERMISSIONS;
    const opts = perms.map((p) => permOptionEl(p.code, t(p.label as keyof EnDict), p.code === selected));
    if (selected && !perms.some((p) => p.code === selected)) {
      opts.push(permOptionEl(selected, selected, true));
    }
    return opts;
  }

  /**
   * Permission template manager. Modal overlay listing every saved template as
   * a collapsed card showing only its title with an expand arrow; expanding
   * reveals the per-user permission grants plus "Add user". Edits auto-save
   * through KE.templates (debounced); per-username existence is checked live.
   */
  function openTemplatesManager(preset?: PermissionAssignment[] | null): void {
    const overlay = el("div", { class: "ke-alert-overlay" });
    const dialog = el("div", { class: "ke-alert-dialog ke-tpl-dialog" });
    dialog.appendChild(el("div", { class: "ke-alert-title", text: t("Permission templates") }));
    dialog.appendChild(
      el("p", {
        class: "ke-alert-desc",
        text: t("Save reusable user–permission sets, then apply them to many projects at once."),
      })
    );

    const body = el("div", { class: "ke-tpl-body" });
    const list = el("div", { class: "ke-tpl-list" });
    const empty = el("div", { class: "ke-tpl-empty", text: t("No templates yet.") });
    body.appendChild(list);
    body.appendChild(empty);
    dialog.appendChild(body);

    const exportTemplates = (): void => {
      const exportable = KE.templates.list().map((t) => ({ name: t.name, grants: t.grants }));
      void KE.exportSvc.makeFilename("ke-permission-templates", "json").then((fn) => {
        KE.exportSvc.download(fn, JSON.stringify({ version: 1, templates: exportable }, null, 2), "application/json;charset=utf-8;");
      });
    };

    const importTemplates = (): void => {
      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = ".json,application/json";
      picker.style.display = "none";
      picker.onchange = () => {
        const file = picker.files && picker.files[0];
        picker.remove();
        if (file) applyImportedFile(file);
      };
      document.body.appendChild(picker);
      picker.click();
    };

    const applyImportedFile = (file: File): void => {
      const reader = new FileReader();
      reader.onload = () => {
        const validPerms = new Set(getActions().PERMISSIONS.map((p) => p.code));
        let imported = 0;
        let rejected = 0;
        try {
          const parsed = JSON.parse(String(reader.result || ""));
          const raw = Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === "object" && Array.isArray((parsed as KoboRecord).templates)
              ? ((parsed as KoboRecord).templates as unknown[])
              : [parsed];
          for (const item of raw) {
            if (!item || typeof item !== "object") continue;
            const rec = item as KoboRecord;
            const name = String(rec.name || "").trim() || t("New template");
            const items: Array<{ username: string; codes: string[] }> = [];
            if (Array.isArray(rec.grants)) {
              for (const g of rec.grants) {
                if (!g || typeof g !== "object") continue;
                const row = g as { username?: unknown; permission?: unknown; permissions?: unknown };
                const username = String(row.username || "").trim();
                // Tolerates both shapes on disk: the current single `permission`
                // and a flat list of the implied rows an older export carried.
                const codes: string[] = [];
                if (Array.isArray(row.permissions)) {
                  for (const c of row.permissions) codes.push(String((c as unknown) || ""));
                }
                if (row.permission) codes.push(String(row.permission));
                if (username && codes.length) items.push({ username, codes });
              }
            }
            const grants = reduceGrantsByUser(items, (code) => validPerms.has(code));
            if (!grants.length) {
              rejected++;
              continue;
            }
            const created = KE.templates.create(name);
            KE.templates.save({
              id: created.id,
              name: created.name,
              grants,
              updatedAt: Date.now(),
            });
            imported++;
          }
        } catch (e) {
          showToast({ type: "warning", title: t("Import failed"), description: t("The selected file is not a valid templates JSON.") });
          return;
        }
        if (!imported) {
          showToast({
            type: "warning",
            title: t("Nothing to import"),
            description: t("No valid templates were found in the selected file."),
          });
          return;
        }
        flushAll();
        list.innerHTML = "";
        for (const tpl of KE.templates.list()) addCard(tpl);
        empty.style.display = list.querySelector(".ke-tpl-card") ? "none" : "";
        refreshTemplates();
        const note = rejected
          ? t("Rejected {count} (no valid permissions).", { count: tP("count-templates", rejected) })
          : "";
        showToast({
          type: "success",
          title: t("Templates imported"),
          description: note
            ? t("Imported {count}. {note}", { count: imported, note })
            : t("Imported {count}.", { count: tP("count-templates", imported) }),
        });
      };
      reader.readAsText(file);
    };

    // Drag & drop a JSON file anywhere in the manager to import it.
    dialog.addEventListener("dragover", (e) => {
      e.preventDefault();
      dialog.classList.add("ke-tpl-drop");
    });
    dialog.addEventListener("dragleave", () => dialog.classList.remove("ke-tpl-drop"));
    dialog.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dialog.classList.remove("ke-tpl-drop");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) applyImportedFile(file);
    });

    const top = el("div", { class: "ke-tpl-top" }, [
      el("div", { class: "ke-tpl-top-actions" }, [
        el("button", {
          class: "ke-alert-btn is-secondary",
          type: "button",
          onclick: importTemplates,
        }, [el("span", { text: t("Import") })]),
        el("button", {
          class: "ke-alert-btn is-secondary",
          type: "button",
          onclick: exportTemplates,
        }, [el("span", { text: t("Export") })]),
      ]),
      el("button", {
        class: "ke-alert-btn is-secondary",
        type: "button",
        onclick: () => addCard(),
      }, [el("span", { text: t("+ New template") })]),
    ]);
    dialog.appendChild(top);

    const footer = el("div", { class: "ke-tpl-dialog-actions" }, [
      el("ul", { class: "ke-tpl-help" }, [
        el("li", { text: t("Changes save automatically") }),
        el("li", { text: t("Stored in this browser") }),
        el("li", { text: t("Export or drop JSON to import") }),
      ]),
      el("button", {
        class: "ke-alert-btn is-secondary",
        type: "button",
        onclick: close,
      }, [el("span", { text: t("Done") })]),
    ]);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    let closed = false;
    let confirming = false;
    function finishClose(): void {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onEsc);
      overlay.remove();
    }
    function onEsc(e: KeyboardEvent): void {
      if (e.key === "Escape" && !confirming) close();
    }
    function doRemove(): void {
      if (closed || confirming) return;
      flushAll();
      const emptyTpls = KE.templates.list().filter((t) => t.grants.length === 0);
      if (emptyTpls.length) {
        confirming = true;
        const many = emptyTpls.length > 1;
        const labels = emptyTpls.map((t) => `"${t.name}"`).join(", ");
        void KE.components.showConfirmDialogInPage(
          many
            ? t("The templates {labels} have no users. Discard them, or keep editing?", { labels })
            : t("Template {labels} has no users. Discard it, or keep editing?", { labels }),
          [
            { label: t("Keep editing"), value: "keep" },
            { label: t("Discard changes"), value: "discard", destructive: true },
          ],
          overlay,
          many ? t("Templates with no users") : t("Template with no users")
        ).then((v) => {
          confirming = false;
          if (v === "discard") {
            for (const t of emptyTpls) KE.templates.remove(t.id);
            refreshTemplates();
            finishClose();
          }
        });
        return;
      }
      finishClose();
    }
    function close(): void {
      doRemove();
    }

    const saveTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    const checkTokens = { next: 0 };

    /** Reads one card's DOM and persists it (debounced saves go through this). */
    const saveCard = (card: HTMLElement) => {
      const nameInput = card.querySelector(".ke-tpl-name") as HTMLInputElement;
      const grantsEl = card.querySelector(".ke-tpl-grants") as HTMLElement;
      const name = (nameInput ? nameInput.value : "").trim() || t("Untitled template");
      const grants = collectGrants(grantsEl);
      const saved = KE.templates.save({ id: card.dataset.keTplId || "", name, grants, updatedAt: Date.now() });
      if (saved.name !== name) {
        if (nameInput) nameInput.value = saved.name;
        showToast({
          type: "warning",
          title: t("Template renamed"),
          description: t("\"{name}\" was renamed to \"{saved}\" because the name is already in use.", {
            name,
            saved: saved.name,
          }),
        });
      }
      refreshTemplates();
    };

    const scheduleSave = (card: HTMLElement) => {
      const prev = saveTimers.get(card);
      if (prev) clearTimeout(prev);
      saveTimers.set(
        card,
        setTimeout(() => {
          saveTimers.delete(card);
          saveCard(card);
        }, 600)
      );
    };

    const flushAll = () => {
      for (const card of Array.from(list.querySelectorAll(".ke-tpl-card"))) {
        const timer = saveTimers.get(card as HTMLElement);
        if (timer) clearTimeout(timer);
        saveTimers.delete(card as HTMLElement);
        saveCard(card as HTMLElement);
      }
    };

    const lastLookups = new WeakMap<HTMLInputElement, string>();

    /**
     * Checks one username row: a duplicate inside the same template wins and is
     * marked red; otherwise the value is resolved against the account and the
     * border turns green/red. Re-running with an unchanged value that already
     * resolved skips the API call (the duplicate test still runs first).
     */
    const checkUsername = (input: HTMLInputElement, card: HTMLElement) => {
      const token = ++checkTokens.next;
      const val = input.value.trim();
      if (!val) {
        input.classList.remove("ke-tpl-ok", "ke-tpl-bad");
        input.title = "";
        lastLookups.delete(input);
        return;
      }
      const dup = Array.from(card.querySelectorAll(".ke-tpl-grant")).some((r) => {
        const i = r.querySelector("input") as HTMLInputElement | null;
        return !!i && i !== input && (i.value || "").trim() === val;
      });
      if (dup) {
        input.classList.remove("ke-tpl-ok");
        input.classList.add("ke-tpl-bad");
        input.title = t("Duplicate user in this template");
        return;
      }
      input.title = "";
      if (lastLookups.get(input) === val) return;
      lastLookups.set(input, val);
      input.classList.remove("ke-tpl-ok", "ke-tpl-bad");
      KE.apiUsers.lookupUser(val).then(() => {
        if (token === checkTokens.next) input.classList.add("ke-tpl-ok");
      }).catch(() => {
        if (token === checkTokens.next) input.classList.add("ke-tpl-bad");
      });
    };

    /** Re-checks every username row (after adding/removing rows or typing). */
    const refreshRowChecks = (card: HTMLElement) => {
      for (const row of Array.from(card.querySelectorAll(".ke-tpl-grant"))) {
        const i = row.querySelector("input") as HTMLInputElement | null;
        if (i) checkUsername(i, card);
      }
    };

    /** Live count of unique non-empty users shown on the collapsed card header. */
    const updateCount = (card: HTMLElement): void => {
      const countEl = card.querySelector(".ke-tpl-count") as HTMLElement | null;
      if (!countEl) return;
      const seen = new Set<string>();
      let n = 0;
      for (const r of Array.from(card.querySelectorAll(".ke-tpl-grant"))) {
        const i = r.querySelector("input") as HTMLInputElement | null;
        const v = i ? (i.value || "").trim() : "";
        if (v && !seen.has(v)) {
          seen.add(v);
          n++;
        }
      }
      countEl.textContent = tP("count-users", n);
    };

    const addGrantRow = (card: HTMLElement, grantsEl: HTMLElement, username: string, permission: string) => {
      const row = el("div", { class: "ke-tpl-grant" });
      const input = el("input", {
        type: "text",
        class: "ke-input",
        placeholder: t("Username"),
        value: username,
        autocomplete: "off",
        spellcheck: "false",
      }) as HTMLInputElement;
      let inputTimer: ReturnType<typeof setTimeout> | null = null;
      input.addEventListener("input", () => {
        if (inputTimer) clearTimeout(inputTimer);
        inputTimer = setTimeout(() => refreshRowChecks(card), 350);
        updateCount(card);
        scheduleSave(card);
      });
      const select = el("select", { class: "ke-input ke-perm ke-tpl-perm", title: t("Permission") }) as HTMLSelectElement;
      for (const opt of permSelectOptions(permission)) select.appendChild(opt);
      select.addEventListener("change", () => scheduleSave(card));
      const removeBtn = el("button", {
        type: "button",
        class: "ke-tpl-x",
        "aria-label": t("Remove user"),
        text: "\u00D7",
        onclick: () => {
          row.remove();
          updateCount(card);
          refreshRowChecks(card);
          scheduleSave(card);
        },
      });
      row.appendChild(input);
      row.appendChild(select);
      row.appendChild(removeBtn);
      grantsEl.appendChild(row);
    };

    const renderGrants = (card: HTMLElement, grantsEl: HTMLElement, work: PermissionTemplate) => {
      for (const g of work.grants) addGrantRow(card, grantsEl, g.username, g.permission);
    };

    const collectGrants = (grantsEl: HTMLElement): PermissionTemplateGrant[] => {
      const out: PermissionTemplateGrant[] = [];
      const seen = new Set<string>();
      const rows = grantsEl.querySelectorAll(".ke-tpl-grant");
      for (const row of Array.from(rows)) {
        const input = row.querySelector("input") as HTMLInputElement;
        const select = row.querySelector("select") as HTMLSelectElement;
        const username = (input.value || "").trim();
        const permission = select.value;
        if (!username || !permission || seen.has(username)) continue;
        seen.add(username);
        out.push({ username, permission });
      }
      return out;
    };

    const addCard = (tpl?: PermissionTemplate): HTMLElement => {
      const work: PermissionTemplate = tpl || KE.templates.create(t("New template"));
      const card = el("div", { class: "ke-tpl-card" });
      card.dataset.keTplId = work.id;
      empty.style.display = "none";

      const head = el("div", { class: "ke-tpl-card-head" });
      const toggleBtn = el("button", {
        type: "button",
        class: "ke-tpl-toggle",
        "aria-label": t("Expand template"),
        "aria-expanded": "false",
      }, [buildIcon("chevron-down", 16)]) as HTMLButtonElement;
      const nameInput = el("input", {
        type: "text",
        class: "ke-tpl-name",
        placeholder: t("Template name"),
        value: work.name,
        autocomplete: "off",
        spellcheck: "false",
      }) as HTMLInputElement;
      const delBtn = el("button", {
        type: "button",
        class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon ke-stop-btn",
        onclick: () => {
          void KE.components.showConfirmDialogInPage(
            t("Delete template \"{name}\"? This cannot be undone.", { name: (nameInput.value || work.name).trim() }),
            [
              { label: t("Cancel"), value: "cancel" },
              { label: t("Delete"), value: "delete", destructive: true },
            ],
            overlay,
            t("Delete template")
          ).then((v) => {
            if (v !== "delete") return;
            const timer = saveTimers.get(card);
            if (timer) clearTimeout(timer);
            saveTimers.delete(card);
            KE.templates.remove(work.id);
            card.remove();
            refreshTemplates();
            if (!list.querySelector(".ke-tpl-card")) empty.style.display = "";
          });
        },
      }, [buildIcon("trash", 16)]) as HTMLButtonElement;
      const delWrap = el("span", {
        class: "right-tooltip ke-tpl-del-wrap",
        "data-tip": t("Delete template"),
        "aria-label": t("Delete template"),
      }, [delBtn]);
      const countEl = el("span", { class: "ke-tpl-count" });

      nameInput.addEventListener("input", () => {
        scheduleSave(card);
        updateCount(card);
      });
      toggleBtn.addEventListener("click", () => {
        const open = card.classList.toggle("open");
        toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });

      head.appendChild(toggleBtn);
      head.appendChild(nameInput);
      head.appendChild(countEl);
      head.appendChild(delWrap);
      card.appendChild(head);

      const cardBody = el("div", { class: "ke-tpl-card-body" });
      const grantsEl = el("div", { class: "ke-tpl-grants" });
      renderGrants(card, grantsEl, work);
      cardBody.appendChild(grantsEl);
      cardBody.appendChild(
        el("button", {
          type: "button",
          class: "ke-btn ke-tpl-add-user",
          onclick: () => {
            addGrantRow(card, grantsEl, "", "view_asset");
            updateCount(card);
            scheduleSave(card);
          },
        }, [el("span", { text: t("+ Add user") })]),
      );
      card.appendChild(cardBody);
      updateCount(card);

      list.appendChild(card);
      return card;
    };

    for (const tpl of KE.templates.list()) addCard(tpl);
    if (list.querySelector(".ke-tpl-card")) empty.style.display = "none";

    if (preset && preset.length) {
      const name = selectedProjectName() || t("New template");
      const created = KE.templates.create(name);
      const saved = KE.templates.save({
        id: created.id,
        name: created.name,
        grants: grantsFromAssignments(preset),
        updatedAt: Date.now(),
      });
      const card = addCard(saved);
      if (card) {
        card.classList.add("open");
        const toggle = card.querySelector(".ke-tpl-toggle") as HTMLButtonElement | null;
        if (toggle) {
          toggle.setAttribute("aria-expanded", "true");
          toggle.setAttribute("aria-label", t("Collapse template"));
        }
      }
      refreshTemplates();
    }

    document.addEventListener("keydown", onEsc);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    document.body.appendChild(overlay);
  }

  // ---------- custom icon dropdowns (action + scope selectors) ----------

  const SCOPE_ICON_KEYS: Record<string, string> = {
    selected: "check-square",
    manual: "hash",
    all: "layers",
  };

  /** Resolves the dropdown icon for an action option from its descriptor. */
  function actionIconResolver(value: string): string {
    if (!value) return "";
    const def = getActionDef(value);
    return (def && def.icon) || "";
  }

  let dropdownOpen: SelectDropdownHandle | null = null;

  /**
   * Wraps a native <select> with a custom icon dropdown. The native element
   * stays in the DOM (visually hidden) and remains the source of truth, so all
   * existing `.value` reads / change listeners keep working. Returns
   * { wrap, update } — call update() after option labels change. `iconKeys`
   * may be a value->icon map or a resolver function (optionValue) => iconName.
   */
  function createSelectDropdown(selectEl: HTMLSelectElement, iconKeys: Record<string, string> | ((value: string) => string)): SelectDropdownHandle {
    const resolveIcon = (value: string): string =>
      typeof iconKeys === "function" ? iconKeys(value) : iconKeys[value];
    const wrap = el("div", { class: "ke-select-wrap" });
    const trigger = el("button", {
      type: "button",
      class: "ke-select-trigger",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      title: selectEl.title || "",
    });
    const triggerIcon = el("span", { class: "ke-select-trigger-icon" });
    const triggerLabel = el("span", { class: "ke-select-trigger-label" });
    const chevron = el("span", { class: "ke-select-trigger-chevron" }, [buildIcon("chevron-down", 14)]);
    trigger.appendChild(triggerIcon);
    trigger.appendChild(triggerLabel);
    trigger.appendChild(chevron);
    selectEl.classList.add("ke-select--native");
    wrap.appendChild(trigger);
    wrap.appendChild(selectEl);

    const menu = el("div", { class: "ke-select-menu", role: "listbox" });
    wrap.appendChild(menu);

    function closeMenu(): void {
      if (!menu.classList.contains("open")) return;
      menu.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      if (dropdownOpen === self) dropdownOpen = null;
    }

    function selectedOption(): HTMLOptionElement | null {
      if (!selectEl.options || !selectEl.options.length) return null;
      if (selectEl.selectedOptions && selectEl.selectedOptions.length) return selectEl.selectedOptions[0];
      return selectEl.options[selectEl.selectedIndex] || null;
    }

    function renderItems(): void {
      menu.innerHTML = "";
      menu.appendChild(
        el("div", { class: "ke-select-section-label", text: selectEl.title && !selectEl.querySelector("optgroup") ? selectEl.title : "" })
      );
      let currentGroup: string | null = null;
      for (const opt of Array.from(selectEl.options)) {
        const group = opt.parentElement && opt.parentElement.tagName === "OPTGROUP" ? (opt.parentElement as HTMLOptGroupElement).label : "";
        const isSelected = opt.selected || (selectEl.selectedIndex >= 0 && selectEl.options[selectEl.selectedIndex] === opt);
        if (group && group !== currentGroup) {
          currentGroup = group;
          menu.appendChild(el("div", { class: "ke-select-section-label", text: group }));
        } else if (!group && currentGroup) {
          currentGroup = null;
        }
        const icon = buildIcon(resolveIcon(opt.value), 15);
        const item = el("button", {
          type: "button",
          class: "ke-select-option" + (isSelected ? " ke-selected" : ""),
          role: "option",
          "aria-selected": String(isSelected),
          title: opt.title || selectEl.title || "",
        }, [
          el("span", { class: "ke-opt-icon" }, icon ? [icon] : []),
          el("span", { class: "ke-select-option-label", text: opt.text }),
        ]);
        item.addEventListener("click", () => {
          if (selectEl.value === opt.value) {
            closeMenu();
            return;
          }
          selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event("change", { bubbles: true }));
          update();
          closeMenu();
        });
        menu.appendChild(item);
      }
    }

    function positionMenu(): void {
      const r = trigger.getBoundingClientRect();
      menu.style.top = r.bottom + 4 + "px";
      menu.style.left = r.left + "px";
      menu.style.minWidth = Math.max(r.width, 240) + "px";
      menu.style.maxWidth = Math.min(320, window.innerWidth - r.left - 8) + "px";
      const mh = menu.offsetHeight;
      if (r.bottom + mh + 8 > window.innerHeight && r.top - mh - 4 > 0) {
        menu.style.top = r.top - mh - 4 + "px";
      }
    }

    function openMenu(): void {
      if (dropdownOpen && dropdownOpen !== self) dropdownOpen.closeMenu();
      renderItems();
      menu.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      positionMenu();
      dropdownOpen = self;
    }

    function toggleMenu(): void {
      if (menu.classList.contains("open")) closeMenu();
      else openMenu();
    }

    trigger.addEventListener("click", toggleMenu);

    function onDocClick(e: MouseEvent): void {
      const t = e.target;
      if (wrap.isConnected && !(t instanceof Node && wrap.contains(t))) closeMenu();
    }
    function onEscape(e: KeyboardEvent): void {
      if (e.key === "Escape") closeMenu();
    }
    function onViewportChange(e: Event): void {
      const target = e ? e.target : null;
      if (target instanceof Node && wrap.contains(target)) return;
      closeMenu();
    }
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onEscape, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);

    selectEl.addEventListener("change", update);

    function update(): void {
      if (!wrap.isConnected) return;
      const opt = selectedOption();
      triggerIcon.innerHTML = "";
      if (opt) {
        triggerLabel.textContent = opt.text;
        const ic = buildIcon(resolveIcon(opt.value), 16);
        if (ic) triggerIcon.appendChild(ic);
      } else {
        triggerLabel.textContent = selectEl.options && selectEl.options.length ? selectEl.options[0].text : "";
      }
      wrap.classList.toggle("ke-disabled", !!selectEl.disabled);
      trigger.tabIndex = selectEl.disabled ? -1 : 0;
    }

    update();
    const self: SelectDropdownHandle = { wrap, update, closeMenu };
    return self;
  }

  function parseManualUids(): UID[] {
    const raw = (refs.manualInput ? refs.manualInput.value : "") || "";
    const out: UID[] = [];
    const seen = new Set<string>();
    for (const token of raw.split(/[\s,;]+/)) {
      const t = (token || "").trim();
      if (!t) continue;
      let uid = t;
      const m = t.match(/\/forms\/([A-Za-z0-9]+)\/?$/);
      if (m) uid = m[1];
      if (!/^[A-Za-z0-9]{6,32}$/.test(uid)) continue;
      if (!seen.has(uid)) {
        seen.add(uid);
        out.push(uid);
      }
    }
    return out;
  }

  function parseTagsInput(raw: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const token of (raw || "").split(/[\s,;]+/)) {
      const t = (token || "").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  function parseUsersInput(raw: string): string[] {
    return parseTagsInput(raw);
  }

  /** Fills the template selector from KE.templates; keeps the current pick when possible. */
  function refreshTemplates(): void {
    if (!refs.templateSelect) return;
    const prev = refs.templateSelect.value;
    refs.templateSelect.innerHTML = "";
    const tpls = KE.templates.list().filter((t) => t.grants.length > 0);
    const ph = el("option", {
      value: "",
      text: tpls.length ? t("Select a template...") : t("No templates with users yet - create one to get started"),
    });
    (ph as HTMLOptionElement).selected = true;
    refs.templateSelect.appendChild(ph);
    for (const t of tpls) {
      refs.templateSelect.appendChild(
        el("option", { value: t.id, text: `${t.name} (${tP("count-users", t.grants.length)})` })
      );
    }
    if (prev && tpls.some((t) => t.id === prev)) refs.templateSelect.value = prev;
    updateRunBtn();
  }

  // ---------- cross-account transfer (row 2) ----------

  /** Values of the row-2 scope dropdown. Submissions always travel with the
   *  form in v1, so "submissions only" is deliberately not an option. */
  const TRANSFER_SCOPE_FORMS = "forms";
  const TRANSFER_SCOPE_BOTH = "forms+submissions";

  function transferFormsChecked(): boolean {
    // Every option copies the form, so forms are always on.
    return true;
  }

  function transferSubmissionsChecked(): boolean {
    return !!refs.transferScope && refs.transferScope.value === TRANSFER_SCOPE_BOTH;
  }

  /** Opens the transfer settings panel (source token shown read-only, plus the
   *  destination server + token, validated on save). */
  function openTransferPanel(): void {
    KE.transfer.openPanel();
  }

  /**
   * Repaints the transfer row from the destination store and re-gates Run.
   *
   * Called on every syncFields() while the action is selected, whenever the
   * panel reports a change, and once after init. The destination metadata lives
   * in `chrome.storage.local` behind an in-memory cache, so the first paint can
   * land before hydration finishes; `refreshTransferRow()` therefore re-paints
   * itself once the store reports ready. The token half is memory-only and async,
   * so the ready flag is re-checked in the background and the Run button is
   * re-gated when that settles.
   */
  function refreshTransferRow(): void {
    const store = KE.transferDestination;

    // The store hydrates from chrome.storage.local asynchronously, so the very
    // first paint can beat it and briefly draw "Not set". Kick hydration once and
    // re-paint when it lands; the flag keeps the repaint from queueing another.
    if (!transferRowHydrated) {
      transferRowHydrated = true;
      store.ready().then(() => {
        refreshTransferRow();
      }).catch(() => { /* an empty cache just leaves the row as painted */ });
    }

    const dest = store.getDestination();
    if (refs.transferSummary) {
      if (dest) {
        const info = store.serverInfo(dest.server);
        const who = dest.username ? `${dest.username} @ ${info.label}` : info.label;
        // "Move projects from <signed-in account> to <destination>". The source
        // name resolves async, so paint the destination side now and the full
        // sentence once the username lands.
        refs.transferSummary.textContent = transferSourceName
          ? t("Move projects from {source} to {dest}", { source: transferSourceName, dest: who })
          : who;
        refs.transferSummary.title = t("Move projects from {source} to {dest}", { source: transferSourceName || "?", dest: who });
        refs.transferSummary.classList.remove("is-empty");
      } else {
        refs.transferSummary.textContent = t("Not set");
        refs.transferSummary.title = t("Set the destination account");
        refs.transferSummary.classList.add("is-empty");
      }
    }
    // A destination without a live token cannot be used: disable the scope
    // dropdown so the state is visible instead of silently failing at run time.
    const canChoose = !!dest;
    if (refs.transferScope) refs.transferScope.disabled = !canChoose;

    updateRunBtn();

    // Resolve the signed-in account name once, for the "from ... to ..." label.
    if (!transferSourceName) {
      KE.auth.getUsername().then((u) => {
        if (!u) return;
        transferSourceName = u;
        refreshTransferRow();
      }).catch(() => { /* the summary falls back to the destination side only */ });
    }
    // isReady() is async (it reads the in-memory token) while the Run gate is
    // sync, so cache the answer and re-gate when it settles. The token is never
    // persisted, so on a fresh page load this settles false and the user must
    // re-enter the token before Run unlocks.
    store.isReady().then((ready) => {
      transferReady = !!ready;
      updateRunBtn();
    }).catch(() => {
      transferReady = false;
      updateRunBtn();
    });
  }

  function getTargetUids(): UID[] {
    const source = refs.sourceSelect ? refs.sourceSelect.value : "selected";
    if (source === "manual") return parseManualUids();
    if (source === "all") return [];
    return selectedUidsVar.uids.slice();
  }

  function updateRunBtn(): void {
    if (!refs.runBtn) return;
    const action = refs.actionSelect ? refs.actionSelect.value : "";
    const ready = !!action && targetValidFor(action) && fieldsReadyFor(action);
    refs.runBtn.disabled = running || !ready;
  }

  /** Fills the source-project field from the page selection (exactly one). */
  function onUseSelectedSource(): void {
    const uids = KE.scraper.getSelectedCheckboxUids();
    if (uids.length === 1) {
      cancelSourceNameLookup();
      if (refs.sourceProjectInput) {
        refs.sourceProjectInput.value = uids[0];
        updateRunBtn();
      }
      setSourceProjectName(selectedProjectName());
      return;
    }
    showToast({
      type: "warning",
      title: uids.length === 0 ? t("No project selected") : t("Multiple projects selected"),
      description: t("Select exactly one project on the page to use as the source."),
    });
  }

  /** Builds a new permission template from the collaborators of one selected project. */
  function onCreateTemplateFromProject(): void {
    const uids = KE.scraper.getSelectedCheckboxUids();
    if (uids.length !== 1) {
      showToast({
        type: "warning",
        title: uids.length === 0 ? t("No project selected") : t("Multiple projects selected"),
        description: t("Select exactly one project on the page to build a template from."),
      });
      return;
    }
    const signal = new AbortController().signal;
    Promise.all([
      KE.apiPermissions.getPermissionAssignments(uids[0], signal),
      KE.apiAssets.fetchAsset(uids[0], signal).then((asset) => asset.owner__username || (asset.owner && asset.owner.username) || ""),
      KE.auth.getUsername(),
    ]).then(([assignments, owner, currentUsername]) => {
      const excluded = new Set(
        ["anonymoususer", "anonymous"]
          .concat(owner || [], currentUsername || [])
          .map((s) => (s || "").toLowerCase())
          .filter(Boolean)
      );
      const list = assignments.filter((a) => !excluded.has(a.username.toLowerCase()));
      if (!list.length) {
        showToast({
          type: "warning",
          title: t("No collaborators"),
          description: t("The selected project has no other collaborators to load into a template."),
        });
        return;
      }
      openTemplatesManager(list);
    }).catch((e) => {
      const err = (e || {}) as KoboRecord;
      showToast({
        type: "error",
        title: t("Source project not found"),
        description: (err.detail || err.message) as string | undefined,
      });
    });
  }

  /** The name of the single checked project row, or "" when none is found. */
  function selectedProjectName(): string {
    const rows = findBodyRows() || [];
    for (const row of rows) {
      const cb = KE.scraper.getRowCheckbox(row);
      if (!cb || !(cb.checked || cb.getAttribute("aria-checked") === "true")) continue;
      const link = row.querySelector('[data-field="name"] a[href*="/forms/"]');
      return link ? (link.textContent || "").trim() : "";
    }
    return "";
  }

  /** Shows/hides the resolved source-project name next to the field. */
  function setSourceProjectName(name: string): void {
    if (!refs.sourceProjectName) return;
    const text = (name || "").trim();
    refs.sourceProjectName.textContent = text;
    refs.sourceProjectName.style.display = text ? "" : "none";
  }

  /** Cancels any pending/in-flight name lookup (debounce + request token). */
  function cancelSourceNameLookup(): void {
    if (sourceNameTimer) {
      clearTimeout(sourceNameTimer);
      sourceNameTimer = null;
    }
    sourceNameReq++;
  }

  /** Debounced UID input handler: run-button gate + resolve the project name. */
  function onSourceProjectInput(): void {
    updateRunBtn();
    cancelSourceNameLookup();
    const uid = refs.sourceProjectInput ? refs.sourceProjectInput.value.trim() : "";
    if (!uid) {
      setSourceProjectName("");
      return;
    }
    sourceNameTimer = setTimeout(() => loadSourceProjectName(uid), 450);
  }

  /** Looks the UID up via the API and shows its name (hides it when unknown). */
  async function loadSourceProjectName(uid: string): Promise<void> {
    const token = ++sourceNameReq;
    try {
      const asset = await KE.apiAssets.fetchAsset(uid);
      if (token !== sourceNameReq) return;
      setSourceProjectName((asset && asset.name) || "");
    } catch (e) {
      if (token !== sourceNameReq) return;
      setSourceProjectName("");
    }
  }

  function targetValidFor(action: string): boolean {
    const def = getActionDef(action);
    // Panel actions open a modal instead of acting on projects: no target needed.
    if (def && def.kind === "panel") return true;
    const source = refs.sourceSelect ? refs.sourceSelect.value : "selected";
    if (source === "all") return true;
    return getTargetUids().length > 0;
  }

  function fieldsReadyFor(action: string): boolean {
    const def = action ? getActionDef(action) : null;
    if (!def) return false;
    const req = (def.requiredFields || []).map((k) => {
      if (k === "prefix_suffix") return (refs.prefixInput && refs.prefixInput.value.trim()) || (refs.suffixInput && refs.suffixInput.value.trim()) ? true : false;
      if (k === "tags") {
        const mode = refs.tagsModeSelect ? refs.tagsModeSelect.value : "append";
        return mode === "replace" || !!(refs.tagsInput && refs.tagsInput.value.trim());
      }
      if (k === "countries") return !!(countryPicker && countryPicker.hasSelection());
      if (k === "sectors") return !!(sectorPicker && sectorPicker.hasSelection());
      if (k === "permission") return !!(refs.permSelect && refs.permSelect.value);
      if (k === "username") return !!(refs.usernameInput && refs.usernameInput.value.trim());
      if (k === "users") return parseUsersInput(refs.usersInput ? refs.usersInput.value : "").length > 0;
      if (k === "description") return !!(refs.descriptionInput && refs.descriptionInput.value.trim());
      if (k === "find") return !!(refs.findInput && refs.findInput.value.trim());
      if (k === "sourceProject") return !!(refs.sourceProjectInput && refs.sourceProjectInput.value.trim());
      if (k === "template") return !!(refs.templateSelect && refs.templateSelect.selectedIndex > 0);
      // A validated destination is required; the token itself stays in the store.
      if (k === "transfer") return transferReady;
      return true;
    });
    return req.every(Boolean);
  }

  function updateScopeLabels(): void {
    if (!refs.sourceSelect) return;
    const opts = refs.sourceSelect.options;
    if (!opts || opts.length < 3) return;
    const selCount = selectedUidsVar.uids.length;
    const manCount = parseManualUids().length;
    opts[0].text = selCount ? t("Selected projects ({n})", { n: selCount }) : t("Selected projects");
    opts[1].text = manCount ? t("By project UID(s) ({n})", { n: manCount }) : t("By project UID(s)");
    opts[2].text = t("Entire account");
    if (scopeDropdown) scopeDropdown.update();
    if (actionDropdown) actionDropdown.update();
  }

  // ---------- live run-progress toast helpers ----------

  function ensureRunToast(title: string, step: string): ProgressToastHandle {
    if (title) currentRunTitle = title;
    if (!runToast) runToast = KE.components.showProgressToast(currentRunTitle || t("Working..."));
    if (step) runToast.setStep(step);
    return runToast;
  }

  function setRunStep(text: string): void {
    if (runToast) runToast.setStep(text);
  }

  function setRunProgress(done: number, total?: number): void {
    if (runToast) runToast.setProgress(done, total as number);
  }

  function finishRunToast(): void {
    if (runToast) {
      runToast.finish();
      runToast = null;
    }
  }

// ---------- pause & resume ----------

  /** Toolbar pause/resume button: parks or lifts the executor's loop. */
  function onPauseClick(): void {
    if (!running) return;
    if (paused) {
      KE.actionExecutor.resume();
      paused = false;
      setPausedUI(false);
      return;
    }
    KE.actionExecutor.pause();
    paused = true;
    setPausedUI(true);
  }

  /** Mirrors the executor's paused flag onto the toolbar + progress toast. */
  function setPausedUI(pausedNow: boolean): void {
    paused = pausedNow;
    if (refs.pauseBtn) {
      const btn = refs.pauseBtn;
      btn.innerHTML = "";
      btn.appendChild(pausedNow ? svgPlayIcon() : svgPauseIcon());
      btn.title = pausedNow ? t("Resume run") : t("Pause run");
    }
    if (refs.pauseTipWrap) {
      const tip = pausedNow
        ? (pausedInfo ? t("Resume — {done} of {total} done", { done: pausedInfo.processed, total: pausedInfo.total }) : t("Resume run"))
        : t("Pause run");
      refs.pauseTipWrap.setAttribute("data-tip", tip);
      refs.pauseTipWrap.setAttribute("aria-label", tip);
    }
    if (refs.pauseDlWrap) {
      refs.pauseDlWrap.style.display = pausedNow && !!pausedInfo ? "" : "none";
    }
    if (runToast) {
      if (pausedNow) {
        runToast.setStep(pausedInfo ? t("Paused — {done} of {total} done", { done: pausedInfo.processed, total: pausedInfo.total }) : t("Paused"));
      } else if (currentRunTitle) {
        runToast.setStep(t("{title}... running", { title: currentRunTitle }));
      }
    }
  }

  /** Called by the executor whenever the run loop actually parks. */
  function onRunPaused(info: RunPauseInfo): void {
    pausedAction = refs.actionSelect ? refs.actionSelect.value : "";
    pausedInfo = info;
    paused = true;
    setPausedUI(true);
    const saved = savePausedSnapshot(info);
    if (!saved && info.remaining.length > 0) {
      showToast({
        type: "warning",
        title: t("Too large to persist"),
        description: t("This pause can only be resumed in the current session; a page reload would lose it."),
      });
    }
  }

  /** Mirrors the current toolbar inputs into the snapshot's sanitized request. */
  function gatherRequestSettings(): ActionRequest {
    return {
      username: refs.usernameInput ? refs.usernameInput.value.trim() : "",
      usernames: refs.usersInput ? parseUsersInput(refs.usersInput.value) : [],
      permission: refs.permSelect ? refs.permSelect.value : "",
      prefix: refs.prefixInput ? refs.prefixInput.value : "",
      suffix: refs.suffixInput ? refs.suffixInput.value : "",
      findText: refs.findInput ? refs.findInput.value : "",
      replaceText: refs.replaceInput ? refs.replaceInput.value : "",
      description: refs.descriptionInput ? refs.descriptionInput.value : "",
      countries: selectedCountries(),
      sectors: selectedSectors(),
      tags: refs.tagsInput ? parseTagsInput(refs.tagsInput.value) : [],
      tagsMode: refs.tagsModeSelect ? (refs.tagsModeSelect.value as "append" | "remove" | "replace") : "append",
      sourceProject: refs.sourceProjectInput ? refs.sourceProjectInput.value.trim() : "",
      templateId: refs.templateSelect ? refs.templateSelect.value : "",
      moveForms: transferFormsChecked(),
      moveSubmissions: transferSubmissionsChecked(),
      transferReady,
    };
  }

  function savePausedSnapshot(info: RunPauseInfo): boolean {
    if (!KE.pausedRun) return false;
    const source = refs.sourceSelect ? refs.sourceSelect.value : "selected";
    return KE.pausedRun.save({
      v: 1,
      ts: Date.now(),
      user: pausedUser,
      baseUrl: KE.auth.getBaseUrl(),
      action: pausedAction,
      source,
      wholeAccount: source === "all",
      filterUrl: lastFilterUrl,
      settings: gatherRequestSettings(),
      remaining: info.remaining.slice(),
      processed: info.processed,
      total: info.total,
      rows: info.rows.slice(),
    });
  }

  /** Shared partial-report download: same prefix as the full report so the
   *  Timestamp column tells the stage apart. */
  function downloadProgressRows(rows: ReportRow[], actionId?: string): void {
    if (!rows || !rows.length) {
      showToast({ type: "warning", title: t("No progress to download"), description: t("No projects have completed yet in this run.") });
      return;
    }
    const id = actionId || pausedAction;
    const def = id ? getActionDef(id) : null;
    const slug = (def && def.report && def.report.slug) || (def && def.reportSlug) || (def ? def.id : "partial") || "partial";
    const files = KE.exportSvc.buildCsvFiles([
      { filename: `kobo-bulk-${slug}-report`, rows, columns: KE.exportSvc.unionKeys(rows) },
    ]);
    const file = files[0];
    if (!file) return;
    KE.exportSvc.makeFilename(file.filename)
      .then((name) => KE.exportSvc.download(name, file.csv || ""))
      .catch(() => {});
  }

  function downloadPartialReport(): void {
    downloadProgressRows(pausedInfo ? pausedInfo.rows : [], pausedAction);
  }

  function onResumeClick(): Promise<void> | void {
    const snap = idleSnapshot;
    if (!snap) return;
    const def = snap.action ? getActionDef(snap.action) : null;
    const label = def ? t(def.label as keyof EnDict) : snap.action;
    return KE.components.showConfirmDialogInPage(
      t("The run \"{label}\" was paused with {n} of {total} projects still to do. Continue it now?", {
        label,
        n: snap.remaining.length,
        total: snap.total,
      }),
      [
        { label: t("Resume"), value: "resume", primary: true },
        { label: t("Download progress report"), value: "download" },
        { label: t("Discard"), value: "discard", destructive: true },
        { label: t("Cancel"), value: "cancel" },
      ],
      document.body,
      t("Resume paused run")
    ).then((choice: unknown) => {
      if (choice === "download") {
        downloadProgressRows(snap.rows || [], snap.action);
        return;
      }
      if (choice === "discard") {
        KE.pausedRun.clear();
        hideResume();
        return;
      }
      if (choice !== "resume") return;
      currentRunTitle = label;
      startRun(runOptionsFromSnapshot(snap));
    });
  }

  function runOptionsFromSnapshot(snap: PausedRunSnapshot): RunOptions {
    const s = snap.settings || ({} as ActionRequest);
    return {
      uids: (snap.remaining || []).slice(),
      wholeAccount: false,
      source: snap.source || "selected",
      filterUrl: snap.filterUrl,
      action: snap.action,
      username: s.username || "",
      users: Array.isArray(s.usernames) ? s.usernames.slice() : [],
      permission: s.permission || "",
      prefix: s.prefix || "",
      suffix: s.suffix || "",
      findText: s.findText || "",
      replaceText: s.replaceText || "",
      description: s.description || "",
      countries: Array.isArray(s.countries) ? s.countries.slice() : [],
      sectors: Array.isArray(s.sectors) ? s.sectors.slice() : [],
      tags: Array.isArray(s.tags) ? s.tags.slice() : [],
      tagsMode: s.tagsMode || "append",
      sourceProject: s.sourceProject || "",
      templateId: s.templateId || "",
      // A resumed transfer must re-confirm the destination still exists and
      // that at least one copy option is still selected.
      moveForms: s.moveForms === undefined ? transferFormsChecked() : !!s.moveForms,
      moveSubmissions: s.moveSubmissions === undefined ? transferSubmissionsChecked() : !!s.moveSubmissions,
      transferReady,
      skipConfirm: true,
      resumeOf: { processed: snap.processed || 0, total: snap.total || 0 },
      seedRows: Array.isArray(snap.rows) ? snap.rows.slice() : [],
    };
  }

  function hideResume(): void {
    idleSnapshot = null;
    if (refs.resumeWrap) refs.resumeWrap.style.display = "none";
  }

  /** Offer Resume after a reload when a valid paused-run snapshot exists. */
  async function checkPausedSnapshot(): Promise<void> {
    if (!KE.pausedRun || !refs.resumeWrap) return;
    const snap = KE.pausedRun.load();
    if (!snap) {
      hideResume();
      return;
    }
    let ok = false;
    try {
      ok = await KE.pausedRun.valid(snap);
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      KE.pausedRun.clear();
      hideResume();
      return;
    }
    idleSnapshot = snap;
    const def = snap.action ? getActionDef(snap.action) : null;
    const label = def ? t(def.label as keyof EnDict) : snap.action;
    const tip = t("Resume \"{label}\" — {n} of {total} projects remain", {
      label,
      n: snap.remaining.length,
      total: snap.total,
    });
    if (refs.resumeBtn) refs.resumeBtn.title = tip;
    if (refs.resumeWrap) {
      refs.resumeWrap.setAttribute("data-tip", tip);
      refs.resumeWrap.setAttribute("aria-label", tip);
      refs.resumeWrap.style.display = "";
    }
    showToast({
      type: "warning",
      title: t("Paused run found"),
      description: t("\"{label}\" — {n} of {total} projects remain. Resume, download progress, or discard.", {
        label,
        n: snap.remaining.length,
        total: snap.total,
      }),
      action: { label: t("Resume"), onClick: onResumeClick },
    });
  }

/** Locks/unlocks the whole toolbar for one run (bulk OR account action). */
  function lockUI(run: boolean): void {
    running = run;
    if (refs.runWrap) refs.runWrap.style.display = run ? "none" : "";
    updateRunBtn();
    if (refs.pauseWrap) refs.pauseWrap.style.display = run ? "inline-flex" : "none";
    if (refs.resumeWrap) refs.resumeWrap.style.display = "none";
    if (refs.pauseDlWrap) {
      refs.pauseDlWrap.style.display = "none";
    } else if (refs.pauseDlBtn) {
      refs.pauseDlBtn.style.display = "none";
    }
    if (refs.stopWrap) refs.stopWrap.style.display = run ? "" : "none";
    if (refs.historyBtn) refs.historyBtn.disabled = run;
    if (refs.collectBtn) refs.collectBtn.disabled = run;
    if (refs.settingsBtn) refs.settingsBtn.disabled = run;
    if (refs.actionSelect) refs.actionSelect.disabled = run;
    if (refs.usernameInput) refs.usernameInput.disabled = run;
    if (refs.usersInput) refs.usersInput.disabled = run;
    if (refs.permSelect) refs.permSelect.disabled = run;
    if (refs.prefixInput) refs.prefixInput.disabled = run;
    if (refs.suffixInput) refs.suffixInput.disabled = run;
    if (refs.findInput) refs.findInput.disabled = run;
    if (refs.replaceInput) refs.replaceInput.disabled = run;
    if (refs.descriptionInput) refs.descriptionInput.disabled = run;
    if (refs.tagsModeSelect) refs.tagsModeSelect.disabled = run;
    if (refs.tagsInput) refs.tagsInput.disabled = run;
    if (refs.sourceProjectInput) refs.sourceProjectInput.disabled = run;
    if (refs.sourceProjectBtn) refs.sourceProjectBtn.disabled = run;
    if (refs.templateSelect) refs.templateSelect.disabled = run;
    if (refs.templateBtn) refs.templateBtn.disabled = run;
    if (refs.templateFromProjectBtn) refs.templateFromProjectBtn.disabled = run;
    if (refs.transferBtn) refs.transferBtn.disabled = run;
    if (refs.transferScope) refs.transferScope.disabled = run;
    if (countryPicker) countryPicker.setDisabled(run);
    if (sectorPicker) sectorPicker.setDisabled(run);
    if (refs.manualInput) refs.manualInput.disabled = run;
    updateSourceEnabled();
    updateScopeLabels();
  }

  // ---------- selection sync ----------

  function syncSelection(): void {
    const uids = KE.scraper.getSelectedCheckboxUids();
    selectedUidsVar.uids = uids;
    KE.store.setPageContext({ selectedUids: uids });
    updateScopeLabels();
    updateRunBtn();
    updateSelectAllIcon();
  }

  function updateSelectAllIcon(): void {
    if (!refs.selectAllInput) return;
    const cbs = (findBodyRows() || []).map(KE.scraper.getRowCheckbox).filter(Boolean) as HTMLInputElement[];
    const checked = cbs.filter((c) => c.checked).length;
    refs.selectAllInput.checked = cbs.length > 0 && checked === cbs.length;
    refs.selectAllInput.indeterminate = cbs.length > 0 && checked > 0 && checked < cbs.length;
  }

  function toggleSelectAll(): void {
    const cbs = (findBodyRows() || []).map(KE.scraper.getRowCheckbox).filter(Boolean) as HTMLInputElement[];
    const allChecked = cbs.length > 0 && cbs.every((c) => c.checked);
    for (const cb of cbs) {
      if (cb.checked === allChecked) cb.click();
    }
    setTimeout(syncSelection, 0);
  }

  // ---------- select all / deselect all (Kobo checkbox icon) ----------

  function ensureHeaderSelectAll(): void {
    if (selectAllIcon && selectAllIcon.isConnected) return;
    if (refs.selectAllInput && refs.selectAllInput.isConnected) return;
    const header = findHeaderRow();
    if (!header) return;
    const cell = header.querySelector('[data-field="checkbox"]');
    if (!cell) return;
    let wrapper = cell.querySelector("[data-ke-selectall]");
    if (!wrapper && refs.selectAllInput) {
      wrapper = el("div", { class: "checkbox ke-select-all-box" }, [
        el("label", { class: "checkbox__wrapper" }, [refs.selectAllInput]),
      ]);
      cell.appendChild(wrapper);
    }
    if (!wrapper) {
      const input = el("input", {
        type: "checkbox",
        class: "checkbox__input",
        "data-ke-selectall": "1",
        title: t("Select or deselect all projects on this page"),
      });
      input.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSelectAll();
      });
      wrapper = el("div", { class: "checkbox ke-select-all-box" }, [
        el("label", { class: "checkbox__wrapper" }, [input]),
      ]);
      cell.appendChild(wrapper);
    }
    refs.selectAllInput = wrapper.querySelector("input") as HTMLInputElement;
    updateSelectAllIcon();
  }

  // ---------- table events ----------

  function bindTableEvents(): void {
    const t = findTableRoot();
    if (!t || t.getAttribute("data-ke-bound") === "1") return;
    t.setAttribute("data-ke-bound", "1");
    t.addEventListener("click", (e) => {
      const tgt = e.target as Element | null;
      if (tgt && tgt.matches && tgt.matches('[data-field="checkbox"] input[type="checkbox"]')) {
        setTimeout(syncSelection, 0);
      }
    });
  }

  // ---------- row status icons (replace only affected checkboxes) ----------

  function findRowByUid(uid: UID): Element | null {
    for (const row of findBodyRows() || []) {
      if (KE.scraper.getRowUid(row) === uid) return row;
    }
    return null;
  }

  function getRowCheckboxCell(row: Element | null): HTMLElement | null {
    return row ? (row.querySelector('[data-field="checkbox"]') as HTMLElement) : null;
  }

  function setIconToStatus(icon: HTMLElement, status: string, detail?: string): void {
    icon.innerHTML = "";
    icon.appendChild(buildStatusSvg(status));
    icon.className = `ke-row-status ke-row-status-${status}`;
    icon.title = status + (detail ? ": " + detail : "");
  }

  /** Swaps checkboxes only for the affected (selected) rows. */
  function replaceRowCheckboxes(uids: UID[]): void {
    for (const uid of uids) {
      const row = findRowByUid(uid);
      const cb = KE.scraper.getRowCheckbox(row);
      const cell = getRowCheckboxCell(row);
      if (!cb || !cell || statusIcons[uid]) continue;
      const wrapper = cb.closest(".checkbox") || cb.parentElement;
      rowBoxes[uid] = wrapper;
      const icon = el("span", { class: "ke-row-status ke-row-status-pending" });
      setIconToStatus(icon, "pending");
      cell.replaceChild(icon, wrapper as ChildNode);
      statusIcons[uid] = icon;
    }
  }

  function updateRowStatus(uid: UID, status: string, detail?: string): void {
    const icon = statusIcons[uid];
    if (!icon || !icon.isConnected) return;
    setIconToStatus(icon, status, detail);
  }

  function restoreRowCheckboxes(): void {
    for (const uid of Object.keys(rowBoxes)) {
      const wrapper = rowBoxes[uid];
      const row = findRowByUid(uid);
      const cell = getRowCheckboxCell(row);
      if (cell && wrapper && !wrapper.isConnected) {
        const icon = statusIcons[uid];
        if (icon && icon.isConnected) cell.replaceChild(wrapper, icon);
        else if (!cell.querySelector(".checkbox")) cell.appendChild(wrapper);
      }
      delete rowBoxes[uid];
      if (statusIcons[uid]) delete statusIcons[uid];
    }
  }

  function replaceSelectAllCheckbox(): void {
    if (!refs.selectAllInput || selectAllIcon || !refs.selectAllInput.isConnected) return;
    const cell = refs.selectAllInput.closest('[data-field="checkbox"]');
    const wrapper = (refs.selectAllInput.closest(".checkbox") || refs.selectAllInput.parentElement) as HTMLElement | null;
    if (!cell || !wrapper) return;
    selectAllBox = wrapper;
    const icon = el("span", { class: "ke-row-status ke-row-status-running" });
    setIconToStatus(icon, "running");
    icon.className += " ke-select-all-box";
    cell.replaceChild(icon, wrapper);
    selectAllIcon = icon;
  }

  function restoreSelectAllCheckbox(): void {
    if (!selectAllBox || !selectAllIcon) return;
    const cell = selectAllIcon.closest('[data-field="checkbox"]');
    if (cell && selectAllIcon.isConnected && !selectAllBox.isConnected) {
      cell.replaceChild(selectAllBox, selectAllIcon);
    }
    selectAllBox = null;
    selectAllIcon = null;
    updateSelectAllIcon();
  }

  // ---------- run wiring ----------

  function selectedCountries(): Array<{ value: string; label: string }> {
    return countryPicker ? countryPicker.selected() : [];
  }

  function selectedSectors(): Array<{ value: string; label: string }> {
    return sectorPicker ? sectorPicker.selected() : [];
  }

  async function onRunClick(): Promise<void> {
    if (running) return;
    const action = refs.actionSelect ? refs.actionSelect.value : "";
    if (!action) {
      showDialogInPage(t("Select an action before running."), document.body);
      return;
    }
    const def = getActionDef(action);
    currentRunTitle = def ? t(def.label as keyof EnDict) : action;
    // Panel actions have no project target: running one opens its modal UI
    // directly (e.g. KE.collect.openPanel) instead of the item/row loop.
    if (def && def.kind === "panel") {
      if (KE.collect && typeof KE.collect.openPanel === "function") {
        KE.collect.openPanel();
        return;
      }
      showDialogInPage(t("This action is not available."), document.body);
      return;
    }
    const source = refs.sourceSelect ? refs.sourceSelect.value : "selected";
    const wholeAccount = source === "all";
    const uids = wholeAccount ? [] : getTargetUids();
    if (!wholeAccount && uids.length === 0) {
      showDialogInPage(
        source === "manual"
          ? t("Enter at least one valid project UID.")
          : t("No projects selected on the page."),
        document.body
      );
      return;
    }
    startRun({
      uids,
      wholeAccount,
      source,
      filterUrl: lastFilterUrl,
      resolveWholeAccount: resolveAllProjectUids,
      action,
      username: refs.usernameInput ? refs.usernameInput.value.trim() : "",
      users: refs.usersInput ? parseUsersInput(refs.usersInput.value) : [],
      permission: refs.permSelect ? refs.permSelect.value : "",
      prefix: refs.prefixInput ? refs.prefixInput.value : "",
      suffix: refs.suffixInput ? refs.suffixInput.value : "",
      findText: refs.findInput ? refs.findInput.value : "",
      replaceText: refs.replaceInput ? refs.replaceInput.value : "",
      description: refs.descriptionInput ? refs.descriptionInput.value : "",
      countries: selectedCountries(),
      sectors: selectedSectors(),
      tags: refs.tagsInput ? parseTagsInput(refs.tagsInput.value) : [],
      tagsMode: refs.tagsModeSelect ? (refs.tagsModeSelect.value as "append" | "remove" | "replace") : "append",
      sourceProject: refs.sourceProjectInput ? refs.sourceProjectInput.value.trim() : "",
      templateId: refs.templateSelect ? refs.templateSelect.value : "",
      moveForms: transferFormsChecked(),
      moveSubmissions: transferSubmissionsChecked(),
      transferReady,
    });
  }

  /** Runs bulk/account options with the standard toolbar wiring attached. */
  function startRun(fields: RunOptions): void {
    getActions().run(Object.assign({}, fields, {
      onStatus: setStatus,
      onStarted: onRunStarted,
      onFinished: onRunFinished,
      onPaused: onRunPaused,
      onProgress: (msg: string, done?: number, total?: number) => {
        const resumeOf = fields.resumeOf;
        if (resumeOf && typeof done === "number") {
          const origDone = resumeOf.processed + done;
          const origTotal = resumeOf.total;
          setRunProgress(origDone, origTotal);
          setRunStep((msg || "").replace(/\(\d+\/\d+\)/, `(${origDone}/${origTotal})`));
        } else {
          setRunStep(msg);
          if (typeof done === "number") setRunProgress(done, total);
        }
      },
    }));
  }

  function setStatus(uid: UID, status: string, detail?: string): void {
    updateRowStatus(uid, status, detail);
  }

  function onRunStarted(uids: UID[], def: Action): void {
    KE.components.dismissAllToasts();
    // A freshly started run invalidates any previously saved pause snapshot.
    paused = false;
    pausedInfo = null;
    pausedAction = "";
    pausedUser = "";
    if (KE.pausedRun) KE.pausedRun.clear();
    hideResume();
    if (KE.auth && typeof KE.auth.getUsername === "function") {
      KE.auth.getUsername().then((u) => { pausedUser = u || ""; }).catch(() => {});
    }
    const list = uids || [];
    ensureRunToast(
      currentRunTitle,
      def.kind === "account"
        ? t((def.loadingStep || "Fetching project list...") as keyof EnDict)
        : // The action's OWN step label, not a hardcoded "Running". This is the
          // first thing the toast shows and it stays until the first project
          // finishes, so a hardcoded word here left every bulk action reading
          // "Running... (0/2)" while it was in fact moving projects — and the
          // label then jumped mid-run, which looked like two different runs.
          //
          // The counter is the project BEING PROCESSED, not the number finished,
          // so a two-project run reads 1/2 then 2/2. Counting completions showed
          // 0/2 for the whole of the first project, which reads as "nothing has
          // happened yet" while a copy is in flight.
          t("{step}... ({done}/{total})", {
            step: t((def.stepLabel || "Running") as keyof EnDict),
            done: list.length ? 1 : 0,
            total: list.length,
          })
    );
    if (list.length) setRunProgress(0, list.length);
    runningUids = list;
    lockUI(true);
    if (def.kind === "account") return;
    replaceRowCheckboxes(runningUids);
    replaceSelectAllCheckbox();
  }

  async function onRunFinished(res: RunReport | AccountReport): Promise<void> {
    lockUI(false);
    paused = false;
    pausedInfo = null;
    pausedAction = "";
    if (KE.pausedRun) KE.pausedRun.clear();
    finishRunToast();
    restoreRowCheckboxes();
    restoreSelectAllCheckbox();
    runningUids = [];
    syncSelection();
    if (res.stopped || res.error || res.empty) {
      applyReportUI(res.ui);
      return;
    }
    if (res.kind !== "account" && KE.tagsColumn && typeof KE.tagsColumn.applyRunReport === "function") {
      KE.tagsColumn.applyRunReport(res.report || []);
    }
    applyReportUI(res.ui);
    if (res.kind === "account") setTimeout(syncSelection, 4000);
  }

  /**
   * Renders the finished payload of any action into the result UI: a dialog
   * (`ui.dialog`) or a toast with metrics + downloadable report file(s)
   * (`ui.type/title/description/metrics/files`). Filename prefixes resolve
   * up-front (against the budget-capped username lookup) so the download
   * click feels instant.
   */
  function applyReportUI(ui?: RunFinishedUi): void {
    if (!ui) return;
    if (ui.dialog) {
      showDialogInPage(ui.dialog as string, document.body);
      return;
    }
    const files = ui.files || [];
    const fnamePromises = files.map((f) => KE.exportSvc.makeFilename(f.filename));
    const download = async () => {
      for (let i = 0; i < files.length; i++) {
        KE.exportSvc.download(await fnamePromises[i], files[i].csv || "");
        if (i < files.length - 1) await new Promise((r) => setTimeout(r, 600));
      }
    };
    showToast({
      type: ui.type || "success",
      title: ui.title || t("Finished"),
      description: ui.description || "",
      metrics: ui.metrics || [],
      // A run that produced a report keeps its toast until the user closes it,
      // downloads the report, or starts another run (which dismisses all toasts).
      // It used to disappear on its own after 6 seconds, taking the counts and
      // the download button with it — worst on a whole-project run, where the
      // numbers are the whole point.
      duration: files.length ? 0 : undefined,
      action: files.length
        ? {
            label: files.length === 1 ? t("Download report") : t("Download {n} files", { n: files.length }),
            onClick: download,
          }
        : null,
    });
  }

  /** Resolves UIDs for a whole-account modify run, respecting the current list filter. */
  async function resolveAllProjectUids(signal: AbortSignal): Promise<UID[]> {
    ensureRunToast(currentRunTitle, t("Resolving projects..."));
    return KE.surveys.resolveUids({
      filterUrl: lastFilterUrl,
      signal,
      onProgress: (msg: string, done?: number, total?: number) => {
        setRunStep(msg);
        if (typeof done === "number") setRunProgress(done, total);
      },
    });
  }

  window.KoboEnhance.integration = { init };
})();