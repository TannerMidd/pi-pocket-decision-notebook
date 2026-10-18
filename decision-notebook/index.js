/** @typedef {import('./state.ts').Notebook} Notebook */
/** @typedef {import('./state.ts').Decision} Decision */
/** @typedef {import('./state.ts').DecisionContent} Content */
/** @typedef {{ id: number, title: string, cwd: string }} Source */
/** @typedef {{ protocol: number, version: string, source: Source, book: Notebook, markdown: string }} View */
/** @typedef {{ source: Source, id: string, fresh: boolean, revision: number, original: string, content: Content, replaces: string }} Draft */

export const pocketApi = 1;

/** @param {Decision} decision */
const stateOf = (decision) =>
    decision.withdrawn
        ? "withdrawn"
        : decision.supersededBy
          ? "superseded"
          : decision.accepted
            ? "accepted"
            : "proposal";
/** @param {Source} a @param {Source} b */
const sameSource = (a, b) => a.id === b.id && a.title === b.title && a.cwd === b.cwd;
const blank = () => ({
    title: "",
    chosenOption: "",
    rationale: "",
    alternatives: [],
    revisitDate: "",
});
/** @param {unknown} failure */
const message = (failure) =>
    failure instanceof Error ? failure.message : "The notebook could not load.";

function newProposalId() {
    const bytes = new Uint8Array(16);

    try {
        // Unlike randomUUID, getRandomValues is available on plain-HTTP LAN contexts too.
        globalThis.crypto.getRandomValues(bytes);
    } catch {
        // The owned sheet boundary displays this error; never substitute a weak random ID.
        throw new Error(
            "Cannot create a proposal: secure random ID generation failed. No proposal was saved.",
        );
    }

    return `d-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** @param {import('../_pocket.d.ts').Pocket} pocket */
export default function setup(pocket) {
    const { html, useEffect, useRef, useState } = pocket;
    let disposed = false;
    /** @type {Set<() => void>} */
    const listeners = new Set();
    /** @type {Set<AbortController>} */
    const requests = new Set();
    const version = pocket.pocketVersion?.match(/^(\d+)\.(\d+)\./);
    const supported = !!version && (Number(version[1]) > 0 || Number(version[2]) >= 16);

    pocket.style("style.css");

    let pendingStop = /** @type {AbortController | null} */ (null);
    let openingStop = /** @type {AbortController | null} */ (null);
    let openingSource = /** @type {number | null} */ (null);

    /** @param {number} source @param {AbortController} controller */
    async function readCurrent(source, controller) {
        if (!supported) {
            throw new Error("Decision notebook 0.2.0 needs Pi Pocket 0.16.0 or later.");
        }

        if (disposed || pocket.conversationId() !== source) {
            throw new Error("The conversation changed. Choose review again in the current source.");
        }

        const result = /** @type {View} */ (
            await pocket.api(`notebook/${source}`, undefined, {
                signal: controller.signal,
            })
        );

        if (disposed || controller.signal.aborted || pocket.conversationId() !== source) {
            throw new Error("The conversation changed while loading. No review was opened.");
        }

        if (result.protocol !== 2 || result.source?.id !== source) {
            throw new Error(
                "The notebook server is updating. Wait a moment, then try review again.",
            );
        }

        return result;
    }

    /** @param {number | null} count @param {string} hint */
    function pendingHint(count, hint) {
        if (disposed) {
            return;
        }

        notebookRail.update({ badge: count });
        reviewMenu.update({ hint });
        reviewLauncher.update({ detail: `${hint} · newest pending proposal in this conversation` });
    }

    async function refreshPending() {
        pendingStop?.abort();
        const controller = new AbortController();
        const source = pocket.conversationId();

        pendingStop = controller;
        requests.add(controller);

        try {
            if (!source) {
                pendingHint(null, "Open a conversation");
                return;
            }

            const view = await readCurrent(source, controller);

            if (
                !disposed &&
                !controller.signal.aborted &&
                document.visibilityState === "visible" &&
                pocket.conversationId() === source
            ) {
                const count = view.book.decisions.filter(
                    (entry) => stateOf(entry) === "proposal",
                ).length;

                pendingHint(count, `${count} pending`);
            }
        } catch {
            if (!disposed && !controller.signal.aborted && pocket.conversationId() === source) {
                pendingHint(null, supported ? "Refresh needed" : "Update Pocket");
            }
        } finally {
            requests.delete(controller);
        }
    }

    async function reviewPending() {
        if (disposed || openingStop) {
            return;
        }

        const source = pocket.conversationId();

        if (!source) {
            pocket.notify(
                "info",
                "Open a conversation first. Each conversation has its own notebook.",
            );
            return;
        }

        const controller = new AbortController();

        openingStop = controller;
        openingSource = source;
        requests.add(controller);

        try {
            // Never approve or open from a badge cache: this click always reads the selected source fresh.
            const view = await readCurrent(source, controller);
            const proposal = view.book.decisions.findLast((entry) => stateOf(entry) === "proposal");

            if (
                disposed ||
                controller.signal.aborted ||
                document.visibilityState !== "visible" ||
                pocket.conversationId() !== source
            ) {
                return;
            }

            if (!proposal) {
                pocket.notify(
                    "info",
                    "No pending proposals in this conversation. Open Decision notebook for its history.",
                );
                return;
            }

            pocket.openSheet("review", { initial: view, id: proposal.id });
        } catch (failure) {
            if (!disposed && !controller.signal.aborted) {
                pocket.notify("warning", message(failure));
            }
        } finally {
            requests.delete(controller);

            if (openingStop === controller) {
                openingStop = null;
                openingSource = null;
            }
        }
    }

    function reconcile() {
        if (!disposed && document.visibilityState === "visible") {
            void refreshPending();

            for (const refresh of listeners) {
                refresh();
            }
        }
    }

    // Public module events are hints, not authority. No conversation/reconnect event exists.
    const off = pocket.on("changed", (/** @type {{ conversation: number }} */ event) => {
        if (event.conversation === pocket.conversationId()) {
            reconcile();
        }
    });
    const offOpen = pocket.on("open", (/** @type {{ conversation: number }} */ event) => {
        if (
            !disposed &&
            document.visibilityState === "visible" &&
            event.conversation === pocket.conversationId()
        ) {
            pocket.openPage("notebook");
        }
    });
    let observed = pocket.conversationId();
    let lastRead = Date.now();
    const timer = setInterval(() => {
        if (disposed || document.visibilityState !== "visible") {
            return;
        }

        const current = pocket.conversationId();

        // Watch the public source ID even in chat. Missed events recover with a visible 30s read.
        if (current !== observed || Date.now() - lastRead >= 30_000) {
            if (current !== observed) {
                if (openingSource !== current) {
                    openingStop?.abort();
                    openingStop = null;
                    openingSource = null;
                }

                pendingHint(null, "Checking…");
            }

            observed = current;
            lastRead = Date.now();
            reconcile();
        }
    }, 1000);

    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    pocket.onDispose(() => {
        disposed = true;
        clearInterval(timer);
        off();
        offOpen();
        listeners.clear();
        requests.forEach((request) => request.abort());
        window.removeEventListener("focus", reconcile);
        window.removeEventListener("online", reconcile);
        document.removeEventListener("visibilitychange", reconcile);
    });

    /** @param {number | undefined} fixed */
    function useNotebook(fixed) {
        const [view, setView] = useState(/** @type {View | null} */ (null));
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState("");
        const serial = useRef(0);
        const stop = useRef(/** @type {AbortController | null} */ (null));
        const alive = useRef(true);

        async function refresh() {
            stop.current?.abort();
            const controller = new AbortController();
            const generation = ++serial.current;
            const conversation = pocket.conversationId();

            stop.current = controller;
            requests.add(controller);
            setLoading(true);
            setError("");

            try {
                if (!supported) {
                    throw new Error("Decision notebook 0.2.0 needs Pi Pocket 0.16.0 or later.");
                }

                if (!conversation) {
                    setView(null);
                    return;
                }

                if (fixed !== undefined && conversation !== fixed) {
                    throw new Error(
                        "The conversation changed. Return to the source to review this decision. Your edits are kept.",
                    );
                }

                const result = await pocket.api(`notebook/${conversation}`, undefined, {
                    signal: controller.signal,
                });

                if (
                    disposed ||
                    !alive.current ||
                    controller.signal.aborted ||
                    generation !== serial.current
                ) {
                    return;
                }

                if (pocket.conversationId() !== conversation) {
                    throw new Error(
                        "The conversation changed while loading. Refresh to review the current source.",
                    );
                }

                const next = /** @type {View} */ (result);

                if (next.protocol !== 2 || next.source?.id !== conversation) {
                    throw new Error(
                        "The notebook server is updating. Wait a moment, then refresh. No action was sent.",
                    );
                }

                setView(next);
            } catch (failure) {
                if (
                    !controller.signal.aborted &&
                    alive.current &&
                    generation === serial.current &&
                    !disposed
                ) {
                    setView(null);
                    setError(message(failure));
                }
            } finally {
                requests.delete(controller);

                if (
                    !controller.signal.aborted &&
                    alive.current &&
                    generation === serial.current &&
                    !disposed
                ) {
                    setLoading(false);
                }
            }
        }

        useEffect(() => {
            listeners.add(refresh);
            void refresh();

            return () => {
                alive.current = false;
                listeners.delete(refresh);
                stop.current?.abort();
            };
        }, []);

        return {
            view,
            loading,
            error,
            refresh,
            adopt: (/** @type {View} */ next) => {
                stop.current?.abort();
                serial.current++;
                setView(next);
                setLoading(false);
                setError("");
            },
        };
    }

    /** @param {{ source: Source }} props */
    function SourceLine({ source }) {
        return html`<div class="dn-source">
            <strong>${source.title || "Untitled conversation"}</strong
            ><span>Conversation ${source.id} · this conversation only</span
            ><span class="mono">${source.cwd}</span>
        </div>`;
    }

    /** @param {{ content: Content }} props */
    function Contents({ content }) {
        return html`<div class="dn-contents">
            <h3>${content.title}</h3>
            <h4>Chosen option</h4>
            <p>${content.chosenOption}</p>
            <h4>Rationale</h4>
            <p>${content.rationale}</p>
            <h4>Alternatives</h4>
            ${
                content.alternatives.length
                    ? html`<ul>
                          ${content.alternatives.map((alternative) => html`<li>${alternative}</li>`)}
                      </ul>`
                    : html`<p class="muted">None recorded.</p>`
            }
            <p class="small muted">Revisit: ${content.revisitDate || "Not set"} (UTC)</p>
        </div>`;
    }

    /** @param {Draft} draft */
    function draftKey(draft) {
        return `x.decision-notebook.draft.v2:${pocket.me()?.id}:${draft.source.id}:${draft.fresh ? "new" : draft.id}`;
    }

    /** @param {Draft} initial */
    function recover(initial) {
        try {
            const raw = sessionStorage.getItem(draftKey(initial));

            if (raw && raw.length <= 60_000) {
                const draft = /** @type {Draft} */ (JSON.parse(raw));
                const content = draft.content;

                if (
                    draft.source?.id === initial.source.id &&
                    (initial.fresh ? draft.fresh : draft.id === initial.id) &&
                    /^d-[a-f0-9]{32}$/.test(draft.id) &&
                    Number.isSafeInteger(draft.revision) &&
                    typeof draft.original === "string" &&
                    typeof draft.replaces === "string" &&
                    typeof content?.title === "string" &&
                    typeof content.chosenOption === "string" &&
                    typeof content.rationale === "string" &&
                    typeof content.revisitDate === "string" &&
                    Array.isArray(content.alternatives) &&
                    content.alternatives.every((value) => typeof value === "string")
                ) {
                    return draft;
                }
            }
        } catch {
            // Storage can be blocked. Keep the editor usable and report persistence failure on edit.
        }

        return initial;
    }

    /** @param {{ initial: View, id?: string, fresh?: boolean, close: () => void }} props */
    function Review({ initial, id, fresh = false, close }) {
        const [draft, setDraft] = useState(() => {
            const content =
                initial.book.decisions.find((decision) => decision.id === id)?.content ?? blank();

            const restored = recover({
                source: initial.source,
                id: id ?? "",
                fresh,
                revision: initial.book.revision,
                original: JSON.stringify(content),
                content: structuredClone(content),
                replaces: "",
            });

            // A recovered draft already owns its stable ID, including after a lost create response.
            return restored.id ? restored : { ...restored, id: newProposalId() };
        });
        const [baseline, setBaseline] = useState(() => ({
            ...initial,
            source: draft.source,
            book: { ...initial.book, revision: draft.revision },
        }));
        const latest = useNotebook(initial.source.id);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const [notice, setNotice] = useState("");
        const [storageError, setStorageError] = useState("");
        const [confirmWithdraw, setConfirmWithdraw] = useState(false);
        const actionStop = useRef(/** @type {AbortController | null} */ (null));
        const alive = useRef(true);
        const decision = baseline.book.decisions.find((entry) => entry.id === draft.id);
        const current = latest.view?.book.decisions.find((entry) => entry.id === draft.id);
        const pending = draft.fresh || (decision && stateOf(decision) === "proposal");
        const dirty = draft.fresh || JSON.stringify(draft.content) !== draft.original;
        const stale =
            !latest.view ||
            latest.view.book.revision !== baseline.book.revision ||
            !sameSource(latest.view.source, baseline.source);
        const disabled = busy || latest.loading || stale || !supported;
        const accepted = baseline.book.decisions.filter((entry) => stateOf(entry) === "accepted");

        useEffect(
            () => () => {
                alive.current = false;
                actionStop.current?.abort();
            },
            [],
        );

        /** @param {Draft} next */
        function keep(next) {
            setDraft(next);
            setError("");
            setNotice("");

            try {
                sessionStorage.setItem(draftKey(next), JSON.stringify(next));

                if (draftKey(next) !== draftKey(draft)) {
                    sessionStorage.removeItem(draftKey(draft));
                }

                setStorageError("");
            } catch {
                setStorageError(
                    "This browser cannot keep a draft across reloads. Keep this sheet open or copy your edits before leaving.",
                );
            }
        }

        /** @param {keyof Content} field @param {string | string[]} value */
        function edit(field, value) {
            setConfirmWithdraw(false);
            keep({ ...draft, content: { ...draft.content, [field]: value } });
        }

        function reviewLatest() {
            const next = latest.view;

            if (!next || pocket.conversationId() !== initial.source.id) {
                return;
            }

            const proposal = next.book.decisions.find((entry) => entry.id === draft.id);
            const validTarget = next.book.decisions.some(
                (entry) => entry.id === draft.replaces && stateOf(entry) === "accepted",
            );

            setBaseline(next);
            keep({
                ...draft,
                source: next.source,
                // A create may have committed before its response was lost. Reconcile the
                // stable ID as an existing proposal, never issue a second create for it.
                fresh: draft.fresh && !proposal,
                revision: next.book.revision,
                original: JSON.stringify(proposal?.content ?? blank()),
                content: !dirty && proposal ? structuredClone(proposal.content) : draft.content,
                replaces: validTarget ? draft.replaces : "",
            });
            setConfirmWithdraw(false);
            setNotice(
                draft.replaces && !validTarget
                    ? "The replacement target changed. Select a currently accepted decision again."
                    : "Latest version loaded. Your unsaved edits are kept; compare them with the saved proposal before saving.",
            );
        }

        /** @param {'create' | 'edit' | 'accept' | 'withdraw'} action */
        async function act(action) {
            if (disabled || disposed || !alive.current) {
                return;
            }

            if (pocket.conversationId() !== baseline.source.id) {
                setError(
                    "The conversation changed. Return to the displayed source. Your edits are kept.",
                );
                return;
            }

            if ((action === "accept" || action === "withdraw") && dirty) {
                setError(
                    "Save or discard your edits before accepting or withdrawing. Saving never accepts a decision.",
                );
                return;
            }

            const controller = new AbortController();

            actionStop.current = controller;
            requests.add(controller);
            setBusy(true);
            setError("");

            try {
                const result = /** @type {View} */ (
                    await pocket.api(
                        `notebook/${baseline.source.id}`,
                        {
                            source: baseline.source,
                            revision: baseline.book.revision,
                            id: draft.id,
                            action,
                            ...(action === "create" || action === "edit"
                                ? {
                                      content: {
                                          ...draft.content,
                                          alternatives: draft.content.alternatives.filter((value) =>
                                              value.trim(),
                                          ),
                                      },
                                  }
                                : {}),
                            ...(action === "accept" && draft.replaces
                                ? { replaces: draft.replaces }
                                : {}),
                        },
                        { signal: controller.signal },
                    )
                );

                if (
                    disposed ||
                    !alive.current ||
                    controller.signal.aborted ||
                    pocket.conversationId() !== baseline.source.id
                ) {
                    return;
                }

                if (result.protocol !== 2 || result.source?.id !== baseline.source.id) {
                    throw new Error(
                        "The notebook server changed. Refresh before taking another action.",
                    );
                }

                const saved = result.book.decisions.find((entry) => entry.id === draft.id);

                if (!saved) {
                    throw new Error(
                        "The proposal could not be read after saving. Refresh before trying again.",
                    );
                }

                try {
                    sessionStorage.removeItem(draftKey(draft));
                } catch {
                    // A blocked store could not have saved a draft either.
                }

                setDraft({
                    ...draft,
                    fresh: false,
                    revision: result.book.revision,
                    original: JSON.stringify(saved.content),
                    content: structuredClone(saved.content),
                    replaces: "",
                });
                setBaseline(result);
                latest.adopt(result);
                setConfirmWithdraw(false);
                setNotice(
                    action === "accept"
                        ? "Decision accepted. Its contents are now immutable."
                        : action === "withdraw"
                          ? "Proposal withdrawn. Its ID and text are retained."
                          : "Proposal saved. Review it, then accept only if you agree.",
                );
            } catch (failure) {
                if (!controller.signal.aborted && alive.current && !disposed) {
                    setError(message(failure));
                    void latest.refresh();
                }
            } finally {
                requests.delete(controller);

                if (alive.current && !disposed) {
                    setBusy(false);
                }
            }
        }

        function discard() {
            try {
                sessionStorage.removeItem(draftKey(draft));
            } catch {
                // Keep discard usable without storage.
            }

            if (draft.fresh) {
                close();
            } else if (decision) {
                setDraft({
                    ...draft,
                    content: structuredClone(decision.content),
                    original: JSON.stringify(decision.content),
                });
                setNotice("Local edits discarded.");
            }
        }

        return html`<div class="dn-shell">
            <div class="dn-review">
                <${SourceLine} source=${baseline.source} />
                <div class="dn-meta">
                    <span class="dn-badge"
                        >${draft.fresh ? "New proposal" : decision ? stateOf(decision) : "Unavailable"}</span
                    ><span>Revision ${baseline.book.revision}</span>
                </div>
                ${latest.error && html`<div class="error-box" role="alert">${latest.error}</div>`}
                ${
                    stale &&
                    html`<div class="dn-warning" role="status">
                        ${latest.view ? "The notebook or source changed. Review the latest version before any action." : "Checking the current notebook…"}
                        <div class="dn-actions">
                            <button
                                class="button"
                                disabled=${busy || latest.loading}
                                onClick=${() => void latest.refresh()}
                            >
                                Refresh</button
                            >${latest.view && html`<button class="button" disabled=${busy || latest.loading} onClick=${reviewLatest}>Review latest · keep edits</button>`}
                        </div>
                    </div>`
                }
                ${error && html`<div class="error-box" role="alert">${error}</div>`}
                ${storageError && html`<div class="dn-warning" role="status">${storageError}</div>`}
                ${notice && html`<p class="dn-notice" role="status">${notice}</p>`}
                ${!pending && dirty && html`<p class="dn-warning">This proposal is no longer pending. Your local edits are kept below, but cannot change accepted or withdrawn content.</p>`}
                ${
                    pending || dirty
                        ? html`<form
                              class="dn-form"
                              onSubmit=${(/** @type {Event} */ event) => {
                                  event.preventDefault();
                                  void act(draft.fresh ? "create" : "edit");
                              }}
                          >
                              <label
                                  >Title<input
                                      required
                                      maxlength="160"
                                      value=${draft.content.title}
                                      disabled=${busy || !pending}
                                      onInput=${(/** @type {Event} */ event) => edit("title", /** @type {HTMLInputElement} */ (event.currentTarget).value)}
                              /></label>
                              <label
                                  >Chosen option<textarea
                                      required
                                      maxlength="1000"
                                      rows="3"
                                      value=${draft.content.chosenOption}
                                      disabled=${busy || !pending}
                                      onInput=${(/** @type {Event} */ event) => edit("chosenOption", /** @type {HTMLTextAreaElement} */ (event.currentTarget).value)}
                                  ></textarea>
                              </label>
                              <label
                                  >Rationale<textarea
                                      required
                                      maxlength="2400"
                                      rows="4"
                                      value=${draft.content.rationale}
                                      disabled=${busy || !pending}
                                      onInput=${(/** @type {Event} */ event) => edit("rationale", /** @type {HTMLTextAreaElement} */ (event.currentTarget).value)}
                                  ></textarea>
                              </label>
                              <label
                                  >Alternatives
                                  <span class="muted small">Up to four, one per line</span
                                  ><textarea
                                      rows="3"
                                      maxlength="2003"
                                      value=${draft.content.alternatives.join("\n")}
                                      disabled=${busy || !pending}
                                      onInput=${(/** @type {Event} */ event) => edit("alternatives", /** @type {HTMLTextAreaElement} */ (event.currentTarget).value.split("\n"))}
                                  ></textarea>
                              </label>
                              <label
                                  >Revisit date <span class="muted small">Optional · UTC</span
                                  ><input
                                      type="date"
                                      value=${draft.content.revisitDate}
                                      disabled=${busy || !pending}
                                      onInput=${(/** @type {Event} */ event) => edit("revisitDate", /** @type {HTMLInputElement} */ (event.currentTarget).value)}
                              /></label>
                              ${
                                  dirty &&
                                  current &&
                                  html`<details class="dn-compare" open=${stale}>
                                      <summary>Compare with saved proposal</summary>
                                      <${Contents} content=${current.content} />
                                  </details>`
                              }
                              <div class="dn-actions">
                                  <button
                                      class="button"
                                      type="submit"
                                      disabled=${disabled || !pending || !dirty}
                                  >
                                      ${draft.fresh ? "Save proposal" : "Save edits"}</button
                                  >${dirty && html`<button class="button" type="button" disabled=${busy} onClick=${discard}>Discard local edits</button>`}
                              </div>
                              <p class="small muted">
                                  ${`${dirty ? "Unsaved edits · kept in this tab when storage is available." : "No unsaved edits."} Saving does not accept a decision.`}
                              </p>
                          </form>`
                        : decision && html`<${Contents} content=${decision.content} />`
                }
                ${
                    pending &&
                    !draft.fresh &&
                    html`<section class="dn-approval">
                        <h3>Owner approval</h3>
                        ${
                            accepted.length > 0 &&
                            html`<label
                                >Replace an accepted decision
                                <span class="muted small"
                                    >Optional · retains the previous decision</span
                                ><select
                                    value=${draft.replaces}
                                    disabled=${disabled}
                                    onChange=${(/** @type {Event} */ event) => keep({ ...draft, replaces: /** @type {HTMLSelectElement} */ (event.currentTarget).value })}
                                >
                                    <option value="">Accept as a separate decision</option>
                                    ${accepted.map((entry) => html`<option value=${entry.id}>${entry.content.title}</option>`)}
                                </select></label
                            >`
                        }
                        ${
                            draft.replaces &&
                            html`<div class="dn-target">
                                <p class="small muted">Will supersede this decision atomically:</p>
                                <${Contents}
                                    content=${accepted.find((entry) => entry.id === draft.replaces)?.content ?? blank()}
                                />
                            </div>`
                        }
                        <div class="dn-actions">
                            <button
                                class="button primary"
                                disabled=${disabled || dirty}
                                onClick=${() => void act("accept")}
                            >
                                ${draft.replaces ? "Accept and supersede" : "Accept decision"}</button
                            ><button
                                class="button dn-withdraw"
                                disabled=${disabled || dirty}
                                onClick=${() => setConfirmWithdraw(!confirmWithdraw)}
                            >
                                Withdraw proposal
                            </button>
                        </div>
                        ${
                            confirmWithdraw &&
                            html`<div class="dn-warning">
                                Withdraw this pending proposal? Its text and ID stay in history.
                                <div class="dn-actions">
                                    <button
                                        class="button"
                                        disabled=${disabled || dirty}
                                        onClick=${() => void act("withdraw")}
                                    >
                                        Confirm withdrawal</button
                                    ><button
                                        class="button"
                                        disabled=${busy}
                                        onClick=${() => setConfirmWithdraw(false)}
                                    >
                                        Keep proposal
                                    </button>
                                </div>
                            </div>`
                        }
                    </section>`
                }
                ${decision && html`<footer class="dn-history"><span class="mono">${decision.id}</span><span>Proposed ${decision.proposedAt}</span>${decision.accepted && html`<span>Accepted ${decision.accepted.at} · person ID ${decision.accepted.by}</span>`}${decision.withdrawn && html`<span>Withdrawn ${decision.withdrawn.at} · person ID ${decision.withdrawn.by}</span>`}${decision.supersededBy && html`<span>Superseded by <code>${decision.supersededBy}</code>. Original contents retained.</span>`}</footer>`}
            </div>
        </div>`;
    }

    /** @param {{ initial: View }} props */
    function Export({ initial }) {
        const [notice, setNotice] = useState("");

        async function copy() {
            try {
                await navigator.clipboard.writeText(initial.markdown);
                setNotice("Markdown copied.");
            } catch {
                setNotice("Clipboard unavailable. Select and copy the text below.");
            }
        }

        return html`<div class="dn-shell">
            <div class="dn-review">
                <${SourceLine} source=${initial.source} />
                <p class="small muted">Complete notebook · revision ${initial.book.revision}</p>
                <label class="dn-export"
                    >Notebook Markdown<textarea
                        readonly
                        rows="16"
                        value=${initial.markdown}
                    ></textarea></label
                ><button class="button" onClick=${() => void copy()}>Copy Markdown</button
                >${notice && html`<p role="status">${notice}</p>`}
            </div>
        </div>`;
    }

    function NotebookPage() {
        const data = useNotebook(undefined);
        const [query, setQuery] = useState("");
        const [filter, setFilter] = useState("all");
        const view = data.view;
        const decisions = view?.book.decisions ?? [];
        const today = new Date().toISOString().slice(0, 10);
        /** @param {Decision} decision */
        const due = (decision) =>
            stateOf(decision) === "accepted" &&
            !!decision.content.revisitDate &&
            decision.content.revisitDate <= today;
        const needle = query.trim().toLocaleLowerCase();
        const filtered = decisions.filter(
            (decision) =>
                (filter === "all" ||
                    (filter === "revisit" ? due(decision) : stateOf(decision) === filter)) &&
                JSON.stringify(decision.content).toLocaleLowerCase().includes(needle),
        );

        /** @param {string | undefined} id */
        function review(id) {
            if (!view || pocket.conversationId() !== view.source.id) {
                void data.refresh();
                return;
            }

            pocket.openSheet("review", { initial: view, id, fresh: !id });
        }

        return html`<div class="dn-shell">
            <div class="dn-page">
                <header class="dn-header">
                    <p class="muted">
                        Pi proposes. Only the owner accepts. Accepted contents stay unchanged.
                    </p>
                    <div class="dn-actions">
                        <button
                            class="button primary"
                            disabled=${!view || data.loading}
                            onClick=${() => review(undefined)}
                        >
                            New proposal</button
                        ><button
                            class="button"
                            disabled=${data.loading}
                            onClick=${() => void data.refresh()}
                        >
                            Refresh</button
                        ><button
                            class="button"
                            disabled=${!view || data.loading}
                            onClick=${() => {
                                if (view && pocket.conversationId() === view.source.id) {
                                    pocket.openSheet("export", { initial: view });
                                }
                            }}
                        >
                            Export
                        </button>
                    </div>
                </header>
                ${data.error && html`<div class="error-box" role="alert">${data.error}</div>`}
                ${data.loading && !view && html`<${pocket.Loader} label="Loading notebook…" />`}
                ${!data.loading && !pocket.conversationId() && html`<p class="dn-empty">Open a conversation first. Each conversation has its own notebook.</p>`}
                ${
                    view &&
                    html`<${SourceLine} source=${view.source} />
                        <div class="dn-meta">
                            <span
                                >${`${decisions.filter((entry) => stateOf(entry) === "proposal").length} pending`}</span
                            ><span
                                >${`${decisions.filter((entry) => stateOf(entry) === "accepted").length} accepted`}</span
                            ><span>${decisions.filter(due).length} to revisit</span
                            ><span
                                >${`Revision ${view.book.revision} · ${decisions.length}/100 entries`}</span
                            >
                        </div>
                        <div class="dn-filters">
                            <label
                                >Search<input
                                    type="search"
                                    maxlength="160"
                                    placeholder="Title, choice, rationale…"
                                    value=${query}
                                    onInput=${(/** @type {Event} */ event) => setQuery(/** @type {HTMLInputElement} */ (event.currentTarget).value)} /></label
                            ><label
                                >State<select
                                    value=${filter}
                                    onChange=${(/** @type {Event} */ event) => setFilter(/** @type {HTMLSelectElement} */ (event.currentTarget).value)}
                                >
                                    <option value="all">All decisions</option>
                                    <option value="proposal">Pending proposals</option>
                                    <option value="accepted">Accepted</option>
                                    <option value="superseded">Superseded</option>
                                    <option value="withdrawn">Withdrawn</option>
                                    <option value="revisit">Revisit due</option>
                                </select></label
                            >
                        </div>
                        ${
                            !decisions.length &&
                            html`<div class="dn-empty">
                                <h3>No decisions yet</h3>
                                <p>
                                    ${"Create a proposal here, or ask Pi to propose a decision in this conversation."}
                                </p>
                            </div>`
                        }
                        ${!!decisions.length && !filtered.length && html`<p class="dn-empty">No matching decisions.</p>`}
                        <div class="dn-list">
                            ${filtered.map(
                                (decision) =>
                                    html`<button
                                        class="dn-row"
                                        onClick=${() => review(decision.id)}
                                        key=${decision.id}
                                    >
                                        <span class="dn-row-text"
                                            ><strong>${decision.content.title}</strong
                                            ><span>${decision.content.chosenOption}</span></span
                                        ><span class="dn-row-state"
                                            ><span class=${`dn-badge dn-${stateOf(decision)}`}
                                                >${stateOf(decision) === "proposal" ? "Pending" : stateOf(decision)}</span
                                            >${due(decision) && html`<span class="dn-due">Revisit due</span>`}<span
                                                class="small muted"
                                                >${stateOf(decision) === "proposal" ? "Review →" : "View →"}</span
                                            ></span
                                        >
                                    </button>`,
                            )}
                        </div> `
                }
            </div>
        </div>`;
    }

    pocket.page({ id: "notebook", title: "Decision notebook", component: NotebookPage });
    pocket.sheet({ id: "review", title: "Review decision", component: Review, wide: true });
    pocket.sheet({ id: "export", title: "Export notebook", component: Export, wide: true });
    const notebookRail = pocket.rail({
        id: "notebook",
        title: "Decision notebook",
        icon: "folder",
        page: "notebook",
    });
    const reviewMenu = pocket.menu({
        id: "review-pending",
        label: "Review pending decision",
        hint: "Checking…",
        run: reviewPending,
    });
    const reviewLauncher = pocket.launcher({
        id: "review-pending",
        label: "Review pending decision",
        detail: "Review the newest pending proposal without leaving this conversation",
        keywords: ["decisions", "approve", "pending", "review"],
        icon: "folder",
        run: reviewPending,
    });

    pocket.menu({
        id: "notebook",
        label: "Decision notebook",
        hint: "Search and history",
        page: "notebook",
    });
    pocket.launcher({
        id: "notebook",
        label: "Decision notebook",
        detail: "Review decisions in the current conversation",
        keywords: ["decisions", "rationale", "proposals"],
        icon: "folder",
        page: "notebook",
    });

    // Badge recovery remains active when the page and review sheet are both closed.
    reconcile();

    // A new client can briefly meet the previous backend while an extension update is loading.
    try {
        pocket.toolCall({
            tool: "decision_notebook_propose",
            icon: "folder",
            label: () => "proposed decision",
            subject: (args) => String(args.title ?? ""),
        });
        pocket.toolCall({
            tool: "decision_notebook_list",
            icon: "search",
            label: () => "read decisions",
        });
    } catch {
        // Optional labels must never stop the owner UI during that update window.
    }
}
