"use strict";
/**
 * core/transfer/usage.api.ts — how much a Kobo account has, and has left.
 *
 * WHY THIS EXISTS
 * Kobo enforces a submission allowance per account (per organization, in fact),
 * and a destination that is at its cap answers every submission POST with HTTP
 * 402. That failure is silent in the worst way: the form is copied, then every
 * submission is refused, and a 50-project run generates thousands of pointless
 * requests before anyone notices — which is exactly what happened before the
 * walk learned to give up after five consecutive rejections. Finding out
 * BEFOREHAND is cheap and turns a ruined run into a warning the user can act on.
 *
 * THE ENDPOINTS
 *   GET /api/v2/service_usage/   an account's allowance for the current
 *                                billing period, plus what it has already used.
 *   GET /api/v2/assets/          the project list; each survey row carries
 *                                deployment__submission_count.
 *
 * Both were confirmed against the live OpenAPI schema on 2026-10-19
 * (eu.kobotoolbox.org/api/v2/schema/). service_usage is marked deprecated in
 * Kobo's own schema in favour of the organization-level endpoint, which cannot
 * be used here because the destination account's organization is not knowable
 * from the user token. It therefore stays best-effort: an endpoint that goes
 * away produces a warning in the confirm dialog, never a blocked run.
 *
 * THE BALANCE SHAPES ARE NOT GUESSED
 * kpi/utils/usage_calculator.py: `calculate_usage_balance` returns
 *   effective_limit  the cap
 *   balance_value    limit - usage, i.e. what is LEFT
 *   balance_percent  (usage / limit) * 100, i.e. how much is USED
 *   exceeded         limit - usage < 0
 * and returns null for an uncapped account, which is why TransferUsage carries
 * an explicit `unlimited` instead of treating a missing limit as zero.
 *
 * ONE PASS, NOT ONE REQUEST PER PROJECT
 * Counting the submissions about to be uploaded walks the paginated
 * /api/v2/assets/ list once and reads `deployment__submission_count` — the same
 * number the project list shows in its Submissions column. Fetching /data.xml
 * per project instead would be the most literal answer but costs one round trip
 * per project before a run even starts, which is a visible stall on a large
 * account for a number the run is about to discover anyway.
 *
 * WHY NOT /api/v2/asset_usage/ (tried, wrong)
 * That endpoint does report per-asset usage, but only for assets the requesting
 * user owns: a project shared from an organization — the normal shape of a Kobo
 * account — is absent from it. Summing "the rows that matched" then produced
 * 0 submissions for projects full of submissions, which is worse than no number
 * at all. The asset list is the same set of rows the UI draws, so a project the
 * user can select is a project that gets counted.
 */
