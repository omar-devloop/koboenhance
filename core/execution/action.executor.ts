/**
 * core/execution/action.executor.ts — EXECUTION concept: "how an action runs".
 *
 * The executor owns everything that is NOT business logic:
 *   - resolving the scope (explicit UIDs or entire account),
 *   - validating + confirming before anything is touched,
 *   - the per-item loop, cancellation (AbortController), error policy and
 *     progress accounting (runItems),
 *   - summing the report into success/fail/cancel/skip counts and the CSV,
 *     and materializing account scans' declared export data (the report
 *     stage, core/export/export.service.js buildCsvFiles).
 *
 * It drives BOTH action kinds through the same generic path, with zero
 * knowledge of which action is running:
 *
 *   bulk    -> def.validate(context) -> def.confirm(context) ->
 *              scope resolution -> def.execute(ctx) per project
 *              (ctx = { uid, signal, request }) -> standardized result
 *              { uid, projectName, status, message, error, data } (via
 *              def.formatResult) -> flattened report rows (action-registry
 *              rowFor: stable base columns + unioned `data` columns)
 *   account -> def.validate(context) -> def.confirm(context) ->
 *              def.execute(context) (one whole-run scan, returns the raw
 *              result the action owns) -> the executor materializes
 *              res.files (declared export specs) into CSV via the report
 *              stage -> def.report.summary(result)
 *
 * Everything the toolbar needs to render afterwards is packaged into the
 * finished payload and, when relevant, `finished.ui` — a
 * { dialog } | { type,title,description?,metrics?,files? } | null shape.
 * No action name, platform key, or per-action branch lives here.
 */
