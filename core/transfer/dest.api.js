"use strict";
/**
 * core/transfer/dest.api.ts — WRITES to the destination account.
 *
 * Every call here crosses the server boundary and therefore goes through the
 * background service worker (core/transfer/transport.sw.ts) with the
 * destination API token. Nothing in this file may use KE.apiClient: that client
 * is bound to the signed-in SOURCE account.
 *
 * The endpoint shapes are the ones the Python reference tool uses
 * (C:\src\kobo-transfer\transfer\asset.py and helpers/config.py:82-100), which
 * is the only documented way Kobo's v2 API accepts a project copy:
 *
 *   1. POST  /api/v2/assets/?format=json         create an empty survey project
 *   2. POST  /api/v2/assets/{uid}/files/         form media, INLINE as a data URL
 *   3. PATCH /api/v2/assets/{uid}/?format=json   set a version's XML content
 *   4. POST  /api/v2/assets/{uid}/deployment/    deploy it (PATCH for the rest)
 *
 * Four things here are counter-intuitive enough that they are encoded in the
 * code rather than left to the caller, because each one fails silently or
 * confusingly if guessed:
 *
 *   - The version PATCH body is {"content": "<the XML, JSON-encoded>"}. The XML
 *     is nested inside a JSON *string*, not sent as a JSON document
 *     (asset.py:66 — `json={"content": json.dumps(asset_content)}`). Passing raw
 *     XML here is the single easiest way to create a project whose form is empty.
 *   - The PATCH response, not the source, is where the new version's UID comes
 *     from: it returns `version_id`, the UID the destination just minted.
 *     Submitting a source version UID would deploy nothing.
 *   - Deployment targets the ASSET (/assets/{uid}/deployment/), not the version,
 *     and takes {"active": true, "version_id": ...} in the body.
 *   - The first deployment is a POST and every later one is a PATCH
 *     (asset.py:73). A PATCH as the very first call does not create a deployment.
 *
 * RESPONSES ARE NOT ASSUMED
 * The service worker deliberately returns 4xx/5xx responses instead of throwing,
 * so every method checks ok/status itself and throws with Kobo's own `detail`
 * message. Nothing here reports success on a status it did not verify.
 */
