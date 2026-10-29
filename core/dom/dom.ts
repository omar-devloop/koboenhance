/**
 * core/dom/dom.ts — generic DOM element factory (layer-agnostic UI
 * infrastructure). Exposed as KE.dom.el so that features and the ui layer
 * can build DOM without depending on each other; the ui layer composes
 * higher-level rendering (dialogs, toasts) on top of it.
 */
(function () {
  function el(tag: string, attrs: Record<string, unknown> = {}, children: unknown = []): HTMLElement {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v as string;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v as EventListenerOrEventListenerObject);
      else node.setAttribute(k, v as string);
    }
    for (const child of ([] as unknown[]).concat(children as unknown[])) {
      if (child) node.appendChild(child as Node);
    }
    return node;
  }

  window.KoboEnhance.dom = { el };
})();