"use strict";
/**
 * core/transfer/source.api.ts — reads from the SOURCE account (the one the user
 * is signed in to).
 *
 * WHY THIS ISN'T KE.apiClient
 * One of the three things a transfer needs is not JSON — the submission list at
 * /data.xml is an XML document — and the shared client parses every response as
 * JSON. There is also a security reason to be explicit here: the URLs it follows
 * for media bytes and for the next submission page come out of API responses
 * rather than being built from the page origin, so this file asserts
 * same-origin BEFORE sending anything. A hand-edited or hostile response
 * therefore cannot make the extension attach the user's credential to some
 * other host.
 *
 * ONE REQUEST GETS ALMOST EVERYTHING
 * The project's detail payload already carries the deployed version history and
 * the form media list, so a transfer reads it once and works from that:
 *
 *   { uid, name, settings, asset_type,
 *     deployed_versions: { count, results: [ { uid, url, version_key, ... } ] },
 *     files: [ { content: "<download url>", metadata: { filename, mimetype } } ] }
 *
 * This matches the reference tool (C:\src\kobo-transfer\transfer\asset.py:6-29)
 * and avoids two extra round-trips per project. Two field names are easy to get
 * wrong and are therefore read only here: a media file's download URL is
 * `content`, not `url`, and its filename/mimetype live under `metadata`.
 *
 * THE SOURCE ACCOUNT'S OWN API TOKEN, NOT ONLY ITS COOKIE
 * Reads carry `Authorization: Token <source token>` whenever one is known, and
 * fall back to the page session when it is not (core/transfer/source.account.ts
 * owns that token and the fallback). The reason is survival rather than speed:
 * a long run outlives a session, and a transfer that dies at project 32 of 50
 * because the cookie expired has already copied half an account.
 */
