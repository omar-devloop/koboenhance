"use strict";
/**
 * features/transfer/transfer.action.ts — move projects to another account.
 *
 * A BULK action (one source project per row), so it reuses the existing
 * scope/executor/report machinery: selected projects, manually entered UIDs and
 * whole-account scope all work without any transfer-specific plumbing.
 *
 * v1 scope (agreed with the user):
 *   - source = the account currently signed in, addressed by its OWN API token
 *     where one can be read (core/transfer/source.account.ts) and by the page
 *     session otherwise
 *   - destination = one configured Global/EU account, validated in
 *     features/transfer/transfer.panel.ts and held by
 *     core/transfer/destination.store.ts
 *   - forms and submissions are copied; submission ATTACHMENTS are not
 *
 * The destination token is never part of the run request: ActionRequest only
 * carries `transferReady` (a boolean gate) plus the user's two choices. The
 * token is read from the destination store at execution time, so it can never
 * be snapshotted into run history by the paused-run/history stores. The source
 * token is never stored at all — not even in memory beyond the page, and never
 * in a request.
 *
 * WHAT validate() DOES, BEFORE THE CONFIRM DIALOG
 *   1. checks the destination and the two choices
 *   2. reads the source account's API token, so a run that lasts an hour does
 *      not inherit the session cookie's expiry
 *   3. runs the PREFLIGHT (features/transfer/transfer.preflight.ts): how many
 *      projects this run would copy, how many submissions that is, and how much
 *      submission allowance the destination has left. A shortfall is shown as a
 *      warning; it does not block the run, because the user is the one who
 *      knows whether they meant to copy everything.
 *
 * WHAT execute() DOES, IN ORDER
 *   1. re-checks the destination and the token, which validate() cannot do
 *      (validation ran at click time, in a different tick)
 *   2. re-reads the source project and applies the same two guards the Python
 *      reference tool applies: asset_type == "survey" and has_deployment
 *   3. reads the destination account's own project list and SKIPS a project that
 *      is already there — same recorded UID, or same name — so re-running a
 *      whole-account transfer cannot duplicate an account
 *   4. runs the copy pipeline (features/transfer/transfer.pipeline.ts)
 *   5. records the mapping, then reports every counter, including the partial
 *      failures the pipeline had to work around
 */
