/**
 * core/transfer/submission.xml.ts — reading and rewriting Kobo submissions.
 *
 * WHY THIS IS XML AND NOT JSON
 * The source project's submissions come from
 * GET /api/v2/assets/{uid}/data.xml?limit=N, which returns an XML document, not
 * the JSON envelope the rest of the v2 API uses:
 *
 *   <data>
 *     <next>https://.../data.xml?limit=300&amp;offset=300</next>
 *     <count>1284</count>
 *     <results>
 *       <aSourceUid id="aSourceUid" version="aSourceVersion"> ... </aSourceUid>
 *       <aSourceUid ...> ... </aSourceUid>
 *     </results>
 *   </data>
 *
 * Every direct child of <results> is ONE submission, and the element name is the
 * SOURCE project's UID. Two quirks are load-bearing and handled here:
 *   - <next> is the STRING "None" on the last page, not a null. A naive
 *     `while (next)` loop would then request "None" as a URL.
 *   - <next> and <count> are siblings of <results>, so they are read relative to
 *     <results> rather than with getElementsByTagName. A form is free to have a
 *     question named "count" or "next", and a document-wide search would pick up
 *     the data field instead of the pagination value.
 *
 * THE REWRITE
 * A submission belongs to the project it was collected for, so a source
 * submission cannot be posted to a destination project unchanged. Four things
 * are rewritten, matching the reference tool (transfer/xml.py:35-69):
 *
 *   root tag    source UID  ->  destination UID
 *   id=""       source UID  ->  destination UID
 *   version=""  source ver  ->  DESTINATION's deployed version UID   (required)
 *   __version__ (count) (date)  ->  the destination's own count and date
 *   formhub/uuid source     ->  the destination deployment UUID
 *
 * __version__ is the one that silently corrupts data if it is wrong: Kobo keeps
 * its own record of each deployed version and rejects a submission whose
 * __version__ does not match, so it is read back from the destination project
 * (dest.api.ts fetchProject) rather than guessed.
 *
 * meta/instanceID IS DELIBERATELY LEFT ALONE. The value is not rewritten and not
 * regenerated when it exists: it is the submission's identity, and preserving it
 * is what makes a re-run idempotent — Kobo answers 202 "already exists" instead of
 * creating a duplicate. The value is only minted when the source submission has
 * none at all.
 */
