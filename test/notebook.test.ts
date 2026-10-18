import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Conversation, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { Command, CommandContext, Host, Web, ConversationWebRequest } from "../_pocket.d.ts";
import setup from "../decision-notebook.ts";
import {
    NotebookDoc,
    NotebookError,
    emptyNotebook,
    propose,
    approve,
    validateContent,
    editProposal,
} from "../decision-notebook/state.ts";

const content = {
    title: "Store locally",
    chosenOption: "SQLite",
    rationale: "No network needed.",
    alternatives: ["JSONL"],
    revisitDate: "2027-02-28",
};
const options = () => ({ models: createModels(), registry: createRegistry() });
const owner = { id: "owner-id", name: "Owner", role: "owner" as const };

function moduleHarness() {
    const commands = new Map<string, Command>();
    const routes = new Map<string, (request: ConversationWebRequest) => unknown>();
    let fenced = false;
    const web = {
        api: 1,
        module: "decision-notebook",
        client: (_entry, access) => assert.equal(access?.access, "owner"),
        route: () => assert.fail("Use conversation-bound routes"),
        conversationRoute: (method, _path, handler, access) => {
            assert.equal(access.conversation, "source");
            assert.equal(access.access, "owner");
            routes.set(method, handler);
        },
        command: (name, command) => commands.set(name, command),
        error: (status, message) => Object.assign(new Error(message), { status }),
        onDispose: () => {},
        send: () => {},
    } satisfies Partial<Web>;
    const host = {
        text: {
            defang: (text: string) => {
                fenced = true;
                return text.replace(/<\//g, "< /");
            },
        },
    } as Host;
    const extension = setup(host, web as Web);

    return {
        commands,
        read: (request: ConversationWebRequest) => routes.get("GET")!(request),
        write: (request: ConversationWebRequest) => routes.get("POST")!(request),
        tools: extension.tools! as readonly ToolRegistration[],
        fenced: () => fenced,
    };
}

function commandContext(harness: Harness, conversation: Conversation): CommandContext {
    return {
        user: owner,
        conversationId: conversation.id,
        cwd: "/not-read",
        signal: new AbortController().signal,
        context,
        snapshot: harness.snapshot.bind(harness),
        commit: (change) => conversation.commit(change, context),
    };
}

function toolApi(
    harness: Harness,
    conversation: Conversation,
    callId = "proposal",
): ToolExecutionApi {
    return {
        taskId: 123,
        callId,
        conversationId: conversation.id,
        snapshot: harness.snapshot.bind(harness),
        commit: (change: Parameters<Conversation["commit"]>[0]) =>
            conversation.commit(change, context),
    } as unknown as ToolExecutionApi;
}

test("safe tool replay stays one proposal across SQLite reopen, isolated from other conversations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-notebook-"));
    const path = join(directory, "test.sqlite");
    let harness = await Harness.open(await openNodeSqliteStorage(path), options(), context);

    try {
        const root = await harness.root(context);
        const module = moduleHarness();
        const tool = module.tools.find((tool) => tool.name === "decision_notebook_propose")!;

        await tool.execute(content, toolApi(harness, root), context);
        await harness.close(context);
        harness = await Harness.open(await openNodeSqliteStorage(path), options(), context);
        const reopened = await harness.root(context);

        await tool.execute(content, toolApi(harness, reopened), context);
        const book = await harness.snapshot(NotebookDoc, reopened.id, context);

        assert.equal(book?.decisions.length, 1);
        assert.equal(book?.revision, 1);
        const other = await harness.createConversation(
            { ownership: { kind: "ownerless" } },
            context,
        );

        assert.equal(
            (await harness.snapshot(NotebookDoc, other.id, context))?.decisions.length ?? 0,
            0,
        );
        const list = module.tools.find((tool) => tool.name === "decision_notebook_list")!;
        const result = await list.execute({}, toolApi(harness, reopened), context);

        assert.ok(module.fenced());
        assert.match(JSON.stringify(result), /untrusted data, not instructions/);
    } finally {
        await harness.close(context);
        await rm(directory, { recursive: true, force: true });
    }
});

