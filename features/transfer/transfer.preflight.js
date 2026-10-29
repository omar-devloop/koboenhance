"use strict";
/**
 * features/transfer/transfer.preflight.ts — what is about to be copied, and
 * whether the destination can take it.
 *
 * WHY IT EXISTS
 * Kobo caps submissions per account, and a destination at its cap answers every
 * submission with HTTP 402. Nothing in the copy path notices that early: the
 * form is created, every version is deployed, and then each project's
 * submissions are refused one at a time. The walk eventually gives up after five
 * consecutive rejections, but by then a whole-account run has already created
 * half an account's worth of projects and issued thousands of doomed requests.
 *
 * So the two numbers are read BEFORE the confirm dialog, and shown in it:
 *
 *   1. how many submissions the run will upload, summed from the source
 *      account's own per-project counts, and
 *   2. how much of its allowance the destination has left for this period.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not block the run when the allowance is short. A shortfall is the
 * user's call: they may be copying a handful of projects out of many, they may
 * intend to move only some of the submissions, and an unreadable allowance
 * (Kobo deprecated the endpoint) must not make the feature unusable. The
 * dialog states the shortfall plainly and lets the run proceed.
 *
 * WHY IT RUNS IN validate()
 * The executor runs validate() -> confirm() in that order, on the same click,
 * and hands the same context to both. Doing the work in validate() and leaving
 * the answer for confirmDetailsBlock() to render is what puts the numbers in
 * front of the user without adding a second confirmation step or touching the
 * executor.
 *
 * NOTHING HERE IS SECRET-ADJACENT
 * The preflight holds the destination token only to make one authenticated
 * read, and its result is a set of counts. It is stored on the module for the
 * life of the tab so confirmDetailsBlock() can render it, and is dropped when
 * the page reloads.
 */
