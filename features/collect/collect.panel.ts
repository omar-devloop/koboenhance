/**
 * features/collect/collect.panel.ts — KoboCollect survey list (OpenRosa).
 *
 * Reads the OpenRosa form list (`<origin>/formList`) for the CURRENTLY logged
 * in account — the same XML list the KoboCollect mobile app shows. The panel
 * fetches it with the existing page session (no credentials, this is not a
 * Power Query clone: the endpoint + response shape are reused, none of its
 * auth logic is), renders the rows, and offers a CSV report download.
 *
 * This panel is opened by the toolbar's smartphone button (ui/integration.ts,
 * left of the action selector) — it is NOT a selector action, so it never
 * enters the item/row executor loop.
 */
(function () {
  const KE = window.KoboEnhance;
  const { t, tP } = KE.i18n;
  const { el } = KE.dom;
  const { showToast } = KE.components;

  interface CollectFormRow {
    formID: string;
    name: string;
    majorMinorVersion: string;
    version: string;
    hash: string;
    descriptionText: string;
    downloadUrl: string;
    manifestUrl: string;
  }

  /** Reads an attribute of one <xform> element, or "" when absent. */
  function attrOf(node: Element | null, name: string): string {
    return node ? (node.getAttribute(name) || "").trim() : "";
  }

  /** Finds a child element by its local name (namespace-agnostic). */
  function childElem(node: Element, name: string): Element | null {
    for (const c of Array.from(node.children)) {
      if (c.localName === name) return c;
    }
    return null;
  }

  /** First non-empty value among the candidates, else "". */
  function firstOf(parts: Array<string | null>): string {
    for (const p of parts) {
      if (typeof p === "string" && p.trim()) return p.trim();
    }
    return "";
  }

  /**
   * Reads one formList field. Kobo's /formList serializes each field as a
   * CHILD ELEMENT (<formID>aBc</formID>), while the OpenRosa spec allows them
   * as attributes — accept both, child element first.
   */
  function rowValue(f: Element, name: string): string {
    const child = childElem(f, name);
    return firstOf([child ? child.textContent : null, f.getAttribute(name)]);
  }

  /** Parses the OpenRosa XFormList XML into row objects (Power Query row shape). */
  function parseFormListXml(xml: string): CollectFormRow[] {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const rows: CollectFormRow[] = [];
    const forms = doc.getElementsByTagNameNS("*", "xform");
    for (let i = 0; i < forms.length; i++) {
      const f = forms[i];
      rows.push({
        formID: rowValue(f, "formID"),
        name: rowValue(f, "name"),
        majorMinorVersion: rowValue(f, "majorMinorVersion"),
        version: rowValue(f, "version"),
        hash: rowValue(f, "hash"),
        descriptionText: rowValue(f, "descriptionText"),
        downloadUrl: rowValue(f, "downloadUrl"),
        manifestUrl: rowValue(f, "manifestUrl"),
      });
    }
    return rows;
  }

  /**
   * Fetches the form list. Reuses the page's own session against the same
   * origin by default; when a username + password are given, authenticates as
   * that other account with the OpenRosa Basic header (KoboCollect style). A
   * cache buster is sent because OpenRosa responses are cacheable and
   * KoboCollect depends on fresh versions.
   *
   * IMPORTANT: when an Authorization header is sent, credentials must be
   * "omit" — otherwise a 401 + "WWW-Authenticate: Basic" response makes the
   * browser show its native "Sign in to access this site" dialog instead of
   * returning the 401 to us.
   */
  function fetchFormList(username?: string, password?: string, signal?: AbortSignal): Promise<CollectFormRow[]> {
    const url = `${KE.auth.getBaseUrl()}/formList?t=${encodeURIComponent(String(Date.now()))}`;
    const headers: Record<string, string> = {
      Accept: "text/xml, application/xml",
      "Cache-Control": "no-cache",
    };
    const u = (username || "").trim();
    const useCreds = !!(u && password);
    if (useCreds) {
      // HTTP Basic carries the raw bytes of "user:password". The credentials
      // are UTF-8 encoded first, so a non-ASCII password works; the bytes are
      // then turned into a binary string for btoa(). (The old
      // btoa/unescape/encodeURIComponent trick relied on the deprecated
      // unescape and is no longer needed.)
      const bytes = new TextEncoder().encode(u + ":" + password);
      let bin = "";
      bytes.forEach((b) => (bin += String.fromCharCode(b)));
      headers.Authorization = "Basic " + btoa(bin);
    }
    return fetch(url, {
      method: "GET",
      credentials: useCreds ? "omit" : "same-origin",
      signal,
      headers,
    })
      .then((res) => {
        if (res.status === 401 || res.status === 403) {
          const e = new Error(t("Session not authenticated for the KoboCollect endpoint.")) as Error & { status?: number };
          e.status = res.status;
          throw e;
        }
        if (!res.ok) {
          const e = new Error(t("KoboCollect list request failed (HTTP {status}).", { status: res.status })) as Error & { status?: number };
          e.status = res.status;
          throw e;
        }
        return res.text();
      })
      .then(parseFormListXml);
  }

  const REPORT_HEADERS = ["FormID", "Name", "Version", "Hash", "DownloadURL", "ManifestURL", "Description"];

  function buildReportRows(rows: CollectFormRow[]): Array<Record<string, string>> {
    return rows.map((r) => ({
      FormID: r.formID,
      Name: r.name,
      Version: r.majorMinorVersion || r.version,
      Hash: r.hash,
      DownloadURL: r.downloadUrl,
      ManifestURL: r.manifestUrl,
      Description: r.descriptionText,
    }));
  }

  function downloadReport(rows: CollectFormRow[], otherAccount?: string): void {
    const csv = KE.exportSvc.toCSV(buildReportRows(rows), REPORT_HEADERS);
    // Naming logic is untouched: makeFilename appends "<username>-<timestamp>".
    // For another account's list we just inject "(other)" into the prefix, so:
    //   own list      -> kobocollect-forms-alice-20260923-1515.csv
    //   other's list  -> kobocollect-forms-(bob)-alice-20260923-1515.csv
    const prefix = otherAccount ? `kobocollect-forms-(${otherAccount})` : "kobocollect-forms";
    KE.exportSvc.makeFilename(prefix, "csv").then((filename) => {
      KE.exportSvc.download(filename, csv, "text/csv;charset=utf-8;");
    });
  }

  function copyToClipboard(text: string): void {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  function copyIcon(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", "9");
    rect.setAttribute("y", "9");
    rect.setAttribute("width", "13");
    rect.setAttribute("height", "13");
    rect.setAttribute("rx", "2");
    rect.setAttribute("ry", "2");
    svg.appendChild(rect);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1");
    svg.appendChild(path);
    return svg;
  }

  function reloadIcon(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const p1 = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    p1.setAttribute("points", "23 4 23 10 17 10");
    svg.appendChild(p1);
    const p2 = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    p2.setAttribute("points", "1 20 1 14 7 14");
    svg.appendChild(p2);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15");
    svg.appendChild(path);
    return svg;
  }

  /** Renders the fetched rows like the KoboCollect app list: name on top,
   *  then version + form id on one small secondary line. */
  function renderTable(rows: CollectFormRow[]): HTMLElement {
    if (!rows.length) {
      return el("div", { class: "ke-tpl-empty", text: t("No surveys returned. Only deployed, collectable forms appear here.") });
    }
    const list = el("div", { class: "ke-collect-list" });
    for (const r of rows) {
      const name = r.name || r.formID || t("(untitled)");
      const copyBtn = el("button", {
        type: "button",
        class: "ke-collect-copy",
        title: t("Copy form name"),
        "aria-label": t("Copy form name"),
        onclick: () => {
          copyToClipboard(name);
          const label = copyBtn.querySelector(".ke-collect-copy-label") as HTMLElement | null;
          if (label) {
            const prev = label.textContent || "";
            label.textContent = t("Copied");
            setTimeout(() => {
              label.textContent = prev;
            }, 1500);
          }
        },
      }, [copyIcon(), el("span", { class: "ke-collect-copy-label", text: t("Copy") })]) as HTMLButtonElement;
      list.appendChild(
        el("div", { class: "ke-collect-row" }, [
          el("div", { class: "ke-collect-head" }, [
            el("div", { class: "ke-collect-name", text: name }),
            copyBtn,
          ]),
          el("div", { class: "ke-collect-meta" }, [
            el("div", { class: "ke-collect-version", text: t("Version: {version}", { version: r.majorMinorVersion || r.version }) }),
            el("div", { class: "ke-collect-formid", text: t("ID: {id}", { id: r.formID }) }),
          ]),
        ])
      );
    }
    return list;
  }

  /** Opens the modal panel, loads the list on open, then enables the report. */
  function openPanel(): void {
    const overlay = el("div", { class: "ke-alert-overlay" });
    const dialog = el("div", { class: "ke-alert-dialog ke-tpl-dialog ke-collect-dialog" });
    dialog.appendChild(
      el("div", { class: "ke-collect-header" }, [
        el("div", { class: "ke-alert-title", text: t("KoboCollect survey list") }),
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
        text: t("The surveys available to this account in the KoboCollect app."),
      })
    );
    dialog.appendChild(
      el("p", { class: "ke-collect-hint", text: t("Leave username/password empty to use your own login.") })
    );

    const toolbar = el("div", { class: "ke-collect-toolbar" });
    const userInput = el("input", {
      type: "text",
      class: "ke-input ke-collect-user",
      placeholder: t("Username"),
      title: t("Account whose form list to load (empty = your own login)"),
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const passInput = el("input", {
      type: "password",
      class: "ke-input ke-collect-pass",
      placeholder: t("Password"),
      title: t("Password for the account above (empty = your own login)"),
      autocomplete: "off",
    }) as HTMLInputElement;
    const loadBtn = el("button", {
      type: "button",
      class: "ke-alert-btn is-secondary ke-collect-reload",
      title: t("Reload list"),
      "aria-label": t("Reload list"),
    }, [reloadIcon()]) as HTMLButtonElement;
    toolbar.appendChild(userInput);
    toolbar.appendChild(passInput);
    toolbar.appendChild(loadBtn);
    dialog.appendChild(toolbar);

    const body = el("div", { class: "ke-tpl-body" });
    const placeholder = el("div", { class: "ke-tpl-empty", text: t("Loading the surveys...") });
    body.appendChild(placeholder);
    dialog.appendChild(body);

    const downloadBtn = el("button", {
      type: "button",
      class: "ke-alert-btn is-primary",
      disabled: "true",
      style: "display:none;",
      onclick: (): void => {
        if (rowsRef) downloadReport(rowsRef, reportOther);
      },
    }, [el("span", { text: t("Download report") })]) as HTMLButtonElement;
    const status = el("span", { class: "ke-collect-status" });
    const footer = el("div", { class: "ke-tpl-dialog-actions ke-collect-footer" }, [
      status,
      el("div", { class: "ke-collect-footer-actions" }, [downloadBtn]),
    ]);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    let rowsRef: CollectFormRow[] | null = null;
    let loading = false;
    let closed = false;
    let currentUser = "";
    let reportOther = "";
    // Resolve the logged-in username once on open, so the footer can label
    // whether the list shown is the current account or a different one.
    KE.auth.getUsername().then((u) => { currentUser = u || ""; }).catch(() => { currentUser = ""; });

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

    function finishLoad(): void {
      loading = false;
      loadBtn.disabled = false;
    }

    function beginLoad(user: string | undefined, pass: string | undefined): void {
      loading = true;
      loadBtn.disabled = true;
      status.textContent = t("Loading...");
      body.innerHTML = "";
      body.appendChild(el("div", { class: "ke-collect-status is-busy" }, [
        KE.components.buildSpinner(18),
        el("span", { text: t("Fetching the KoboCollect form list...") }),
      ]));
      fetchFormList(user, pass)
        .then((rows) => {
          rowsRef = rows;
          body.innerHTML = "";
          body.appendChild(renderTable(rows));
          downloadBtn.style.display = "";
          downloadBtn.disabled = false;
          downloadBtn.classList.remove("ke-collect-dl-off");
          const signedInAs = !!(user && pass);
          const label = signedInAs ? user : currentUser || t("your account");
          reportOther = signedInAs && (!currentUser || user.toLowerCase() !== currentUser.toLowerCase()) ? user : "";
          status.textContent = rows.length
            ? t("{count} loaded · account: {account}", { count: tP("count-surveys", rows.length), account: label })
            : t("List is empty");
          finishLoad();
        })
        .catch((e: unknown) => {
          const err = e as (Error & { status?: number }) | null;
          const failedAuth = !!(user && err && (err.status === 401 || err.status === 403));
          status.textContent = t("Load failed");
          // Never render the previous table on a failed load.
          body.innerHTML = "";
          body.appendChild(el("div", { class: "ke-tpl-empty", text: t("Could not load the form list.") }));
          rowsRef = null;
          downloadBtn.disabled = true;
          downloadBtn.style.display = "";
          downloadBtn.classList.add("ke-collect-dl-off");
          const msg = (err && err.message) || String(e);
          if (failedAuth) {
            showToast({ type: "warning", title: t("Sign-in failed"), description: t("Login as \"{user}\" was rejected. No list is shown.", { user: user || "" }) });
          } else {
            showToast({ type: "warning", title: t("Could not load the KoboCollect list"), description: msg });
          }
          finishLoad();
        });
    }

    function load(): void {
      if (loading) return;
      const user = userInput.value.trim();
      const pass = passInput.value;
      beginLoad(user || undefined, user ? pass : undefined);
    }
    loadBtn.addEventListener("click", load);

    // Load immediately when the panel opens (the button acts as a reload).
    load();

    document.addEventListener("keydown", onEsc);
    document.body.appendChild(overlay);
  }

  window.KoboEnhance.collect = {
    fetchFormList,
    openPanel,
  };
})();