/**
 * core/i18n/i18n.ts — INTERNATIONALIZATION core.
 *
 * The engine behind every user-facing string. Classic IIFE on the shared
 * window.KoboEnhance namespace: no imports, load order decided by the manifest.
 *
 *   - English is the default and the KEY source: `t("...")` looks the exact
 *     English template up in the active dictionary (so unknown keys are build
 *     errors, see the EnDict typing in types/global.d.ts).
 *   - Dictionaries self-register via KE.i18n.registerLocale(lang, dict).
 *     English (core/i18n/locales/en.ts) is the default and registers first;
 *     French and Arabic follow as one locale file + one manifest line each.
 *   - A user override persists in localStorage "ke:lang" and is changed from
 *     the toolbar Settings panel (ui/integration.ts), which lists the locales
 *     reported by KE.i18n.locales().
 *   - Plural forms read `${key}~${form}` where form comes from
 *     Intl.PluralRules(lang) (en: ~one/~other; ar later: ~zero ~two ~few
 *     ~many ~other). See tP().
 */
(function () {
  const KE = window.KoboEnhance;
  const STORE_KEY = "ke:lang";
  const DEFAULT_LANG = "en";

  const dictionaries: Record<string, LocaleDict> = {};
  let lang = DEFAULT_LANG;

  function render(template: string, vars?: Record<string, string | number>): string {
    if (!vars) return template;
    let out = template;
    for (const name of Object.keys(vars)) {
      out = out.split(`{${name}}`).join(String(vars[name]));
    }
    return out;
  }

  /** Looks up `key` in the active language; falls back to the key itself. */
  function lookup(key: string): string | null {
    const dict: Record<string, string> | undefined = dictionaries[lang];
    if (dict && dict[key] !== undefined) return dict[key];
    return null;
  }

  function t(key: keyof EnDict, vars?: Record<string, string | number>): string {
    return render(lookup(key) || key, vars);
  }

  function tP(key: string, n: number): string {
    let form = "other";
    try {
      form = new Intl.PluralRules(lang).select(n);
    } catch (e) {
      form = "other";
    }
    const full = `${key}~${form}`;
    const active = lookup(full);
    const english = dictionaries[DEFAULT_LANG] as Record<string, string> | undefined;
    const template = active || (english && english[full]) || key;
    return render(template, { n });
  }

  /** Registers a language dictionary. Called once per locale module at load.
   *  While the active language is still the default, every registration
   *  re-checks the persisted override (localStorage "ke:lang") — otherwise a
   *  stored "ar" would be missed, because "en" registers first and the Arabic
   *  dictionary only exists one manifest line later. */
  function registerLocale(nextLang: string, dict: LocaleDict): void {
    dictionaries[nextLang] = dict;
    if (lang !== DEFAULT_LANG) return;
    try {
      const stored = localStorage.getItem(STORE_KEY);
      if (stored && dictionaries[stored]) lang = stored;
    } catch (e) {
      /* storage blocked — stays English */
    }
  }

  function getLang(): string {
    return lang;
  }

  /** Every registered language code, in registration order (en first). The
   *  Settings panel builds its language selector from this list, so adding a
   *  locale file + manifest line is all a new language needs. */
  function locales(): string[] {
    return Object.keys(dictionaries);
  }

  /** Switches the active dictionary, persists the choice and re-translates
   *  every [data-i18n] node. Unknown (unregistered) languages are ignored. */
  function setLang(next: string): void {
    if (next === lang) return;
    if (!dictionaries[next]) return;
    lang = next;
    try {
      localStorage.setItem(STORE_KEY, next);
    } catch (e) {
      /* storage blocked — the override just won't survive a reload */
    }
    apply();
  }

  /** Re-translates [data-i18n] text + [data-i18n-title] tooltips under `root`.
   *  Wiring is ready for the later language picker; nothing uses it in the UI
   *  yet (this stage ships English only). */
  function apply(root?: HTMLElement | Document | null): void {
    const base = root || document;
    if (!base || typeof base.querySelectorAll !== "function") return;
    const nodes = base.querySelectorAll("[data-i18n],[data-i18n-title]");
    nodes.forEach((node) => {
      const textKey = node.getAttribute("data-i18n");
      if (textKey) node.textContent = t(textKey as keyof EnDict);
      const titleKey = node.getAttribute("data-i18n-title");
      if (titleKey) node.setAttribute("title", t(titleKey as keyof EnDict));
    });
  }

  window.KoboEnhance.i18n = {
    get lang() { return lang; },
    getLang,
    setLang,
    locales,
    registerLocale,
    t,
    tP,
    apply,
  };
})();