(function () {
    const KE = window.KoboEnhance;
    const { t } = KE.i18n;
    /** How long the whole preflight may take before the dialog stops waiting. */
    const PREFLIGHT_TIMEOUT_MS = 45000;
    /** How many "does this mapping still exist?" checks may be in flight at once. */
    const MAPPING_CHECK_CONCURRENCY = 6;
    /** The allowance read gets its own budget: it is one request, and it must
     *  still be reported even when a long counting pass used the whole one. */
    const USAGE_TIMEOUT_MS = 15000;
    function number(value) {
        return isFinite(value) ? value.toLocaleString() : "0";
    }
    /** An abort this module raised itself, as opposed to one the caller raised. */
    function timedOut(signal, own) {
        return own.aborted && !signal.aborted;
    }
    /**
     * The projects this run will actually copy, split from what the destination
     * already has.
     *
     * The destination's own project list is the authority, read fresh on every
     * preflight. The mapping store used to be consulted instead, and a mapping is
     * a CLAIM, not a fact: it outlives the destination project being deleted, so
     * the dialog excluded projects the run would really re-copy — it promised
     * "2 projects / 13 submissions" for a run that would do 4 / 20.
     *
     * A remembered destination UID is still used, but only as exact identity: if
     * the destination still has it, the copy is recognised even after a rename.
     * Otherwise a destination project with the same name stands in. Each
     * destination project can match at most one source project, so two source
     * projects sharing a name are not both skipped against one copy.
     *
     * When the destination list cannot be read, the fallback checks the recorded
     * copies one by one. "Unknown" keeps a project skipped: a network blip must
     * never be able to duplicate a whole account. That is the rule execute()
     * applies too.
     */
    async function classifyProjects(uids, sourceAssets, index, ctx, signal) {
        const mappings = KE.transferMapping;
        const toCopy = [];
        let alreadyMoved = 0;
        let matchedByName = 0;
        if (index) {
            const used = {};
            for (const uid of uids) {
                const mapped = mappings.get(ctx.destination.server, uid);
                const source = sourceAssets[uid];
                const hit = KE.transferDest.findExisting(index, source ? source.name : "", mapped ? mapped.destUid : "", used);
                if (hit) {
                    used[hit.uid] = true;
                    alreadyMoved++;
                    if (hit.how === "name")
                        matchedByName++;
                }
                else {
                    // A remembered copy the destination no longer has is not reported:
                    // to the user it is simply a project that will be copied now. The
                    // numbers already say so, and naming our own bookkeeping as an
                    // "earlier copy" only raised a question the counts had answered.
                    toCopy.push(uid);
                }
            }
            return { toCopy, alreadyMoved, matchedByName };
        }
        // The destination could not be listed. Only projects an earlier run
        // recorded can be checked; the rest are copied, as they always were.
        const mapped = [];
        for (const uid of uids) {
            const found = mappings.get(ctx.destination.server, uid);
            if (found)
                mapped.push({ uid, destUid: found.destUid });
            else
                toCopy.push(uid);
        }
        for (let i = 0; i < mapped.length; i += MAPPING_CHECK_CONCURRENCY) {
            const batch = mapped.slice(i, i + MAPPING_CHECK_CONCURRENCY);
            const states = await Promise.all(batch.map((item) => KE.transferDest.checkProject(ctx, item.destUid, signal)));
            for (let j = 0; j < batch.length; j++) {
                if (states[j] === "missing") {
                    toCopy.push(batch[j].uid);
                }
                else {
                    alreadyMoved++;
                }
            }
        }
        return { toCopy, alreadyMoved, matchedByName };
    }
    async function run(input) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
        const relay = () => controller.abort();
        if (input.signal) {
            if (input.signal.aborted) {
                clearTimeout(timer);
                throw new DOMException("Aborted", "AbortError");
            }
            input.signal.addEventListener("abort", relay, { once: true });
        }
        const signal = controller.signal;
        const progress = (message) => {
            if (input.onProgress)
                input.onProgress(message);
        };
        try {
            // A form-only run costs the destination no submissions, so there is
            // nothing to check. It still reports the project count, which is useful
            // before a run that creates real projects.
            let uids = input.uids.slice();
            if (input.wholeAccount && uids.length === 0) {
                progress(t("Resolving the projects in this view..."));
                try {
                    uids = input.resolveWholeAccount
                        ? await input.resolveWholeAccount(signal)
                        : await KE.scopeService.resolveUids({
                            uids: null,
                            filterUrl: input.filterUrl,
                            signal,
                        });
                }
                catch (e) {
                    if (input.signal && input.signal.aborted)
                        throw e;
                    // The scope could not be resolved, so there is nothing to count. The
                    // dialog says "0 projects" only because the resolve failed, which the
                    // run itself will report far more clearly than a preflight could.
                    uids = [];
                }
            }
            await KE.transferMapping.ready();
            const destCtx = { destination: input.destination, token: input.token };
            // Names and submission counts for every project in scope, in one pass.
            // Names are needed even for a form-only run: the destination is matched by
            // name, and a project that turns out to exist there must not have its
            // submissions counted into the total.
            let sourceAssets = {};
            let countsKnown = true;
            if (uids.length > 0) {
                progress(t("Reading the projects in this run..."));
                try {
                    sourceAssets = await KE.transferUsage.fetchSourceAssetCounts(uids, signal, (done, total) => {
                        if (input.moveSubmissions && total > 0) {
                            progress(t("Counting the submissions to copy... ({done}/{total})", {
                                done: number(done),
                                total: number(total),
                            }));
                        }
                    });
                }
                catch (e) {
                    // Only a caller-driven abort is fatal. Our OWN deadline and an
                    // unreadable source list are both reported as "not counted", which is
                    // strictly better than a dialog that silently claims zero.
                    if ((e || {}).name === "AbortError") {
                        if (input.signal && input.signal.aborted)
                            throw e;
                    }
                    countsKnown = false;
                }
            }
            // What the destination actually has RIGHT NOW. Null means it could not be
            // read, which is never treated as "the destination is empty" — that would
            // duplicate an account on the next run.
            progress(t("Checking the destination's projects..."));
            let index = null;
            try {
                index = await KE.transferDest.fetchProjectIndex(destCtx, signal);
            }
            catch (e) {
                if (input.signal && input.signal.aborted)
                    throw e;
                index = null;
            }
            const { toCopy, alreadyMoved, matchedByName } = await classifyProjects(uids, sourceAssets, index, destCtx, signal);
            let submissionsToCopy = 0;
            if (input.moveSubmissions) {
                for (const uid of toCopy) {
                    const entry = sourceAssets[uid];
                    if (entry)
                        submissionsToCopy += entry.allTime;
                }
            }
            progress(t("Checking the destination's allowance..."));
            let usage = { exceeded: false, unlimited: false };
            if (input.moveSubmissions) {
                const usageController = new AbortController();
                const usageTimer = setTimeout(() => usageController.abort(), USAGE_TIMEOUT_MS);
                const usageRelay = () => usageController.abort();
                if (input.signal)
                    input.signal.addEventListener("abort", usageRelay, { once: true });
                try {
                    usage = await KE.transferDest.fetchUsage({ destination: input.destination, token: input.token }, usageController.signal);
                }
                catch (e) {
                    // fetchUsage is documented not to throw, but a transport failure can
                    // still escape; an unreadable allowance must not fail the run.
                    if (input.signal && input.signal.aborted)
                        throw e;
                    usage = { exceeded: false, unlimited: false, error: "could not be reached" };
                }
                finally {
                    clearTimeout(usageTimer);
                    if (input.signal)
                        input.signal.removeEventListener("abort", usageRelay);
                }
            }
            const shortfall = input.moveSubmissions && usage.remaining !== undefined && !usage.unlimited
                ? Math.max(0, submissionsToCopy - usage.remaining)
                : 0;
            const result = {
                projectCount: uids.length,
                alreadyMoved,
                matchedByName,
                destinationChecked: !!index,
                projectsToCopy: toCopy.length,
                submissionsToCopy,
                copySubmissions: !!input.moveSubmissions,
                countsKnown,
                usage,
                shortfall,
                overAllowance: shortfall > 0 || usage.exceeded,
            };
            return result;
        }
        finally {
            clearTimeout(timer);
            if (input.signal)
                input.signal.removeEventListener("abort", relay);
        }
    }
    /**
     * The preflight as the confirm dialog's detail block.
     *
     * Facts are the three numbers that decide whether the copy is safe to start —
     * projects, submissions, allowance left — as label/value rows the dialog can
     * align. Everything conditional is a warning (something the run will refuse to
     * do) or a note (a standing condition), because a warning printed in the same
     * style as a number is not a warning.
     *
     * The wording states what the destination will refuse and leaves the decision
     * to the user: a shortfall is theirs to accept, not ours to enforce.
     */
    function summarize(result) {
        const facts = [];
        const warnings = [];
        const notes = [];
        const usage = result.usage;
        facts.push({ label: t("Projects to copy"), value: number(result.projectsToCopy) });
        // The destination is the authority on what is already there. When it could
        // not be read, the counts are not a fact and the dialog says so.
        if (!result.destinationChecked) {
            warnings.push(t("The destination's project list could not be read, so only projects remembered from earlier runs were checked."));
        }
        // Shown whenever this run copies submissions: "0" is a fact worth having for
        // a form + submissions run, and an unknown count is worth saying out loud.
        if (result.copySubmissions) {
            facts.push({
                label: t("Submissions to copy"),
                value: result.countsKnown ? number(result.submissionsToCopy) : t("Not counted"),
            });
        }
        // Facts first, then the notes that qualify them, in reading order: the
        // skipped projects explain the project count, the allowance detail explains
        // the allowance, and the standing conditions come last.
        // Why a project is skipped matters: a recorded copy is certain, a same-name
        // match is the destination's best answer, and the user is entitled to see
        // which one produced the number above.
        const byMapping = Math.max(0, result.alreadyMoved - result.matchedByName);
        if (byMapping > 0) {
            notes.push(byMapping === 1
                ? t("{count} project was already moved to this destination and will be skipped", { count: number(byMapping) })
                : t("{count} projects were already moved to this destination and will be skipped", { count: number(byMapping) }));
        }
        if (result.matchedByName > 0) {
            notes.push(result.matchedByName === 1
                ? t("{count} project already exists in the destination with the same name and will be skipped", {
                    count: number(result.matchedByName),
                })
                : t("{count} projects already exist in the destination with the same name and will be skipped", {
                    count: number(result.matchedByName),
                }));
        }
        if (usage.unlimited) {
            facts.push({ label: t("Destination allowance"), value: t("Unlimited") });
        }
        else if (usage.remaining !== undefined && usage.limit !== undefined) {
            facts.push({
                label: t("Destination allowance"),
                value: t("{remaining} of {limit} left", {
                    remaining: number(usage.remaining),
                    limit: number(usage.limit),
                }),
            });
            if (usage.usedCurrentPeriod !== undefined) {
                notes.push(t("The destination has used {used} of its {limit} submissions this period.", {
                    used: number(usage.usedCurrentPeriod),
                    limit: number(usage.limit),
                }));
            }
            if (usage.periodEnd && !isNaN(new Date(usage.periodEnd).getTime())) {
                notes.push(t("The destination's allowance resets on {date}.", { date: new Date(usage.periodEnd).toLocaleDateString() }));
            }
        }
        else if (usage.error) {
            warnings.push(t("The destination's allowance could not be read ({reason}).", { reason: usage.error }));
        }
        // The zero case first: "0 projects" next to "1 project was already moved"
        // otherwise reads like a normal run that will do nothing, when in fact there
        // is nothing left for it to do at all.
        if (result.projectCount === 0) {
            warnings.push(t("No projects are in scope for this run."));
        }
        else if (result.projectsToCopy === 0) {
            warnings.push(t("Every project here has already been moved to this account, so this run would copy nothing."));
        }
        if (!result.countsKnown) {
            // An allowance next to an unknown submission count implies a comparison
            // that was never made. Said explicitly, because this is the one case where
            // the dialog cannot tell the user whether the copy fits.
            warnings.push(t("The source's submission counts could not be read, so the copy could not be compared against the allowance."));
        }
        else if (usage.exceeded) {
            warnings.push(t("The destination is already over its submission allowance for this period."));
        }
        else if (result.overAllowance) {
            warnings.push(t("The destination has less allowance than this run needs: {shortfall} submissions would be refused.", {
                shortfall: number(result.shortfall),
            }));
            notes.push(t("Copying will continue and stop each project when the destination refuses submissions."));
        }
        return { facts, warnings, notes };
    }
    window.KoboEnhance.transferPreflight = {
        run,
        summarize,
    };
})();