(function () {
  /** Kobo's OpenRosa submission endpoint on the KC host. Different origin from
   *  kf, which is the whole reason the service worker exists. */
  const SUBMISSION_PATH = "/submission";

  // -------------------------------------------------------------------
  // Small DOM helpers (namespace-agnostic on purpose)
  // -------------------------------------------------------------------

  function localName(el: Element): string {
    return el.localName || el.nodeName;
  }

  function elementChildren(parent: Element): Element[] {
    const out: Element[] = [];
    for (let i = 0; i < parent.children.length; i++) out.push(parent.children[i]);
    return out;
  }

  /** A direct child element with this name, ignoring text nodes and prefixes. */
  function findDirect(parent: Element, name: string): Element | null {
    for (const child of elementChildren(parent)) {
      if (localName(child) === name) return child;
    }
    return null;
  }

  function setDirectValue(root: Element, path: string, value: string): void {
    // "formhub/uuid" means: find-or-create <formhub>, then <uuid> inside it.
    const parts = path.split("/");
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = findDirect(parent, parts[i]);
      if (!child) {
        child = root.ownerDocument.createElement(parts[i]);
        parent.appendChild(child);
      }
      parent = child;
    }
    const last = parts[parts.length - 1];
    let target = findDirect(parent, last);
    if (!target) {
      target = root.ownerDocument.createElement(last);
      parent.appendChild(target);
    }
    // textContent, not setAttribute: these are element bodies in the schema.
    target.textContent = value;
  }

  function readDirectValue(root: Element, path: string): string {
    const parts = path.split("/");
    let parent: Element | null = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!parent) return "";
      parent = findDirect(parent, parts[i]);
    }
    if (!parent) return "";
    const target = findDirect(parent, parts[parts.length - 1]);
    return target ? (target.textContent || "") : "";
  }

  // -------------------------------------------------------------------
  // Parsing one page
  // -------------------------------------------------------------------

  function parseXml(body: string): Document {
    const doc = new DOMParser().parseFromString(body, "text/xml");
    // A parse failure is a <parsererror> document, not an exception.
    const failed = doc.getElementsByTagName("parsererror");
    if (failed && failed.length > 0) {
      throw new Error("The source account returned submission XML that could not be read.");
    }
    return doc;
  }

  /** The <results> element, or null when the body is not a submission page. */
  function findResults(doc: Document): Element | null {
    const root = doc.documentElement;
    if (!root) return null;
    for (const child of elementChildren(root)) {
      if (localName(child) === "results") return child;
    }
    // Fall back to a descendant search, but only accept a <results> that
    // actually holds submissions, so a data field named "results" in an
    // unexpected envelope cannot be mistaken for the page container.
    const all = doc.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i] as Element;
      if (localName(el) === "results" && el.children.length > 0) return el;
    }
    return null;
  }

  /** Kobo's <next> is "" / "None" / a full URL. Only a URL continues the walk. */
  function normalizeNext(value: string): string | null {
    const trimmed = (value || "").trim();
    if (!trimmed || trimmed === "None" || trimmed === "null" || trimmed === "undefined") return null;
    if (!/^(https?:\/\/|\/)/.test(trimmed)) return null;
    return trimmed;
  }

  function parsePage(body: string, url: string): TransferSubmissionsPage {
    const doc = parseXml(body);
    const results = findResults(doc);

    if (!results) {
      // Not XML, or an envelope we do not recognise. Say so plainly instead of
      // silently copying zero submissions, which would look like success.
      throw new Error(`No submission data was found at ${url}.`);
    }

    // Pagination values are siblings of <results>, which keeps them separate
    // from any data field that happens to share their name.
    const container = results.parentNode;
    let count = 0;
    let next: string | null = null;
    if (container && container.nodeType === 1) {
      const parentEl = container as Element;
      count = parseInt(readDirectValue(parentEl, "count"), 10);
      next = normalizeNext(readDirectValue(parentEl, "next"));
    }
    if (!isFinite(count) || count < 0) count = 0;

    const serializer = new XMLSerializer();
    const items: TransferSourceSubmission[] = [];
    for (const child of elementChildren(results)) {
      items.push({
        instanceId: stripUuidPrefix(readDirectValue(child, "meta/instanceID")),
        xml: serializer.serializeToString(child),
      });
    }

    return { count, next, items };
  }

  function stripUuidPrefix(value: string): string {
    const trimmed = (value || "").trim();
    return trimmed.indexOf("uuid:") === 0 ? trimmed.slice(5) : trimmed;
  }

  // -------------------------------------------------------------------
  // Rewriting one submission
  // -------------------------------------------------------------------

  function newUuid(): string {
    const c = typeof crypto !== "undefined" ? crypto : null;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    if (c && typeof c.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
      const hex: string[] = [];
      for (let i = 0; i < bytes.length; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
        .slice(8, 10)
        .join("")}-${hex.slice(10, 16).join("")}`;
    }
    return `ke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  /**
   * Repoints one submission at the destination project.
   *
   * The root element is REBUILT rather than renamed in place, because the
   * reference tool replaces the attribute set wholesale (only id and version
   * survive). Namespace declarations are the one exception and are carried over
   * verbatim, so a submission whose children use a prefix still serializes to a
   * well-formed document.
   */
  function rewrite(
    source: TransferSourceSubmission,
    target: { destUid: UID; versionUid: string; versionLabel: string; formhubUuid: string }
  ): { xml: string; instanceId: string } {
    const doc = parseXml(source.xml);
    const root = doc.documentElement;
    if (!root) throw new Error("A submission was empty.");

    let instanceId = stripUuidPrefix(source.instanceId) || stripUuidPrefix(readDirectValue(root, "meta/instanceID"));

    const replacement = doc.createElement(target.destUid);
    for (let i = 0; i < root.attributes.length; i++) {
      const attr = root.attributes[i];
      if (attr.name === "xmlns" || attr.name.indexOf("xmlns:") === 0) {
        replacement.setAttribute(attr.name, attr.value);
      }
    }
    // The two version fields are NOT interchangeable, and an earlier revision had
    // them the wrong way round. The reference (transfer\xml.py:18-23,
    // applied at :141-153) builds:
    //
    //     data = { 'version': f'{count} ({date})',   # the LABEL
    //              '__version__': deployed_version_uid }   # the UID
    //
    // and then puts `version` on the ROOT ELEMENT and `__version__` inside the
    // submission. Swapping them still posts successfully for most rows — the
    // endpoint reads meta/instanceID and the root id and is otherwise lenient —
    // so the damage is invisible except as a small number of submissions the
    // destination refuses, which is exactly how this was found.
    replacement.setAttribute("id", target.destUid);
    replacement.setAttribute("version", target.versionLabel);

    while (root.firstChild) replacement.appendChild(root.firstChild);

    // `<meta><deprecatedID>` marks a submission as an EDIT of an earlier
    // instance. The instance it names existed only on the source account, so on
    // the destination the post is an edit of something that does not exist and
    // Kobo refuses it.
    //
    // Observed directly: a project with 8 submissions posted 6, and the 2 that
    // were refused were exactly the 2 carrying a deprecatedID. Dropping the
    // element is correct rather than a workaround — the link has no destination
    // to point at, and its absence makes the submission a normal new one, which
    // is what a fresh copy of that record is.
    //
    // A deliberate deviation from the reference, which leaves the element in
    // place (transfer/xml.py:119-173 touches only the root
    // tag/attributes, __version__ and formhub/uuid). The reference does not move
    // a project's submissions into a NEW project, so it never hits this.
    const meta = findDirect(replacement, "meta");
    const deprecated = meta ? findDirect(meta, "deprecatedID") : null;
    if (deprecated && deprecated.parentNode) {
      deprecated.parentNode.removeChild(deprecated);
    }

    // Preserve an existing instanceID verbatim; only mint one when the source
    // has none, so a re-run is deduplicated rather than duplicated.
    if (!instanceId) {
      instanceId = newUuid();
      setDirectValue(replacement, "meta/instanceID", `uuid:${instanceId}`);
    }

    setDirectValue(replacement, "__version__", target.versionUid);
    if (target.formhubUuid) {
      setDirectValue(replacement, "formhub/uuid", target.formhubUuid);
    }

    return { xml: new XMLSerializer().serializeToString(replacement), instanceId };
  }

  /**
   * "2021-03-29T19:40:28.123456+00:00" -> "2021-03-29 19:40:28".
   * Drops the microseconds but keeps any timezone offset that Kobo sent, which
   * is what the reference tool does and therefore what the destination expects.
   */
  function formatVersionDate(iso: string): string {
    const raw = String(iso || "");
    const t = raw.indexOf("T");
    if (t === -1) return raw;
    const date = raw.slice(0, t);
    const rest = raw.slice(t + 1);
    const dot = rest.indexOf(".");
    return `${date} ${dot === -1 ? rest : rest.slice(0, dot)}`;
  }

  window.KoboEnhance.transferSubmissionsXml = {
    SUBMISSION_PATH,
    parsePage,
    rewrite,
    formatVersionDate,
  };
})();
