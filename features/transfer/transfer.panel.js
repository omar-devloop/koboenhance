"use strict";
/**
 * features/transfer/transfer.panel.ts — the transfer settings panel.
 *
 * Opened by the row-2 gear button of the cross-account transfer action
 * (ui/integration.ts). It is NOT an action of its own: it never enters the
 * item/row executor loop and never runs over projects. Its job is to describe
 * the two accounts a transfer runs between and to collect the one credential
 * that cannot be discovered:
 *
 *   SOURCE      the account you are signed in to. Its API token is READ from
 *               the session (GET /token/) and shown read-only, because it is
 *               what every source read will authenticate with and the user is
 *               entitled to see it. There is nothing to type.
 *   DESTINATION the account that will receive the copies. Its server and API
 *               token must be typed and are then PROVED with a real
 *               authenticated request through the background service worker.
 *
 * Flow:
 *   open -> source token is read automatically and displayed
 *        -> destination server + token -> "Test and use"
 *        -> store.validateDestination()
 *        -> on success: remember the SERVER, repaint row 2, CLOSE the panel
 *        -> on failure: keep the panel open and show a localized reason
 *
 * WHY IT IS CALLED "TRANSFER SETTINGS"
 * It stopped being a destination-only form once the source token moved into it.
 * "Transfer settings" says what it configures (the move) rather than which half
 * of it is being edited, which is what a panel with a read-only section above a
 * form is.
 *
 * NEITHER TOKEN IS EVER SAVED. Both live in their store's memory for the
 * lifetime of this page and nowhere else, so the user is asked again after every
 * reload. Only the destination's server enum is persisted, and it identifies no
 * account.
 */
