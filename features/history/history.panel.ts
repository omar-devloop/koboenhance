/**
 * features/history/history.panel.ts — run history & audit log panel.
 *
 * The modal opened by the toolbar's history button (ui/integration.ts, placed
 * next to Run in the actions row). It lists the compact run records persisted
 * by features/history/history.store.ts (newest first), lets the user filter by
 * action/user, download the exact CSV of a bulked run, download the whole log
 * index, and clear the log (with confirmation).
 *
 * The panel is NOT an action in the selector — it is a plain toolbar button,
 * so it never enters the executor loop and is never recorded itself.
 */
(function () {
  const KE = window.KoboEnhance;
  const { el } = KE.dom;
  const { showToast } = KE.components;
  const { t, tP } = KE.i18n;

  const INDEX_HEADERS = ["Date", "Action", "Kind", "User", "Source", "Projects", "Success", "Failed", "Cancelled", "Skipped", "Outcome", "Error", "Settings"];

  function formatDate(ts: number): string {
    try {
      return new Date(ts).toLocaleString();
    } catch (e) {
      return String(ts);
    }
  }

  function outcomeLabel(o: RunHistoryOutcome): string {
    return o.toUpperCase();
  }

  function classNameForOutcome(o: RunHistoryOutcome): string {
    return o === "success" ? "is-success" : o === "error" ? "is-error" : o === "stopped" ? "is-stopped" : "is-empty";
  }

  function countsLabel(e: RunHistoryEntry): string {
    const c = e.counts || { success: 0, failed: 0, cancelled: 0, skipped: 0 };
    const parts: string[] = [];
    parts.push(`\u2713 ${c.success}`);
    parts.push(`\u2715 ${c.failed}`);
    parts.push(`${t("cancelled")} ${c.cancelled}`);
    parts.push(`${t("skipped")} ${c.skipped}`);
    return parts.join(" \u00b7 ");
  }

  function scopeLabel(e: RunHistoryEntry): string {
    const scope = e.scope || { projectCount: 0, wholeAccount: false };
    return `projects: ${scope.projectCount}${scope.wholeAccount ? " \u00b7 entire account" : ""}`;
  }

  function metaLabel(e: RunHistoryEntry): string {
    return `${e.user || "anonymous"} \u00b7 ${e.kind} \u00b7 ${scopeLabel(e)}${e.source ? ` \u00b7 source: ${e.source}` : ""}`;
  }

  function buildIndexRows(entries: RunHistoryEntry[]): Array<Record<string, string>> {
    return entries.map((e) => ({
      Date: formatDate(e.ts),
      Action: e.actionLabel,
      Kind: e.kind,
      User: e.user,
      Source: e.source || "",
      Projects: String((e.scope && e.scope.projectCount) || 0),
      Success: String((e.counts && e.counts.success) || 0),
      Failed: String((e.counts && e.counts.failed) || 0),
      Cancelled: String((e.counts && e.counts.cancelled) || 0),
      Skipped: String((e.counts && e.counts.skipped) || 0),
      Outcome: outcomeLabel(e.outcome),
      Error: e.error || "",
      Settings: JSON.stringify(e.settings || {}),
    }));
  }

  function downloadDetails(entry: RunHistoryEntry): void {
    if (!entry.details) return;
    const d = entry.details;
    KE.exportSvc.makeFilename(`run-history-${entry.action}`, "csv").then((filename) => {
      KE.exportSvc.download(filename, d.csv || KE.exportSvc.toCSV(d.rows || [], d.headers || []), "text/csv;charset=utf-8;");
    });
  }

  function downloadIndex(entries: RunHistoryEntry[]): void {
    if (!entries.length) return;
    const csv = KE.exportSvc.toCSV(buildIndexRows(entries), INDEX_HEADERS);
    KE.exportSvc.makeFilename("kobocollect-log", "csv").then((filename) => {
      KE.exportSvc.download(filename, csv, "text/csv;charset=utf-8;");
    });
  }

  /** Renders one audited run as a compact list row. */
  function entryRow(e: RunHistoryEntry): HTMLElement {
    const detailsBtn = el("button", {
      type: "button",
      class: "ke-history-details",
      title: t("Download the exact CSV of this run"),
      onclick: () => downloadDetails(e),
    }, [el("span", { text: t("Details") })]) as HTMLButtonElement;
    detailsBtn.disabled = !e.details;
    return el("div", { class: "ke-history-row" }, [
      el("div", { class: "ke-history-head" }, [
        el("div", { class: "ke-history-title", text: t(e.actionLabel as keyof EnDict) }),
        el("span", { class: `ke-history-outcome ${classNameForOutcome(e.outcome)}`, text: outcomeLabel(e.outcome) }),
        detailsBtn,
      ]),
      el("div", { class: "ke-history-counts", text: countsLabel(e) }),
      el("div", { class: "ke-history-meta", text: `${metaLabel(e)} \u00b7 ${formatDate(e.ts)}` }),
    ]);
  }

  /** Opens the run-history modal. */
  function openPanel(): void {
    const overlay = el("div", { class: "ke-alert-overlay" });
    const dialog = el("div", { class: "ke-alert-dialog ke-tpl-dialog ke-collect-dialog" });
    let closed = false;
    let currentUser = "";
    let filter = "";
    KE.auth.getUsername().then((u) => { currentUser = u || ""; renderFooter(); }).catch(() => { currentUser = ""; });

    dialog.appendChild(
      el("div", { class: "ke-collect-header" }, [
        el("div", { class: "ke-alert-title", text: t("Run history and audit log") }),
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
        text: t("Every run of your bulk actions and account scans, recorded locally."),
      })
    );

    const toolbar = el("div", { class: "ke-collect-toolbar" });
    const searchInput = el("input", {
      type: "text",
      class: "ke-input ke-history-search",
      placeholder: t("Filter by action or user"),
      title: t("Filter the log by action name or user"),
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const clearBtn = el("button", {
      type: "button",
      class: "ke-alert-btn is-secondary ke-history-clear",
      title: t("Delete all recorded runs"),
    }, [el("span", { text: t("Clear history") })]) as HTMLButtonElement;
    toolbar.appendChild(searchInput);
    toolbar.appendChild(el("div", { class: "ke-collect-toolbar-spacer" }));
    toolbar.appendChild(clearBtn);
    dialog.appendChild(toolbar);

    const body = el("div", { class: "ke-tpl-body ke-history-body" });
    const listEl = el("div", { class: "ke-history-list" });
    body.appendChild(listEl);
    dialog.appendChild(body);

    const downloadBtn = el("button", {
      type: "button",
      class: "ke-alert-btn is-primary",
      disabled: "true",
      onclick: () => downloadIndex(KE.history.list()),
    }, [el("span", { text: t("Download log (CSV)") })]) as HTMLButtonElement;
    const status = el("span", { class: "ke-collect-status" });
    const footer = el("div", { class: "ke-tpl-dialog-actions ke-collect-footer" }, [
      status,
      el("div", { class: "ke-collect-footer-actions" }, [downloadBtn]),
    ]);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    function finishClose(): void {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onEsc);
      overlay.remove();
    }
    function onEsc(e: KeyboardEvent): void {
      if (e.key === "Escape") close();
    }
    function close(): void {
      finishClose();
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    function entries(): RunHistoryEntry[] {
      const all = KE.history.list();
      const q = filter.trim().toLowerCase();
      if (!q) return all;
      return all.filter((e) => {
        return (e.actionLabel || "").toLowerCase().indexOf(q) >= 0 || (e.user || "").toLowerCase().indexOf(q) >= 0;
      });
    }

    function renderFooter(): void {
      const n = entries().length;
      if (!n) {
        status.textContent = currentUser
          ? t("No runs recorded yet · account: {user}", { user: currentUser })
          : t("No runs recorded yet");
        downloadBtn.disabled = true;
        clearBtn.style.display = "none";
        return;
      }
      status.textContent = `${tP("run-shown", n)}${currentUser ? ` ${t("· account: {user}", { user: currentUser })}` : ""}`;
      downloadBtn.disabled = false;
      clearBtn.style.display = "";
    }

    function render(): void {
      const rows = entries();
      listEl.innerHTML = "";
      if (!rows.length) {
        listEl.appendChild(el("div", { class: "ke-tpl-empty", text: t("No runs recorded yet. Run a bulk action or account scan to start the audit log.") }));
      } else {
        for (const e of rows) listEl.appendChild(entryRow(e));
      }
      renderFooter();
    }

    searchInput.addEventListener("input", () => {
      filter = searchInput.value;
      render();
    });
    clearBtn.addEventListener("click", () => {
      void KE.components.showConfirmDialogInPage(
        t("Delete all recorded runs? This cannot be undone."),
        [
          { label: t("Cancel"), value: false },
          { label: t("Delete all"), value: true, destructive: true },
        ],
        overlay,
        t("Clear run history")
      ).then((ok) => {
        if (ok) {
          KE.history.clear();
          render();
          showToast({ type: "success", title: t("Run history cleared"), description: t("All recorded runs were deleted.") });
        }
      });
    });

    render();
    document.addEventListener("keydown", onEsc);
    document.body.appendChild(overlay);
  }

  // Install the panel into the service registered by history.store.ts.
  window.KoboEnhance.history.openPanel = openPanel;
})();