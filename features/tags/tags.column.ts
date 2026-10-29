/**
 * features/tags/tags.column.ts — "Tags" column for Kobo's projects table.
 *
 * Injects a header cell + a body cell per project row, wired into Kobo's
 * native Fields menu so it behaves like a native column. Visibility is
 * persisted in localStorage (ke:tags:visible). Cells are filled with each
 * project's tags (settings.extra_metadata.tags), loaded once and refreshed
 * periodically.
 *
 * The table is a CSS-grid layout where each row holds every column cell,
 * so the column also appends one extra grid track via an injected style
 * rule (with a flex/table fallback).
 */
(function () {
  const KE = window.KoboEnhance;
  const { t } = KE.i18n;
  const { el } = KE.dom;

  const STORE_KEY = "ke:tags:visible";
  const ROW_SEL = '[class*="projectsTableRow-module__row"]';
  const ROW_TYPE_SEL = '[class*="projectsTableRow-module__rowTypeHeader"]';

  type TaggedCell = Element & { __keFilledUid?: string | null };

  interface MenuCapture {
    menuClass: string;
    itemClass: string;
    sectionClass: string;
    labelClass: string;
    spacerHTML: string;
  }

  let trackStyle: HTMLElement | null = null;

  // uid -> [tag, ...] map; null until data arrives.
  let tagsCache: Record<string, string[]> | null = null;
  let dataLoadedAt = 0;
  let lastFillSource: Record<string, string[]> | null = null;
  let fallbackScheduled = false;

  // Mantine menu structure captured from a live native column menu, so the
  // Tags "Hide field" menu can reuse the real hashed classes.
  let menuTemplate: MenuCapture | null = null;
  let captureStarted = false;
  let openMenuEl: HTMLElement | null = null;

  function findTableRoot(): Element | null {
    return document.querySelector('[class*="projectsTable-module__root"]');
  }

  function findHeaderRow(): Element | null {
    const t = findTableRoot();
    return t ? t.querySelector(ROW_TYPE_SEL) : null;
  }

  /** Body rows that actually represent a project (have a name cell). */
  function findProjectRows(): Element[] {
    const t = findTableRoot();
    if (!t) return [];
    return Array.from(t.querySelectorAll(ROW_SEL)).filter(
      (r) => !r.matches(ROW_TYPE_SEL) && r.querySelector('[data-field="name"]')
    );
  }

  function isVisible(): boolean {
    return localStorage.getItem(STORE_KEY) !== "0";
  }

  function setVisible(next: boolean): void {
    localStorage.setItem(STORE_KEY, next ? "1" : "0");
  }

  // ---------- native-style "Hide field" menu ----------

  function captureMenuTemplate(): void {
    const menus = Array.from(
      document.querySelectorAll('[data-menu-dropdown="true"]:not([data-ke-tags="menu"])')
    );
    for (const menu of menus) {
      const item = menu.querySelector('[data-menu-item="true"], [class*="mantine-Menu-item"]');
      if (!item) continue;
      const section = item.querySelector('[class*="mantine-Menu-itemSection"], [data-position="left"]');
      const labelEl = item.querySelector('[class*="mantine-Menu-itemLabel"]');
      menuTemplate = {
        menuClass: menu.getAttribute("class") || "",
        itemClass: item.getAttribute("class") || "",
        sectionClass: section ? section.getAttribute("class") || "" : "",
        labelClass: labelEl ? labelEl.getAttribute("class") || "" : "",
        spacerHTML: menu.firstElementChild ? menu.firstElementChild.outerHTML : "",
      };
      return;
    }
  }

  function startCapture(): void {
    captureMenuTemplate();
    if (captureStarted) return;
    captureStarted = true;
    const target = document.body || document.documentElement;
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (
            n.nodeType === 1 &&
            (n as Element).matches &&
            (n as Element).matches('[data-menu-dropdown="true"]:not([data-ke-tags="menu"])')
          ) {
            captureMenuTemplate();
            return;
          }
        }
      }
    });
    obs.observe(target, { childList: true, subtree: true });
  }

  function buildMenu(): HTMLElement {
    const menu = el("div", {
      class: "ke-tags-menu" + (menuTemplate ? " " + menuTemplate.menuClass : ""),
    });
    menu.setAttribute("data-ke-tags", "menu");
    menu.setAttribute("data-menu-dropdown", "true");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-orientation", "vertical");
    menu.setAttribute("tabindex", "-1");
    if (menuTemplate && menuTemplate.spacerHTML) {
      menu.insertAdjacentHTML("beforeend", menuTemplate.spacerHTML);
    }
    const item = el("button", {
      type: "button",
      role: "menuitem",
      tabindex: "-1",
      onclick: hideColumn,
    });
    item.className =
      "ke-tags-menu-item" +
      (menuTemplate ? " " + menuTemplate.itemClass : " mantine-Menu-item mantine-UnstyledButton-root");
    const section = el("div", {
      class:
        "ke-tags-menu-section" +
        (menuTemplate ? " " + menuTemplate.sectionClass : " mantine-Menu-itemSection"),
      "data-position": "left",
    });
    section.appendChild(el("i", { class: "k-icon--size-m k-icon k-icon-hide" }));
    const labelEl = el("div", {
      class:
        "ke-tags-menu-label" +
        (menuTemplate ? " " + menuTemplate.labelClass : " mantine-Menu-itemLabel"),
      text: t("Hide field"),
    });
    item.appendChild(section);
    item.appendChild(labelEl);
    menu.appendChild(item);
    return menu;
  }

  function headerTriggers(): NodeListOf<Element> {
    return document.querySelectorAll('[data-ke-tags="header"] button[aria-haspopup="menu"]');
  }

  function closeMenu(): void {
    if (openMenuEl) {
      openMenuEl.remove();
      openMenuEl = null;
    }
    document.removeEventListener("mousedown", onMenuOutside, true);
    window.removeEventListener("scroll", onMenuScroll, true);
    window.removeEventListener("keydown", onMenuKey, true);
    for (const b of headerTriggers()) {
      b.setAttribute("aria-expanded", "false");
      const caret = b.querySelector("i.k-icon-caret-down, i.k-icon-caret-up");
      if (caret) {
        caret.classList.remove("k-icon-caret-up");
        caret.classList.add("k-icon-caret-down");
      }
    }
  }

  function positionMenu(menu: HTMLElement, btn: HTMLElement): void {
    const rect = btn.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.zIndex = "300";
    menu.style.top = rect.bottom + 6 + "px";
    menu.style.left = rect.left + "px";
    menu.style.width = "max-content";
    (document.body || document.documentElement).appendChild(menu);
    const mrect = menu.getBoundingClientRect();
    if (mrect.right > window.innerWidth - 8) {
      menu.style.left = Math.max(8, window.innerWidth - mrect.width - 8) + "px";
    }
  }

  function toggleMenu(btn: HTMLElement): void {
    if (openMenuEl) {
      closeMenu();
      return;
    }
    startCapture();
    const menu = buildMenu();
    positionMenu(menu, btn);
    openMenuEl = menu;
    btn.setAttribute("aria-expanded", "true");
    const caret = btn.querySelector("i.k-icon-caret-down, i.k-icon-caret-up");
    if (caret) {
      caret.classList.remove("k-icon-caret-down");
      caret.classList.add("k-icon-caret-up");
    }
    setTimeout(() => {
      document.addEventListener("mousedown", onMenuOutside, true);
      window.addEventListener("scroll", onMenuScroll, true);
      window.addEventListener("keydown", onMenuKey, true);
    }, 0);
  }

  function onMenuOutside(e: Event): void {
    if (openMenuEl && !openMenuEl.contains(e.target as Node | null)) closeMenu();
  }

  function onMenuScroll(): void {
    if (openMenuEl) closeMenu();
  }

  function onMenuKey(e: Event): void {
    if ((e as KeyboardEvent).key === "Escape") closeMenu();
  }

  function hideColumn(): void {
    setVisible(false);
    ensureTagsColumn();
    syncFieldCheckbox();
    closeMenu();
  }

  function syncFieldCheckbox(): void {
    const input = document.querySelector('[data-ke-tags="field-item"] input[type="checkbox"]') as HTMLInputElement | null;
    if (input) input.checked = isVisible();
  }

  // ---------- column cells ----------

  function makeHeaderCell(): HTMLElement {
    const src = document.querySelector(
      '[class*="projectsTableHeader-module__columnRoot"]:not([data-field="name"])'
    );
    const cell = (src ? (src.cloneNode(false) as HTMLElement) : el("div", { class: "ke-tags-header-cell" }));
    cell.removeAttribute("id");
    cell.setAttribute("data-field", "ke-tags");
    cell.setAttribute("data-ke-tags", "header");

    // Native column headers are a clickable <button> with a caret + label;
    // clone one so the Tags header looks and interacts the same way.
    const btnSrc = src
      ? src.querySelector('button[class*="projectsTableHeader-module__trigger"]')
      : null;
    const btn = (btnSrc ? (btnSrc.cloneNode(true) as HTMLElement) : el("button", { type: "button", class: "ke-tags-trigger" }));
    btn.removeAttribute("id");
    btn.removeAttribute("aria-controls");
    btn.removeAttribute("data-expanded");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");

    let caret = btn.querySelector(
      "i.k-icon-caret-up, i.k-icon-caret-down, i[class*='k-icon-caret']"
    );
    if (!caret) {
      caret = el("i", { class: "k-icon--size-xxs k-icon k-icon-caret-down" });
      btn.insertBefore(caret, btn.firstChild);
    } else {
      caret.classList.remove("k-icon-caret-up");
      caret.classList.add("k-icon-caret-down");
    }

    const label =
      btn.querySelector('[class*="triggerLabel"], [class*="headerLabel"]') ||
      el("span", { class: "ke-tags-trigger-label" });
    label.textContent = "Tags";

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleMenu(btn);
    });

    cell.appendChild(btn);
    return cell;
  }

  function makeBodyCell(): HTMLElement {
    const rows = findProjectRows();
    const src =
      (rows[0] && rows[0].querySelector('[data-field="sector"]')) ||
      (rows[0] && rows[0].querySelector('[data-field="countries"]')) ||
      (rows[0] && rows[0].querySelector('[data-field="status"]'));
    const cell = (src ? (src.cloneNode(false) as HTMLElement) : el("div", { class: "ke-tags-body-cell" }));
    cell.removeAttribute("data-field");
    cell.setAttribute("data-ke-tags", "cell");
    cell.textContent = "";
    return cell;
  }

  function removeColumn(): void {
    closeMenu();
    document
      .querySelectorAll('[data-ke-tags="header"], [data-ke-tags="cell"]')
      .forEach((n) => n.remove());
    if (trackStyle && trackStyle.isConnected) trackStyle.remove();
  }

  // ---------- tag data (settings.extra_metadata.tags) ----------

  function assetTags(asset: Project | null | undefined): string[] {
    const s = asset && asset.settings;
    const t = s && s.extra_metadata && s.extra_metadata.tags;
    return Array.isArray(t)
      ? t.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
      : [];
  }

  function normalizeList(list: unknown): string[] {
    return Array.isArray(list)
      ? list.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
      : [];
  }

  /** Tags captured from Kobo's own asset-list responses (posted from entry/inject.js). */
  function applyAssetResponse(assets: unknown): void {
    if (!Array.isArray(assets) || !assets.length) return;
    if (!tagsCache) tagsCache = {};
    let changed = false;
    for (const item of assets) {
      if (!item || !item.uid) continue;
      const next = normalizeList(item.tags);
      if (JSON.stringify(next) !== JSON.stringify(tagsCache[item.uid])) {
        tagsCache[item.uid] = next;
        changed = true;
      }
    }
    dataLoadedAt = Date.now();
    if (changed) {
      lastFillSource = null;
      fillAll(tagsCache);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const d = event.data;
    if (d && d.channel === "__koboenhance__" && d.type === "asset-list-detail") {
      applyAssetResponse(d.assets);
    }
  });

  /** After an Add-tags run, update cached tags locally (no extra API call). */
  function applyRunReport(report: ReportRow[]): void {
    if (!Array.isArray(report)) return;
    let changed = false;
    for (const row of report) {
      if (!row || row.Final_Status !== "success" || typeof row.New_Tags !== "string") continue;
      if (!tagsCache) tagsCache = {};
      const next = row.New_Tags ? normalizeList(row.New_Tags.split(", ")) : [];
      if (JSON.stringify(next) !== JSON.stringify(tagsCache[row.Project_UID || ""])) {
        tagsCache[row.Project_UID || ""] = next;
        changed = true;
      }
    }
    if (changed) {
      lastFillSource = null;
      fillAll(tagsCache);
    }
  }

  /** Safety net: only if Kobo's response was never captured, fetch the current list URL once. */
  async function requestFallback(): Promise<void> {
    if (tagsCache !== null) return;
    const url = (KE.store.getState().pageContext.lastFilterUrl) ||
      `${KE.auth.getBaseUrl()}/api/v2/assets/`;
    try {
      if (!tagsCache) tagsCache = {};
      await KE.pagination.fetchAllAssets(url, (page) => {
        for (const asset of page.results || []) {
          const uid = asset && asset.uid;
          if (!uid) continue;
          (tagsCache as Record<string, string[]>)[uid] = assetTags(asset);
        }
      });
      dataLoadedAt = Date.now();
      lastFillSource = null;
      fillAll(tagsCache || {});
    } catch (e) {
      /* leave empty */
    }
  }

  /** Called on every refresh; does no network work once captured data is present. */
  function ensureData(): void {
    if (!isVisible()) return;
    if (tagsCache !== null) {
      fillAll(tagsCache);
      return;
    }
    if (!fallbackScheduled) {
      fallbackScheduled = true;
      setTimeout(requestFallback, 2000);
    }
  }

  function cellUid(cell: Element): string | null {
    const row = cell.closest(ROW_SEL);
    if (!row) return null;
    const link = row.querySelector('[data-field="name"] a[href*="/forms/"]');
    const href = (link && link.getAttribute("href")) || "";
    const m = href.match(/forms\/([a-zA-Z0-9]+)/);
    return m && m[1] ? m[1] : null;
  }

  function renderCell(cell: Element, tags: unknown): void {
    cell.textContent = "";
    const list = (Array.isArray(tags) ? tags : []).filter(Boolean);
    if (list.length === 0) {
      cell.appendChild(el("span", { class: "ke-tags-empty", text: "—" }));
      return;
    }
    const wrap = el("div", { class: "ke-tags-cell" });
    for (const tag of list) {
      wrap.appendChild(el("span", { class: "ke-tag ke-tag-in-cell", title: tag, text: tag }));
    }
    cell.appendChild(wrap);
  }

  function fillAll(source: Record<string, string[]> | null): void {
    if (!source) return;
    const cells = document.querySelectorAll('[data-ke-tags="cell"]');
    for (const cell of cells) {
      const uid = cellUid(cell);
      if ((cell as TaggedCell).__keFilledUid === uid && source === lastFillSource) continue;
      renderCell(cell, (uid && source[uid]) || []);
      (cell as TaggedCell).__keFilledUid = uid;
    }
    lastFillSource = source;
  }

  // ---------- layout (grid track / flex / table fallback) ----------

  function ensureLayout(): void {
    const probe = findHeaderRow() || findProjectRows()[0];
    if (!probe) return;
    if (!trackStyle || !trackStyle.isConnected) {
      trackStyle = el("style", { id: "ke-tags-track" });
      (document.head || document.documentElement).appendChild(trackStyle);
    }
    const cs = getComputedStyle(probe);
    if (cs.display === "grid") {
      const tracks = cs.gridTemplateColumns.split(" ").map((t) => t.trim()).filter(Boolean);
      if (!tracks.length) return;
      trackStyle.textContent =
        `${ROW_SEL} { grid-template-columns: ${tracks.concat(tracks[tracks.length - 1]).join(" ")} !important; }`;
    } else if (cs.display === "flex") {
      trackStyle.textContent =
        `[data-ke-tags="header"], [data-ke-tags="cell"] { flex: 0 0 200px; }`;
    } else {
      trackStyle.textContent =
        `[data-ke-tags="header"], [data-ke-tags="cell"] { min-width: 200px; }`;
    }
  }

  function ensureTagsColumn(): void {
    if (!isVisible()) {
      removeColumn();
      return;
    }
    const header = findHeaderRow();
    if (header && !header.querySelector('[data-ke-tags="header"]')) {
      header.appendChild(makeHeaderCell());
    }
    for (const row of findProjectRows()) {
      if (!row.querySelector('[data-ke-tags="cell"]')) {
        row.appendChild(makeBodyCell());
      }
    }
    ensureLayout();
  }

  // ---------- Fields menu checkbox ----------

  function findFieldsList(): Element | null {
    const lists = Array.from(document.querySelectorAll("ul.multi-checkbox"));
    return (
      lists.find((ul) =>
        Array.from(ul.querySelectorAll(".checkbox__label")).some(
          (n) => (n.textContent || "").trim() === "Project name"
        )
      ) || null
    );
  }

  function makeFieldItem(): HTMLElement {
    const list = findFieldsList();
    const src = list ? list.querySelector("li.multi-checkbox__item") : null;
    const li = (src ? (src.cloneNode(true) as HTMLElement) : el("li", { class: "multi-checkbox__item" }));
    const wrapper = li.querySelector(".checkbox");
    const input = li.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    const label = li.querySelector(".checkbox__label");
    if (wrapper) wrapper.classList.remove("checkbox--disabled");
    if (input) {
      input.removeAttribute("disabled");
      input.checked = isVisible();
      input.addEventListener("change", () => {
        setVisible(input.checked);
        ensureTagsColumn();
        if (input.checked) ensureData();
      });
    }
    if (label) label.textContent = "Tags";
    li.setAttribute("data-ke-tags", "field-item");
    return li;
  }

  function ensureFieldItem(): void {
    const list = findFieldsList();
    if (!list || list.querySelector('[data-ke-tags="field-item"]')) return;
    list.appendChild(makeFieldItem());
  }

  function refresh(): void {
    startCapture();
    ensureTagsColumn();
    ensureFieldItem();
    ensureData();
  }

  window.KoboEnhance.tagsColumn = { refresh, isVisible, setVisible, applyRunReport };
})();