(function () {
    const KE = window.KoboEnhance;
    const A = KE.actionRegistry;
    const { t } = KE.i18n;
    const store = KE.transferDestination;
    const mappings = KE.transferMapping;
    const pipeline = KE.transferPipeline;
    /**
     * The preflight for the run currently being confirmed.
     *
     * Held on the module because validate() and confirmDetailsBlock() are two
     * separate calls on the same click: validate() does the counting and this is
     * what the dialog renders, so the numbers the user reads are exactly the
     * numbers that were read. Never persisted, and it carries no credentials — the
     * destination token is re-read from the store at execution time.
     */
    let plan = null;
    /**
     * The destination's project list for the run in progress.
     *
     * Fetched once, lazily, on the first project: validate() runs before the user
     * confirms and the destination can change in between, so the read happens at
     * execute time. Reset by validate() for every new run and never persisted.
     */
    let runIndex = null;
    let runIndexTried = false;
    /** Destination projects already matched in this run, so two source projects
     *  that share a name cannot both be skipped against one destination copy. */
    const runUsedDest = {};
    function resetRunIndex() {
        runIndex = null;
        runIndexTried = false;
        for (const uid of Object.keys(runUsedDest))
            delete runUsedDest[uid];
    }
    async function destinationIndex(destination, token, signal) {
        if (runIndexTried)
            return runIndex;
        runIndexTried = true;
        try {
            runIndex = await KE.transferDest.fetchProjectIndex({ destination, token }, signal);
        }
        catch (e) {
            if (signal && signal.aborted)
                throw e;
            runIndex = null;
        }
        return runIndex;
    }
    /**
     * A status line for the wait before the confirm dialog.
     *
     * The executor runs validate() before it creates the run toast, so on an
     * account with hundreds of projects a counting pass would otherwise look like
     * a dead Run button. One toast, dismissed as soon as the pass finishes.
     */
    function beginPlanning(initial) {
        let step = "";
        const handle = KE.components.showToast({
            type: "info",
            title: t("Checking what this run will copy..."),
            description: initial,
            duration: 0,
        });
        return {
            paint(message) {
                if (message === step)
                    return;
                step = message;
                const desc = handle.el.querySelector(".ke-toast-desc");
                if (desc)
                    desc.textContent = message;
            },
            dismiss() {
                handle.dismiss();
            },
        };
    }
    /**
     * Attaches the project name to a thrown error.
     *
     * The executor builds a failed row from the error alone and cannot know which
     * project it came from a uid, so it left Project_Name blank. On a 50-project
     * run all 28 failures had no name and no destination UID, and identifying one
     * meant joining the report on Project_UID by hand.
     *
     * The error is returned rather than swallowed so the executor still sees it,
     * which is what makes its expired-session and connection-lost stops work.
     */
    function labelError(e, projectName) {
        const err = (e || {});
        if (!err.projectName)
            err.projectName = projectName;
        return err;
    }
    /** The scope as the row-2 dropdown words it, so the confirm dialog echoes
     *  the exact option the user picked. Every option includes the form, so this
     *  is a choice of one of two labels rather than a join. */
    function describeScope(cfg) {
        return cfg.moveSubmissions ? t("Form + Submissions") : t("Form only");
    }
    function destinationLabel() {
        const dest = store.getDestination();
        if (!dest)
            return "";
        const info = store.serverInfo(dest.server);
        return dest.username ? `${dest.username} @ ${info.label}` : info.label;
    }
    function number(value) {
        return isFinite(value) ? String(value) : "0";
    }
    /** A project's outcome, as the report shows it. */
    function buildData(cfg, result) {
        const data = {
            Destination: destinationLabel(),
            Copying: describeScope(cfg),
            Destination_Project: result.destinationProjectName,
            Destination_UID: result.destUid,
            Versions_Deployed: number(result.versionsDeployed),
            Form_Media_Copied: number(result.formMediaFiles),
            Form_Media_Failed: result.formMediaFailed.length > 0 ? result.formMediaFailed.join("; ") : "0",
            Submissions_Created: number(result.submissionsCreated),
            Submissions_Already_There: number(result.submissionsDuplicate),
            Submissions_Failed: number(result.submissionsFailed),
            Submissions_Rejected: result.submissionFailures.length ? result.submissionFailures.join("; ") : "",
        };
        return data;
    }
    /** One line describing what happened, for the report's message column. */
    function summarize(cfg, result) {
        const parts = [];
        if (result.isArchivedCopy && result.archiveFailed) {
            parts.push(t("The project could not be archived, so it is still live on the destination ({reason})", {
                reason: result.archiveError || "",
            }));
        }
        else if (result.isArchivedCopy) {
            // Every version was deployed, submissions were posted while the project was
            // live, and only then was it archived. Said explicitly because
            // "deployed" and "archived" otherwise look contradictory in a report.
            parts.push(t("{versions} form versions copied, then archived to match the source", {
                versions: number(result.versionsWritten),
            }));
        }
        else {
            parts.push(t("{versions} form versions deployed", { versions: number(result.versionsDeployed) }));
        }
        if (result.formMediaFiles > 0 || result.formMediaFailed.length > 0) {
            parts.push(t("{copied} media files copied", { copied: number(result.formMediaFiles) }));
        }
        if (result.formMediaFailed.length > 0) {
            // Named, not counted: the user has to be able to find these in the
            // destination project and know which ones are missing.
            parts.push(t("{count} media files could not be copied: {names}", {
                count: String(result.formMediaFailed.length),
                names: result.formMediaFailed.join(", "),
            }));
        }
        if (cfg.moveSubmissions) {
            // The read itself, always. Whether the loss happened while reading or while
            // posting decides where the bug is, and no other counter distinguishes them.
            if (result.submissionsDeclared !== undefined && result.submissionsRead !== undefined) {
                parts.push(t("The source listed {declared} and {read} were read", {
                    declared: number(result.submissionsDeclared),
                    read: number(result.submissionsRead),
                }));
            }
            parts.push(t("{created} submissions copied", { created: number(result.submissionsCreated) }));
            if (result.submissionsDuplicate > 0) {
                parts.push(t("{count} were already there", { count: number(result.submissionsDuplicate) }));
            }
            if (result.submissionsFailed > 0) {
                parts.push(t("{count} could not be copied", { count: number(result.submissionsFailed) }));
                // The reason and the submission id, because "2 could not be copied"
                // alone cannot be acted on. This is what turns a partial copy into a
                // diagnosable one.
                if (result.submissionFailures.length > 0) {
                    parts.push(t("Rejected submissions: {details}", {
                        details: result.submissionFailures.join("; "),
                    }));
                }
            }
            if (result.submissionsAborted) {
                // The walk gave up because the same rejection kept coming. Said plainly,
                // because "N copied" with no explanation is how a run that had been
                // rejected from the very first request could still read as a clean pass.
                parts.push(t("Stopped copying submissions after {n} consecutive rejections ({status}). Re-run this project once that is fixed.", {
                    n: String(pipeline.MAX_CONSECUTIVE_SUBMISSION_FAILURES),
                    status: result.submissionAbortStatus || "",
                }));
            }
            if (result.submissionReadShortfall && result.submissionReadShortfall > 0) {
                // The source counted more submissions than the walk produced. Neither a
                // failure nor a duplicate explains this, so it is called out on its own.
                parts.push(t("{count} submissions the source reported were never read", {
                    count: number(result.submissionReadShortfall),
                }));
            }
        }
        if (result.mappingNotSaved) {
            // The copy happened; only the "don't do this twice" record was lost.
            parts.push(t("This project was copied, but KoboEnhance could not remember that, so a re-run would copy it again."));
        }
        return parts.join(". ");
    }
    A.register("transfer_project", {
        label: "Move projects to another account",
        group: "Account tools",
        description: "Copy projects and submissions into a second Kobo account",
        icon: "copy",
        // "transfer" is not a text input: it selects which toolbar row to show and
        // is the required-field gate for "a destination has been validated".
        fields: ["transfer"],
        requiredFields: ["transfer"],
        stepLabel: "Moving projects",
        reportFields: [
            "Destination",
            "Copying",
            "Destination_Project",
            "Destination_UID",
            "Versions_Deployed",
            "Form_Media_Copied",
            "Form_Media_Failed",
            "Submissions_Created",
            "Submissions_Already_There",
            "Submissions_Failed",
            "Submissions_Rejected",
        ],
        skipReason: "Not a deployed survey project",
        confirmDetailsBlock(context) {
            const cfg = context.request;
            // The two account lines are this action's own; everything numeric comes
            // from the preflight, which owns those numbers.
            const facts = [
                { label: t("Destination"), value: destinationLabel() },
                { label: t("Copying"), value: describeScope(cfg) },
            ];
            const warnings = [];
            const notes = [
                t("Attachments are not copied."),
                t("A project that was already moved is skipped instead of copied again."),
            ];
            if (plan) {
                const summary = KE.transferPreflight.summarize(plan);
                for (const fact of summary.facts || [])
                    facts.push(fact);
                for (const warning of summary.warnings || [])
                    warnings.push(warning);
                // The preflight's notes qualify the numbers above ("already moved",
                // "resets on"), so they lead; the standing conditions read better last.
                return {
                    facts,
                    warnings,
                    notes: (summary.notes || []).concat(notes),
                };
            }
            // Said rather than omitted. A confirm dialog that silently lacks the
            // copy-size and allowance rows reads as though there were none to
            // report, when the truth is that they could not be read.
            warnings.push(t("KoboEnhance could not check the copy size or the destination's allowance."));
            return { facts, warnings, notes };
        },
        async validate(context) {
            // Every click on Run starts a new run: the destination list cached for the
            // previous one must not answer for this one.
            resetRunIndex();
            const dest = store.getDestination();
            if (!dest)
                return t("Set a destination account first.");
            if (!context.request.moveForms && !context.request.moveSubmissions) {
                return t("Select at least one of Forms or Submissions to copy.");
            }
            if (context.request.moveSubmissions && !context.request.moveForms) {
                return t("Submissions can only be copied into a project that already exists in the destination account.");
            }
            const token = await store.getToken();
            if (!token)
                return t("The destination account needs to be set up again before this can run.");
            // Read the source account's own token before the run, so the reads that
            // follow do not depend on the page session staying alive for the length
            // of a transfer. A failure here is not fatal: source reads fall back to
            // the session, which is exactly how they worked before.
            await KE.transferSourceAccount.ensureToken();
            // Defence in depth for a destination validated before the panel learned to
            // reject this: the destination must not be the account being copied FROM.
            const sourceToken = KE.transferSourceAccount.getToken();
            if (sourceToken && sourceToken === token) {
                return t("That is the token of the account you are signed in to. Enter the destination account's token instead.");
            }
            // The preflight: what will be copied, and whether the destination has the
            // submission allowance to receive it. A shortfall is a WARNING, not a
            // block — the user may have a reason, and an allowance Kobo no longer
            // reports must not make the feature unusable.
            const status = beginPlanning(t("Counting the projects in this run..."));
            try {
                plan = await KE.transferPreflight.run({
                    uids: context.uids,
                    wholeAccount: context.wholeAccount,
                    filterUrl: context.filterUrl,
                    resolveWholeAccount: context.resolveWholeAccount,
                    moveSubmissions: !!context.request.moveSubmissions,
                    destination: dest,
                    token,
                    onProgress: (message) => status.paint(message),
                });
            }
            catch (e) {
                // A preflight that cannot complete must not silently pretend the copy is
                // small: the confirm dialog falls back to its standing lines and says so.
                plan = null;
            }
            finally {
                status.dismiss();
            }
            return null;
        },
        /**
         * Copies one project. Throwing marks the row failed and lets the executor
         * move on to the next project; returning marks it handled. Nothing here is
         * read-only any more — this creates real projects on the destination.
         */
        async execute(ctx) {
            const c = ctx;
            const cfg = c.request;
            const signal = c.signal;
            // validate() ran when the user clicked Run, in an earlier tick. The page
            // may have been reloaded since (the token is memory-only and does not
            // survive a reload) or the destination may have been cleared, so the gate
            // is re-checked here rather than trusted.
            const destination = store.getDestination();
            if (!destination)
                throw new Error(t("Set a destination account first."));
            const token = await store.getToken();
            if (!token)
                throw new Error(t("The destination account needs to be set up again before this can run."));
            // Read through the transfer's own source API rather than the shared
            // session client: the same `.json` detail form the pipeline needs (the
            // trailing-slash form can come back trimmed), and it carries the source
            // account's API token when one is known, so a long run does not depend on
            // the page session outliving it.
            const asset = await KE.transferSource.fetchAssetDetail(c.uid, signal);
            const a = (asset || {});
            const projectName = a.name || (a.settings && a.settings.name) || "";
            const assetType = String(a.asset_type || "");
            const hasDeployment = a["has_deployment"] === true;
            // Same two guards the Python tool applies before touching a project
            // (helpers/config.py: asset_type == "survey" and has_deployment).
            if (assetType !== "survey" || !hasDeployment) {
                return {
                    unchanged: true,
                    projectName,
                    message: t("This project has no deployed form, so it cannot be copied."),
                    data: {
                        Destination: destinationLabel(),
                        Copying: describeScope(cfg),
                        Source_Asset_Type: assetType,
                        Source_Has_Deployment: hasDeployment ? "yes" : "no",
                    },
                };
            }
            // Idempotency. A whole-account re-run is the dangerous case: without this
            // it would create a second copy of every project in the account.
            //
            // The destination's own project list answers "is it already there?", read
            // fresh for this run. The mapping is only an identity hint: a recorded UID
            // that still exists recognises a copy the user renamed after moving it.
            // Matching by name is what finds a copy made before this extension
            // existed, or by hand — exactly the case a mapping-only check could not
            // see.
            await KE.transferMapping.ready();
            const mapped = mappings.get(destination.server, c.uid);
            const index = await destinationIndex(destination, token, signal);
            let existing = null;
            let unverified = false;
            if (index) {
                existing = KE.transferDest.findExisting(index, projectName, mapped ? mapped.destUid : "", runUsedDest);
            }
            else if (mapped) {
                // The list could not be read. Only a recorded copy can be checked, and
                // "unknown" still means SKIP: a network blip must never be allowed to
                // duplicate a whole account.
                const state = await KE.transferDest.checkProject({ destination, token }, mapped.destUid, signal);
                if (state !== "missing") {
                    existing = { uid: mapped.destUid, name: mapped.destName, how: "mapping" };
                    unverified = state === "unknown";
                }
            }
            if (existing) {
                runUsedDest[existing.uid] = true;
                // A name match is a real copy too. Record it, so a later rename of the
                // destination project cannot make the same project look absent again.
                if (existing.how === "name") {
                    await mappings.set(destination.server, {
                        sourceUid: c.uid,
                        destUid: existing.uid,
                        destName: existing.name,
                        at: Date.now(),
                    });
                }
                return {
                    unchanged: true,
                    projectName,
                    message: existing.how === "name"
                        ? t("This project already exists in the destination as {name}; nothing was copied.", {
                            name: existing.name,
                        })
                        : unverified
                            ? t("This project was already moved to {uid}, but the destination could not be checked, so nothing was copied.", {
                                uid: existing.uid,
                            })
                            : t("This project was already moved to {uid} on {date}.", {
                                uid: existing.uid,
                                date: new Date(mapped ? mapped.at : Date.now()).toLocaleDateString(),
                            }),
                    data: {
                        Destination: destinationLabel(),
                        Copying: describeScope(cfg),
                        Destination_Project: existing.name,
                        Destination_UID: existing.uid,
                        Versions_Deployed: "",
                        Form_Media_Copied: "",
                        Form_Media_Failed: "",
                        Submissions_Created: "0",
                        Submissions_Already_There: "0",
                        Submissions_Failed: "0",
                        Source_Asset_Type: assetType,
                        Source_Has_Deployment: "yes",
                    },
                };
            }
            // Not on the destination, so any mapping is stale. Drop it before copying:
            // if the copy fails, it must not be left to be trusted again.
            if (mapped)
                await mappings.remove(destination.server, c.uid);
            // copyForm is the only call below that can throw, and by now the project's
            // name is known, so its failure is labelled with that name.
            let result;
            try {
                result = await pipeline.copyForm(c, a, destination, token);
            }
            catch (e) {
                throw labelError(e, projectName);
            }
            // Submissions next, while the destination is still LIVE. An archived project
            // does not collect, so archiving first would make every submission POST
            // fail. This is why archiving is deferred to the step below.
            if (cfg.moveSubmissions) {
                const submissionCounts = await pipeline.copySubmissions(c, result.deployedProject, c.uid, destination, token);
                result.submissionsCreated = submissionCounts.submissionsCreated;
                result.submissionsDuplicate = submissionCounts.submissionsDuplicate;
                result.submissionsFailed = submissionCounts.submissionsFailed;
                // The failure REASONS have to be carried across too. They were not, and
                // the omission made `Submissions_Rejected` permanently empty — so a run in
                // which every submission on a project failed reported "0 could not be
                // copied" with no explanation at all, which is the one situation where the
                // explanation matters most.
                result.submissionFailures = submissionCounts.submissionFailures;
                result.submissionsDeclared = submissionCounts.submissionsDeclared;
                result.submissionsRead = submissionCounts.submissionsRead;
                result.submissionReadShortfall = submissionCounts.submissionReadShortfall;
                result.submissionsAborted = submissionCounts.submissionsAborted;
                result.submissionAbortStatus = submissionCounts.submissionAbortStatus;
                result.submissionAbortReason = submissionCounts.submissionAbortReason;
            }
            // Archive LAST, so the destination ends in the same state as the source:
            //   move form -> move submissions -> archive
            // A failure here is reported but NOT fatal. The form and the submissions
            // are already safely on the destination; losing the final state must not
            // discard that work or leave the mapping unwritten.
            try {
                await pipeline.archiveCopy(result, destination, token, signal);
            }
            catch (e) {
                const err = (e || {});
                result.archiveFailed = true;
                result.archiveError = err.message || String(e);
            }
            // Recorded only after the copy succeeded, so a failed attempt is retried
            // on the next run rather than being wrongly treated as done.
            result.mappingNotSaved = !(await mappings.set(destination.server, {
                sourceUid: c.uid,
                destUid: result.destUid,
                destName: result.destinationProjectName,
                at: Date.now(),
            }));
            result.summary = summarize(cfg, result);
            return {
                unchanged: false,
                projectName,
                message: result.summary,
                data: buildData(cfg, result),
            };
        },
    });
})();
