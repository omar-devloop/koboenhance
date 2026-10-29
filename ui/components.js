"use strict";
(function () {
    const KE = window.KoboEnhance;
    const { t } = KE.i18n;
    const { el } = KE.dom;
    // Page-context styles for the in-page integration (rendered in <head>,
    // NOT inside shadow DOM). Everything is .ke- prefixed to avoid clobbering
    // Kobo's own styles.
    const PAGE_STYLES = `
    .ke-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.35);
      z-index: 2147483001;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ke-dialog {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
      padding: 18px 20px;
      max-width: 340px;
      width: 90%;
      text-align: left;
      font-family: 'Roboto', Arial, sans-serif;
      font-size: 13px;
      color: #2e2e2e;
    }
    .ke-dialog-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; color: #0086d6; }
    .ke-dialog p { margin: 0; font-size: 13px; line-height: 1.5; color: #2e2e2e; white-space: pre-line; }
    .ke-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .ke-btn {
      background: #0086d6; color: #fff; border: none; border-radius: 4px;
      padding: 6px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
      font-family: 'Roboto', Arial, sans-serif;
    }
    .ke-btn:hover { filter: brightness(0.95); }
    .ke-btn.secondary { background: #eef1f2; color: #2e2e2e; }
    .ke-btn.danger { background: #d64545; }
    .ke-btn:disabled { opacity: .5; cursor: not-allowed; }

    .ke-alert-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.55);
      z-index: 2147483001;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: ke-alert-fade-in 0.15s ease-out;
    }
    .ke-alert-dialog {
      background: #fff;
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 12px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.2);
      width: 420px;
      max-width: calc(100vw - 32px);
      padding: 22px;
      font-family: 'Roboto', Arial, sans-serif;
      animation: ke-alert-zoom-in 0.15s ease-out;
    }
    .ke-alert-title {
      font-size: 17px;
      font-weight: 600;
      color: #18181b;
      margin: 0 0 8px;
    }
    .ke-alert-desc {
      font-size: 14px;
      line-height: 1.5;
      color: #71717a;
      margin: 0;
      white-space: pre-line;
    }
    .ke-alert-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 20px;
    }
    /* ---- confirm dialog detail block -------------------------------
       A bulk run's detail is numbers to scan, not prose: facts are an
       aligned label/value grid (tabular figures, values right-aligned),
       warnings are alert rows so they cannot be mistaken for notes, and
       notes are the standing conditions. */
    .ke-alert-dialog--details { width: 480px; }
    .ke-confirm-details { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
    .ke-confirm-facts {
      margin: 0;
      display: grid;
      grid-template-columns: minmax(0, auto) minmax(0, 1fr);
      gap: 7px 16px;
      padding: 12px 14px;
      background: #f7f7f8;
      border: 1px solid #e9e9ec;
      border-radius: 8px;
    }
    .ke-confirm-facts dt {
      color: #71717a;
      font-size: 12.5px;
      line-height: 1.4;
      min-width: 0;
    }
    .ke-confirm-facts dd {
      margin: 0;
      color: #18181b;
      font-size: 12.5px;
      font-weight: 600;
      line-height: 1.4;
      text-align: right;
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .ke-confirm-warning {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 8px;
      background: #fffbeb;
      border: 1px solid #fde68a;
      color: #92400e;
      font-size: 12.5px;
      line-height: 1.45;
    }
    .ke-confirm-warning-icon {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      margin-top: 1px;
      border-radius: 50%;
      background: #f59e0b;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .ke-confirm-notes {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: #71717a;
      line-height: 1.45;
    }
    .ke-confirm-notes li { position: relative; padding-left: 12px; }
    .ke-confirm-notes li::before {
      content: "";
      position: absolute;
      left: 2px;
      top: 7px;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #d4d4d8;
    }
    .ke-confirm-notes.is-plain li { color: #52525b; }
    .ke-alert-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 34px;
      padding: 0 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      font-family: 'Roboto', Arial, sans-serif;
      transition: background-color 0.12s ease, border-color 0.12s ease;
    }
    .ke-alert-btn:focus-visible {
      outline: 2px solid #18181b;
      outline-offset: 2px;
    }
    .ke-alert-btn.is-secondary {
      background: #fff;
      border-color: #e4e4e7;
      color: #3f3f46;
    }
    .ke-alert-btn.is-secondary:hover { background: #f4f4f5; }
    .ke-alert-btn.is-primary {
      background: #18181b;
      color: #fff;
    }
    .ke-alert-btn.is-primary:hover { background: #27272a; }
    .ke-alert-btn.is-primary.ke-collect-dl-off {
      background: #d4d4d4; color: #f4f4f5; cursor: not-allowed;
    }
    .ke-alert-btn.is-primary.ke-collect-dl-off:hover { background: #d4d4d4; }
    .ke-alert-btn.is-destructive {
      background: #dc2626;
      color: #fff;
    }
    .ke-alert-btn.is-destructive:hover { background: #b91c1c; }
    .ke-tpl-dialog { width: 640px; max-width: calc(100vw - 32px); max-height: 82vh; display: flex; flex-direction: column; }
    .ke-tpl-dialog.ke-tpl-drop { outline: 2px dashed #0086d6; outline-offset: -4px; }
    .ke-tpl-body { overflow-y: auto; padding-right: 4px; margin-top: 12px; flex: 1 1 auto; }
    /* The body scrolls, so a control flush against its edge loses the top and
       bottom of its focus ring to the clip. Padding keeps the whole highlight
       inside the scroll box. */
    .ke-settings-body { padding: 10px 4px 10px 0; }
    .ke-tpl-list { display: flex; flex-direction: column; gap: 8px; }
    .ke-tpl-card { border: 1px solid #e4e4e7; border-radius: 8px; background: #fafafa; }
    .ke-tpl-card-head { display: flex; gap: 6px; align-items: center; padding: 8px 10px; }
    .ke-tpl-toggle {
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; border: none; border-radius: 4px; cursor: pointer;
      background: transparent; color: #52525b; flex: 0 0 auto;
    }
    .ke-tpl-toggle:hover { background: #f1f1f1; }
    .ke-tpl-toggle svg { transition: transform 0.15s ease; }
    .ke-tpl-card.open .ke-tpl-toggle svg { transform: rotate(180deg); }
    .ke-tpl-name {
      flex: 1 1 auto; min-width: 0; font-weight: 600; font-size: 13px;
      border: 1px solid transparent; background: transparent; border-radius: 4px;
      padding: 4px 6px; color: #18181b; font-family: 'Roboto', Arial, sans-serif;
    }
    .ke-tpl-name:hover { border-color: #e4e4e7; }
    .ke-tpl-name:focus { outline: 2px solid #0086d6; outline-offset: -1px; background: #fff; }
    .ke-tpl-card-body { display: none; padding: 0 10px 10px; }
    .ke-tpl-card.open .ke-tpl-card-body { display: block; }
    .ke-tpl-del-wrap { display: none; }
    .ke-tpl-card.open .ke-tpl-del-wrap { display: inline-flex; }
    .ke-tpl-grant { display: flex; gap: 6px; align-items: center; }
    .ke-tpl-grant .ke-input { flex: 1 1 auto; min-width: 0; }
    .ke-tpl-perm { max-width: 210px; flex: 0 0 auto; }
    .ke-tpl-count { flex: 0 0 auto; font-size: 12px; color: #71717a; white-space: nowrap; margin-left: 4px; }
    .ke-tpl-grant .ke-input.ke-tpl-ok { border-color: #2e7d32; }
    .ke-tpl-grant .ke-input.ke-tpl-bad { border-color: #d64545; }
    .ke-tpl-x {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border: none; border-radius: 4px; cursor: pointer;
      background: transparent; color: #9a9a9a; flex: 0 0 auto;
    }
    .ke-tpl-x:hover { background: #f1f1f1; color: #d64545; }
    .ke-tpl-grants { display: flex; flex-direction: column; gap: 6px; }
    .ke-tpl-add-user { margin-top: 8px; align-self: flex-start; }
    .ke-tpl-empty { color: #8a8a8a; font-size: 13px; padding: 18px 0; text-align: center; border: 1px dashed #d4d4d4; border-radius: 8px; }
    .ke-tpl-top { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 12px; }
    .ke-tpl-top-actions { display: flex; gap: 6px; align-items: center; }
    .ke-tpl-dialog-actions { display: flex; gap: 8px; justify-content: space-between; align-items: center; margin-top: 14px; }
    .ke-tpl-help { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; font-size: 11px; color: #7a7a85; }
    .ke-tpl-help li { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
    .ke-tpl-help li::before { content: "•"; font-size: 9px; }
    .ke-actions-row2 .ke-row.ke-template-row { align-items: center; }
    .ke-actions-row2 .ke-row.ke-template-row > * { align-self: center; }
    .ke-collect-dialog { width: 720px; }
    .ke-collect-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .ke-collect-header .ke-alert-title { margin: 0; }
    .ke-collect-close {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border: none; border-radius: 6px;
      background: transparent; color: #71717a; cursor: pointer;
      font-size: 15px; line-height: 1; font-family: 'Roboto', Arial, sans-serif; flex: 0 0 auto;
    }
    .ke-collect-close:hover { background: #f1f1f1; color: #d64545; }
    .ke-collect-toolbar { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
    .ke-collect-hint { font-size: 12px; color: #8a8a8f; margin: 2px 0 0; }
    .ke-collect-user, .ke-collect-pass { flex: 0 1 200px; min-width: 0; }
    .ke-collect-reload { margin-left: auto; padding: 0 10px; flex: 0 0 auto; }
    .ke-collect-status { font-size: 12px; color: #71717a; }
    .ke-collect-status.is-busy { display: inline-flex; align-items: center; gap: 8px; color: #52525b; }
    .ke-collect-list { display: flex; flex-direction: column; border: 1px solid #e4e4e7; border-radius: 8px; overflow: auto; }
    .ke-collect-row { padding: 8px 12px; border-bottom: 1px solid #f1f1f1; }
    .ke-collect-row:last-child { border-bottom: none; }
    .ke-collect-row:nth-child(even) { background: #fafafa; }
    .ke-collect-head { display: flex; align-items: center; gap: 8px; }
    .ke-collect-name { flex: 1 1 auto; font-size: 13px; font-weight: 600; color: #18181b; word-break: break-word; }
    .ke-collect-copy {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 6px; border: 1px solid #e4e4e7; border-radius: 4px;
      background: #fff; color: #3f3f46; cursor: pointer;
      font-size: 11px; font-family: 'Roboto', Arial, sans-serif; flex: 0 0 auto;
    }
    .ke-collect-copy:hover { border-color: #b0b0b0; background: #fafafa; }
    .ke-collect-meta { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-top: 3px; }
    .ke-collect-version { font-size: 11px; color: #70707a; }
    .ke-collect-formid { font-size: 11px; color: #a0a0aa; font-family: 'Roboto Mono', Consolas, monospace; word-break: break-all; text-align: right; }
    .ke-collect-dialog .ke-collect-footer-actions { margin-left: auto; }
    .ke-collect-footer-actions { display: inline-flex; gap: 8px; align-items: center; }
    .ke-collect-toolbar-spacer { flex: 1 1 auto; }
    .ke-actions-row2 .ke-row.ke-transfer-row { align-items: center; }
    .ke-actions-row2 .ke-row.ke-transfer-row > * { align-self: center; }
    /* Scope dropdown leads on the left; the destination text + gear are
       grouped flush right. margin-left:auto on the summary is what pushes the
       pair over; right-align keeps the text readable when it ellipsizes, and
       flex:0 0 auto on the gear stops the row's nowrap layout from nudging it. */
    .ke-transfer-scope { flex: 0 0 auto; }
    .ke-transfer-summary {
      font-size: 12px; color: #3f3f46; flex: 0 1 auto; min-width: 0;
      margin-left: auto; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; text-align: right;
    }
    .ke-transfer-summary.is-empty { color: #a0a0aa; font-style: italic; }
    .ke-transfer-row .right-tooltip { flex: 0 0 auto; display: inline-flex; }
    .ke-transfer-dialog { width: 460px; }
    .ke-transfer-field { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
    .ke-transfer-label { font-size: 12px; font-weight: 600; color: #52525b; }
    .ke-transfer-hint { font-size: 11px; color: #8a8a8f; margin: 4px 0 0; }
    .ke-transfer-status { font-size: 12px; color: #71717a; margin-top: 10px; min-height: 16px; }
    .ke-transfer-status.is-error { color: #d64545; }
    .ke-transfer-status.is-ok { color: #2e7d32; }
    .ke-transfer-status.is-busy { display: inline-flex; align-items: center; gap: 8px; color: #52525b; }
    .ke-transfer-current { font-size: 12px; color: #3f3f46; margin: 10px 0 0; }
    /* Transfer settings: two labelled accounts, the source one read-only. */
    .ke-transfer-section {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid #ececee;
    }
    .ke-transfer-section-title { font-size: 12px; font-weight: 700; color: #3f3f46; letter-spacing: 0.02em; }
    .ke-transfer-readonly {
      background: #f4f4f5;
      color: #3f3f46;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      cursor: text;
    }
    .ke-transfer-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .ke-transfer-account { font-size: 12px; color: #52525b; margin-right: auto; }
    .ke-transfer-mini { padding: 3px 10px; font-size: 11px; }

    .ke-history-search { flex: 0 1 240px; min-width: 0; }
    .ke-history-clear { flex: 0 0 auto; }
    .ke-history-body { max-height: 60vh; }
    .ke-history-list { display: flex; flex-direction: column; gap: 8px; }
    .ke-history-row { border: 1px solid #e4e4e7; border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 3px; }
    .ke-history-row:nth-child(even) { background: #fafafa; }
    .ke-history-head { display: flex; align-items: center; gap: 8px; }
    .ke-history-title { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 600; color: #18181b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ke-history-outcome { flex: 0 0 auto; font-size: 10px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; }
    .ke-history-outcome.is-success { background: #e7f5ec; color: #1a7f37; }
    .ke-history-outcome.is-error { background: #fbeaea; color: #c62828; }
    .ke-history-outcome.is-stopped { background: #fff4e5; color: #b26a00; }
    .ke-history-outcome.is-empty { background: #ececef; color: #6b6b70; }
    .ke-history-details {
      flex: 0 0 auto; height: 24px; padding: 0 10px; border: 1px solid #e4e4e7; border-radius: 6px;
      background: #fff; color: #3f3f46; cursor: pointer; font-size: 12px; font-family: 'Roboto', Arial, sans-serif;
    }
    .ke-history-details:hover { background: #f4f4f5; border-color: #b0b0b0; }
    .ke-history-details:disabled { opacity: .4; cursor: not-allowed; }
    .ke-history-counts { font-size: 12px; color: #4b4b50; }
    .ke-history-meta { font-size: 11px; color: #8a8a8f; }
    @keyframes ke-alert-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes ke-alert-zoom-in {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
    .ke-actions {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .ke-sep {
      width: 1px;
      height: 22px;
      background: #d7d7d7;
      align-self: center;
      flex: 0 0 1px;
      border: none;
      margin: 0;
      padding: 0;
      pointer-events: none;
    }
    .ke-actions-row2 {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 6px;
    }
    .ke-actions-manual {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 6px;
    }
    .ke-field-label {
      font-size: 12px;
      color: #2e2e2e;
      font-weight: 600;
      white-space: nowrap;
      line-height: 1.6;
      min-width: 96px;
      text-align: right;
    }
    .ke-actions-manual textarea.ke-input {
      flex: 1 1 auto;
      min-width: 220px;
      min-height: 30px;
      resize: vertical;
      font-family: 'Roboto Mono', Consolas, monospace;
    }
    .ke-select, .ke-input {
      padding: 5px 8px; border: 1px solid #d4d4d4; border-radius: 4px;
      font-size: 12px; background: #fff; color: #2e2e2e;
      font-family: 'Roboto', Arial, sans-serif;
    }
    .ke-select--native {
      position: absolute; opacity: 0; width: 1px; height: 1px;
      pointer-events: none; border: 0; padding: 0; margin: 0;
    }
    .ke-select-wrap { position: relative; display: inline-flex; max-width: 280px; }
    .ke-select-trigger {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 8px; border: 1px solid #d4d4d4; border-radius: 4px;
      background: #fff; color: #2e2e2e; font-family: 'Roboto', Arial, sans-serif;
      font-size: 12px; cursor: pointer; width: 100%;
    }
    .ke-select-trigger:hover { border-color: #b0b0b0; background: #fafafa; }
    .ke-select-trigger:focus-visible { outline: 2px solid #0086d6; outline-offset: -1px; }
    .ke-select-wrap.ke-disabled .ke-select-trigger {
      opacity: .55; cursor: default; pointer-events: none; color: #9a9a9a;
    }
    .ke-select-trigger-icon {
      display: inline-flex; align-items: center; flex: 0 0 auto;
      color: #0086d6;
    }
    .ke-select-trigger-label {
      flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ke-select-trigger-chevron {
      display: inline-flex; align-items: center; flex: 0 0 auto; color: #8a8a8a;
    }
    .ke-select-menu {
      display: none; position: fixed; z-index: 1000000;
      background: #fff; border: 1px solid #ddd; border-radius: 6px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14); padding: 4px;
      max-height: 380px; overflow: auto;
    }
    .ke-select-menu.open { display: block; }
    .ke-select-section-label {
      padding: 6px 10px 2px; font-size: 11px; font-weight: 600;
      color: #8a8a8a; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .ke-select-option {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 6px 10px; border: none; background: none; border-radius: 4px;
      font-family: 'Roboto', Arial, sans-serif; font-size: 12px;
      color: #2e2e2e; text-align: left; cursor: pointer;
    }
    .ke-select-option:hover, .ke-select-option:focus-visible { background: #f5f5f6; outline: none; }
    .ke-select-option .ke-opt-icon {
      display: inline-flex; align-items: center; justify-content: center;
      flex: 0 0 auto; color: #0086d6; width: 16px;
    }
    .ke-select-option.ke-selected { color: #0086d6; font-weight: 600; }
    .ke-select-option-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ke-actions-row2 > .ke-row { width: 100%; flex-wrap: nowrap; }
    .ke-actions-row2 .ke-row > input,
    .ke-actions-row2 .ke-row > select,
    .ke-actions-row2 .ke-row > textarea {
      flex: 1 1 auto;
      min-width: 0;
    }
    .ke-perm { max-width: 180px; }
    .ke-source-project-row .ke-source-project-name {
      flex: 0 1 auto;
      min-width: 0;
      max-width: 45%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      color: #555;
    }
    .ke-tags-row select.ke-tags-mode {
      flex: 0 0 auto;
      width: 90px;
    }
    .ke-tags-row .ke-field-label {
      min-width: 0;
      margin-right: auto;
    }
    .ke-field {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1 1 0;
      min-width: 160px;
    }
    .ke-field .ke-input {
      flex: 1 1 auto;
      min-width: 0;
      width: auto;
    }
    .ke-country-row {
      width: 100%;
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .ke-description-row { width: 100%; }
    .ke-description-input {
      flex: 1 1 auto;
      min-width: 0;
      max-height: 96px;
      resize: vertical;
    }
    .ke-tags-input {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      padding: 3px 6px;
      border: 1px solid #d4d4d4;
      border-radius: 4px;
      background: #fff;
      cursor: text;
      position: relative;
    }
    .ke-tags-input:focus-within { border-color: #0086d6; }
    .ke-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: #e3f2fd;
      color: #1565c0;
      border-radius: 12px;
      padding: 2px 8px;
      font-size: 12px;
      font-family: 'Roboto', Arial, sans-serif;
      white-space: nowrap;
    }
    .ke-tag-x {
      border: none;
      background: transparent;
      color: #1565c0;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
    }
    .ke-tag-x:hover { color: #d64545; }
    .ke-tags-cell {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    }
    .ke-tags-cell .ke-tag.ke-tag-in-cell {
      font-size: 11px;
      line-height: 1.5;
      padding: 1px 7px;
    }
    .ke-tags-empty { color: #9e9e9e; }
    .ke-tags-text {
      flex: 1 1 140px;
      min-width: 140px;
      border: none;
      outline: none;
      padding: 2px 4px;
      font-size: 12px;
      font-family: 'Roboto', Arial, sans-serif;
      background: transparent;
      color: #2e2e2e;
    }
    .ke-tags-dropdown {
      position: absolute;
      top: calc(100% + 2px);
      left: 0;
      right: 0;
      background: #fff;
      border: 1px solid #d4d4d4;
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      max-height: 180px;
      overflow-y: auto;
      z-index: 2147483002;
    }
    .ke-tags-option {
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      font-family: 'Roboto', Arial, sans-serif;
      color: #2e2e2e;
    }
    .ke-tags-option:hover, .ke-tags-option.ke-active { background: #e3f2fd; }
    .ke-tags-option-empty { color: #888; cursor: default; }
    .ke-tags-menu {
      position: fixed;
      background: #fff;
      border: 1px solid #e9e9e9;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      padding: 4px;
      min-width: 170px;
      max-width: 320px;
      z-index: 300;
    }
    .ke-tags-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      border: none;
      background: transparent;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 13px;
      color: #23262f;
      text-align: left;
      cursor: pointer;
      font-family: 'Roboto', Arial, sans-serif;
    }
    .ke-tags-menu-item:hover { background: #f5f5f6; }
    .ke-tags-menu-section { display: inline-flex; align-items: center; }
    .ke-tags-menu-label { flex: 1 1 auto; }
    .ke-icon-btn {
      background: transparent;
      border: none;
      border-radius: 4px;
      padding: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #2e2e2e;
    }
    .ke-icon-btn:hover { background: rgba(0,0,0,0.08); }
    .ke-stop-btn.k-button.k-button--type-secondary { background: #FFEBEB; color: #850509; border-color: #850509; }
    .ke-stop-btn.k-button.k-button--type-secondary:hover { background: #ffcccd; color: #850509; border-color: #850509; }
    .ke-pause-btn.k-button.k-button--type-secondary { background: #FFF4E2; color: #B25B00; border-color: #F2A73B; }
    .ke-pause-btn.k-button.k-button--type-secondary:hover { background: #FFE8C4; color: #B25B00; border-color: #E8912B; }
    .ke-pause-btn.k-button.k-button--type-secondary:disabled { background: #F7F7F7; color: #C5C5C5; border-color: #E0E0E0; }
    .ke-select-all-box {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin: auto;
    }
    .ke-row-status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      color: #888;
    }
    .ke-row-status svg { display: block; }
    .ke-row-status.ke-row-status-idle,
    .ke-row-status.ke-row-status-pending { color: #999; }
    .ke-row-status.ke-row-status-running { color: #1565c0; }
    .ke-row-status.ke-row-status-success { color: #2e7d32; }
    .ke-row-status.ke-row-status-failed { color: #d64545; }
    .ke-row-status.ke-row-status-cancelled { color: #888; }
    .ke-row-status.ke-row-status-skipped { color: #9e9e9e; }
    .ke-spin-arc {
      animation: ke-spin-dash 0.9s linear infinite;
    }
    @keyframes ke-spin-dash { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -56.55; } }

    .ke-toaster {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 340px;
      max-width: calc(100vw - 32px);
      pointer-events: none;
    }
    .ke-toast {
      pointer-events: auto;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px;
      background: #fff;
      color: #0a0a0a;
      border: 1px solid rgba(0,0,0,0.1);
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      font-size: 13px;
      line-height: 1.35;
      animation: ke-toast-in 0.18s ease-out;
    }
    .ke-toast-out { animation: ke-toast-out 0.18s ease-in forwards; }
    @keyframes ke-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes ke-toast-out { to { opacity: 0; transform: translateY(8px); } }
    .ke-toast-icon {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 1px;
      color: #64748b;
    }
    .ke-toast-icon svg { flex: 0 0 auto; }
    .ke-toast--success .ke-toast-icon { color: #16a34a; }
    .ke-toast--error .ke-toast-icon { color: #dc2626; }
    .ke-toast--warning .ke-toast-icon { color: #d97706; }
    .ke-toast--info .ke-toast-icon { color: #2563eb; }
    .ke-toast-body { flex: 1 1 auto; min-width: 0; }
    .ke-toast-title { font-weight: 600; }
    .ke-toast-desc { margin-top: 2px; color: #52525b; white-space: pre-line; }
    .ke-toast-metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px 12px;
      margin-top: 8px;
    }
    .ke-toast-metric { display: flex; align-items: baseline; gap: 6px; }
    .ke-toast-metric-value { font-weight: 600; font-variant-numeric: tabular-nums; }
    .ke-toast-metric-label { color: #71717a; font-size: 12px; }
    .ke-toast-metric--success .ke-toast-metric-value { color: #16a34a; }
    .ke-toast-metric--error .ke-toast-metric-value { color: #dc2626; }
    .ke-toast-metric--warning .ke-toast-metric-value { color: #d97706; }
    .ke-toast-close {
      flex: 0 0 auto;
      border: 0;
      background: transparent;
      color: #a1a1aa;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 0 2px;
    }
    .ke-toast-close:hover { color: #52525b; }
    .ke-toast-actions { margin-top: 10px; }
    .ke-toast-action {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border: 0;
      border-radius: 6px;
      background: #18181b;
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .ke-toast-action:hover { background: #27272a; }
    .ke-toast-step { margin-top: 2px; color: #52525b; font-size: 12px; white-space: pre-line; }
    .ke-toast-progress {
      margin-top: 8px;
      height: 4px;
      border-radius: 2px;
      background: #e4e4e7;
      overflow: hidden;
    }
    .ke-toast-progress-fill {
      height: 100%;
      width: 0%;
      border-radius: 2px;
      background: #18181b;
      transition: width 0.25s ease;
    }
  `;
    /** Simple OK dialog rendered in the page DOM (outside shadow). */
    function showDialogInPage(message, hostEl) {
        const overlay = el("div", { class: "ke-overlay" });
        const dialog = el("div", { class: "ke-dialog" }, [
            el("p", { text: message }),
            el("div", { class: "ke-row", style: "justify-content:flex-end;" }, [
                el("button", { class: "ke-btn", text: "OK", onclick: () => overlay.remove() }),
            ]),
        ]);
        overlay.appendChild(dialog);
        (hostEl || document.body).appendChild(overlay);
    }
    /**
     * The structured detail of a confirm dialog.
     *
     * Facts become an aligned grid (label left, value right, tabular figures), so
     * a column of counts reads down the page instead of being buried in a
     * paragraph. Warnings are alert rows; notes are the small standing
     * conditions.
     */
    function confirmDetailsEl(details) {
        const box = el("div", { class: "ke-confirm-details" });
        const facts = (details.facts || []).filter((f) => f && f.label);
        if (facts.length) {
            const grid = el("dl", { class: "ke-confirm-facts" });
            for (const fact of facts) {
                grid.appendChild(el("dt", { text: fact.label }));
                grid.appendChild(el("dd", { text: fact.value }));
            }
            box.appendChild(grid);
        }
        for (const warning of details.warnings || []) {
            if (!warning)
                continue;
            box.appendChild(el("div", { class: "ke-confirm-warning" }, [
                el("span", { class: "ke-confirm-warning-icon", "aria-hidden": "true", text: "!" }),
                el("span", { text: warning }),
            ]));
        }
        const notes = (details.notes || []).filter(Boolean);
        if (notes.length) {
            const list = el("ul", { class: "ke-confirm-notes" });
            for (const note of notes)
                list.appendChild(el("li", { text: note }));
            box.appendChild(list);
        }
        return box;
    }
    /**
     * Confirm dialog (shadcn AlertDialog-style) rendered in the page DOM.
     * Resolves with the clicked button's value (false for Cancel / scrim / Escape).
     * buttons: [{ label, value, primary?, destructive? }]
     *
     * The message is the QUESTION. Anything after it is detail: either the
     * structured `details` block, or — for callers that still append lines after a
     * blank line — those lines, rendered as a list rather than as raw newlines in
     * one paragraph.
     */
    function showConfirmDialogInPage(message, buttons, hostEl, title, details) {
        return new Promise((resolve) => {
            const overlay = el("div", { class: "ke-alert-overlay" });
            const children = [];
            if (title)
                children.push(el("div", { class: "ke-alert-title", text: title }));
            const parts = String(message || "").split(/\n{2,}/);
            const question = (parts.shift() || "").trim();
            const extraLines = [];
            for (const part of parts) {
                for (const line of part.split("\n")) {
                    const text = line.trim();
                    if (text)
                        extraLines.push(text);
                }
            }
            if (question)
                children.push(el("p", { class: "ke-alert-desc", text: question }));
            if (details && (details.facts || details.warnings || details.notes)) {
                children.push(confirmDetailsEl(details));
            }
            else if (extraLines.length) {
                const list = el("ul", { class: "ke-confirm-notes is-plain" });
                for (const line of extraLines)
                    list.appendChild(el("li", { text: line }));
                children.push(list);
            }
            const footer = el("div", { class: "ke-alert-footer" });
            for (const btn of buttons) {
                footer.appendChild(el("button", {
                    class: "ke-alert-btn " +
                        (btn.primary ? "is-primary" : btn.destructive ? "is-destructive" : "is-secondary"),
                    type: "button",
                    text: btn.label,
                    onclick: () => close(btn.value),
                }));
            }
            const dialogClass = "ke-alert-dialog" +
                (details && (details.facts || details.warnings || details.notes) ? " ke-alert-dialog--details" : "");
            const dialog = el("div", { class: dialogClass }, children.concat(footer));
            overlay.appendChild(dialog);
            let docEsc = null;
            const close = (value) => {
                if (docEsc)
                    document.removeEventListener("keydown", docEsc);
                overlay.remove();
                resolve(value);
            };
            docEsc = (e) => {
                if (e.key === "Escape")
                    close(false);
            };
            document.addEventListener("keydown", docEsc);
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay)
                    close(false);
            });
            const first = footer.querySelector("button");
            if (first)
                requestAnimationFrame(() => first.focus());
            (hostEl || document.body).appendChild(overlay);
        });
    }
    // ---------- toasts (lightweight, shadcn-inspired) ----------
    let toasterEl = null;
    function ensureToaster() {
        if (toasterEl && toasterEl.isConnected)
            return toasterEl;
        toasterEl = el("div", { class: "ke-toaster", "data-ke-toaster": "1" });
        document.body.appendChild(toasterEl);
        return toasterEl;
    }
    const TOAST_PATHS = {
        success: ["M20 6L9 17l-5-5"],
        error: ["M18 6L6 18", "M6 6l12 12"],
        warning: ["M10.3 3.9l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z", "M12 9v4", "M12 17h.01"],
        info: ["M12 16v-4", "M12 8h.01"],
    };
    const SPINNER_RING_PATH = "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0";
    /**
     * Canonical spinner: a faint track plus a dash arc animated with
     * `stroke-dashoffset`. The arc travels along the ring's own geometry, so it
     * is always centered on the ring — no `transform-origin`/`transform-box`
     * inference, and no dependence on the element's box, layout, or browser.
     */
    function buildSpinner(size) {
        const NS = "http://www.w3.org/2000/svg";
        const px = String(size || 18);
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", px);
        svg.setAttribute("height", px);
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.style.display = "block";
        const track = document.createElementNS(NS, "path");
        track.setAttribute("d", SPINNER_RING_PATH);
        track.setAttribute("stroke-opacity", "0.15");
        svg.appendChild(track);
        const arc = document.createElementNS(NS, "path");
        arc.setAttribute("d", SPINNER_RING_PATH);
        arc.setAttribute("stroke-dasharray", "22 34.55");
        arc.classList.add("ke-spin-arc");
        svg.appendChild(arc);
        return svg;
    }
    function toastIcon(type) {
        if (type === "loading")
            return buildSpinner(18);
        const NS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "18");
        svg.setAttribute("height", "18");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        for (const d of TOAST_PATHS[type] || TOAST_PATHS.info) {
            const p = document.createElementNS(NS, "path");
            p.setAttribute("d", d);
            svg.appendChild(p);
        }
        return svg;
    }
    function toastIconWrapper(type) {
        return el("span", { class: "ke-toast-icon" }, [toastIcon(type)]);
    }
    /** Non-blocking toast. opts: { type, title, description, action: {label,onClick}, metrics, duration }.
     *  Toasts persist until the user closes them or a new run starts
     *  (dismissAllToasts). Warning and success toasts are transient and auto-close
     *  after `o.duration`, default 6s — EXCEPT when `duration` is 0, which makes a
     *  toast sticky: no timer at all. The only other auto-close is 10s AFTER a
     *  toast's action button is clicked (e.g. "Download report").
     *
     *  Sticky exists for a run's report toast on a whole-project run. It carries
     *  counts the user needs to read and a report they may want to download, and
     *  it used to vanish on its own after 6s, taking the download button with it. */
    function showToast(opts) {
        const o = typeof opts === "string" ? { title: opts } : opts || {};
        const type = o.type || "info";
        const host = ensureToaster();
        const icon = toastIconWrapper(type);
        const body = el("div", { class: "ke-toast-body" }, [
            el("div", { class: "ke-toast-title", text: o.title || "" }),
        ]);
        if (o.description)
            body.appendChild(el("div", { class: "ke-toast-desc", text: o.description }));
        if (o.metrics && o.metrics.length) {
            const grid = el("div", { class: "ke-toast-metrics" });
            for (const m of o.metrics) {
                grid.appendChild(el("div", { class: "ke-toast-metric" + (m.tone ? ` ke-toast-metric--${m.tone}` : "") }, [
                    el("span", { class: "ke-toast-metric-value", text: String(m.value) }),
                    el("span", { class: "ke-toast-metric-label", text: m.label }),
                ]));
            }
            body.appendChild(grid);
        }
        if (o.action && typeof o.action.onClick === "function") {
            body.appendChild(el("div", { class: "ke-toast-actions" }, [
                el("button", {
                    class: "ke-toast-action",
                    type: "button",
                    text: o.action.label || t("Download"),
                    onclick: () => {
                        try {
                            const r = o.action.onClick();
                            if (r && typeof r.catch === "function")
                                r.catch(() => { });
                        }
                        catch (e) { /* ignore download errors */ }
                        // The report was downloaded, so this toast may close shortly after.
                        setTimeout(dismiss, 10000);
                    },
                }),
            ]));
        }
        const close = el("button", {
            class: "ke-toast-close",
            type: "button",
            "aria-label": t("Dismiss"),
            text: "\u00d7",
        });
        const toast = el("div", { class: `ke-toast ke-toast--${type}`, role: "status", "aria-live": "polite" }, [icon, body, close]);
        host.appendChild(toast);
        const dismiss = () => {
            toast.classList.add("ke-toast-out");
            setTimeout(() => toast.remove(), 180);
        };
        close.addEventListener("click", dismiss);
        // duration 0 means sticky: no auto-close timer at all. Warning and success
        // toasts are otherwise transient; every other type already persists.
        if (o.duration === 0) {
            /* intentionally sticky */
        }
        else if (type === "warning" || type === "success") {
            setTimeout(dismiss, typeof o.duration === "number" ? o.duration : 6000);
        }
        return { el: toast, dismiss };
    }
    /** Dismisses all open toasts (used when a new run starts). */
    function dismissAllToasts() {
        if (!toasterEl || !toasterEl.isConnected)
            return;
        const nodes = Array.from(toasterEl.children);
        for (const node of nodes) {
            node.classList.add("ke-toast-out");
            setTimeout(() => node.remove(), 180);
        }
    }
    /** Live run-progress toast with a real progress bar. Returns { setTitle, setStep, setProgress, finish }. */
    function showProgressToast(title) {
        const host = ensureToaster();
        const icon = toastIconWrapper("loading");
        const titleEl = el("div", { class: "ke-toast-title", text: title || "" });
        const stepEl = el("div", { class: "ke-toast-step", text: "" });
        const fill = el("div", { class: "ke-toast-progress-fill" });
        const body = el("div", { class: "ke-toast-body" }, [
            titleEl,
            stepEl,
            el("div", { class: "ke-toast-progress" }, [fill]),
        ]);
        const toast = el("div", { class: "ke-toast ke-toast--loading", role: "status", "aria-live": "polite" }, [icon, body]);
        host.appendChild(toast);
        let removed = false;
        const finish = () => {
            if (removed)
                return;
            removed = true;
            toast.classList.add("ke-toast-out");
            setTimeout(() => toast.remove(), 180);
        };
        return {
            setTitle(text) { titleEl.textContent = text || ""; },
            setStep(text) { stepEl.textContent = text || ""; },
            setProgress(done, total) {
                const pct = total > 0 ? Math.round(Math.max(0, Math.min(100, (done / total) * 100))) : 0;
                fill.style.width = pct + "%";
            },
            finish,
        };
    }
    window.KoboEnhance.components = {
        PAGE_STYLES,
        showDialogInPage,
        showConfirmDialogInPage,
        showToast,
        dismissAllToasts,
        showProgressToast,
        buildSpinner,
    };
})();
