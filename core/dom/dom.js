"use strict";
/**
 * core/dom/dom.ts — generic DOM element factory (layer-agnostic UI
 * infrastructure). Exposed as KE.dom.el so that features and the ui layer
 * can build DOM without depending on each other; the ui layer composes
 * higher-level rendering (dialogs, toasts) on top of it.
 */
(function () {
    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === "text")
                node.textContent = v;
            else if (k.startsWith("on") && typeof v === "function")
                node.addEventListener(k.slice(2), v);
            else
                node.setAttribute(k, v);
        }
        for (const child of [].concat(children)) {
            if (child)
                node.appendChild(child);
        }
        return node;
    }
    window.KoboEnhance.dom = { el };
})();
