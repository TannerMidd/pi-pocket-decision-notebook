import { defineDoc } from "@earendil-works/pi-durable";

export type DecisionContent = {
    title: string;
    chosenOption: string;
    rationale: string;
    alternatives: string[];
    revisitDate: string;
};

export type Decision = {
    id: string;
    content: DecisionContent;
    proposedAt: string;
    accepted?: { by: string; at: string };
    supersededBy?: string;
};

export type Notebook = {
    revision: number;
    decisions: Decision[];
};

export const emptyNotebook = (): Notebook => ({ revision: 0, decisions: [] });

// Stored contract: do not rename or change scope/history/fork after installation.
export const NotebookDoc = defineDoc<Notebook>({
    kind: "x.decision-notebook.notebook",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: emptyNotebook,
});

export class NotebookError extends Error {}

function text(value: unknown, max: number, optional = false): string {
    if (
        typeof value !== "string" ||
        value.length > max ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ) {
        throw new NotebookError("A field is missing, too long, or contains control characters.");
    }

    const result = value.trim();

    if (!optional && !result) {
        throw new NotebookError("Title, chosen option, and rationale must not be empty.");
    }

    return result;
}

export function validateContent(input: Record<string, unknown>): DecisionContent {
    const title = text(input.title, 160);
    const chosenOption = text(input.chosenOption, 1000);
    const rationale = text(input.rationale, 2400);
    const values = input.alternatives ?? [];

    if (!Array.isArray(values) || values.length > 4) {
        throw new NotebookError("Use at most four alternatives.");
    }

    const alternatives = values.map((value) => text(value, 500));
    const revisitDate = text(input.revisitDate ?? "", 10, true);

    const date = new Date(`${revisitDate}T00:00:00.000Z`);

    if (
        revisitDate &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(revisitDate) ||
            !Number.isFinite(date.getTime()) ||
            date.toISOString().slice(0, 10) !== revisitDate)
    ) {
        throw new NotebookError("Use a real revisit date in YYYY-MM-DD form, or leave it empty.");
    }

    return { title, chosenOption, rationale, alternatives, revisitDate };
}

export function stateOf(decision: Decision): "proposal" | "accepted" | "superseded" {
    return decision.supersededBy ? "superseded" : decision.accepted ? "accepted" : "proposal";
}

export function propose(
    book: Notebook,
    id: string,
    content: DecisionContent,
    at: string,
): Decision {
    // Idempotency is in the same document commit as the proposal. Never prune these keys.
    const existing = book.decisions.find((decision) => decision.id === id);

    if (existing) {
        return existing;
    }

    const decision: Decision = { id, content: structuredClone(content), proposedAt: at };
    const next = { revision: book.revision + 1, decisions: [...book.decisions, decision] };

    // Reserve every entry's eventual acceptance and supersession metadata now. There is
    // no delete action, so accepting an admitted proposal must not require free capacity.
    const reserved = {
        revision: 200, // At most 100 proposals plus 100 acceptance transactions.
        decisions: next.decisions.map((entry) => ({
            ...entry,
            accepted: entry.accepted ?? {
                // A lone surrogate uses the longest JSON encoding: six characters per unit.
                by: "\ud800".repeat(160),
                at: "+999999-12-31T23:59:59.999Z",
            },
            supersededBy: entry.supersededBy ?? `d-${"f".repeat(32)}`,
        })),
    };

    checkSize(reserved);
    book.decisions.push(decision);
    book.revision++;

    return decision;
}

export function approve(
    book: Notebook,
    id: string,
    expected: number,
    by: string,
    at: string,
    replaces?: string,
): void {
    // All checks and edits run inside one Durable transaction.
    if (book.revision !== expected) {
        throw new NotebookError(
            "The notebook changed. Run /decision-notebook-open and copy a new command.",
        );
    }

    const proposal = book.decisions.find((decision) => decision.id === id);
    const previous = replaces
        ? book.decisions.find((decision) => decision.id === replaces)
        : undefined;

    if (!proposal || stateOf(proposal) !== "proposal") {
        throw new NotebookError("The new decision must be a pending proposal.");
    }

    if (replaces && (!previous || stateOf(previous) !== "accepted")) {
        throw new NotebookError("Only a currently accepted decision can be superseded.");
    }

    const accepted = { by: text(by, 160), at };
    const next = {
        revision: book.revision + 1,
        decisions: book.decisions.map((decision) =>
            decision.id === id
                ? { ...decision, accepted }
                : decision.id === replaces
                  ? { ...decision, supersededBy: id }
                  : decision,
        ),
    };

    checkSize(next);
    proposal.accepted = accepted;

    if (previous) {
        previous.supersededBy = proposal.id;
    }

    book.revision++;
}

function checkSize(book: Notebook): void {
    // UTF-16 code units of the complete JSON document, including IDs and approval metadata.
    if (book.decisions.length > 100 || JSON.stringify(book).length > 180000) {
        throw new NotebookError(
            "This notebook is full (100 decisions or 180,000 JSON characters). Use a new conversation.",
        );
    }
}

export function findDecisions(book: Notebook, query = "", status = "all"): Decision[] {
    if (
        query.length > 160 ||
        !["all", "proposal", "accepted", "superseded", "revisit"].includes(status)
    ) {
        throw new NotebookError("Use a search of at most 160 characters and a known status.");
    }

    const needle = query.trim().toLocaleLowerCase();
    const today = new Date().toISOString().slice(0, 10);

    return book.decisions.filter((decision) => {
        const state = stateOf(decision);
        const due =
            state === "accepted" &&
            decision.content.revisitDate &&
            decision.content.revisitDate <= today;
        const matches = status === "all" || (status === "revisit" ? due : state === status);

        return matches && JSON.stringify(decision.content).toLocaleLowerCase().includes(needle);
    });
}

function md(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/[\\`*_{}\[\]()#+.!|]/g, "\\$&");
}

export function markdown(book: Notebook): string {
    return (
        [
            "# Decision notebook",
            `Revision: ${book.revision}`,
            ...book.decisions.map((decision) =>
                [
                    `## ${md(decision.content.title)}`,
                    `ID: ${decision.id} · State: ${stateOf(decision)}`,
                    `Proposed: ${decision.proposedAt}`,
                    decision.accepted
                        ? `Accepted: ${decision.accepted.at} · Person ID: ${md(decision.accepted.by)}`
                        : "",
                    decision.supersededBy ? `Superseded by: ${decision.supersededBy}` : "",
                    `### Chosen option\n\n${md(decision.content.chosenOption)}`,
                    `### Rationale\n\n${md(decision.content.rationale)}`,
                    `### Alternatives\n\n${decision.content.alternatives.map((alternative) => `- ${md(alternative).replace(/\n/g, "\n  ")}`).join("\n") || "None recorded."}`,
                    `Revisit: ${decision.content.revisitDate || "Not set"}`,
                ]
                    .filter(Boolean)
                    .join("\n\n"),
            ),
        ].join("\n\n") + "\n"
    );
}
