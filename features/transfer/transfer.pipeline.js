"use strict";
/**
 * features/transfer/transfer.pipeline.ts — the actual copy, one project at a
 * time.
 *
 * This is deliberately separate from transfer.action.ts: the action file owns
 * the bulk-action contract (scope, report rows, status) while this file owns the
 * multi-step conversation with two different accounts. Keeping them apart means
 * the step order is written out once, in order, and can be read on its own.
 *
 * THE ORDER IS LOAD-BEARING
 *   1. read the source project's detail payload (versions + form media)
 *   2. create the destination project
 *   3. upload its form media
 *   4. write each source version's XML, OLDEST FIRST, keeping the version UID
 *      the destination returns
 *   5. deploy those destination versions, OLDEST FIRST (POST, then PATCH)
 *   6. re-read the destination to learn the live version UID + deployment UUID
 *   7. only then, copy submissions
 *
 * Steps 4 and 5 are separate because writing a version's content does not deploy
 * it, and PATCHing content mints a NEW version UID on the destination rather
 * than reusing the source's. The version UID a submission must reference is
 * therefore only knowable after deploying, which is why submissions are the last
 * thing rather than a parallel branch. Writing all versions before deploying any
 * is what preserves the form's revision history on the destination.
 *
 * PARTIAL FAILURE IS REPORTED, NOT HIDDEN
 * A project that has already been created cannot be un-created by throwing, so
 * from the moment the create call returns, every failure is re-thrown with the
 * new project's UID attached — the user has to be able to find the half-copied
 * project and delete it. The mapping is deliberately NOT written in that case, so
 * a re-run retries instead of skipping a broken project. A hard stop before
 * creation (nothing to create, no form versions) throws with nothing left
 * behind. The executor's onItemError records the failure and continues with the
 * next project.
 *
 * IDEMPOTENCY
 * The mapping store is written by the action, not here, and is checked before
 * anything is created — see transfer.action.ts. Re-running a transfer therefore
 * skips projects that already arrived instead of duplicating them.
 */
