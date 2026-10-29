/**
 * features/notes/form.summary.notes.ts — "Notes" widget on the Form Summary
 * page (#/forms/<uid>/summary).
 *
 * Two views:
 *  - Read-only (default): the note text as plain, non-editable text with an
 *    "Edit" button (same button style as the Run action button) on the top
 *    right. Clicking it switches to the edit view.
 *  - Edit view: a free-form, resizable textarea with Save / Clear buttons.
 *    Save persists and returns to read-only; Clear asks for confirmation with
 *    the project's own confirm dialog (KE.components.showConfirmDialogInPage)
 *    and, on confirm, clears + returns to read-only.
 *
 * Stored in settings.extra_metadata.notes. Display mirrors the Tags row:
 * entry/inject.js captures Kobo's own single-asset response (now including
 * settings.extra_metadata.notes) and posts it over the __koboenhance__
 * channel, so NO extra API call is needed for display. Saves always PATCH the
 * FULL freshly-fetched extra_metadata object (Object.assign on top of
 * fetchAsset), so tags and every other key are preserved when notes change —
 * and the bulk tags action does the same, so notes survive tag edits.
 *
 * The row lives directly after the "Project information" row in the left
 * column (form-view__column--left), before "Submissions".
 */
(function () {
  const KE = window.KoboEnhance;
  const { t } = KE.i18n;
  const { el } = KE.dom;

  const LEFT_COLUMN_SEL = '[class*="form-view__column--left"]';
  const STYLE_ID = "ke-form-summary-notes-styles";

  // uid -> notes cache captured from Kobo's own responses.
  const notesByUid: Record<string, string> = {};
  let lastDetailUid: string | null = null;
  let scheduleTimer: ReturnType<typeof setTimeout> | null = null;

  let rowEl: HTMLElement | null = null;
  let readWrapEl: HTMLElement | null = null;
  let editWrapEl: HTMLElement | null = null;
  let valueEl: HTMLElement | null = null;
  let editBtn: HTMLButtonElement | null = null;
  let textarea: HTMLTextAreaElement | null = null;
  let saveBtn: HTMLButtonElement | null = null;
  let clearBtn: HTMLButtonElement | null = null;
  let cancelBtn: HTMLButtonElement | null = null;
  let mode: "read" | "edit" = "read";
  let populatedUid: string | null = null;
  let dirty = false;
  let saving = false;
  let saveController: AbortController | null = null;
  let saveProgress: ProgressToastHandle | null = null;

  function currentUid(): string | null {
    const m = window.location.hash.match(/\/forms\/([a-zA-Z][a-zA-Z0-9]{21,})(?:\/|$)/);
    return m ? m[1] : lastDetailUid;
  }

  function findLeftColumn(): HTMLElement | null {
    return document.querySelector(LEFT_COLUMN_SEL) as HTMLElement | null;
  }

  /** The "Project information" row — our anchor right after it. */
  function findProjectInfoRow(): HTMLElement | null {
    const column = findLeftColumn();
    if (!column) return null;
    for (const child of Array.from(column.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (!/form-view__row/.test(child.className)) continue;
      const label = child.querySelector(":scope > .form-view__cell--label") as HTMLElement | null;
      if (label && label.textContent && label.textContent.trim() === "Project information") {
        return child;
      }
    }
    return null;
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

  /** Auto-closing toast (statuses are transient: Saved / Cleared / Saving...). */
  function notify(title: string, type?: string): void {
    const t = KE.components.showToast({ title, type: type || "info" });
    if (t && typeof t.dismiss === "function") setTimeout(() => t.dismiss(), 2500);
  }

  function setMode(m: "read" | "edit"): void {
    mode = m;
    if (readWrapEl) readWrapEl.hidden = m !== "read";
    if (editWrapEl) editWrapEl.hidden = m !== "edit";
    if (m === "edit") {
      if (textarea && document.activeElement !== textarea) textarea.focus();
    } else {
      renderReadValue();
    }
  }

  function renderReadValue(): void {
    if (!valueEl) return;
    const uid = currentUid();
    const v = (uid && notesByUid[uid]) || "";
    valueEl.textContent = v || t("No note yet");
    valueEl.classList.toggle("ke-notes-empty", v === "");
  }

  function buildWidget(): void {
    const anchor = findProjectInfoRow();
    const row = el("div", { class: "form-view__row form-view__row--project-notes", "data-ke-form-notes": "row" });

    const label = el("div", { class: "form-view__cell form-view__cell--label form-view__cell--first", text: t("Notes") });
    const box = el("div", { class: "form-view__cell form-view__cell--box form-view__cell--padding" });

    // ---------- read-only view ----------
    readWrapEl = el("div", { class: "ke-notes-readrow" });
    valueEl = el("div", { class: "ke-notes-value" });
    editBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon ke-notes-edit",
      type: "button",
    }, [svgIcon("M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z")]) as HTMLButtonElement;
    editBtn.addEventListener("click", beginEdit);
    const editWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Edit note"),
      "aria-label": t("Edit note"),
    }, [editBtn]);
    readWrapEl.appendChild(valueEl);
    readWrapEl.appendChild(editWrap);

    // ---------- edit view ----------
    editWrapEl = el("div", { class: "ke-notes-editwrap" });
    textarea = el("textarea", {
      class: "ke-input ke-description-input ke-notes-textarea",
      spellcheck: "false",
      placeholder: t("Add a note..."),
      rows: "3",
    }) as HTMLTextAreaElement;
    textarea.value = "";
    textarea.addEventListener("input", () => {
      dirty = true;
    });

    saveBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon ke-notes-save",
      type: "button",
    }, [svgIcon("M20 6 9 17l-5-5"), document.createTextNode(t("Save"))]) as HTMLButtonElement;
    saveBtn.addEventListener("click", () => {
      void onSaveClick();
    });
    const saveWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Save note"),
      "aria-label": t("Save note"),
    }, [saveBtn]);

    clearBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon ke-notes-clear ke-stop-btn",
      type: "button",
    }, [svgIcon("M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"), document.createTextNode(t("Clear"))]) as HTMLButtonElement;
    clearBtn.addEventListener("click", onClearClick);
    const clearWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Clear note"),
      "aria-label": t("Clear note"),
    }, [clearBtn]);

    cancelBtn = el("button", {
      class: "k-button k-button--type-secondary k-button--size-s k-button--has-start-icon ke-notes-cancel",
      type: "button",
    }, [svgIcon("M18 6 6 18M6 6l12 12"), document.createTextNode(t("Cancel"))]) as HTMLButtonElement;
    cancelBtn.addEventListener("click", onCancelClick);
    const cancelWrap = el("span", {
      class: "right-tooltip",
      "data-tip": t("Cancel editing"),
      "aria-label": t("Cancel editing"),
    }, [cancelBtn]);

    const controls = el("div", { class: "ke-notes-controls" }, [
      clearWrap,
      el("div", { class: "ke-notes-spacer" }),
      cancelWrap,
      saveWrap,
    ]);
    editWrapEl.appendChild(textarea);
    editWrapEl.appendChild(controls);

    box.appendChild(readWrapEl);
    box.appendChild(editWrapEl);

    row.appendChild(label);
    row.appendChild(box);

    rowEl = row;
    if (anchor) anchor.insertAdjacentElement("afterend", row);
    else findLeftColumn()?.appendChild(row);

    populatedUid = null;
    dirty = false;
    mode = "read";
    setMode("read");
  }

  function ensureRow(): void {
    const anchor = findProjectInfoRow();
    if (!rowEl || !rowEl.isConnected) {
      if (anchor || findLeftColumn()) buildWidget();
      return;
    }
    if (!anchor) return;
    // Keep the widget glued right after "Project information" — React can
    // re-append its own rows, which would otherwise leave Notes mid-column.
    if (anchor.nextElementSibling !== rowEl) {
      anchor.insertAdjacentElement("afterend", rowEl);
    }
  }

  function beginEdit(): void {
    if (!textarea) return;
    const uid = currentUid();
    textarea.value = (uid && notesByUid[uid]) || "";
    populatedUid = uid || null;
    dirty = false;
    setMode("edit");
    textarea.focus();
  }

  function applyCached(uid: string, force: boolean): void {
    const cached = notesByUid[uid] || "";
    if (mode === "edit") {
      if (!textarea) return;
      if (force || uid !== populatedUid) {
        textarea.value = cached;
        populatedUid = uid;
        dirty = false;
      } else if (!dirty && document.activeElement !== textarea && textarea.value !== cached) {
        // Server-side value arrived (e.g. our own save response) with no unsaved edits.
        textarea.value = cached;
      }
      return;
    }
    // read-only mode: just refresh the displayed text.
    populatedUid = uid;
    renderReadValue();
  }

  function refresh(): void {
    const uid = currentUid();
    ensureRow();
    if (!uid) return;
    applyCached(uid, false);
    if (saveBtn && saving) saveBtn.disabled = true;
    if (clearBtn && saving) clearBtn.disabled = true;
    if (cancelBtn && saving) cancelBtn.disabled = true;
  }

  function onCancelClick(): void {
    if (saving || !textarea) return;
    const uid = currentUid();
    const cached = (uid && notesByUid[uid]) || "";
    if (!dirty && textarea.value === cached) {
      dirty = false;
      setMode("read");
      return;
    }
    void KE.components.showConfirmDialogInPage(
      t("Discard unsaved changes to this note?"),
      [
        { label: t("Keep editing"), value: false },
        { label: t("Discard changes"), value: true, destructive: true },
      ],
      document.body,
      t("Discard changes")
    ).then((res) => {
      if (!res) return;
      if (textarea) textarea.value = (uid && notesByUid[uid]) || "";
      dirty = false;
      setMode("read");
    });
  }

  function onClearClick(): void {
    void KE.components.showConfirmDialogInPage(
      t("Clear the note for this project? This cannot be undone."),
      [
        { label: t("Cancel"), value: false },
        { label: t("Clear"), value: true, destructive: true },
      ],
      document.body,
      t("Clear note")
    ).then((res) => {
      if (!res) return;
      if (textarea) textarea.value = "";
      dirty = true;
      void onSaveClick();
    });
  }

  async function onSaveClick(): Promise<void> {
    const uid = currentUid();
    if (!textarea) return;
    if (!uid) {
      KE.components.showToast({ title: t("Could not determine the project UID"), type: "warning" });
      return;
    }
    const value = textarea.value;
    if (!dirty && value === (notesByUid[uid] || "")) {
      notify(t("Notes saved"), "success");
      setMode("read");
      return;
    }
    if (saving) return;
    saving = true;
    if (saveController) saveController.abort();
    saveController = new AbortController();
    if (saveBtn) saveBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (saveProgress) saveProgress.finish();
    saveProgress = KE.components.showProgressToast(t("Saving note..."));
    try {
      // Read the CURRENT extra_metadata and merge, so tags (and any other
      // keys) are preserved — never PATCH a bare { notes } skeleton.
      const asset = await KE.apiAssets.fetchAsset(uid, saveController.signal);
      const currentExtra = ((asset && asset.settings && asset.settings.extra_metadata) || {}) as ExtraMetadata;
      await KE.apiAssets.updateAssetExtraMetadata(
        uid,
        Object.assign({}, currentExtra, { notes: value }),
        saveController.signal
      );
      notesByUid[uid] = value;
      dirty = false;
      notify(t("Notes saved"), "success");
      setMode("read");
    } catch (e) {
      if (saveController && saveController.signal.aborted) {
        if (saveProgress) saveProgress.finish();
        saveProgress = null;
        return;
      }
      const err = (e as { detail?: unknown; message?: unknown }) || {};
      KE.components.showToast({
        title: t("Could not save notes"),
        type: "warning",
        description: (err.detail || err.message || String(e)) as string,
      });
    } finally {
      if (saveProgress) saveProgress.finish();
      saveProgress = null;
      saving = false;
      if (saveBtn) saveBtn.disabled = false;
      if (clearBtn) clearBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (d && d.channel === "__koboenhance__" && d.type === "asset-detail") {
      if (!d.uid) return;
      notesByUid[d.uid] = typeof d.notes === "string" ? d.notes : "";
      lastDetailUid = d.uid;
      const uid = currentUid();
      if (uid && uid === d.uid) applyCached(uid, false);
    }
  });

  function injectStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .ke-notes-readrow {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        width: 100%;
      }
      .ke-notes-value {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 13px;
        line-height: 1.5;
        color: #2e2e2e;
        white-space: pre-line;
        word-break: break-word;
        padding-top: 4px;
      }
      .ke-notes-value.ke-notes-empty {
        color: #9e9e9e;
        font-style: italic;
      }
      .ke-notes-edit {
        flex: 0 0 auto;
      }
      .ke-notes-editwrap[hidden],
      .ke-notes-readrow[hidden] { display: none !important; }
      .ke-notes-textarea {
        display: block;
        width: 100%;
        box-sizing: border-box;
        min-height: 64px;
        max-height: 360px;
        resize: vertical;
      }
      .ke-notes-spacer { flex: 1 1 auto; }
      .ke-notes-controls {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 12px;
        margin-top: 16px;
      }
      .ke-notes-save[disabled],
      .ke-notes-clear[disabled],
      .ke-notes-cancel[disabled] { opacity: 0.6; cursor: default; }
      .ke-notes-clear.k-button,
      .ke-notes-clear.k-button:hover {
        background: #FFEBEB; color: #850509; border-color: #850509;
      }
      .ke-notes-save.k-button,
      .ke-notes-clear.k-button,
      .ke-notes-cancel.k-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 128px;
        box-sizing: border-box;
      }
      .ke-notes-edit.k-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
      }
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
      if (findProjectInfoRow() || findLeftColumn()) refresh();
    }, 2000);
  }

  function init(): void {
    injectStyles();
    observe();
    refresh();
  }

  window.KoboEnhance.formSummaryNotes = { init };
})();