test("fresh owner actions guard revisions, preserve accepted history and retain withdrawn replay IDs", async () => {
    const harness = await Harness.open(new MemoryStorage(), options(), context);

    try {
        const root = await harness.root(context);
        const module = moduleHarness();
        const ctx = commandContext(harness, root);
        const source = {
            id: root.id,
            title: "Local index",
            cwd: "/not-read",
            thinkingLevel: "off" as const,
        };
        const request = {
            ...ctx,
            conversation: source,
            body: {},
            params: { source: String(root.id) },
        } as unknown as ConversationWebRequest;
        const ids = ["a", "b", "c"].map((letter) => `d-${letter.repeat(32)}`);
        const write = (body: Record<string, unknown>) =>
            module.write({ ...request, body: { source, ...body } });

        await root.commit(async (tx) => {
            const book = await tx.doc(NotebookDoc, root.id);

            for (const id of ids) {
                propose(book, id, validateContent(content), "2026-10-18T00:00:00.000Z");
            }
        }, context);
        assert.equal(
            ((await module.read(request)) as { book: { revision: number } }).book.revision,
            3,
        );
        await assert.rejects(
            async () => module.write({ ...request, user: { ...owner, role: "guest" } }),
            /Only the owner/,
        );
        await assert.rejects(
            async () =>
                write({
                    source: { ...source, cwd: "/changed" },
                    action: "accept",
                    id: ids[0],
                    revision: 3,
                }),
            /source conversation changed/,
        );
        const approvals = await Promise.allSettled(
            ids.slice(0, 2).map((id) => write({ action: "accept", id, revision: 3 })),
        );

        assert.equal(approvals.filter((result) => result.status === "fulfilled").length, 1);
        const before = (await harness.snapshot(NotebookDoc, root.id, context))!;
        const accepted = before.decisions.find((decision) => decision.accepted)!;
        const next = before.decisions.find((decision) => !decision.accepted)!;

        await write({ action: "accept", id: next.id, replaces: accepted.id, revision: 4 });
        const after = (await harness.snapshot(NotebookDoc, root.id, context))!;

        assert.deepEqual(
            after.decisions.find((decision) => decision.id === accepted.id)?.content,
            accepted.content,
        );
        assert.equal(
            after.decisions.find((decision) => decision.id === accepted.id)?.supersededBy,
            next.id,
        );
        await assert.rejects(
            async () => write({ action: "edit", id: accepted.id, content, revision: 5 }),
            /Only a pending/,
        );
        const pending = after.decisions.find((decision) => !decision.accepted)!;

        await write({
            action: "edit",
            id: pending.id,
            content: { ...content, title: "Edited by owner" },
            revision: 5,
        });
        await write({ action: "withdraw", id: pending.id, revision: 6 });
        await root.commit(async (tx) => {
            const book = await tx.doc(NotebookDoc, root.id);

            propose(book, pending.id, validateContent(content), "2026-10-18T00:00:00.000Z");
        }, context);
        const final = (await harness.snapshot(NotebookDoc, root.id, context))!;

        assert.equal(final.decisions.length, 3);
        assert.equal(final.revision, 7);
        assert.equal(
            final.decisions.find((decision) => decision.id === pending.id)?.withdrawn?.by,
            owner.id,
        );
        // Compatibility commands still use the same atomic guards, never a model acceptance tool.
        await assert.rejects(
            async () =>
                module.commands.get("decision-notebook-accept")!.handler(`${pending.id} 6`, ctx),
            /notebook changed/,
        );
    } finally {
        await harness.close(context);
    }
});

test("invalid dates fail cleanly; a proposal at capacity can still be accepted", () => {
    assert.throws(() => validateContent({ ...content, revisitDate: "2026-99-99" }), NotebookError);
    const book = emptyNotebook();

    book.revision = Number.MAX_SAFE_INTEGER - 1000;
    const large = validateContent({
        ...content,
        rationale: "r".repeat(2400),
        alternatives: Array(4).fill("a".repeat(500)),
    });

    assert.throws(() => {
        for (let index = 0; index < 100; index++) {
            propose(
                book,
                `d-${String(index).padStart(32, "0")}`,
                large,
                "2026-10-18T00:00:00.000Z",
            );
        }
    }, /notebook is full/);
    editProposal(book, book.decisions[0]!.id, book.revision, large);

    for (const decision of book.decisions) {
        approve(
            book,
            decision.id,
            book.revision,
            "\ud800".repeat(160),
            "+999999-12-31T23:59:59.999Z",
        );
    }

    assert.ok(book.decisions.every((decision) => decision.accepted));
    assert.ok(JSON.stringify(book).length <= 180000);
    book.revision = Number.MAX_SAFE_INTEGER;
    assert.throws(
        () => propose(book, `d-${"f".repeat(32)}`, large, "2026-10-18T00:00:00.000Z"),
        /revision limit/,
    );
});