(function () {
    const KE = window.KoboEnhance;
    const { transferSource, transferDest, transferSubmissionsXml } = KE;
    const { t } = KE.i18n;
    function throwIfAborted(signal) {
        if (signal.aborted)
            throw new DOMException("Aborted", "AbortError");
    }
    function destContext(destination, token) {
        return { destination, token };
    }
    // -------------------------------------------------------------------
    // Forms
    // -------------------------------------------------------------------
    /**
     * Creates the destination project and replays its whole version history.
     *
     * `source` must already be the source project's detail payload: the action
     * fetched it to apply the survey/deployment guards, and that one payload also
     * carries the version history and media list, so there is nothing to re-fetch.
     */
    async function copyForm(ctx, source, destination, token) {
        const signal = ctx.signal;
        const dest = destContext(destination, token);
        const sourceUid = source.uid || ctx.uid;
        const projectName = (source.name || (source.settings && source.settings.name) || "");
        // Deployed versions only, exactly as the reference reads them
        // (C:\src\kobo-transfer\transfer\asset.py:19 — `deployed_versions['results']`,
        // passed straight to `deploy_all_versions`). Nothing in the reference touches
        // a versions collection or copies an unpublished draft, so a destination
        // copied this way has as many versions as the source has DEPLOYED ones. A
        // source showing v13 whose deployed_versions.count is 11 legitimately yields
        // v11 on the destination: the other two were never published.
        const sourceVersions = transferSource.fetchVersions(source);
        if (sourceVersions.length === 0) {
            throw new Error(t("This project has no form versions to copy."));
        }
        const sourceMedia = transferSource.fetchFormMedia(source);
        throwIfAborted(signal);
        const created = await transferDest.createAsset(dest, {
            name: projectName,
            settings: (source.settings || {}),
            asset_type: String(source.asset_type || "survey"),
        }, signal);
        throwIfAborted(signal);
        // From here on the destination project EXISTS, and nothing Kobo offers can
        // undo it — so every failure from this point on is handled by the cleanup
        // below, which deletes the project we just created.
        const destUid = created.uid;
        /**
         * Whether the source project is ARCHIVED.
         *
         * From `deployment__active` in the asset payload: observed `true` with
         * `deployment_status: "deployed"`, and `false` with `"archived"`. Only an
         * explicit `false` counts, so a payload without the field behaves as it always
         * did rather than silently archiving projects that should be live.
         */
        const sourceIsArchived = (source || {})["deployment__active"] === false;
        let result;
        try {
            const media = await copyFormMedia(dest, destUid, sourceMedia, signal);
            throwIfAborted(signal);
            // Each version is WRITTEN and then DEPLOYED before the next one is written,
            // exactly as the reference does
            // (C:\src\kobo-transfer\transfer\asset.py:52-81):
            //
            //     for i, dp in enumerate(reversed(deployed_versions)):
            //         PATCH content ; version_id = res.json()['version_id']
            //         deploy(version_id)          # POST when i == 0, else PATCH
            //
            // An earlier version of this file wrote EVERY version first and deployed
            // them in a second pass. That is indistinguishable from the reference for a
            // project with one version, and it broke every project with more: the
            // destination is left holding several un-deployed drafts and then asked to
            // activate the oldest one, which it answers with HTTP 500. Same reason a
            // one-question project transferred fine while a 9-version one never did.
            const destVersionUids = [];
            let isFirstDeployment = true;
            for (const version of sourceVersions) {
                throwIfAborted(signal);
                const content = await transferSource.fetchVersionContent(version, signal);
                const versionUid = await transferDest.setVersionContent(dest, destUid, content, signal);
                destVersionUids.push(versionUid);
                await transferDest.deployVersion(dest, destUid, versionUid, isFirstDeployment, signal);
                isFirstDeployment = false;
            }
            if (destVersionUids.length === 0) {
                throw new Error(t("The destination project has no versions to deploy."));
            }
            // Archiving is deliberately NOT done here. It is the last step of the whole
            // copy, not of the form copy: an archived project does not collect, so
            // archiving before the submissions are posted makes the destination reject
            // every one of them. `archiveCopy` is called by the action once the
            // submissions are done, so the sequence is
            //     move form -> move submissions -> archive
            // rather than
            //     move form -> archive -> move submissions (all rejected).
            // `isArchivedCopy` on the result tells the action that this is pending.
            // Read the live version UID and deployment UUID back off the destination:
            // both are needed per submission and neither is knowable before deploying.
            const deployed = await transferDest.fetchProject(dest, destUid, signal);
            if (!deployed.deployedVersionUid) {
                throw new Error(t("The destination project has no deployed version."));
            }
            // The deployment UUID is created with the project, so fall back to the
            // value from the create response if the re-read omitted it. An empty value
            // here means submissions would carry a wrong formhub/uuid, so stop before
            // copying any rather than write data that cannot be attributed.
            const deploymentUuid = deployed.deploymentUuid || created.deploymentUuid;
            if (!deploymentUuid) {
                throw new Error(t("The destination project has no deployment ID."));
            }
            deployed.deploymentUuid = deploymentUuid;
            result = {
                destUid,
                deployedProject: deployed,
                destinationProjectName: deployed.name || projectName,
                versionsDeployed: destVersionUids.length,
                versionsWritten: destVersionUids.length,
                isArchivedCopy: sourceIsArchived,
                archiveFailed: false,
                formMediaFiles: media.copied,
                formMediaFailed: media.failed,
                submissionsCreated: 0,
                submissionsDuplicate: 0,
                submissionsFailed: 0,
                submissionFailures: [],
                mappingNotSaved: false,
                summary: "",
            };
        }
        catch (e) {
            if (isAbort(e))
                throw e;
            // Delete the project this run created, whenever the form copy failed.
            //
            // The previous rule kept anything that had a deployed version, to avoid
            // destroying a user's form. That was aimed at projects the USER owns, and
            // it is the wrong rule for this one: a whole-account run left 9 projects
            // behind that read as healthy (`deployed`, `active`, `has_deployment`) while
            // holding a STALE older form, because version 1 deployed and a later
            // version was refused. That is worse than a visible failure — it looks like
            // a successful copy and is only discoverable by diffing the two accounts,
            // which is exactly how the problem was found.
            //
            // Nothing pre-existing can be lost here: this project was created by this
            // run, and we know its copy is incomplete because we watched it fail. An
            // abort still skips cleanup, since the user stopped the run and silently
            // deleting a project they may be looking at is surprising.
            throw await removeCreatedProject(dest, destUid, projectName, e);
        }
        return result;
    }
    /**
     * Deletes a project created by a failed transfer and returns the original error,
     * annotated with what happened to the project.
     *
     * The original failure is always the headline: the user needs to know why the
     * transfer failed, not that cleanup worked. The cleanup outcome is appended so
     * a failed delete is visible rather than silently leaving a shell behind.
     *
     * No AbortSignal is taken. The run's own signal may already be aborted, and a
     * cleanup that silently no-ops on an aborted signal would leave exactly the
     * shell this is meant to remove.
     */
    async function removeCreatedProject(dest, destUid, projectName, cause) {
        const detail = (cause || {}).message || String(cause);
        let deleted = false;
        let cleanupNote = "";
        try {
            deleted = await transferDest.deleteProject(dest, destUid);
        }
        catch (delErr) {
            const msg = (delErr || {}).message || String(delErr);
            cleanupNote = t(" The incomplete project could not be deleted ({reason}); remove it manually.", {
                reason: msg,
            });
        }
        if (deleted) {
            return new Error(`${detail} (${t("The incomplete project \"{name}\" was deleted from the destination.", {
                name: projectName,
            })})`);
        }
        if (!cleanupNote) {
            cleanupNote = ` (${t("A project named {name} was created on the destination with ID {uid}.", {
                name: projectName,
                uid: destUid,
            })})`;
        }
        return new Error(`${detail}${cleanupNote}`);
    }
    /**
     * Form media, best-effort per file.
     *
     * The destination project already exists by this point, so throwing on one
     * unsupported photo would leave a project the user has to clean up by hand.
     * Failures are counted and named in the summary instead, which is the same
     * trade-off the reference tool makes (asset.py:98-121 prints a warning and
     * carries on).
     */
    async function copyFormMedia(dest, destUid, sourceMedia, signal) {
        const failed = [];
        let copied = 0;
        for (const item of sourceMedia) {
            throwIfAborted(signal);
            const name = item.name || item.id || "media";
            try {
                const dataUrl = await transferSource.fetchMediaDataUrl(item, signal);
                throwIfAborted(signal);
                await transferDest.uploadFormMedia(dest, destUid, {
                    name,
                    dataUrl,
                    contentType: item.contentType || "application/octet-stream",
                    // Forwarded untouched: Kobo keys the uploaded file off this object,
                    // and a rebuilt one loses the filename/mimetype it needs.
                    metadata: item.metadata || { filename: name, mimetype: item.contentType || "" },
                }, signal);
                copied++;
            }
            catch (e) {
                if (isAbort(e))
                    throw e;
                failed.push(name);
            }
        }
        return { copied, failed };
    }
    // -------------------------------------------------------------------
    // Submissions
    // -------------------------------------------------------------------
    /**
     * Walks the source project's submissions and posts each one to the
     * destination's OpenRosa endpoint.
     *
     * The walk is page-at-a-time over data.xml and each submission is posted
     * individually, because the two endpoints disagree about what a unit of work
     * is: the source returns a page of many submissions, the destination accepts
     * one at a time. Kobo's 201/202 distinction is counted rather than treated as
     * an outcome difference — 201 is newly stored, 202 is "already had this
     * instanceID", which is the expected result of a re-run and not a failure.
     *
     * There is deliberately no delay between submissions. The reference tool posts
     * serially with no pause, the executor already paces BETWEEN projects, and the
     * transport retries 429 with exponential backoff — so a destination that wants
     * requests slowed down is handled by the retry policy rather than by a sleep
     * that would turn a large project into an hours-long run.
     */
    async function copySubmissions(ctx, destProject, sourceUid, destination, token) {
        const signal = ctx.signal;
        const submissionUrl = `${destination.kcUrl}${transferSubmissionsXml.SUBMISSION_PATH}`;
        // Everything a submission must be repointed at. Resolved once: these are
        // the values that are wrong if taken from the source project.
        const target = {
            destUid: destProject.uid,
            versionUid: destProject.deployedVersionUid || "",
            versionLabel: destProject.versionLabel || "",
            formhubUuid: destProject.deploymentUuid || "",
        };
        if (!target.versionUid) {
            throw new Error(t("The destination project has no deployed version, so submissions cannot be copied."));
        }
        const counters = {
            destUid: destProject.uid,
            versionsDeployed: 0,
            versionsWritten: 0,
            isArchivedCopy: false,
            archiveFailed: false,
            formMediaFiles: 0,
            submissionsCreated: 0,
            submissionsDuplicate: 0,
            submissionsFailed: 0,
            submissionFailures: [],
        };
        let url = transferSource.firstSubmissionsPageUrl(sourceUid);
        let guard = 0;
        let declaredTotal = 0;
        let seen = 0;
        let attempted = 0;
        const consecutive = { count: 0, status: "" };
        while (url) {
            throwIfAborted(signal);
            guard++;
            if (guard > 10000) {
                // A misbehaving <next> must not spin forever.
                throw new Error(t("The source account's submission list did not end."));
            }
            const page = await transferSource.fetchSubmissionsPage(url, signal);
            if (declaredTotal === 0)
                declaredTotal = page.count;
            seen += page.items.length;
            for (const submission of page.items) {
                throwIfAborted(signal);
                if (counters.submissionsAborted)
                    break;
                try {
                    const rewritten = transferSubmissionsXml.rewrite(submission, target);
                    const res = await KE.transferTransport.submitXml(token, submissionUrl, rewritten.xml, rewritten.instanceId, signal);
                    if (res.status === 201) {
                        counters.submissionsCreated++;
                        consecutive.count = 0;
                    }
                    else if (res.status === 202) {
                        counters.submissionsDuplicate++;
                        consecutive.count = 0;
                    }
                    else {
                        counters.submissionsFailed++;
                        recordSubmissionFailure(counters, rewritten.instanceId, res.status === undefined ? "?" : String(res.status), res.text || res.error || "");
                        noteConsecutiveFailure(counters, consecutive, String(res.status));
                    }
                }
                catch (e) {
                    if (isAbort(e))
                        throw e;
                    // One malformed or rejected submission must not abandon the rest:
                    // the project is already copied and the rest of the rows are still
                    // worth having.
                    counters.submissionsFailed++;
                    const err = (e || {});
                    recordSubmissionFailure(counters, "?", "threw", err.message || String(e));
                    noteConsecutiveFailure(counters, consecutive, "threw");
                }
                // Published per submission, not per page: a page of 300 is a long time
                // to stare at an unmoving progress line.
                attempted++;
                if (ctx.onStep)
                    ctx.onStep(t("submission ({n})", { n: String(attempted) }));
            }
            // Stop paging too once the walk has been abandoned.
            if (counters.submissionsAborted)
                break;
            url = page.next;
        }
        // If the source says it has submissions but the walk produced none, the
        // page was not understood — reporting "0 copied" as a success would hide a
        // parsing or URL bug behind a green row.
        if (declaredTotal > 0 && seen === 0) {
            throw new Error(t("The source account reported {count} submissions but none could be read.", {
                count: String(declaredTotal),
            }));
        }
        // A SHORT read is just as much a bug as an empty one, and was previously
        // silent: the only guard was `seen === 0`, so a walk that read 6 of 8
        // reported "6 copied" and looked like a clean run. The count is the source's
        // own `<count>`, so a mismatch means rows were dropped between the API and
        // the destination, and saying so is the whole point of counting.
        if (declaredTotal > 0 && seen < declaredTotal) {
            counters.submissionReadShortfall = declaredTotal - seen;
        }
        // Both numbers are always reported, not only on a mismatch. "The source
        // claims 8, we read 8, we posted 6" and "the source claims 8, we read 6, we
        // posted 6" look identical in every other counter, and they need completely
        // different fixes — one is a posting problem, the other a parsing problem.
        counters.submissionsDeclared = declaredTotal;
        counters.submissionsRead = seen;
        return counters;
    }
    function isAbort(e) {
        return (e || {}).name === "AbortError";
    }
    /** How many failure reasons to keep. Enough to spot a pattern without turning
     *  the report cell into a wall of text when a whole project is rejected. */
    const MAX_FAILURE_NOTES = 5;
    /**
     * Consecutive identical submission failures tolerated before the walk is
     * abandoned.
     *
     * Five is chosen to absorb a genuinely flaky request while still stopping fast:
     * the alternative is what a full-account run actually did — 7,646 submissions
     * POSTed at a destination that had rejected the first one, because the
     * destination was returning HTTP 402 (submission allowance exhausted) for every
     * single one. Fifty projects' worth of pointless requests to learn something the
     * fifth response already said.
     */
    const MAX_CONSECUTIVE_SUBMISSION_FAILURES = 5;
    /**
     * Records a failure and abandons the walk once the same failure repeats too
     * many times in a row.
     *
     * Deliberately does NOT throw. The form has already been copied by this point,
     * so the project on the destination is real and keeping it is right; what is
     * reported is that its submissions were abandoned and why, so the project can
     * be re-run once the cause is cleared.
     */
    function noteConsecutiveFailure(counters, state, status) {
        if (counters.submissionsAborted)
            return;
        if (status === state.status) {
            state.count++;
        }
        else {
            state.status = status;
            state.count = 1;
        }
        if (state.count >= MAX_CONSECUTIVE_SUBMISSION_FAILURES) {
            counters.submissionsAborted = true;
            counters.submissionAbortStatus = status;
            counters.submissionAbortReason = counters.submissionFailures.length
                ? counters.submissionFailures[0]
                : "";
        }
    }
    /**
     * Records WHY a submission was rejected, with its instance id.
     *
     * A bare "2 could not be copied" is not actionable and hides the whole class of
     * causes: a rejected media reference, malformed rewritten XML, a version or
     * deployment id Kobo will not accept, a duplicate instance id. The status and
     * the destination's own message are what identify which, so both are kept.
     *
     * The instance id is what lets the offending submission be found on the source.
     * The body is truncated because it can echo the submission back.
     */
    function recordSubmissionFailure(counters, instanceId, status, detail) {
        if (counters.submissionFailures.length >= MAX_FAILURE_NOTES)
            return;
        const body = detail.replace(/\s+/g, " ").trim().slice(0, 120);
        counters.submissionFailures.push(body ? `${instanceId} (HTTP ${status}: ${body})` : `${instanceId} (HTTP ${status})`);
    }
    /**
     * Archives the copy when the source project was archived. The LAST step of a
     * transfer, called by the action after submissions have been posted.
     *
     * A no-op returning false for a normal project. For an archived source it
     * issues the form-encoded `active=false` PATCH that Kobo's own UI uses, so the
     * destination ends up in the same state as the source.
     *
     * Throws if the destination refuses, so the caller can report that the final
     * state did not apply while keeping the form and submissions that already
     * transferred. The copy is real work; the archive is a last label on it, and
     * losing the label must not throw away the work.
     */
    async function archiveCopy(result, destination, token, signal) {
        if (!result.isArchivedCopy)
            return false;
        await transferDest.archiveDeployment(destContext(destination, token), result.destUid, signal);
        return true;
    }
    window.KoboEnhance.transferPipeline = {
        /** Exposed so the report can name the same threshold the walk used, rather
         *  than repeating the number and letting the two drift apart. */
        MAX_CONSECUTIVE_SUBMISSION_FAILURES,
        copyForm,
        copyFormMedia,
        copySubmissions,
        archiveCopy,
    };
})();
