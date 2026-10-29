/**
 * features/bulk-actions/actions.integrated.controller.ts — bulk action facade.
 *
 * The execution lifecycle (validation, confirmation, scope resolution, the
 * per-item loop, cancellation, report, summary) lives in the shared runner
 * core/execution/action.executor.ts. This controller is only the ES-compatible
 * entry point the toolbar calls: it forwards the run options to the executor,
 * which resolves the action id through the centralized registry
 * (core/actions/action-registry.ts). Actions and their metadata (id, name,
 * description, category, config requirements, execution handler) come from the
 * registry — no per-action dispatch lives here.
 */
(function () {
  const KE = window.KoboEnhance;
  const registry = KE.actionRegistry;

  function run(options: RunOptions): Promise<RunReport | AccountReport | void> {
    return KE.actionExecutor.runAction(null, options || {});
  }

  function abort(): void {
    KE.actionExecutor.abort();
  }

  window.KoboEnhance.integratedActions = {
    get ACTIONS() { return registry.ACTIONS; },
    get PERMISSIONS() { return registry.PERMISSIONS; },
    run,
    abort,
  };
})();