(function () {
    const KE = window.KoboEnhance;
    const { t } = KE.i18n;
    const { el } = KE.dom;
    const { showToast, buildSpinner } = KE.components;
    const store = KE.transferDestination;
    const sourceAccount = KE.transferSourceAccount;
    /** Listeners notified whenever the destination changes (added/changed/cleared). */
    const listeners = [];
    function notify() {
        const dest = store.getDestination();
        for (const fn of listeners.slice()) {
            try {
                fn(dest);
            }
            catch (e) {
                /* a broken listener must not break the panel */
            }
        }
    }
    /** Maps a store failure CODE to localized text. The store stays i18n-free. */
    function failureText(failure) {
        switch (failure) {
            case "token-empty":
                return t("Enter an API token.");
            case "token-is-source":
                return t("That is the token of the account you are signed in to. Enter the destination account's token instead.");
            case "token-rejected":
                return t("The API token was rejected.");
            case "unreachable":
                return t("The destination server could not be reached.");
            case "no-background":
                return t("The extension background is unavailable. Reload the extension and try again.");
            case "host-blocked":
                return t("The destination server is not allowed.");
            case "cancelled":
                return t("The test was cancelled.");
            default:
                return t("Could not use the destination account");
        }
    }
    /** Why the source token is not in use, as a localized sentence. */
    function sourceFailureText(failure) {
        switch (failure) {
            case "unavailable":
                return t("This Kobo server does not publish an API token, so KoboEnhance will use your signed-in session instead.");
            case "unauthorized":
                return t("Your signed-in session did not return an API token, so KoboEnhance will use the session itself instead.");
            case "empty":
                return t("Your account returned an empty API token, so KoboEnhance will use your signed-in session instead.");
            default:
                return t("Your API token could not be read, so KoboEnhance will use your signed-in session instead.");
        }
    }
    /** "username @ Global", or just the server when no username resolved. */
    function describe(dest) {
        if (!dest)
            return "";
        const info = store.serverInfo(dest.server);
        return dest.username ? `${dest.username} @ ${info.label}` : info.label;
    }
    /** The signed-in account's host, which is what identifies it in this panel. */
    function sourceHost() {
        return KE.apiClient.baseUrl().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    }
    /** A button that copies text, with a brief confirmation in its own label. */
    function copyButton(label, copiedLabel, value) {
        return el("button", {
            type: "button",
            class: "ke-alert-btn is-secondary ke-transfer-mini",
            onclick: (event) => {
                const button = event.currentTarget;
                const text = value();
                if (!text)
                    return;
                const done = () => {
                    const previous = button.textContent;
                    button.textContent = copiedLabel;
                    setTimeout(() => {
                        button.textContent = previous;
                    }, 1200);
                };
                // navigator.clipboard is unavailable on an insecure origin and can be
                // refused outright, so the old execCommand path stays as a fallback
                // rather than a nicety.
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(done).catch(() => {
                        legacyCopy(text);
                        done();
                    });
                }
                else {
                    legacyCopy(text);
                    done();
                }
            },
        }, [el("span", { text: label })]);
    }
    function legacyCopy(text) {
        try {
            const area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "readonly");
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            document.body.removeChild(area);
        }
        catch (e) {
            /* nothing else to try; the field itself is selectable */
        }
    }
    function openPanel() {
        // Kick hydration before the first read so the "current destination" line and
        // the preselected server reflect what is actually stored. The dialog paints
        // immediately either way; if hydration is somehow still pending the user just
        // retypes the server, which is not worth blocking the panel for.
        void store.ready();
        const existing = store.getDestination();
        const overlay = el("div", { class: "ke-alert-overlay" });
        const dialog = el("div", { class: "ke-alert-dialog ke-tpl-dialog ke-transfer-dialog" });
        dialog.appendChild(el("div", { class: "ke-collect-header" }, [
            el("div", { class: "ke-alert-title", text: t("Transfer settings") }),
            el("button", {
                type: "button",
                class: "ke-collect-close",
                title: t("Close"),
                "aria-label": t("Close"),
                onclick: close,
            }, [el("span", { text: "\u2715" })]),
        ]));
        dialog.appendChild(el("p", {
            class: "ke-alert-desc",
            text: t("KoboEnhance copies projects between two Kobo accounts. Your source account is read from this page; the destination is set here."),
        }));
        // -----------------------------------------------------------------
        // Source account — read-only, nothing to type
        // -----------------------------------------------------------------
        dialog.appendChild(el("div", { class: "ke-transfer-section" }, [
            el("div", { class: "ke-transfer-section-title", text: t("Source account (this page)") }),
        ]));
        const sourceValue = el("input", {
            type: "password",
            class: "ke-input ke-transfer-readonly",
            readonly: true,
            spellcheck: "false",
            autocomplete: "off",
            value: "",
            placeholder: t("Reading your API token..."),
        });
        const sourceNote = el("p", { class: "ke-transfer-hint" });
        const hostLine = el("span", { class: "ke-transfer-account", text: sourceHost() });
        const revealBtn = el("button", {
            type: "button",
            class: "ke-alert-btn is-secondary ke-transfer-mini",
            title: t("Show the source account token"),
            onclick: () => {
                const hidden = sourceValue.type === "password";
                sourceValue.type = hidden ? "text" : "password";
                revealBtn.textContent = hidden ? t("Hide") : t("Show");
            },
        }, [el("span", { text: t("Show") })]);
        const copyBtn = copyButton(t("Copy"), t("Copied"), () => sourceValue.value);
        const rereadBtn = el("button", {
            type: "button",
            class: "ke-alert-btn is-secondary ke-transfer-mini",
            title: t("Read your API token again"),
            onclick: () => {
                void loadSource(true);
            },
        }, [el("span", { text: t("Read again") })]);
        dialog.appendChild(el("div", { class: "ke-transfer-field" }, [
            el("label", { class: "ke-transfer-label", text: t("Source account API token:") }),
            sourceValue,
            el("div", { class: "ke-transfer-inline" }, [hostLine, revealBtn, copyBtn, rereadBtn]),
            sourceNote,
        ]));
        /** Reads the token and paints the field, the note and the buttons. */
        function paintSource(state, loading) {
            if (loading) {
                sourceValue.value = "";
                sourceValue.placeholder = t("Reading your API token...");
                sourceNote.textContent = "";
                revealBtn.disabled = true;
                copyBtn.disabled = true;
                rereadBtn.disabled = true;
                return;
            }
            const token = state.token;
            sourceValue.value = token;
            revealBtn.disabled = !token;
            copyBtn.disabled = !token;
            rereadBtn.disabled = false;
            if (token) {
                // Masked by default: this is a live credential, and the panel is often
                // open on a screen someone else can see. Revealing it is one click.
                sourceValue.type = "password";
                revealBtn.textContent = t("Show");
                sourceValue.placeholder = "";
                sourceNote.textContent = t("Read from your signed-in account. Transfers read the source with this token, so a run survives a session that ends mid-way. It is kept in memory only and is never saved.");
            }
            else {
                sourceNote.textContent = sourceFailureText(state.failure);
            }
        }
        /** Names the signed-in account on its host line once the username is known. */
        function paintSourceAccount() {
            KE.auth
                .getUsername()
                .then((username) => {
                const who = (username || "").trim();
                if (!who || closed)
                    return;
                hostLine.textContent = `${who} — ${sourceHost()}`;
            })
                .catch(() => {
                /* the host alone is enough to identify the account */
            });
        }
        // Read once the panel opens, so the token is there before the user needs it
        // — and so the same cached value serves the run they are about to start.
        async function loadSource(force) {
            paintSource(sourceAccount.getState(), true);
            if (force)
                await sourceAccount.fetchToken();
            else
                await sourceAccount.ensureToken();
            if (closed)
                return;
            paintSource(sourceAccount.getState(), false);
        }
        dialog.appendChild(el("div", { class: "ke-transfer-section" }, [
            el("div", { class: "ke-transfer-section-title", text: t("Destination account") }),
        ]));
        // ---- server -------------------------------------------------------
        const serverSelect = el("select", {
            class: "ke-input",
            title: t("Server:"),
        });
        // The host is shown next to each name. "Global" and "EU" on their own do
        // not tell the user which instance their destination account is on, and
        // picking the wrong one sends the copy to an account they never chose. The
        // hostname is the thing they recognise from their own address bar, so it is
        // not translated.
        for (const id of KE.transferDestination.SERVER_KEYS) {
            const info = store.serverInfo(id);
            const host = info.kfUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
            const opt = el("option", {
                value: id,
                text: `${info.label} — ${host}`,
            });
            serverSelect.appendChild(opt);
        }
        // Preselect the server the user chose last time, defaulting to EU.
        serverSelect.value = store.getLastServer();
        dialog.appendChild(el("div", { class: "ke-transfer-field" }, [
            el("label", { class: "ke-transfer-label", text: t("Server:") }),
            serverSelect,
            el("p", {
                class: "ke-transfer-hint",
                text: t("Pick the server where the destination account is. Projects are copied to that account only."),
            }),
        ]));
        // ---- destination token --------------------------------------------
        // Always required, never prefilled, never reused. The store keeps the token
        // in memory only, so there is no saved copy to show and an empty box means
        // "no token" rather than "use the previous one".
        const tokenInput = el("input", {
            type: "password",
            class: "ke-input",
            placeholder: t("Paste the destination account's API token."),
            title: t("API token:"),
            autocomplete: "off",
            spellcheck: "false",
        });
        dialog.appendChild(el("div", { class: "ke-transfer-field" }, [
            el("label", { class: "ke-transfer-label", text: t("API token:") }),
            tokenInput,
        ]));
        dialog.appendChild(el("p", { class: "ke-transfer-hint", text: t("The token is never saved. You will be asked for it again each time you reload this page.") }));
        // ---- current destination -----------------------------------------
        const currentLine = el("p", { class: "ke-transfer-current" });
        if (existing) {
            currentLine.appendChild(el("span", { text: `${t("Destination account")}: ${describe(existing)}` }));
        }
        if (existing)
            dialog.appendChild(currentLine);
        // ---- status + actions --------------------------------------------
        const status = el("div", { class: "ke-transfer-status" });
        dialog.appendChild(status);
        const confirmBtn = el("button", {
            type: "button",
            class: "ke-alert-btn is-primary",
            onclick: confirm,
        }, [el("span", { text: t("Test and use") })]);
        const cancelBtn = el("button", {
            type: "button",
            class: "ke-alert-btn is-secondary",
            onclick: close,
        }, [el("span", { text: t("Cancel") })]);
        dialog.appendChild(el("div", { class: "ke-tpl-dialog-actions" }, [cancelBtn, confirmBtn]));
        overlay.appendChild(dialog);
        // ---- lifecycle ----------------------------------------------------
        let closed = false;
        let busy = false;
        const controller = new AbortController();
        function finishClose() {
            if (closed)
                return;
            closed = true;
            // Aborting a validation in flight also cancels the service worker request.
            if (busy)
                controller.abort();
            document.removeEventListener("keydown", onEsc);
            overlay.remove();
        }
        function onEsc(e) {
            if (e.key === "Escape")
                close();
        }
        function close() {
            finishClose();
        }
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay)
                close();
        });
        function setBusy(on) {
            busy = on;
            confirmBtn.disabled = on;
            serverSelect.disabled = on;
            tokenInput.disabled = on;
            status.className = "ke-transfer-status";
            if (on) {
                status.classList.add("is-busy");
                status.textContent = "";
                status.appendChild(buildSpinner(14));
                status.appendChild(el("span", { text: t("Testing the destination account...") }));
            }
        }
        function setError(message) {
            status.className = "ke-transfer-status is-error";
            status.textContent = message;
        }
        async function confirm() {
            if (busy || closed)
                return;
            const server = serverSelect.value === "eu" ? "eu" : "global";
            const token = tokenInput.value.trim();
            setBusy(true);
            try {
                // The token must be typed every time. The previous one is not reused, so
                // a revoked or rotated token can never be applied silently.
                const res = await store.validateDestination(server, token, controller.signal);
                if (closed)
                    return;
                if (res.ok) {
                    setBusy(false);
                    status.className = "ke-transfer-status is-ok";
                    status.textContent = t("Destination account ready");
                    notify();
                    showToast({
                        type: "success",
                        title: t("Destination account ready"),
                        description: describe(res.destination || null),
                    });
                    close();
                    return;
                }
                setBusy(false);
                setError(failureText(res.failure));
                tokenInput.focus();
            }
            catch (e) {
                if (closed)
                    return;
                setBusy(false);
                setError(failureText("unknown"));
            }
        }
        // ---- mount ---------------------------------------------------------
        document.addEventListener("keydown", onEsc);
        document.body.appendChild(overlay);
        // Both reads are kicked off here, after the dialog is on the page and the
        // lifecycle flags exist: the source token (which the run reuses) and the
        // signed-in username for its label.
        paintSourceAccount();
        void loadSource(false);
        tokenInput.focus();
    }
    window.KoboEnhance.transfer = {
        openPanel,
        subscribe(onChange) {
            listeners.push(onChange);
            return () => {
                const i = listeners.indexOf(onChange);
                if (i !== -1)
                    listeners.splice(i, 1);
            };
        },
        setValidatedDestination(dest) {
            store.setDestination(dest);
            notify();
        },
    };
})();
