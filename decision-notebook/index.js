/** @typedef {import('./state.ts').Notebook} Notebook */
/** @typedef {import('./state.ts').Decision} Decision */
/** @typedef {{ conversation: number, book: Notebook, updatedAt: string, markdown: string }} View */

export const pocketApi = 1;

/** @param {import('../_pocket.d.ts').Pocket} pocket */
export default function setup(pocket) {
    const { html, useEffect, useRef, useState } = pocket;

    pocket.style("style.css");

    function NotebookPage() {
        const [conversation] = useState(() => pocket.conversationId());
        const [view, setView] = useState(/** @type {View | null} */ (null));
        const [loading, setLoading] = useState(true);
        const [error, setError] = useState("");
        const [query, setQuery] = useState("");
        const [filter, setFilter] = useState("all");
        const [command, setCommand] = useState("");
        const [message, setMessage] = useState("");
        const [showExport, setShowExport] = useState(false);
        const [replacements, setReplacements] = useState(
            /** @type {Record<string, string>} */ ({}),
        );
        const request = useRef(0);
        const controller = useRef(/** @type {AbortController | null} */ (null));
        const commandField = useRef(/** @type {HTMLTextAreaElement | null} */ (null));

        async function refresh() {
            controller.current?.abort();
            const stop = new AbortController();
            const current = ++request.current;

            controller.current = stop;
            setLoading(true);
            setError("");

            try {
                if (!conversation) {
                    setView(null);
                    return;
                }

                const result = await pocket.api(
                    /** @type {string} */ (`notebook/${conversation}`),
                    undefined,
                    { signal: stop.signal },
                );

                if (current === request.current && !stop.signal.aborted) {
                    setView(/** @type {View} */ (result));
                }
            } catch (failure) {
                if (!stop.signal.aborted && current === request.current) {
                    setView(null);
                    setError(
                        failure instanceof Error ? failure.message : "The notebook could not load.",
                    );
                }
            } finally {
                if (!stop.signal.aborted && current === request.current) {
                    setLoading(false);
                }
            }
        }

        useEffect(() => {
            void refresh();
            const off = pocket.on("changed", (/** @type {{conversation: number}} */ event) => {
                if (event.conversation === conversation) {
                    setCommand("");
                    setMessage("");
                    void refresh();
                }
            });

            return () => {
                off();
                controller.current?.abort();
            };
        }, [conversation]);

        useEffect(() => {
            if (command) {
                commandField.current?.focus();
                commandField.current?.select();
            }
        }, [command]);

        /** @param {string} text */
        async function copy(text) {
            try {
                if (!navigator.clipboard?.writeText) {
                    throw new Error("Clipboard not available");
                }

                await navigator.clipboard.writeText(text);
                setMessage(
                    "Copied. Approval commands must be sent in the conversation shown below.",
                );
            } catch {
                setMessage("Clipboard is not available. Select and copy the text below.");
            }
        }

        /** @param {string} next */
        function chooseCommand(next) {
            setCommand(next);
            void copy(next);
        }

        const decisions = view?.book.decisions ?? [];
        const today = new Date().toISOString().slice(0, 10);
        /** @param {Decision} decision */
        const status = (decision) =>
            decision.supersededBy ? "superseded" : decision.accepted ? "accepted" : "proposal";
        /** @param {Decision} decision */
        const due = (decision) =>
            status(decision) === "accepted" &&
            decision.content.revisitDate &&
            decision.content.revisitDate <= today;
        const accepted = decisions.filter((decision) => status(decision) === "accepted");
        const pending = decisions.filter((decision) => status(decision) === "proposal").length;
        const revisits = decisions.filter(due).length;
        const needle = query.trim().toLocaleLowerCase();
        const filtered = decisions.filter(
            (decision) =>
                (filter === "all" ||
                    (filter === "revisit" ? due(decision) : status(decision) === filter)) &&
                JSON.stringify(decision.content).toLocaleLowerCase().includes(needle),
        );

        return html`
            <div class="dn-page">
                <header class="dn-intro">
                    <p class="dn-eyebrow">DECISION NOTEBOOK</p>
                    <h2>Keep the why, not just the choice.</h2>
                    <p class="muted">Pi proposes. You decide. Accepted contents stay unchanged.</p>
                    <p class="small">
                        Conversation ${conversation ?? "not selected"} · owner review
                    </p>
                </header>
                <aside class="dn-help">
                    <strong>First, refresh from the conversation</strong>
                    <p>
                        Run <code>/decision-notebook-open</code> in this conversation, then open this page. This is a read-only snapshot, not an approval form.
                    </p>
                    <p>
                        To accept or replace a decision, copy its command below. Close this page, paste the command in <strong>conversation ${conversation ?? "—"}</strong>, and send it yourself.
                    </p>
                    <p class="small muted">
                        After a restart or extension reload, run the open command again. Use a new proposal to change accepted contents. Pi cannot approve through its notebook tools.
                    </p>
                </aside>
                <div class="dn-toolbar">
                    <button
                        class="button"
                        onClick=${() => {
                            void refresh();
                        }}
                        disabled=${loading}
                    >
                        Reload snapshot
                    </button>
                    <button
                        class="button"
                        onClick=${() => setShowExport(!showExport)}
                        disabled=${!view}
                    >
                        ${showExport ? "Hide Markdown" : "Export Markdown"}
                    </button>
                </div>
                ${error && html`<div class="error-box" role="alert">${error}</div>`}
                ${loading && html`<${pocket.Loader} label="Loading notebook…" />`}
                ${!loading && !conversation && html`<p class="dn-empty">Open a conversation first. Each conversation has its own notebook.</p>`}
                ${message && html`<p class="dn-help" role="status">${message}</p>`}
                ${
                    command &&
                    html`
                        <section class="dn-command">
                            <label for="dn-command"
                                >Paste and send this in conversation ${conversation}</label
                            >
                            <textarea
                                id="dn-command"
                                ref=${commandField}
                                readonly
                                value=${command}
                                rows="3"
                                spellcheck="false"
                            ></textarea>
                            <p class="small muted">
                                A revision check rejects this command if the notebook changed. Review the new snapshot before you try again.
                            </p>
                        </section>
                    `
                }
                ${
                    view &&
                    html`
                        <div class="dn-summary" aria-label="Notebook counts">
                            <span>${pending} pending</span><span>${accepted.length} accepted</span
                            ><span>${revisits} to revisit</span>
                        </div>
                        <p class="small muted">
                            Revision ${view.book.revision} · snapshot ${view.updatedAt} · ${decisions.length}/100 entries
                        </p>
                        ${
                            showExport &&
                            html`
                                <section class="dn-export">
                                    <label for="dn-markdown">Complete notebook Markdown (all states, not just this filter)</label>
                                    <textarea
                                        id="dn-markdown"
                                        readonly
                                        value=${view.markdown}
                                        rows="12"
                                        spellcheck="false"
                                    ></textarea>
                                    <button
                                        class="button"
                                        onClick=${() => {
                                            void copy(view.markdown);
                                        }}
                                    >
                                        Copy Markdown
                                    </button>
                                </section>
                            `
                        }
                        <div class="dn-filters">
                            <label
                                >Search
                                <input
                                    type="search"
                                    placeholder="Title, choice, rationale…"
                                    maxlength="160"
                                    value=${query}
                                    onInput=${(/** @type {Event} */ event) => setQuery(/** @type {HTMLInputElement} */ (event.currentTarget).value)}
                                />
                            </label>
                            <label
                                >State
                                <select
                                    value=${filter}
                                    onChange=${(/** @type {Event} */ event) => setFilter(/** @type {HTMLSelectElement} */ (event.currentTarget).value)}
                                >
                                    <option value="all">All decisions</option>
                                    <option value="proposal">Pending proposals</option>
                                    <option value="accepted">Accepted</option>
                                    <option value="superseded">Superseded</option>
                                    <option value="revisit">Revisit due</option>
                                </select>
                            </label>
                        </div>
                        ${
                            !decisions.length &&
                            html`<div class="dn-empty">
                                <h3>No decisions yet</h3>
                                <p>
                                    Ask Pi to use <code>decision_notebook_propose</code> with a title, chosen option, rationale, alternatives, and optional revisit date.
                                </p>
                            </div>`
                        }
                        ${!!decisions.length && !filtered.length && html`<p class="dn-empty">No matching decisions. Try another search or state.</p>`}
                        <div class="dn-list">
                            ${filtered.map(
                                (decision) => html`
                                    <article class="dn-decision" key=${decision.id}>
                                        <div class="dn-badges">
                                            <span class=${`dn-badge dn-${status(decision)}`}
                                                >${status(decision) === "proposal" ? "Pending proposal" : status(decision)}</span
                                            >
                                            ${due(decision) && html`<span class="dn-badge dn-due">Revisit due</span>`}
                                        </div>
                                        <h3>${decision.content.title}</h3>
                                        <p class="dn-id">${decision.id}</p>
                                        <h4>Chosen option</h4>
                                        <p class="dn-note">${decision.content.chosenOption}</p>
                                        <h4>Rationale</h4>
                                        <p class="dn-note">${decision.content.rationale}</p>
                                        <h4>Alternatives</h4>
                                        ${
                                            decision.content.alternatives.length
                                                ? html`<ul>
                                                      ${decision.content.alternatives.map((alternative) => html`<li class="dn-note">${alternative}</li>`)}
                                                  </ul>`
                                                : html`<p class="muted">None recorded.</p>`
                                        }
                                        <p class="small">
                                            Revisit: ${decision.content.revisitDate || "Not set"}
                                        </p>
                                        <p class="small muted">Proposed ${decision.proposedAt}</p>
                                        ${decision.accepted && html`<p class="small muted">Accepted ${decision.accepted.at} · person ID ${decision.accepted.by}</p>`}
                                        ${decision.supersededBy && html`<p class="small">Superseded by <code>${decision.supersededBy}</code>. The original contents are retained.</p>`}
                                        ${
                                            status(decision) === "proposal" &&
                                            html`
                                                <div class="dn-review">
                                                    <button
                                                        class="button primary"
                                                        disabled=${loading}
                                                        onClick=${() => chooseCommand(`/decision-notebook-accept ${decision.id} ${view.book.revision}`)}
                                                    >
                                                        Copy accept command
                                                    </button>
                                                    ${
                                                        accepted.length > 0 &&
                                                        html`
                                                            <label
                                                                >Replace an accepted decision instead
                                                                <select
                                                                    value=${replacements[decision.id] || ""}
                                                                    onChange=${(/** @type {Event} */ event) => setReplacements({ ...replacements, [decision.id]: /** @type {HTMLSelectElement} */ (event.currentTarget).value })}
                                                                >
                                                                    <option value="">
                                                                        Select the old decision…
                                                                    </option>
                                                                    ${accepted.map((previous) => html`<option value=${previous.id}>${previous.content.title} (${previous.id})</option>`)}
                                                                </select>
                                                            </label>
                                                            <button
                                                                class="button"
                                                                disabled=${loading || !replacements[decision.id]}
                                                                onClick=${() => chooseCommand(`/decision-notebook-supersede ${replacements[decision.id]} ${decision.id} ${view.book.revision}`)}
                                                            >
                                                                Copy supersede command
                                                            </button>
                                                        `
                                                    }
                                                </div>
                                            `
                                        }
                                    </article>
                                `,
                            )}
                        </div>
                    `
                }
            </div>
        `;
    }

    pocket.page({ id: "notebook", title: "Decision notebook", component: NotebookPage });
    pocket.rail({ id: "notebook", title: "Decision notebook", icon: "folder", page: "notebook" });
    pocket.menu({ id: "notebook", label: "Decision notebook", page: "notebook" });
    pocket.launcher({
        id: "notebook",
        label: "Decision notebook",
        detail: "Review conversation decisions",
        keywords: ["decisions", "rationale", "proposals"],
        icon: "folder",
        page: "notebook",
    });
}