(function () {
    const KE = window.KoboEnhance;
    const { transferTransport } = KE;
    /** Pulls Kobo's human-readable error out of a response body. */
    /**
     * Turns a failed destination response into a message that leads with what the
     * destination actually said.
     *
     * The destination's own words come FIRST because they are the only actionable
     * part. A whole-account run produced 13 failures whose entire diagnosis was in
     * that field — "Invalid question name 'Initial Quantities'", "Duplicate name
     * error: houseCode", "no survey element with this name" — and it used to arrive
     * buried mid-sentence behind our own generic wording.
     */
    function describe(res, fallback) {
        const status = res.status === undefined ? "?" : String(res.status);
        const where = res.method && res.url ? `${res.method} ${res.url}` : "";
        const tail = ` (HTTP ${status}${where ? ` on ${where}` : ""})`;
        const said = res.detail && res.detail.trim() ? res.detail.trim() : "";
        if (said)
            return said + tail;
        if (res.text && res.text.trim()) {
            const head = res.text.trim().slice(0, 200).replace(/\s+/g, " ");
            return `${fallback}: ${head}${tail}`;
        }
        return fallback + tail;
    }
    function requireOk(res, fallback) {
        if (!res.ok)
            throw new Error(describe(res, fallback));
    }
    function asRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    // -------------------------------------------------------------------
    // 1. Create the project
    // -------------------------------------------------------------------
    /**
     * Creates the empty survey project on the destination.
     *
     * `settings` is copied straight from the source project. That is what carries
     * the description, sector, country list and tags across; Kobo creates the
     * project's own UID and deployment UUID, so nothing source-specific is sent.
     *
     * The deployment UUID is returned because every submission's formhub/uuid needs
     * it, and it exists from creation — before any version is deployed. It is
     * re-read later (fetchProject) in case deploying replaced it.
     */
    async function createAsset(ctx, payload, signal) {
        const res = await transferTransport.mutateJson(ctx.token, `${ctx.destination.kfUrl}/api/v2/assets/?format=json`, "POST", payload, signal);
        requireOk(res, "The destination account could not create the project.");
        const body = asRecord(res.data);
        const uid = body.uid;
        if (typeof uid !== "string" || !uid) {
            throw new Error("The destination account created a project without a UID.");
        }
        return {
            uid,
            deploymentUuid: typeof body["deployment__uuid"] === "string" ? body["deployment__uuid"] : "",
        };
    }
    // -------------------------------------------------------------------
    // 2. Form media
    // -------------------------------------------------------------------
    /**
     * Uploads one form-media file.
     *
     * This endpoint is NOT a multipart upload: Kobo takes the file inline in a
     * form-urlencoded body, as a base64 data URL, alongside the source file's own
     * metadata object. `description: "default"` is not optional in practice — the
     * endpoint ignores the file without it. Media is best-effort: one unsupported
     * file must not fail a project that already exists, so the pipeline catches
     * per-file errors (see transfer.pipeline.ts).
     */
    async function uploadFormMedia(ctx, destUid, media, signal) {
        const res = await transferTransport.postForm(ctx.token, `${ctx.destination.kfUrl}/api/v2/assets/${destUid}/files/`, {
            description: "default",
            file_type: "form_media",
            metadata: JSON.stringify(media.metadata),
            base64Encoded: media.dataUrl,
        }, signal);
        requireOk(res, "The destination account rejected a form media file.");
    }
    // -------------------------------------------------------------------
    // 3. Version content
    // -------------------------------------------------------------------
    /**
     * Writes one version's form and returns the version UID the destination created
     * for it.
     *
     * The value is passed through and JSON-encoded EXACTLY ONCE, right here. That
     * single encode is what the API expects and it is what the reference tool does
     * with `json={"content": json.dumps(asset_content)}`
     * (C:\src\kobo-transfer\transfer\asset.py:66). Encoding the value anywhere
     * earlier, or encoding a value that is already a JSON string, produces a
     * doubly-encoded body — which Kobo accepts without complaint and which yields a
     * project whose form is empty, reported as "The survey sheet is either empty or
     * missing important column headers." on the destination.
     *
     * The form is passed through unchanged whether it is XForm XML or a
     * form-definition object; the destination understands both natively, so no
     * conversion happens here.
     */
    async function setVersionContent(ctx, destUid, content, signal) {
        // Reference-faithful, single write (C:\src\kobo-transfer\transfer\asset.py:61-69):
        //
        //     PATCH {asset_url} ?format=json  {"content": json.dumps(content)}
        //     version_id = res.json()["version_id"]
        //
        // One request, no second attempt. The value is JSON-encoded exactly once,
        // which is what json.dumps does and what the destination expects. A previous
        // revision retried with a different encoding on failure; that was a guess,
        // and a guess that can issue a second write is not worth keeping.
        const res = await transferTransport.mutateJson(ctx.token, `${ctx.destination.kfUrl}/api/v2/assets/${destUid}/?format=json`, "PATCH", { content: JSON.stringify(content) }, signal);
        requireOk(res, "The destination account rejected a form version.");
        // The destination's own new version UID, and the only correct thing to deploy.
        const versionId = asRecord(res.data)["version_id"];
        if (typeof versionId !== "string" || !versionId) {
            throw new Error("The destination account saved a form version without an ID.");
        }
        return versionId;
    }
    // -------------------------------------------------------------------
    // 4. Deploy
    // -------------------------------------------------------------------
    /**
     * Deploys a version on the destination project.
     *
     * `isFirst` selects the method: Kobo creates the deployment on the first call
     * and updates it on every call after that, so a PATCH as the very first
     * deployment leaves the project without a live form.
     */
    async function deployVersion(ctx, destUid, versionUid, isFirst, signal) {
        const res = await transferTransport.mutateJson(ctx.token, `${ctx.destination.kfUrl}/api/v2/assets/${destUid}/deployment/`, isFirst ? "POST" : "PATCH", { active: true, version_id: versionUid }, signal);
        if (!res.ok) {
            // Kobo's own validation message leads, unchanged. An earlier version
            // appended "The form was saved but the destination could not build a form
            // from it, which means its content was stored in a form Kobo cannot deploy"
            // — a cause we had not established, and a misleading one. A whole-account
            // run showed the real story: the destination refuses the form because the
            // form is invalid (bad question names, duplicate names, a dangling ${today}
            // reference). The project itself was created perfectly well. So the message
            // is now exactly what the destination said, plus the request it said it on.
            throw new Error(describe(res, "The destination account rejected this form version."));
        }
    }
    /**
     * Archives a deployed project, so the destination matches an archived source.
     *
     * Captured from Kobo's own UI rather than guessed:
     *
     *     PATCH /api/v2/assets/{uid}/deployment/
     *     Content-Type: application/x-www-form-urlencoded
     *     active=false
     *
     * The same endpoint the JSON deployment call uses — only the encoding and the
     * flag differ, which is why the form-encoded PATCH exists in the transport. The
     * reference tool has no equivalent: it checks only `has_deployment` and always
     * leaves the destination live, so an archived source becomes a deployed one
     * there.
     */
    async function archiveDeployment(ctx, destUid, signal) {
        const res = await transferTransport.patchForm(ctx.token, `${ctx.destination.kfUrl}/api/v2/assets/${destUid}/deployment/`, { active: "false" }, signal);
        requireOk(res, "The destination account could not archive the project.");
    }
    /**
     * Whether a remembered destination project still exists.
     *
     * The mapping store is what stops a re-run duplicating an entire account, but a
     * stored mapping can go stale: the user deletes the project on the destination
     * (in Kobo or by hand) and the mapping still claims it is there, so every
     * project is skipped as "already moved" with nothing on the destination at all.
     * A skip is therefore only trusted after the destination has been asked.
     *
     * Three states, and the third matters:
     *   - "exists"  : trust the mapping, skip.
     *   - "missing" : the destination answered 404, so the copy is gone. Report it
     *                 as absent and let the caller copy again.
     *   - "unknown" : the destination could not be reached, or answered with an
     *                 auth/permission problem. The mapping is NOT discarded and the
     *                 project is NOT copied: a network blip must not be able to
     *                 duplicate a whole account. The caller surfaces this instead of
     *                 silently claiming either outcome.
     */
    async function checkProject(ctx, destUid, signal) {
        let res;
        try {
            res = await transferTransport.getJson(ctx.token, `${ctx.destination.kfUrl}/api/v2/assets/${destUid}/?format=json`, undefined, signal);
        }
        catch (e) {
            return "unknown";
        }
        if (res.ok)
            return "exists";
        if (res.status === 404 || res.status === 410)
            return "missing";
        return "unknown";
    }
    // -------------------------------------------------------------------
    // Deleting a project this transfer created
    // -------------------------------------------------------------------
    /**
     * Deletes a destination project. Used ONLY to clean up after a transfer that
     * failed after creating the project, so a failed run does not leave an empty
     * shell in the user's account.
     *
     * Deliberately conservative at the call site: it is invoked only for a project
     * this run created, and only before any version was successfully deployed. A
     * project that holds real content is never deleted, because losing a user's
     * form is far worse than leaving an empty project behind.
     *
     * Returns true when the destination confirmed the delete. A 404 counts as
     * success: the goal state is "this project does not exist", and it does not.
     */
    async function deleteProject(ctx, destUid, signal) {
        const res = await transferTransport.mutateJson(ctx.token, `${ctx.destination.kfUrl}/api/v2/assets/${destUid}/`, "DELETE", undefined, signal);
        if (res.ok)
            return true;
        if (res.status === 404)
            return true;
        return false;
    }
    // -------------------------------------------------------------------
    // Reading back the destination project
    // -------------------------------------------------------------------
    /**
     * Re-reads the destination project after deployment to learn the two values
     * submissions need and which cannot be known before the writes happen: the
     * live DEPLOYED version's UID, and the deployment UUID that goes in
     * formhub/uuid.
     *
     * The version label is "(count) (date)" where count is the number of deployed
     * versions and date is the live version's date_deployed — matching
     * get_info_from_deployed_versions in the reference tool (xml.py:170-179).
     * Both are load-bearing: Kobo rejects a submission whose __version__ does not
     * match the deployed version's own record, so this is read from the
     * destination rather than derived from the source.
     */
    async function fetchProject(ctx, destUid, signal) {
        const res = await transferTransport.getJson(ctx.token, 
        // `?format=json` explicitly, for the same reason as the source detail read:
        // the plain trailing-slash form can answer with a trimmed representation
        // that omits deployed_versions, which is exactly the field this needs.
        `${ctx.destination.kfUrl}/api/v2/assets/${destUid}/?format=json`, undefined, signal);
        requireOk(res, "The destination project could not be read back.");
        const body = asRecord(res.data);
        const deployed = asRecord(body["deployed_versions"]);
        const results = Array.isArray(deployed["results"]) ? deployed["results"] : [];
        // Kobo returns deployed versions newest-first, so [0] is the live one.
        const latest = results.length > 0 ? results[0] : {};
        const count = typeof deployed["count"] === "number" ? deployed["count"] : 0;
        const date = typeof latest["date_deployed"] === "string" ? latest["date_deployed"] : "";
        return {
            uid: destUid,
            name: typeof body["name"] === "string" ? body["name"] : "",
            deployedVersionUrl: typeof latest["url"] === "string" ? latest["url"] : "",
            deployedVersionUid: typeof latest["uid"] === "string" ? latest["uid"] : "",
            deploymentUuid: typeof body["deployment__uuid"] === "string" ? body["deployment__uuid"] : "",
            versionLabel: date ? `${count} (${KE.transferSubmissionsXml.formatVersionDate(date)})` : `${count}`,
        };
    }
    // -------------------------------------------------------------------
    // The destination's submission allowance
    // -------------------------------------------------------------------
    /**
     * How much of its submission allowance the destination has left this period.
     *
     * Read BEFORE a run rather than discovered during one: a destination at its
     * cap answers every submission POST with HTTP 402, which used to mean a
     * whole-account run posted thousands of submissions into a refusal before the
     * first error was noticed. This never throws — an allowance we cannot read is
     * a warning in the confirm dialog, not a reason to refuse to copy.
     */
    async function fetchUsage(ctx, signal) {
        return KE.transferUsage.fetchDestinationUsage(ctx, signal);
    }
    // -------------------------------------------------------------------
    // The destination's own projects
    // -------------------------------------------------------------------
    /** The assets endpoint caps a page at 100. */
    const DEST_PAGE = 100;
    /** Stops a malformed `count` from walking forever. */
    const MAX_DEST_PAGES = 200;
    /**
     * The key two project names are compared by.
     *
     * A copy keeps the source project's name, so the name is the only thing that
     * links a source project to a copy made before this extension existed, or by
     * hand. Trimming, collapsing inner whitespace and case-folding tolerates the
     * cosmetic edits users make; nothing more, because a fuzzy match could skip a
     * project that was never copied.
     */
    function nameKey(name) {
        return String(name === undefined || name === null ? "" : name)
            .trim()
            .replace(/\s+/g, " ")
            .toLowerCase();
    }
    function projectNameOf(row) {
        const direct = row["name"];
        if (typeof direct === "string" && direct.trim())
            return direct.trim();
        const settings = asRecord(row["settings"]);
        const nested = settings["name"];
        return typeof nested === "string" ? nested.trim() : "";
    }
    /**
     * Every project the destination account has, in one paginated pass.
     *
     * This is the "what is actually there?" read the preflight and the run both
     * need. It replaces trusting the mapping store: a mapping outlives the project
     * it points at, which made a dialog promise "2 projects / 13 submissions" for
     * a run that would really copy 4 / 20.
     *
     * Returns null — never an empty list — when the destination could not be read,
     * so a network blip cannot be mistaken for an empty account.
     */
    async function fetchProjectIndex(ctx, signal) {
        const projects = [];
        let start = 0;
        let total = 0;
        try {
            for (let page = 0; page < MAX_DEST_PAGES; page++) {
                const res = await transferTransport.getJson(ctx.token, `${ctx.destination.kfUrl}/api/v2/assets/`, { limit: DEST_PAGE, start }, signal);
                if (!res.ok)
                    return null;
                const body = asRecord(res.data);
                const results = Array.isArray(body["results"]) ? body["results"] : [];
                const declared = body["count"];
                if (typeof declared === "number" && isFinite(declared))
                    total = declared;
                for (const row of results) {
                    // Only a survey can stand in for a project; matching, say, an
                    // "empty" asset with the same name would skip a copy that never
                    // happened.
                    const type = row["asset_type"];
                    if (type !== undefined && type !== "survey")
                        continue;
                    const uid = row["uid"];
                    if (typeof uid !== "string" || !uid)
                        continue;
                    const name = projectNameOf(row);
                    projects.push({ uid, name, key: nameKey(name) });
                }
                start += results.length;
                if (results.length === 0)
                    break;
                if (total > 0 && start >= total)
                    break;
                if (results.length < DEST_PAGE)
                    break;
            }
        }
        catch (e) {
            // A caller-driven abort is not "unreadable": let it propagate so the run
            // stops instead of continuing with half a list.
            if (signal && signal.aborted)
                throw e;
            return null;
        }
        return { projects };
    }
    /**
     * The destination project that already stands for a source project.
     *
     * Exact identity first: a recorded destination UID that the destination still
     * has wins even if the user renamed the copy. Only then a name match, and only
     * for a destination project not already claimed by another source project.
     */
    function findExisting(index, sourceName, mappedDestUid, used) {
        if (mappedDestUid) {
            for (const project of index.projects) {
                if (project.uid === mappedDestUid) {
                    return used[project.uid] ? null : { uid: project.uid, name: project.name, how: "mapping" };
                }
            }
        }
        const key = nameKey(sourceName);
        if (!key)
            return null;
        for (const project of index.projects) {
            if (!used[project.uid] && project.key === key) {
                return { uid: project.uid, name: project.name, how: "name" };
            }
        }
        return null;
    }
    window.KoboEnhance.transferDest = {
        createAsset,
        uploadFormMedia,
        setVersionContent,
        deployVersion,
        archiveDeployment,
        checkProject,
        deleteProject,
        fetchProject,
        fetchUsage,
        fetchProjectIndex,
        nameKey,
        findExisting,
    };
})();
