/**
 * core/scraper/scraper.service.ts — reads the Kobo DOM for UIDs the user has
 * already selected on-screen, and detects the current project from the URL.
 */
(function () {
  // Kobo asset UIDs look like "a" followed by 22 base62-ish chars, e.g. aXXXXXXXXXXXXXXXXXXXXXX
  const UID_RE = /\/([a-zA-Z][a-zA-Z0-9]{21,})(?:\/|$)/;

  function getCurrentProjectUid(): string | null {
    const hash = window.location.hash;
    const match = hash.match(/\/forms\/([a-zA-Z][a-zA-Z0-9]{21,})(?:\/|$)/);
    if (match) return match[1];
    const pathMatch = window.location.pathname.match(UID_RE);
    return pathMatch ? pathMatch[1] : null;
  }

  /** Returns the UID for a single row element, or null. */
  function getRowUid(row: Element | null): string | null {
    if (!row) return null;
    const link = row.querySelector('[data-field="name"] a[href*="/forms/"]');
    if (!link) return null;
    const m = (link.getAttribute("href") || "").match(/forms\/([a-zA-Z0-9]+)/);
    return m && m[1] ? m[1] : null;
  }

  /** Returns the checkbox input for a single row element, or null. */
  function getRowCheckbox(row: Element | null): HTMLInputElement | null {
    if (!row) return null;
    return row.querySelector('[data-field="checkbox"] input[type="checkbox"]') as HTMLInputElement | null;
  }

  /**
   * Looks for checked checkboxes in Kobo's project list that carry a UID,
   * by scanning data-field="checkbox" cells and walking to the row parent.
   * Based on working logic from kobo-bulk-share.
   */
  function getSelectedCheckboxUids(): string[] {
    const cells = document.querySelectorAll('[data-field="checkbox"]');
    const uids: string[] = [];
    cells.forEach((cell) => {
      const input = cell.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!input) return;
      const isChecked = input.checked || input.getAttribute("aria-checked") === "true";
      if (!isChecked) return;
      const row = cell.parentElement;
      if (!row) return;
      const link = row.querySelector('[data-field="name"] a[href*="/forms/"]');
      if (!link) return;
      const m = (link.getAttribute("href") || "").match(/forms\/([a-zA-Z0-9]+)/);
      if (m && m[1]) uids.push(m[1]);
    });
    return [...new Set(uids)];
  }

  window.KoboEnhance.scraper = {
    getCurrentProjectUid,
    getSelectedCheckboxUids,
    getRowUid,
    getRowCheckbox,
  };
})();