(function () {
    const KE = window.KoboEnhance;
    const { auth, transferSourceAccount } = KE;
    const USAGE_PATH = "/api/v2/service_usage/";
    const ASSETS_PATH = "/api/v2/assets/";
    const ASSETS_PAGE = 100;
    /** Hard stop on the asset walk, so a misbehaving page cannot spin. */
    const MAX_ASSET_PAGES = 200;
    /** 0 = unlimited, which is also how Kobo encodes "no cap". */
    const UNLIMITED = 0;
    function asRecord(value) {
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    function asNumber(value) {
        if (typeof value === "number" && isFinite(value))
            return value;
        if (typeof value === "string") {
            const parsed = Number(value.trim());
            if (isFinite(parsed))
                return parsed;
        }
        return undefined;
    }
    function asText(value) {
        return typeof value === "string" ? value : "";
    }
    /**
     * One account's submission balance out of the `balances.submission` object.
     *
     * Only the submission balance is read. Storage and NLP are different meters
     * with different units, and folding them in would produce a number that means
     * nothing to the user.
     *
     * Three outcomes, and the middle one matters:
     *   - an object  — capped; limit and what is LEFT are read off it
     *   - null       — Kobo's way of saying the account is UNCAPPED
     *   - absent     — the account did not report a submission balance at all,
     *                  which is not the same as being uncapped and must not be
     *                  reported as one
     */
    function readSubmissionBalance(balances) {
        if (!Object.prototype.hasOwnProperty.call(balances, "submission")) {
            return { state: "absent", exceeded: false };
        }
        const balance = balances["submission"];
        if (balance === null || balance === undefined) {
            // No cap on this account: Kobo sends null rather than a zeroed object.
            return { state: "uncapped", exceeded: false };
        }
        const record = asRecord(balance);
        const limit = asNumber(record["effective_limit"]);
        const remaining = asNumber(record["balance_value"]);
        const exceeded = record["exceeded"] === true;
        if (limit === undefined || limit === UNLIMITED)
            return { state: "uncapped", exceeded };
        return { state: "capped", limit, remaining: remaining === undefined ? Math.max(0, limit) : remaining, exceeded };
    }
    /**
     * A service_usage body as a TransferUsage, or null when it is not one.
     *
     * The endpoint has shipped as both a single object and an array of one, and
     * the schema and the view disagree about which; both are accepted rather than
     * betting the preflight on one of them.
     */
    function readUsage(data) {
        const body = Array.isArray(data) ? data[0] : data;
        if (!body || typeof body !== "object")
            return null;
        const record = asRecord(body);
        const counts = asRecord(record["total_submission_count"]);
        const balance = readSubmissionBalance(asRecord(record["balances"]));
        const usage = {
            usedCurrentPeriod: asNumber(counts["current_period"]),
            usedAllTime: asNumber(counts["all_time"]),
            exceeded: balance.exceeded === true,
            unlimited: balance.state === "uncapped",
        };
        if (balance.state === "absent") {
            usage.error = "the account reported no submission balance";
        }
        if (balance.limit !== undefined)
            usage.limit = balance.limit;
        if (balance.remaining !== undefined)
            usage.remaining = balance.remaining;
        const start = asText(record["current_period_start"]);
        const end = asText(record["current_period_end"]);
        if (start)
            usage.periodStart = start;
        if (end)
            usage.periodEnd = end;
        return usage;
    }
    /** Wraps a read failure into the shape the dialog renders. */
    function failed(reason) {
        return { exceeded: false, unlimited: false, error: reason };
    }
    /** Short, non-sensitive reason text for an unreadable allowance. */
    function reasonFrom(status) {
        if (status === 401 || status === 403)
            return "not permitted";
        if (status === 404 || status === 410)
            return "not available on this server";
        return status === undefined ? "no response" : `HTTP ${status}`;
    }
    /** The DESTINATION account's allowance, read through the service worker
     *  because it is a different origin from the page. */
    async function fetchDestinationUsage(ctx, signal) {
        let res;
        try {
            res = await KE.transferTransport.getJson(ctx.token, `${ctx.destination.kfUrl}${USAGE_PATH}`, undefined, signal);
        }
        catch (e) {
            const err = (e || {});
            return failed(err.message === "no-background" ? "the extension background is unavailable" : "could not be reached");
        }
        if (!res.ok)
            return failed(reasonFrom(res.status));
        const usage = readUsage(res.data);
        if (!usage)
            return failed("the account returned an unreadable usage report");
        return usage;
    }
    /** The SOURCE (signed-in) account's allowance, same-origin. */
    async function fetchSourceUsage(signal) {
        try {
            const res = await transferSourceAccount.fetchSource(`${auth.getBaseUrl()}${USAGE_PATH}`, signal);
            if (!res.ok)
                return failed(reasonFrom(res.status));
            const usage = readUsage(await res.json());
            if (!usage)
                return failed("the account returned an unreadable usage report");
            return usage;
        }
        catch (e) {
            if ((e || {}).name === "AbortError")
                throw e;
            return failed("could not be reached");
        }
    }
    /** The project uid inside an asset URL (the assets list also sends one, but
     *  an older asset_usage shape carried only this URL). */
    function uidFromAssetUrl(value) {
        const raw = asText(value);
        if (!raw)
            return "";
        const match = /\/assets\/([^/?#]+)/.exec(raw);
        if (match)
            return match[1];
        return /^[A-Za-z0-9]{8,}$/.test(raw) ? raw : "";
    }
    /** The project uid on an assets-list row: its `uid`, or the tail of its URL. */
    function uidFromRow(row) {
        return asText(row["uid"]) || uidFromAssetUrl(row["url"] || row["asset"]);
    }
    /** A survey's label is `name` in the list; older shapes carry `settings.name`. */
    function projectName(row) {
        return asText(row["name"]) || asText(asRecord(row["settings"])["name"]);
    }
    /**
     * Submission counts for the given SOURCE projects, in one paginated pass.
     *
     * Reads `deployment__submission_count` — the number the project list shows —
     * so the count is defined exactly as the user sees it, deletions included:
     * what a copy uploads is what the project holds now, not an all-time total.
     *
     * A project the pass never sees is counted as zero (there is nothing to copy
     * from an asset that is not in the list), but a pass that matches NONE of the
     * wanted projects throws: that is a malfunction — wrong account, changed API —
     * and "0 submissions" would be a lie the dialog cannot tell apart from three
     * empty projects.
     *
     * `onProgress` reports pages read, which is what the preflight's "Checking..."
     * line shows while an account with hundreds of projects is walked.
     */
    async function fetchSourceAssetCounts(uids, signal, onProgress) {
        const wanted = {};
        let remaining = 0;
        for (const uid of uids) {
            if (uid && !wanted[uid]) {
                wanted[uid] = true;
                remaining++;
            }
        }
        const counts = {};
        if (remaining === 0)
            return counts;
        let start = 0;
        let total = 0;
        let pages = 0;
        for (;;) {
            if (signal && signal.aborted)
                throw new DOMException("Aborted", "AbortError");
            pages++;
            const res = await transferSourceAccount.fetchSource(`${auth.getBaseUrl()}${ASSETS_PATH}?limit=${ASSETS_PAGE}&start=${start}`, signal);
            if (!res.ok)
                throw new Error(reasonFrom(res.status));
            const body = asRecord(await res.json());
            const results = Array.isArray(body["results"]) ? body["results"] : [];
            const count = asNumber(body["count"]);
            if (count !== undefined)
                total = count;
            for (const row of results) {
                const uid = uidFromRow(row);
                if (!uid || !wanted[uid] || counts[uid])
                    continue;
                counts[uid] = {
                    name: projectName(row),
                    allTime: asNumber(row["deployment__submission_count"]) || 0,
                };
                remaining--;
            }
            if (onProgress)
                onProgress(start + results.length, total);
            start += results.length;
            // Stop as soon as every project in the run has been seen, and otherwise on
            // an empty page, the declared count, or the page cap (which only matters
            // for an account larger than any realistic move, and stops a payload that
            // keeps pointing at itself from spinning).
            if (remaining === 0 || results.length === 0 || (total > 0 && start >= total) || pages >= MAX_ASSET_PAGES)
                break;
        }
        if (Object.keys(counts).length === 0) {
            throw new Error("the project list did not contain the projects in this run");
        }
        return counts;
    }
    window.KoboEnhance.transferUsage = {
        readUsage,
        fetchDestinationUsage,
        fetchSourceUsage,
        fetchSourceAssetCounts,
    };
})();