(function () {
  const KE = window.KoboEnhance;
  const { t } = KE.i18n;

  // Default UI gateway, injected at bootstrap by entry/main.js (wiring). The
  // executor stays UI-agnostic; it only ever talks to the RunUiGateway.
  let defaultUi: RunUiGateway | null = null;

  /** Silent fallback so a run without wiring never throws on the gateway. */
  const NOOP_UI: RunUiGateway = {
    alert(): void {},
    confirm(): Promise<unknown> { return Promise.resolve(false); },
    toast(): void {},
  };

  function setDefaultUi(ui: RunUiGateway): void {
    defaultUi = ui;
  }

  // Run-history audit: a sink injected by features/history/history.store.ts
  // (DI, same pattern as setDefaultUi — core stays feature-agnostic). Every
  // finished run is captured here so no UI/feature code has to remember to log.
  let historySink: ((capture: RunHistoryCapture) => void) | null = null;

  function setHistorySink(sink: (capture: RunHistoryCapture) => void): void {
    historySink = sink;
  }

  const SECRET_KEY = /password|token|authorization|credential|api[_-]?key|secret/i;

/** Consecutive per-item failures sharing one HTTP status before the run gives up.
 *  Absorbs a genuinely missing project or two; stops a dead session from
 *  producing a false failure for every project that follows it. */
const MAX_REPEATED_ITEM_FAILURES = 5;

  /** Builds the compact audit record for one finished run. Never contains
   *  credentials (sanitizer drops credential-like keys defensively) or the
   *  finished UI payload. */
  function buildHistoryCapture(def: Action, context: ActionContext, finished: RunReport | AccountReport): RunHistoryCapture {
    const settings: ActionRequest = Object.assign({}, context.request);
    for (const k of Object.keys(settings)) {
      if (SECRET_KEY.test(k)) delete (settings as Record<string, unknown>)[k];
    }
    let projectCount = context.uids.length;
    if (finished.kind === "bulk") {
      if (finished.report && finished.report.length > projectCount) projectCount = finished.report.length;
    } else if (finished.kind === "account") {
      const scan = finished.report as ScanResult | undefined;
      const files = scan && Array.isArray(scan.files) ? scan.files : [];
      const counted = files.reduce((n, f) => n + (f && f.rows ? f.rows.length : 0), 0);
      if (counted > projectCount) projectCount = counted;
    }
    let outcome: RunHistoryOutcome = "success";
    if (finished.stopped) outcome = "stopped";
    else if (finished.error) outcome = "error";
    else if (finished.empty) outcome = "empty";
    const capture: RunHistoryCapture = {
      action: def.id,
      actionLabel: def.label || def.id,
      kind: finished.kind === "account" ? "account" : "bulk",
      source: context.source,
      scope: { projectCount, wholeAccount: !!context.wholeAccount },
      outcome,
      error: finished.error || undefined,
      settings,
    };
    if (finished.kind === "bulk") {
      capture.counts = {
        success: finished.successCount || 0,
        failed: finished.failCount || 0,
        cancelled: finished.cancelCount || 0,
        skipped: finished.skipCount || 0,
      };
      if (finished.report && finished.csv) {
        capture.details = {
          headers: KE.exportSvc.unionKeys(finished.report),
          rows: (finished.report as Array<Record<string, string>>).slice(0, 2000),
          csv: finished.csv,
        };
      }
    }
    return capture;
  }

  /** Records the finished run through the injected sink; auditing can never
   *  break or delay a run. */
  function recordHistory(def: Action, context: ActionContext, finished: RunReport | AccountReport): void {
    if (!historySink) return;
    try {
      historySink(buildHistoryCapture(def, context, finished));
    } catch (e) {
      /* audit must never affect the run */
    }
  }

  let currentAbortController: AbortController | null = null;

  // Paused state, separate from cancellation. A paused run parks its loop on a
  // promise gate between items; the AbortController stays unborn so Stop still
  // works, and no in-flight request is ever interrupted.
  let paused = false;
  let pauseGate: Promise<void> | null = null;
  let releasePause: (() => void) | null = null;
  let pauseNotified = false;

  /** Pauses the active run between items. No-op unless something is running. */
  function pause(): void {
    if (!currentAbortController || paused) return;
    paused = true;
    pauseNotified = false;
    pauseGate = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
  }

  /** Lifts a paused run so its loop continues where it parked. */
  function resume(): void {
    if (!paused) return;
    paused = false;
    if (releasePause) releasePause();
    pauseGate = null;
    releasePause = null;
  }

  function isPaused(): boolean {
    return paused;
  }

  /**
   * Parks the loop on a pause until resume() lifts it or the signal aborts.
   * When `notify` is set and a pause listener exists, it fires ONCE per pause
   * episode with the remaining items and the rows accumulated so far (the
   * caller can persist a rescue snapshot or offer the partial report).
   */
  async function parkWhilePaused<T, R>(c: RunItemsConfig<T, R>, items: T[], i: number, processed: number, rows: R[], notify: boolean): Promise<void> {
    if (!paused) return;
    if (c.signal && c.signal.aborted) return;
    if (notify && typeof c.onPause === "function" && !pauseNotified) {
      pauseNotified = true;
      await c.onPause(items.slice(i), processed, rows.slice());
    }
    while (paused && !(c.signal && c.signal.aborted)) {
      const gate = pauseGate;
      if (!gate) break;
      await gate;
    }
  }

  function isAbort(e: unknown): boolean {
    return !!e && (e as { name?: string }).name === "AbortError";
  }

  /** Appends a single report row or a list of rows to the target array. */
  function pushRows<R>(target: R[], out: R | R[] | null | undefined): void {
    if (out == null) return;
    if (Array.isArray(out)) {
      for (const r of out) {
        if (r != null) target.push(r);
      }
      return;
    }
    target.push(out);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Central execution defaults. The execution layer owns pacing/parallelism
   * here — adjust in ONE place (or per run via RunOptions.execution) instead
   * of editing actions. `itemDelayMs: 200` unifies the previous fragmented
   * per-action pauses (bulk 300, permission scans 200, exports 0) into one
   * server-friendly value; `concurrency: 1` preserves the strictly sequential
   * execution behavior.
   */
  const defaultExecution: KoboExecutionOptions = {
    concurrency: 1,
    itemDelayMs: 200,
    requestPacingMs: 0,
  };

  /** Merges a run-level override (RunOptions.execution) onto the global defaults. */
  function resolveExecution(o: RunOptions): KoboExecutionOptions {
    const x = (o && o.execution) || {};
    return {
      concurrency: Math.max(1, Math.floor(x.concurrency || defaultExecution.concurrency)),
      itemDelayMs: Math.max(0, Math.floor(x.itemDelayMs === undefined ? defaultExecution.itemDelayMs : x.itemDelayMs)),
      requestPacingMs: Math.max(0, Math.floor(x.requestPacingMs === undefined ? defaultExecution.requestPacingMs : x.requestPacingMs)),
    };
  }

  /** Central adjustment point: mutate the global execution defaults. */
  function setExecutionPolicy(policy: Partial<KoboExecutionOptions>): void {
    if (!policy) return;
    if (policy.concurrency !== undefined) defaultExecution.concurrency = Math.max(1, Math.floor(policy.concurrency));
    if (policy.itemDelayMs !== undefined) defaultExecution.itemDelayMs = Math.max(0, Math.floor(policy.itemDelayMs));
    if (policy.requestPacingMs !== undefined) defaultExecution.requestPacingMs = Math.max(0, Math.floor(policy.requestPacingMs));
  }

  function getExecutionPolicy(): KoboExecutionOptions {
    return {
      concurrency: defaultExecution.concurrency,
      itemDelayMs: defaultExecution.itemDelayMs,
      requestPacingMs: defaultExecution.requestPacingMs,
    };
  }

  /**
   * The single generic per-item execution loop used by every bulk flow.
   *
   * config:
   *   items           list to iterate (UID strings or asset objects)
   *   signal          AbortSignal driving cancellation
   *   execution       resolved central policy (concurrency/itemDelayMs/requestPacingMs)
   *   perItem         async (item, index) => row | row[] | null
   *   onItemError     async (e, item, index) =>
   *                     { rows?: row|row[], action?: "continue"|"break"|"throw" }
   *                     (never called for AbortError — the runner intercepts it)
   *   onAbort         async (remainingItems) => row | row[] | null
   *                     called with the current + remaining items once the run
   *                     is stopped (nothing is persisted for them otherwise);
   *                     may return rows to mark them (e.g. cancelled rows) or
   *                     null to leave them untouched.
   *   onProgress      (done, total) called after every processed item
   *   propagateAbort  rethrow the AbortError so the caller owns the stop
   *                   wording (used by the project-list export)
   *
   * Returns { processed, rows, stopped }. `rows` accumulates whatever the
   * callbacks return; per-flow policy decides their shape.
   */
  async function runItems<T, R>(config: RunItemsConfig<T, R>): Promise<{ processed: number; rows: R[]; stopped: boolean }> {
    const c = config || {};
    const items: T[] = c.items || [];
    const total = items.length;
    const exec: KoboExecutionOptions = c.execution || getExecutionPolicy();
    const concurrency = Math.max(1, exec.concurrency | 0);
    const itemDelayMs = Math.max(0, exec.itemDelayMs | 0);
    const pacingMs = Math.max(0, exec.requestPacingMs | 0);
    const rows: R[] = [];
    let processed = 0;
    let stopped = false;

    if (total === 0) return { processed, rows, stopped };

    // Fast path: strictly sequential (default). Preserves the historical loop
    // exactly, with the pause sourced from the central policy.
    if (concurrency <= 1) {
      let nextStartAt = 0;
      for (let i = 0; i < total; i++) {
        const item = items[i];

        if (pacingMs > 0 && i > 0) {
          const wait = nextStartAt - Date.now();
          if (wait > 0) await sleep(wait);
          nextStartAt = Date.now() + pacingMs;
        }

        await parkWhilePaused(c, items, i, processed, rows, true);

        if (c.signal && c.signal.aborted) {
          stopped = true;
          if (typeof c.onAbort === "function") {
            pushRows(rows, await c.onAbort(items.slice(i)));
          }
          if (c.propagateAbort) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          break;
        }

        try {
          pushRows(rows, await c.perItem(item, i));
        } catch (e) {
          if ((c.signal && c.signal.aborted) || isAbort(e)) {
            stopped = true;
            if (typeof c.onAbort === "function") {
              pushRows(rows, await c.onAbort(items.slice(i)));
            }
            if (c.propagateAbort) throw e;
            break;
          }
          const handled = typeof c.onItemError === "function" ? await c.onItemError(e, item, i) : null;
          if (handled) {
            pushRows(rows, handled.rows);
            if (handled.action === "break") break;
            if (handled.action === "throw") throw e;
          } else {
            throw e;
          }
        }

        processed++;
        if (typeof c.onProgress === "function") c.onProgress(processed, total);
        if (itemDelayMs > 0) await sleep(itemDelayMs);
      }
      return { processed, rows, stopped };
    }

    // Parallel path (concurrency > 1): a bounded pool. Results are still
    // emitted in input index order and cancellation still wins: once the
    // signal is aborted no new item is started and in-flight work is allowed
    // to settle before the (single, ordered) onAbort pass.
    let cursor = 0;
    let nextStartAt = 0;
    let failedBreak = false;
    let throwError: unknown = null;
    const slots: (R[])[] = new Array(total).fill(null);

    const pace = async (): Promise<void> => {
      if (pacingMs <= 0) return;
      const wait = nextStartAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextStartAt = Date.now() + pacingMs;
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (stopped || failedBreak || throwError !== null) return;
        if (c.signal && c.signal.aborted) {
          stopped = true;
          return;
        }
        const i = cursor++;
        if (i >= total) return;
        const item = items[i];
        await pace();
        await parkWhilePaused(c, items, i, processed, [], false);
        if (c.signal && c.signal.aborted) {
          stopped = true;
          return;
        }
        try {
          const out = await c.perItem(item, i);
          slots[i] = [];
          pushRows(slots[i], out);
        } catch (e) {
          if ((c.signal && c.signal.aborted) || isAbort(e)) {
            stopped = true;
            return;
          }
          const handled = typeof c.onItemError === "function" ? await c.onItemError(e, item, i) : null;
          slots[i] = [];
          if (handled) {
            pushRows(slots[i], handled.rows);
            if (handled.action === "break") {
              failedBreak = true;
              return;
            }
            if (handled.action === "throw") {
              throwError = e;
              return;
            }
          } else {
            throwError = e;
            return;
          }
        }
        processed++;
        if (typeof c.onProgress === "function") c.onProgress(processed, total);
        if (itemDelayMs > 0) await sleep(itemDelayMs);
      }
    };

    const workers: Promise<void>[] = [];
    const poolSize = Math.min(concurrency, total);
    for (let w = 0; w < poolSize; w++) workers.push(worker());
    await Promise.all(workers);

    if (throwError !== null && !stopped) throw throwError;

    for (let i = 0; i < total; i++) {
      const slot = slots[i];
      if (slot) {
        for (const r of slot) rows.push(r);
      }
    }

    if (stopped) {
      if (typeof c.onAbort === "function") {
        const remaining: T[] = [];
        for (let i = 0; i < total; i++) {
          if (!slots[i]) remaining.push(items[i]);
        }
        pushRows(rows, await c.onAbort(remaining));
      }
      if (c.propagateAbort) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
    }

    return { processed, rows, stopped };
  }

  /** Builds the per-action request map out of the run options. */
  function buildRequest(actionDef: Action, o: RunOptions): ActionRequest {
    return {
      username: (o.username || "").trim(),
      usernames: (o.users || []).map((u) => String(u).trim()).filter(Boolean),
      permission: o.permission,
      prefix: o.prefix || "",
      suffix: o.suffix || "",
      findText: o.findText || "",
      replaceText: o.replaceText || "",
      description: o.description || "",
      countries: o.countries || [],
      sectors: o.sectors || [],
      tags: o.tags || [],
      tagsMode: o.tagsMode || "append",
      sourceProject: (o.sourceProject || "").trim(),
      templateId: (o.templateId || "").trim(),
      // The transfer action's own options. This whitelist used to omit them, so
      // a run's ActionRequest arrived at validate() with moveForms and
      // moveSubmissions undefined and the action rejected its own UI. Every
      // field a caller puts on RunOptions has to be copied here, or it silently
      // does not reach the action.
      moveForms: o.moveForms === true,
      moveSubmissions: o.moveSubmissions === true,
      transferReady: o.transferReady === true,
    };
  }

  /** Applies the caller's progress callback in the shared (msg,done,total) form. */
  function forwardProgress(o: RunOptions, msg: string, done: number, total: number): void {
    if (typeof o.onProgress === "function") o.onProgress(msg, done, total);
  }

  /**
   * Runs any registered action (bulk or account) end-to-end through the
   * standard contract: validate -> confirm -> execute -> summarize. Resolves
   * the action by id through the centralized registry (core/actions/
   * action-registry.ts) when no descriptor is passed. The ONLY inputs the
   * executor inspects are the normalized descriptor fields.
   *
   * options: { ui, action, wholeAccount, uids, source, filterUrl,
   *            resolveWholeAccount, username, permission, prefix, suffix,
   *            findText, replaceText, description, countries, sectors, tags,
   *            tagsMode, sourceProject, onStarted, onFinished, onProgress,
   *            onStatus }
   */
  async function runAction(actionDef: Action | null | undefined, options: RunOptions = {}): Promise<RunReport | AccountReport | void> {
    const o = options || {};
    const ug = o.ui || defaultUi || NOOP_UI;
    // Resolve the action through the centralized registry. A raw descriptor
    // may still be passed directly (legacy runBulkAction alias), but any id
    // carried in the run options is resolved here — the single source of truth.
    const def = actionDef || (o.action ? KE.actionRegistry.get(o.action) : null);
    if (!def) {
      ug.alert(t("Select an action before running."));
      return;
    }

    const wholeAccount = !!o.wholeAccount;
    const uids = wholeAccount ? [] : (o.uids || []).filter(Boolean) as UID[];

    // The curated runtime bundle: the ONLY services an action may consume
    // while executing. Assembled once per run so every context (validate,
    // confirm, item executes, account execute) shares the same instance.
    // The resolved execution policy is decided HERE, centrally — actions never
    // set their own timing.
    const exec = resolveExecution(o);

    const runtime: ActionRuntime = {
      api: { assets: KE.apiAssets, permissions: KE.apiPermissions, users: KE.apiUsers },
      scope: KE.scopeService,
      pagination: KE.pagination,
      auth: { baseUrl: KE.auth.getBaseUrl(), getUsername: () => KE.auth.getUsername() },
      permissions: KE.actionRegistry.PERMISSIONS,
      execution: exec,
      // Sub-loops (account scans) inherit the resolved policy; they never pass
      // their own timing.
      runItems: <T, R>(cfg: RunItemsConfig<T, R>) => runItems(Object.assign({}, cfg, { execution: cfg.execution || exec })),
      report: { scalarFields: (obj) => KE.exportSvc.scalarFields(obj) },
    };

    const context: ActionContext = {
      def,
      action: def.id,
      source: o.source || "selected",
      wholeAccount,
      uids,
      filterUrl: o.filterUrl,
      resolveWholeAccount: o.resolveWholeAccount,
      request: buildRequest(def, o),
      runtime,
    };

    const invalid = await def.validate(context);
    if (invalid) {
      const issue = invalid as ValidationIssue;
      if (issue.toast) ug.toast(issue.toast);
      else ug.alert(typeof invalid === "string" ? invalid : (issue.message || "") as string);
      return;
    }

    const c = await def.confirm(context);
    if (!o.skipConfirm) {
      const confirmed = await ug.confirm(c.message, c.buttons, c.title, c.details);
      if (!confirmed) return;
    }

    currentAbortController = new AbortController();
    paused = false;
    pauseGate = null;
    releasePause = null;
    pauseNotified = false;
    const signal = currentAbortController.signal;
    context.signal = signal;

    if (typeof o.onStarted === "function") o.onStarted(wholeAccount ? [] : uids, def);

    let finished: RunReport | AccountReport | undefined;
    try {
      if (def.kind === "panel") {
        // Panel actions do not run the item loop or the report stage: the
        // toolbar opens their modal UI directly (ui/integration.ts). This
        // guard only keeps the executor contract honest if such a run is ever
        // invoked outside the toolbar.
        finished = { action: def.id, actionLabel: def.label || def.id, kind: "panel", ui: null };
      } else {
        finished =
          def.kind === "account"
            ? await runAccount(def, context, o, signal)
            : await runBulk(def, context, o, signal, ug);
      }
    } finally {
      currentAbortController = null;
    }

    if (typeof o.onFinished === "function" && finished) o.onFinished(finished);
    if (finished && finished.kind !== "panel") recordHistory(def, context, finished);
    return finished;
  }

  /** Resolves the UIDs a whole-account run acts on (respecting the list filter). */
  async function resolveWholeAccount(def: Action, context: ActionContext, o: RunOptions, signal: AbortSignal): Promise<UID[]> {
    const effective = context.resolveWholeAccount
      ? await context.resolveWholeAccount(signal)
      : await context.runtime.scope.resolveUids({
          uids: null,
          filterUrl: context.filterUrl,
          signal,
          onProgress: (msg: string, done: number, total: number) => forwardProgress(o, msg, done, total),
        });
    return (effective || []).filter(Boolean) as UID[];
  }

  /** Renders the finished payload + UI for one bulk (per-project) action. */
  async function runBulk(def: Action, context: ActionContext, o: RunOptions, signal: AbortSignal, ug: RunUiGateway): Promise<RunReport> {
    const actionLabel = def.label;
    const request = context.request;

    let effectiveUids: UID[] = context.uids.slice();

    if (context.wholeAccount) {
      try {
        effectiveUids = await resolveWholeAccount(def, context, o, signal);
      } catch (e) {
        if (isAbort(e)) {
          return { action: def.id, actionLabel, kind: "bulk", stopped: true, ui: (def.report && def.report.summary ? def.report.summary({ stopped: true }, def) : null) as RunFinishedUi };
        }
        const error = ((e as { detail?: unknown; message?: unknown }).detail || (e as { message?: string }).message || String(e)) as string;
        return { action: def.id, actionLabel, kind: "bulk", error, ui: (def.report && def.report.summary ? def.report.summary({ error }, def) : null) as RunFinishedUi };
      }
      if (effectiveUids.length === 0) {
        return { action: def.id, actionLabel, kind: "bulk", empty: true, ui: (def.report && def.report.summary ? def.report.summary({ empty: true }, def) : null) as RunFinishedUi };
      }
    }

    const rowOf = (std: ActionResult | KoboRecord): ReportRow =>
      KE.actionRegistry.rowFor(std, {
        actionLabel,
        permissionOut: def.permissionOut(request),
        targetUserOut: def.targetUserOut(request),
      });

    const setStatus = (uid: UID, status: ProcessStatus, detail: string): void => {
      if (typeof o.onStatus === "function") o.onStatus(uid, status, detail);
    };

    for (const uid of effectiveUids) setStatus(uid, "idle", "");

    /**
     * Progress detail for the item currently being processed.
     *
     * `ItemContext` carried no progress hook, so a bulk action could only report
     * once per PROJECT. A long inner step — copying hundreds of submissions —
     * therefore sat on "… (0/1)" for its whole duration with no sign of life. An
     * action can now publish a short detail string, which is appended to the
     * standard step line and pushed immediately rather than at the end of the
     * item, so the toast moves while the work does.
     */
    let itemStepDetail = "";
    let lastDone = 0;
    /**
     * Consecutive per-item failures sharing one HTTP status, used to recognise an
     * expired session. A single 404 is a legitimately missing project; a run of
     * them is a dead session, and continuing only manufactures false failures.
     */
    let repeatStatus = 0;
    let repeatCount = 0;
    const stepLine = (done: number, total: number): string => {
      const step = t((def.stepLabel || "Running") as keyof EnDict);
      return itemStepDetail
        ? t("{step}... ({done}/{total}) - {detail}", { step, done, total, detail: itemStepDetail })
        : t("{step}... ({done}/{total})", { step, done, total });
    };

    const runRes = await runItems<UID, ReportRow>({
      items: effectiveUids,
      signal,
      execution: context.runtime.execution,
      onPause: (remaining: UID[], processed: number, rows: ReportRow[]): void => {
        if (typeof o.onPaused === "function") {
          o.onPaused({ remaining: remaining.slice(), processed, total: effectiveUids.length, rows: rows.slice() });
        }
      },
      perItem: async (uid: UID): Promise<ReportRow> => {
        itemStepDetail = "";
        const itemCtx: ItemContext = {
          uid,
          signal,
          request,
          runtime: context.runtime,
          onStep: (detail: string): void => {
            itemStepDetail = detail;
            const total = effectiveUids.length;
            // Reported against the project BEING PROCESSED (1-based), not the
            // number already finished, so a detail published during the first of
            // two projects reads 1/2 rather than 0/2. `lastDone` counts
            // completions, so the in-flight index is the next one up, clamped so
            // a detail fired after the final item cannot read 3/2.
            const shown = Math.min(lastDone + 1, total);
            forwardProgress(o, stepLine(shown, total), shown, total);
          },
        };
        setStatus(uid, "running", "");
        const result = await def.execute(itemCtx);
        const std = def.formatResult(result, itemCtx);
        setStatus(uid, std.status || "success", std.error || std.message || "");
        // A success clears the run of identical failures: an expired session that
        // the user recovered from must not leave the tally primed to stop the run.
        repeatStatus = 0;
        repeatCount = 0;
        return rowOf(std);
      },
      onItemError: async (e: unknown, uid: UID): Promise<{ rows: ReportRow; action: "continue" | "break" }> => {
        const markFailed = (detail: string, action: "continue" | "break"): { rows: ReportRow; action: "continue" | "break" } => {
          // The failing action's own project name, when it supplied one. An
          // action that knows which project it was working on attaches it to the
          // error, because the executor cannot derive it from a uid — and a
          // report of 50 rows where every failure says "" for Project_Name is
          // not actionable.
          const named = (e as { projectName?: string }).projectName || "";
          const std: ActionResult = { uid, projectName: named, status: "failed", message: detail, error: detail, data: {} };
          setStatus(uid, "failed", detail);
          return { rows: rowOf(std), action };
        };
        if (!navigator.onLine || /Failed to fetch/i.test((e as { message?: string }).message || "")) {
          return markFailed(t("Connection Lost"), "break");
        }

        const detail = ((e as { detail?: unknown }).detail || (e as { message?: string }).message || String(e)) as string;

        // A run whose SIGN-IN has expired fails every remaining project the same
        // way, and there is nothing the run can do about it. Observed: a
        // 50-project transfer where the session died at project 32 and the run
        // dutifully marked the last 18 failed with Kobo's bare "Not found." one
        // second apart — 18 rows of noise that buried the single row that mattered.
        //
        // A repeated identical status is the signal. It is counted rather than
        // treated as fatal on the first 404, because one genuinely missing project
        // is a normal thing to encounter and must not stop a 50-project run.
        const status = (e as { status?: number }).status;
        if (typeof status === "number" && status === repeatStatus) {
          repeatCount++;
        } else {
          repeatStatus = typeof status === "number" ? status : 0;
          repeatCount = 1;
        }
        if (repeatStatus !== 0 && repeatCount >= MAX_REPEATED_ITEM_FAILURES) {
          return markFailed(
            `${detail} (${t("stopped after {n} projects failed with HTTP {status}; this looks like an expired session, not a per-project problem", {
              n: String(repeatCount),
              status: String(repeatStatus),
            })})`,
            "break"
          );
        }
        return markFailed(detail, "continue");
      },
      onAbort: (remaining: UID[]): ReportRow[] =>
        remaining.map((uid: UID): ReportRow => {
          setStatus(uid, "cancelled", t("Stopped by user"));
          return rowOf({ uid, projectName: "", status: "cancelled", message: t("Stopped by user"), error: "", data: {} });
        }),
      onProgress: (done: number, total: number): void => {
        lastDone = done;
        forwardProgress(o, stepLine(done, total), done, total);
        // Cleared so the next item starts from the plain step line.
        itemStepDetail = "";
      },
    });

    let report = runRes.rows;
    // A resumed (post-reload) run seeds the report with the pre-pause rows so
    // the finished CSV stays the full report "as if never paused".
    if (o.seedRows && o.seedRows.length) {
      report = o.seedRows.concat(report);
    }
    const csv = KE.exportSvc.toCSV(report, KE.exportSvc.unionKeys(report));
    const successCount = report.filter((r) => r.Final_Status === "success").length;
    const failCount = report.filter((r) => r.Final_Status === "failed").length;
    const cancelCount = report.filter((r) => r.Final_Status === "cancelled").length;
    const skipCount = report.filter((r) => r.Final_Status === "skipped").length;

    return {
      action: def.id,
      actionLabel,
      kind: "bulk",
      successCount,
      failCount,
      cancelCount,
      skipCount,
      report,
      csv,
      ui: (def.report && def.report.summary ? def.report.summary({ successCount, failCount, cancelCount, skipCount, report, csv, action: def.id, actionLabel }, def) : null) as RunFinishedUi,
    };
  }

  /**
   * Runs one account-kind action (any account scan/report). The action itself
   * drives its whole run through def.execute(context); the executor only pipes
   * the run options through, converts thrown errors into a stable { stopped }
   * / { error } payload, materializes the action's declared export data
   * (res.files -> CSV UiFile[] — the report stage), and lets the action's
   * report.summary produce the UI from the materialized result.
   */
  async function runAccount(def: Action, context: ActionContext, o: RunOptions, signal: AbortSignal): Promise<AccountReport> {
    const actionLabel = def.label;

    let res: ActionResult | ScanResult | KoboRecord;
    try {
      const uidList = context.uids.length ? context.uids.slice() : null;
      res =
        (await def.execute({
          uidList,
          filterUrl: context.filterUrl,
          signal,
          onProgress: (msg: string, done: number, total: number) => forwardProgress(o, msg, done, total),
          request: context.request,
          def,
          runtime: context.runtime,
        })) || {};
    } catch (e) {
      if (isAbort(e)) {
        res = { stopped: true, outcome: "stopped" };
      } else {
        const err = (e as { detail?: unknown; message?: unknown }) || {};
        res = { error: (err.detail || err.message || String(e)) as string };
      }
    }

    // Reporting stage: turn the scan's declared export data into CSV files.
    // Future formats (JSON/Excel) materialize the same ReportFileSpec here.
    const uiFiles = KE.exportSvc.buildCsvFiles((res as ScanResult).files);
    const shown = (uiFiles.length ? Object.assign({}, res, { files: uiFiles }) : res) as KoboRecord;

    let ui: RunFinishedUi = null;
    const rs = def.report && def.report.summary;
    if (typeof rs === "function") ui = rs(shown, def) || null;

    return { action: def.id, actionLabel, kind: "account", report: res as ScanResult, ui };
  }

  /** Stops any in-flight run (bulk or account). Also lifts a parked pause so
   *  the loop observes the aborted signal and finishes as stopped. */
  function abort(): void {
    if (releasePause) {
      releasePause();
      releasePause = null;
    }
    pauseGate = null;
    paused = false;
    if (currentAbortController) currentAbortController.abort();
  }

  window.KoboEnhance.actionExecutor = {
    runItems,
    runAction,
    runBulkAction: runAction, // legacy alias kept for compatibility
    abort,
    pause,
    resume,
    isPaused,
    setDefaultUi,
    setExecutionPolicy,
    getExecutionPolicy,
    setHistorySink,
  };
})();