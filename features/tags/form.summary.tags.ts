/**
 * features/tags/form.summary.tags.ts — editable "Tags" on the Form Summary
 * page (#/forms/<uid>/summary).
 *
 * Kobo already loads the single-asset detail response — which includes
 * settings.extra_metadata.tags — when this page opens. entry/inject.js
 * captures that response and posts it over the __koboenhance__ channel as an
 * "asset-detail" message, so NO extra API call is made for display.
 *
 * UI: the group shows a top row with the "Add a tag..." field (taking the
 * available width) and an "Edit tags" (pencil) button, with the tags as chips
 * below. Hovering (or keyboard focus) reveals an × on a chip to remove it;
 * the field appends new tags (Enter / blur; Backspace on an empty field
 * removes the last chip; Escape cancels without applying). The edit button
 * opens a menu listing the tags as draggable rows so they can be reordered or
 * deleted. Edits apply instantly and persist debounced by PATCHing the FULL
 * freshly-fetched extra_metadata object (Object.assign on top of fetchAsset),
 * so notes and every other key are preserved.
 */
(function () {
  const KE = window.KoboEnhance;
  const { t } = KE.i18n;
  const { el } = KE.dom;

  const TEAM_ROW_SEL =
    '[class*="form-view__row--team"]:not([data-ke-form-tags="row"])';
  const STYLE_ID = "ke-form-summary-tags-styles";

  // uid -> [tag, ...] cache captured from Kobo's own responses.
  const tagsByUid: Record<string, string[]> = {};
  let lastDetailUid: string | null = null;
  let scheduleTimer: ReturnType<typeof setTimeout> | null = null;

  // editor element/state
  let rowEl: HTMLElement | null = null;
  let chipsEl: HTMLElement | null = null;
  let inputEl: HTMLInputElement | null = null;
  let suppressBlurCommit = false;
  let editBtn: HTMLButtonElement | null = null;
  let menuPop: HTMLElement | null = null;
  let dragIndex = -1;
  let populatedUid: string | null = null;
  let pending: string[] = [];
  let dirty = false;
  let saving = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveController: AbortController | null = null;
  let saveProgress: ProgressToastHandle | null = null;

  function currentUid(): string | null {
    const m = window.location.hash.match(/\/forms\/([a-zA-Z][a-zA-Z0-9]{21,})(?:\/|$)/);
    return m ? m[1] : lastDetailUid;
  }

  function findTeamRows(): Element[] {
    return Array.from(document.querySelectorAll(TEAM_ROW_SEL));
  }

  function findQuickLinks(): HTMLElement | null {
    return document.querySelector('[class*="form-view__row--quick-links"]') as HTMLElement | null;
  }

  function findRightColumn(): HTMLElement | null {
    return document.querySelector('[class*="form-view__column--right"]') as HTMLElement | null;
  }

  function svgIcon(path: string): SVGSVGElement {
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
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", path);
    svg.appendChild(p);
    return svg;
  }

  /** Auto-closing toast (transient statuses). */
  function notify(title: string, type?: string): void {
    const t = KE.components.showToast({ title, type: type || "info" });
    if (t && typeof t.dismiss === "function") setTimeout(() => t.dismiss(), 2500);
  }

  function buildEditor(): void {
    const template = findTeamRows()[0] || null;
    const row = (template
      ? (template.cloneNode(true) as HTMLElement)
      : el("div", { class: "form-view__row form-view__row--team" }));
    row.setAttribute("data-ke-form-tags", "row");

    const share = row.querySelector(".team-sharing-button");
    if (share) share.remove();

    let label = row.querySelector(".form-view__cell--label") as HTMLElement | null;
    if (!label) {
      label = el(
        "div",
        { class: "form-view__cell form-view__cell--label form-view__cell--first" }
      );
      row.insertBefore(label, row.firstChild);
    }
    label.textContent = t("Tags");

    let box = row.querySelector(".form-view__cell--box") as HTMLElement | null;
    if (box) {
      box.textContent = "";
    } else {
      box = el("div", { class: "form-view__cell form-view__cell--box form-view__cell--padding" });
      row.appendChild(box);
    }

    const boxWrap = el("div", { class: "ke-tags-box" });
    const tools = el("div", { class: "ke-tags-tools" });
    inputEl = el("input", {
      type: "text",
      class: "ke-input ke-tags-text ke-tags-edit-input",
      placeholder: t("Add a tag..."),
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    wireInlineInput(inputEl);
    editBtn = el("button", {
      type: "button",
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon ke-tags-kebab",
      "aria-label": t("Edit tags"),
      title: t("Edit tags"),
    }, [svgIcon("M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z")]) as HTMLButtonElement;
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu();
    });
    tools.appendChild(inputEl);
    tools.appendChild(editBtn);
    chipsEl = el("div", { class: "ke-form-tags" });
    boxWrap.appendChild(tools);
    boxWrap.appendChild(chipsEl);
    box.appendChild(boxWrap);

    rowEl = row;
    const column = findRightColumn();
    if (column) {
      column.appendChild(row);
    } else {
      const rows = findTeamRows();
      if (rows.length) {
        (rows[rows.length - 1] as Element).insertAdjacentElement("afterend", row);
      } else {
        const link = findQuickLinks();
        if (link) link.insertAdjacentElement("afterend", row);
      }
    }
    populatedUid = null;
    dirty = false;
    pending = [];
  }

  function ensureEditor(): void {
    const column = findRightColumn();
    const rows = findTeamRows();
    const quick = findQuickLinks();
    if (!rowEl || !rowEl.isConnected) {
      if (column || rows.length || quick) buildEditor();
      return;
    }
    if (column) {
      if (rowEl.parentElement !== column || column.lastElementChild !== rowEl) {
        column.appendChild(rowEl);
      }
      return;
    }
    if (rows.length) {
      const last = rows[rows.length - 1];
      if (rowEl.parentElement !== last.parentElement || rowEl.nextElementSibling !== last) {
        last.insertAdjacentElement("afterend", rowEl);
      }
    } else if (quick && rowEl.parentElement !== quick.parentElement) {
      quick.insertAdjacentElement("afterend", rowEl);
    }
  }

  function wireInlineInput(inp: HTMLInputElement): void {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (inp.value && inp.value.trim()) addTag(inp.value);
        else inp.blur();
      } else if (e.key === "Backspace" && !inp.value) {
        const last = pending[pending.length - 1];
        if (last) removeTag(last);
      } else if (e.key === "Escape") {
        suppressBlurCommit = true;
        inp.blur();
      }
    });
    // Clicking outside the field commits a pending (non-empty) type-ahead.
    inp.addEventListener("blur", () => {
      if (suppressBlurCommit) {
        suppressBlurCommit = false;
        return;
      }
      if (inp.value && inp.value.trim()) addTag(inp.value);
    });
  }

  function renderChips(): void {
    if (!chipsEl) return;
    chipsEl.textContent = "";
    for (const tag of pending) {
      const chip = el("span", { class: "ke-tag", title: tag });
      chip.appendChild(document.createTextNode(tag));
      const x = el("button", {
        type: "button",
        class: "ke-tag-x",
        "aria-label": t("Remove {tag}", { tag }),
        title: t("Remove {tag}", { tag }),
        text: "\u00D7",
      });
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        removeTag(tag);
      });
      chip.appendChild(x);
      chipsEl.appendChild(chip);
    }
  }

  // ---------- edit menu ----------

  function openMenu(): void {
    if (!rowEl || !editBtn) return;
    renderMenu();
    positionMenu();
    setTimeout(() => {
      document.addEventListener("mousedown", onOutside, true);
      window.addEventListener("scroll", onScrollClose, true);
      window.addEventListener("keydown", onMenuKey, true);
    }, 0);
  }

  function toggleMenu(): void {
    if (menuPop && menuPop.isConnected) {
      closeMenu();
      return;
    }
    openMenu();
  }

  function refreshMenu(): void {
    if (menuPop && menuPop.isConnected) {
      renderMenu();
      positionMenu();
    }
  }

  function closeMenu(): void {
    if (menuPop) {
      menuPop.remove();
      menuPop = null;
    }
    dragIndex = -1;
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("scroll", onScrollClose, true);
    window.removeEventListener("keydown", onMenuKey, true);
  }

  function onOutside(e: MouseEvent): void {
    const t = e.target as Node | null;
    if (menuPop && !menuPop.contains(t) && editBtn && !editBtn.contains(t)) closeMenu();
  }

  function onScrollClose(e: Event): void {
    if (!menuPop) return;
    const t = e.target as Node | null;
    // Ignore scrolls originating inside the menu itself (e.g. scrolling its
    // tag list) — only close when the page/other containers scroll.
    if (t && menuPop.contains(t)) return;
    closeMenu();
  }

  function onMenuKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && menuPop) closeMenu();
  }

  function positionMenu(): void {
    if (!menuPop || !editBtn) return;
    const rect = editBtn.getBoundingClientRect();
    menuPop.style.position = "fixed";
    menuPop.style.zIndex = "300";
    menuPop.style.top = rect.bottom + 4 + "px";
    menuPop.style.left = rect.left + "px";
    menuPop.style.minWidth = "240px";
    (document.body || document.documentElement).appendChild(menuPop);
    const m = menuPop.getBoundingClientRect();
    if (m.right > window.innerWidth - 8) {
      menuPop.style.left = Math.max(8, window.innerWidth - m.width - 8) + "px";
    }
    if (m.bottom > window.innerHeight - 8) {
      menuPop.style.top = Math.max(8, window.innerHeight - m.height - 8) + "px";
    }
  }

  function renderMenu(): void {
    if (menuPop) {
      menuPop.remove();
      menuPop = null;
    }
    menuPop = el("div", { class: "ke-tags-menu-pop", role: "menu", "data-ke-tags": "pop" });

    if (pending.length === 0) {
      menuPop.appendChild(el("div", { class: "ke-tags-menu-empty", text: t("No tags yet") }));
    }
    for (let i = 0; i < pending.length; i++) {
      const tag = pending[i];
      const grip = el("span", { class: "ke-tags-drag" }, [
        svgIcon("M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"),
      ]);
      const lbl = el("span", { class: "ke-tags-edit-label", text: tag }, []);
      const del = el("button", {
        type: "button",
        class: "ke-tag-x",
        "aria-label": t("Remove {tag}", { tag }),
        title: t("Remove {tag}", { tag }),
        text: "\u00D7",
      });
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        removeTag(tag);
      });
      const r = el("div", { class: "ke-tags-edit-row", role: "menuitem", draggable: "true" }, [grip, lbl, del]);
      r.addEventListener("dragstart", (ev) => {
        dragIndex = i;
        const dt = ev.dataTransfer;
        if (dt) dt.effectAllowed = "move";
      });
      r.addEventListener("dragover", (ev) => ev.preventDefault());
      r.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const from = dragIndex;
        const to = i;
        dragIndex = -1;
        if (from !== to && from >= 0 && to >= 0) reorderTag(from, to);
      });
      menuPop.appendChild(r);
    }
  }

  // ---------- data sync ----------

  /** Syncs the editor with the current cache; never clobbers in-progress edits. */
  function applyCached(): void {
    const uid = currentUid();
    if (!uid || !rowEl) return;
    if (uid !== populatedUid) {
      closeMenu();
      populatedUid = uid;
      dirty = false;
      pending = (tagsByUid[uid] || []).slice();
      renderChips();
      return;
    }
    if (dirty) return;
    const cached = tagsByUid[uid] || [];
    if (JSON.stringify(cached) !== JSON.stringify(pending)) {
      pending = cached.slice();
      renderChips();
      refreshMenu();
    }
  }

  function refresh(): void {
    ensureEditor();
    applyCached();
  }

  function addTag(raw: string): void {
    const v = String(raw || "").trim();
    if (!v) {
      if (inputEl) inputEl.value = "";
      return;
    }
    const exists = pending.some((t) => t.toLowerCase() === v.toLowerCase());
    if (exists) {
      notify(t("Tag \"{tag}\" already exists", { tag: v }), "warning");
      if (inputEl) inputEl.value = "";
      return;
    }
    pending.push(v);
    dirty = true;
    renderChips();
    refreshMenu();
    scheduleSave();
    if (inputEl) inputEl.value = "";
  }

  function removeTag(tag: string): void {
    const idx = pending.indexOf(tag);
    if (idx === -1) return;
    pending.splice(idx, 1);
    dirty = true;
    renderChips();
    refreshMenu();
    scheduleSave();
  }

  function reorderTag(from: number, to: number): void {
    const moved = pending.splice(from, 1)[0];
    if (!moved) return;
    pending.splice(to, 0, moved);
    dirty = true;
    renderChips();
    refreshMenu();
    scheduleSave();
  }

  function scheduleSave(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(runSave, 600);
  }

  function runSave(): void {
    saveTimer = null;
    if (saving) {
      saveTimer = setTimeout(runSave, 150);
      return;
    }
    void persist();
  }

  async function persist(): Promise<void> {
    const uid = populatedUid || currentUid();
    if (!uid) return;
    const next = pending.slice();
    const current = tagsByUid[uid] || [];
    if (!dirty || JSON.stringify(next) === JSON.stringify(current)) {
      dirty = false;
      return;
    }
    saving = true;
    if (saveProgress) saveProgress.finish();
    saveProgress = KE.components.showProgressToast(t("Saving tags..."));
    if (saveController) saveController.abort();
    saveController = new AbortController();
    const controller = saveController;
    const progress = saveProgress;
    try {
      // Read the CURRENT extra_metadata and merge, so notes (and any other
      // keys) are preserved — never PATCH a bare { tags } skeleton.
      const asset = await KE.apiAssets.fetchAsset(uid, controller.signal);
      const currentExtra = ((asset && asset.settings && asset.settings.extra_metadata) || {}) as ExtraMetadata;
      await KE.apiAssets.updateAssetExtraMetadata(
        uid,
        Object.assign({}, currentExtra, { tags: next }),
        controller.signal
      );
      tagsByUid[uid] = next.slice();
      pending = next.slice();
      dirty = false;
      notify(t("Tags saved"), "success");
    } catch (e) {
      if (controller.signal.aborted) return;
      pending = (tagsByUid[uid] || []).slice();
      dirty = false;
      renderChips();
      refreshMenu();
      const err = (e as { detail?: unknown; message?: unknown }) || {};
      KE.components.showToast({
        title: t("Could not save tags"),
        type: "warning",
        description: (err.detail || err.message || String(e)) as string,
      });
    } finally {
      if (progress) progress.finish();
      saving = false;
      saveController = null;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const d = event.data;
    if (d && d.channel === "__koboenhance__" && d.type === "asset-detail") {
      if (!d.uid || !Array.isArray(d.tags)) return;
      tagsByUid[d.uid] = (d.tags as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
      lastDetailUid = d.uid;
      const uid = currentUid();
      if (uid && uid === d.uid) applyCached();
    }
  });

  function injectStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .ke-tags-box {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
      }
      .ke-tags-tools {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .ke-tags-tools .ke-tags-edit-input { flex: 1 1 auto; min-width: 0; }
      .ke-tags-kebab {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
      }
      .ke-form-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        width: 100%;
      }
      .ke-form-tags .ke-tag { font-size: 12px; }
      .ke-form-tags .ke-tag-x { display: none; }
      .ke-form-tags .ke-tag:hover .ke-tag-x,
      .ke-form-tags .ke-tag:focus-within .ke-tag-x { display: inline-flex; }
      .ke-tags-menu-pop {
        position: fixed;
        background: #fff;
        border: 1px solid #d4d4d4;
        border-radius: 6px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
        padding: 6px;
        z-index: 300;
        max-height: 320px;
        overflow-y: auto;
      }
      .ke-tags-menu-empty { padding: 6px 10px; color: #888; font-size: 12px; }
      .ke-tags-edit-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        border-radius: 4px;
      }
      .ke-tags-edit-row:hover { background: #f5f5f6; }
      .ke-tags-edit-row[draggable="true"] { cursor: grab; }
      .ke-tags-edit-row[draggable="true"]:active { cursor: grabbing; }
      .ke-tags-drag { color: #9e9e9e; cursor: grab; display: inline-flex; }
      .ke-tags-edit-label {
        flex: 1 1 auto;
        font-size: 12px;
        color: #2e2e2e;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ke-tags-edit-row .ke-tag-x { display: inline-flex; }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function schedule(): void {
    if (scheduleTimer !== null) clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(refresh, 150);
  }

  function observe(): void {
    const target = document.body || document.documentElement;
    const obs = new MutationObserver(schedule);
    obs.observe(target, { childList: true, subtree: true });
    window.addEventListener("hashchange", schedule);
    setInterval(() => {
      if (findTeamRows().length || findQuickLinks() || findRightColumn()) refresh();
    }, 2000);
  }

  function init(): void {
    injectStyles();
    observe();
    refresh();
  }

  window.KoboEnhance.formSummaryTags = { init, render: refresh };
})();