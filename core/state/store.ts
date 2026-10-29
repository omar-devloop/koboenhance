/**
 * core/state/store.ts — page-level context state for the in-page integration.
 * Attaches to the shared window.KoboEnhance namespace (isolated world).
 *
 * Runs first in the content-script manifest and seeds the namespace object.
 */
(function () {
  window.KoboEnhance = window.KoboEnhance || {};

  const state: KoboStoreState = {
    pageContext: {
      currentProjectUid: null,
      selectedUids: [],
      lastFilterUrl: null,
      filterParams: {},
    },
  };

  async function load(): Promise<KoboStoreState> {
    return state;
  }

  function setPageContext(ctx: Partial<PageContext>): void {
    Object.assign(state.pageContext, ctx);
  }

  function getState(): KoboStoreState {
    return state;
  }

  window.KoboEnhance.store = {
    load,
    getState,
    setPageContext,
  };
})();