(function () {
    const KE = window.KoboEnhance;
    const { transferSourceAccount } = KE;
    const SUBMISSION_PAGE_SIZE = 300;
    /** Bound on the version-content walk. In practice this is 1-2 hops; the cap
     *  exists so a payload that keeps pointing at itself cannot spin. */
    const MAX_VERSION_HOPS = 4;
    /**
     * Form media, not a submission attachment.
     *
     * Both live in the project's `files` list and the user explicitly excluded
     * attachments from this transfer, so the test is deliberately biased towards
     * rejecting: an entry qualifies when it is labelled form_media, or when it
     * carries no label at all and is not tied to a submission instance. Anything
     * labelled "attachment", or carrying an `instance`, is left out.
     */
    function isFormMedia(file) {
        const type = String(file["file_type"] || "");
        if (type === "attachment")
            return false;
        if (file["instance"] !== undefined && file["instance"] !== null && file["instance"] !== "")
            return false;
        return type === "" || type === "form_media";
    }
    function baseUrl() {
        return KE.apiClient.baseUrl();
    }
    /**
     * Same-origin guard. The session cookie is only ever sent to the host the
     * user is already signed in to, never to a URL handed to us by a response.
     */
    function assertSameOrigin(url) {
        let parsed;
        try {
            parsed = new URL(url, window.location.origin);
        }
        catch (e) {
            throw new Error("Malformed URL in the source response.");
        }
        if (parsed.origin !== window.location.origin) {
            throw new Error("Refusing to send the session to another host.");
        }
        return parsed.toString();
    }
    /**
     * A token-authenticated same-origin read.
     *
     * `fetchSource` on the source account carries the API token when there is one
     * and silently degrades to the cookie when the token is refused, so the
     * retries and the fallback policy live in exactly one place.
     */
    async function fetchSameOrigin(url, signal) {
        const safe = assertSameOrigin(url);
        const res = await transferSourceAccount.fetchSource(safe, signal);
        if (!res.ok) {
            throw new Error(`The source account returned HTTP ${res.status}.`);
        }
        return res;
    }
    async function fetchText(url, signal) {
        const res = await fetchSameOrigin(url, signal);
        return res.text();
    }
    // -------------------------------------------------------------------
    // Project detail — the one request that carries versions and media
    // -------------------------------------------------------------------
    /**
     * The project detail payload.
     *
     * Uses the `.json` suffix form, matching the reference tool
     * (C:\src\kobo-transfer\helpers\config.py:91 builds `asset_url_json` as
     * `{asset_url}.json`). This is not cosmetic: the trailing-slash form
     * `/api/v2/assets/{uid}/` can answer with a trimmed representation, and a
     * trimmed `deployed_versions` entry is how a transfer ends up replaying the
     * wrong URL and reporting an empty version.
     *
     * Read through the source account's token-aware fetch rather than the shared
     * session client, so a project read does not depend on the cookie outliving a
     * long run.
     */
    function fetchAssetDetail(uid, signal) {
        return fetchText(`${baseUrl()}/api/v2/assets/${uid}.json`, signal).then((raw) => {
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch (e) {
                throw new Error("The source account returned a project that could not be read.");
            }
            if (!parsed || typeof parsed !== "object") {
                throw new Error("The source account returned a project that could not be read.");
            }
            return parsed;
        });
    }
    /**
     * The project's DEPLOYED form versions, OLDEST FIRST.
     *
     * Order is not cosmetic. The destination project is created empty, so every
     * version has to be replayed in sequence; writing them newest-first would
     * reverse the form's revision history. Kobo returns deployed_versions newest
     * first, so the array is reversed rather than sorted.
     */
    function fetchVersions(asset) {
        const page = (asset || {})["deployed_versions"];
        const results = (page && typeof page === "object" ? page["results"] : null);
        if (!Array.isArray(results))
            return [];
        const versions = [];
        for (let i = results.length - 1; i >= 0; i--) {
            const version = toVersion(results[i], asset);
            if (version)
                versions.push(version);
        }
        return versions;
    }
    /**
     * One version record as a TransferSourceVersion, or null when it carries
     * nothing addressable.
     *
     * The per-version URL is preferred from the record, and rebuilt from the
     * version uid against the asset-scoped path when absent. An earlier revision
     * rebuilt `/api/v2/asset_versions/{uid}/`, which is not this API's shape — the
     * records show `/api/v2/assets/{asset}/versions/{version}/`.
     */
    function toVersion(entry, asset) {
        const uid = typeof entry["uid"] === "string" ? entry["uid"] : "";
        const assetUid = String((asset || {})["uid"] || "");
        const url = typeof entry["url"] === "string" && entry["url"]
            ? entry["url"]
            : assetUid && uid
                ? `/api/v2/assets/${assetUid}/versions/${uid}/?format=json`
                : "";
        if (!url)
            return null;
        return {
            uid,
            versionUrl: url,
            // `version_number` is a STRING in these payloads (observed:
            // "version_number": "9") while `version_key` elsewhere is a number, so both
            // spellings and both types are accepted, coerced to a number.
            versionKey: toVersionNumber(entry["version_key"]) ?? toVersionNumber(entry["version_number"]),
            date_deployed: typeof entry["date_deployed"] === "string" ? entry["date_deployed"] : undefined,
            contentHash: typeof entry["content_hash"] === "string" ? entry["content_hash"] : undefined,
            deployed: true,
        };
    }
    /**
     * The form for one version, exactly as the source account returned it.
     *
     * The value is NOT interpreted. Kobo serves a form either as XForm XML (older
     * projects) or as a structured definition — an object with `schema`, `survey`,
     * `choices`, `settings`, `translated`, `transitions`
     * (C:\src\kobo-transfer\transfer\asset.py:59 does `res.json()['content']` and
     * never checks which). Both are written to the destination unchanged, so
     * requiring a string here is what made every form-builder project fail with
     * "A source form version had no content".
     *
     * A bounded walk (cap 4 hops) covers the two cases where `content` is not
     * inline: a record that carries the form behind its `url`, and a server that
     * needs `format=json` before it will answer with the form at all.
     */
    async function fetchVersionContent(version, signal) {
        let url = version.versionUrl;
        let lastRaw = "";
        const tried = [];
        for (let hop = 0; hop < MAX_VERSION_HOPS; hop++) {
            if (tried.indexOf(url) !== -1)
                break;
            tried.push(url);
            lastRaw = await readVersionBody(url, signal);
            const direct = extractFormContent(lastRaw);
            if (direct !== null)
                return direct;
            // The version record lists `content` NEXT TO a `url`. When the form is not
            // inline, it is served from that `url`, so follow it rather than report it.
            const link = findContentUrl(lastRaw);
            if (link && link !== url) {
                url = link;
                continue;
            }
            // Nothing to follow: ask for JSON explicitly, which is what the reference
            // tool sends on its asset calls (helpers/config.py:94).
            const asJson = withFormatJson(url);
            if (tried.indexOf(asJson) === -1) {
                url = asJson;
                continue;
            }
            break;
        }
        throw new Error(`A source form version had no content. (${describeBody(lastRaw)})`);
    }
    /**
     * The `url` a version record points at when its own `content` is not usable.
     *
     * Observed response: `{ uid, url, content_hash, date_deployed, date_modified,
     * version_number, content }` — the version's metadata view, with `content`
     * null and the XML behind `url`. Returns null when the body is not JSON or
     * carries no such link.
     */
    function findContentUrl(raw) {
        const parsed = parseJsonObject(raw);
        if (!parsed)
            return null;
        const link = parsed["url"];
        if (typeof link !== "string" || !link)
            return null;
        try {
            return new URL(link, window.location.origin).toString();
        }
        catch (e) {
            return null;
        }
    }
    /** Parses a body as a JSON object, or null for anything else. */
    function parseJsonObject(raw) {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.charAt(0) === "<")
            return null;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch (e) {
            return null;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            return parsed;
        return null;
    }
    /** GET a version URL as text, with the same-origin guard applied. */
    async function readVersionBody(url, signal) {
        return fetchText(url, signal);
    }
    /** Adds `format=json` without discarding a query the URL already carries. */
    function withFormatJson(url) {
        let parsed;
        try {
            parsed = new URL(url, window.location.origin);
        }
        catch (e) {
            return url;
        }
        parsed.searchParams.set("format", "json");
        return parsed.toString();
    }
    /**
     * Kobo's version number as a number, from either field name and either JSON
     * type. Returns undefined for anything non-numeric rather than guessing, so a
     * missing number is visible instead of silently becoming NaN.
     */
    function toVersionNumber(value) {
        if (typeof value === "number" && isFinite(value))
            return value;
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed)
                return undefined;
            const parsed = Number(trimmed);
            if (isFinite(parsed))
                return parsed;
        }
        return undefined;
    }
    /**
     * The form carried by a response body, or null when the body holds none.
     *
     * A returned value is the form AS THE SOURCE RETURNED IT — XForm XML, or a
     * form-definition object — and is not to be re-encoded or re-parsed by the
     * caller. Only the destination serialises it, exactly once.
     */
    function extractFormContent(raw) {
        const trimmed = raw.trim();
        if (!trimmed)
            return null;
        // The form XML is the whole body.
        if (trimmed.charAt(0) === "<")
            return looksLikeHtmlPage(trimmed) ? null : raw;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch (e) {
            return null;
        }
        // A JSON-encoded document: the top-level value is the form itself.
        if (typeof parsed === "string") {
            const inner = parsed.trim();
            if (!inner)
                return null;
            if (inner.charAt(0) === "<")
                return looksLikeHtmlPage(inner) ? null : parsed;
            // A form definition that arrived as a JSON string rather than an object.
            // Decoded here, once, so the destination still serialises it exactly once.
            const asObject = tryParseObject(inner);
            return asObject;
        }
        // A version record: its `content` field is the form, in whichever of the two
        // shapes Kobo uses for that project.
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return contentFromRecord(parsed);
        }
        return null;
    }
    /**
     * The `content` of a version record, or null when it is absent or empty.
     *
     * Both shapes are returned untouched. `content` being null is the normal state
     * of the version *metadata* view, in which case the caller follows the record's
     * `url` instead — so null is returned rather than an empty string, which would
     * otherwise be written to the destination as an empty form.
     */
    function contentFromRecord(record) {
        if (!Object.prototype.hasOwnProperty.call(record, "content"))
            return null;
        const content = record["content"];
        if (typeof content === "string") {
            const trimmed = content.trim();
            if (!trimmed)
                return null;
            if (trimmed.charAt(0) === "<")
                return looksLikeHtmlPage(trimmed) ? null : content;
            // JSON-encoded inside the field: decode once, here, so the value handed to
            // the destination is the form and not a string that would be encoded twice.
            return tryParseObject(trimmed);
        }
        // The form-builder shape: { schema, survey, choices, settings, ... }. Taken
        // as-is; the destination understands it natively.
        if (content && typeof content === "object" && !Array.isArray(content)) {
            return isFormDefinition(content) ? content : null;
        }
        return null;
    }
    /** Parses text that should be a JSON object, or null if it is not one. */
    function tryParseObject(text) {
        const trimmed = text.trim();
        if (!trimmed || trimmed.charAt(0) !== "{")
            return null;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch (e) {
            return null;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            return parsed;
        return null;
    }
    /**
     * True when a `content` object looks like a Kobo form definition rather than an
     * unrelated record. Checked so a stray object is never written to the
     * destination as a project's content.
     */
    function isFormDefinition(value) {
        return Object.prototype.hasOwnProperty.call(value, "survey") ||
            Object.prototype.hasOwnProperty.call(value, "schema");
    }
    /**
     * True when a body that starts with "<" is an HTML DOCUMENT rather than the
     * form XML.
     *
     * This guard is load-bearing, not defensive padding. An unauthenticated or
     * expired session makes Kobo answer with a login page, and a login page also
     * starts with "<" — so without this check it would pass as "the form XML" and
     * be PATCHed into the destination as a project's content, producing an empty
     * form on the destination and destroying the real content in the process. A
     * Kobo form is XHTML (`<h:html>` or an `<?xml?>` declaration); an HTML page is
     * `<!DOCTYPE html>` or `<html>`.
     */
    function looksLikeHtmlPage(s) {
        const head = s.slice(0, 64).toLowerCase().trim();
        return head.startsWith("<!doctype html") || head.startsWith("<html");
    }
    /**
     * A short, non-sensitive description of an unexpected response body, so that a
     * failure names its own cause instead of asking the user to guess. Only the
     * top-level keys of a JSON object (or the leading characters of a non-JSON
     * body) are shown — never a form's contents, which can hold respondent data.
     */
    function describeBody(trimmed) {
        // JSON is classified regardless of length. An earlier version of this checked
        // length first, which reported "N characters and did not start with XML" for
        // large JSON bodies too and so hid the only fact that mattered.
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return `the response was a JSON array of ${parsed.length} items, not a version`;
            }
            if (parsed && typeof parsed === "object") {
                const record = parsed;
                const keys = Object.keys(record);
                // The presence and TYPE of `content` is the fact that distinguishes "the
                // metadata view, follow its url" from "the content is genuinely empty",
                // so it is reported explicitly. The value itself is never shown.
                const detail = Object.prototype.hasOwnProperty.call(record, "content")
                    ? `; content was ${describeValue(record["content"])}`
                    : "; there was no content field";
                return `the response was JSON with keys: ${keys.length ? keys.join(", ") : "(none)"}${detail}`;
            }
            return `the response was JSON of type ${typeof parsed}`;
        }
        catch (e) {
            // Not JSON at all: almost certainly an HTML page, so say so and show just
            // enough to identify it.
            const head = trimmed.slice(0, 60).replace(/\s+/g, " ");
            return `the response was not JSON (${trimmed.length} characters) and started with: ${head}`;
        }
    }
    /**
     * Names the TYPE of a JSON value without revealing it, so a diagnostic can say
     * "content was null" instead of printing a form or a respondent's data.
     */
    function describeValue(value) {
        if (value === null)
            return "null";
        if (value === undefined)
            return "absent";
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed)
                return "an empty string";
            return `a string of ${trimmed.length} characters starting with ${JSON.stringify(trimmed.charAt(0))}`;
        }
        if (Array.isArray(value))
            return `an array of ${value.length} items`;
        if (typeof value === "object") {
            const keys = Object.keys(value);
            return `an object with keys: ${keys.length ? keys.join(", ") : "(none)"}`;
        }
        return typeof value;
    }
    // -------------------------------------------------------------------
    // Form media
    // -------------------------------------------------------------------
    /**
     * Form-media attachments, from the project detail payload.
     *
     * `content` is the download URL and `metadata` carries the filename and
     * mimetype that Kobo's own upload expects to receive back, so `metadata` is
     * forwarded verbatim rather than rebuilt — a hand-rebuilt metadata dict is how
     * media ends up on the destination with the wrong name.
     */
    function fetchFormMedia(asset) {
        const files = (asset || {})["files"];
        if (!Array.isArray(files))
            return [];
        const media = [];
        for (const entry of files) {
            if (!isFormMedia(entry))
                continue;
            const url = typeof entry["content"] === "string" ? entry["content"] : "";
            if (!url)
                continue;
            const metadata = (typeof entry["metadata"] === "object" && entry["metadata"] ? entry["metadata"] : {});
            media.push({
                id: String(entry["id"] === undefined ? "" : entry["id"]),
                name: typeof metadata["filename"] === "string" ? metadata["filename"] : "",
                url,
                contentType: typeof metadata["mimetype"] === "string" ? metadata["mimetype"] : "",
                // Forwarded untouched: Kobo keys the uploaded file off this object.
                metadata,
            });
        }
        return media;
    }
    async function fetchMediaBytes(media, signal) {
        const res = await fetchSameOrigin(media.url, signal);
        return res.arrayBuffer();
    }
    /**
     * The bytes as a data URL.
     *
     * Kobo's form-media endpoint takes the file INLINE, as a base64 data URL in a
     * form field, rather than as a multipart part. base64 is assembled here from an
     * ArrayBuffer in chunks, because a single String.fromCharCode over a large
     * media file overflows the argument limit.
     */
    function fetchMediaDataUrl(media, signal) {
        return fetchMediaBytes(media, signal).then((buffer) => {
            const bytes = new Uint8Array(buffer);
            let binary = "";
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                binary += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + CHUNK)));
            }
            const mimetype = media.contentType || "application/octet-stream";
            return `data:${mimetype};base64,${btoa(binary)}`;
        });
    }
    // -------------------------------------------------------------------
    // Submissions
    // -------------------------------------------------------------------
    /** First page of the source project's submissions. */
    function firstSubmissionsPageUrl(uid) {
        return `/api/v2/assets/${uid}/data.xml?limit=${SUBMISSION_PAGE_SIZE}`;
    }
    /**
     * One page of submission XML.
     *
     * /data.xml is NOT JSON — it is an XML document with <count>, <next> and
     * <results>, where every direct child of <results> is one submission whose
     * root tag is the SOURCE project's UID. Parsing is delegated to
     * core/transfer/submission.xml.ts; this function only does the fetch.
     *
     * The URL is used exactly as given: the first page and every subsequent <next>
     * already carry `limit`, so re-appending it here would only duplicate a query
     * parameter. assertSameOrigin still applies, which matters for <next> — it is a
     * URL from a response body and must be confirmed to be the signed-in host
     * before the session cookie goes with it.
     */
    async function fetchSubmissionsPage(url, signal) {
        const body = await fetchText(url, signal);
        return KE.transferSubmissionsXml.parsePage(body, url);
    }
    window.KoboEnhance.transferSource = {
        baseUrl,
        fetchAssetDetail,
        fetchVersions,
        fetchVersionContent,
        fetchFormMedia,
        fetchMediaBytes,
        fetchMediaDataUrl,
        SUBMISSION_PAGE_SIZE,
        firstSubmissionsPageUrl,
        fetchSubmissionsPage,
    };
})();
