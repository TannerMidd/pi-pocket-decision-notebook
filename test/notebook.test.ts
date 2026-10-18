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
import type { Command, CommandContext, Host, Web, WebHandler, WebRequest } from "../_pocket.d.ts";
import setup from "../decision-notebook.ts";
import {
    NotebookDoc,
    NotebookError,
    emptyNotebook,
    propose,
    approve,
    validateContent,
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
    let read: WebHandler;
    let fenced = false;
    const web = {
        api: 1,
        module: "decision-notebook",
        client: (_entry, access) => assert.equal(access?.access, "owner"),
        route: (method, _path, handler, access) => {
            assert.equal(method, "GET");
            assert.equal(access?.access, "owner");
            read = handler;
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
        read: (request: WebRequest) => read(request),
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

test("only owner commands approve; concurrent stale approval fails and supersession retains accepted contents", async () => {
    const harness = await Harness.open(new MemoryStorage(), options(), context);

    try {
        const root = await harness.root(context);
        const module = moduleHarness();
        const ctx = commandContext(harness, root);
        const request = {
            params: { conversation: String(root.id) },
            user: owner,
        } as unknown as WebRequest;
        const ids = ["a", "b", "c"].map((letter) => `d-${letter.repeat(32)}`);

        assert.throws(() => module.read(request), /decision-notebook-open/);
        await root.commit(async (tx) => {
            const book = await tx.doc(NotebookDoc, root.id);

            for (const id of ids) {
                propose(book, id, validateContent(content), "2026-10-18T00:00:00.000Z");
            }
        }, context);
        const accept = module.commands.get("decision-notebook-accept")!.handler;

        await assert.rejects(
            async () => accept(`${ids[0]} 3`, { ...ctx, user: { ...owner, role: "guest" } }),
            /Only the owner/,
        );
        const approvals = await Promise.allSettled([
            accept(`${ids[0]} 3`, ctx),
            accept(`${ids[1]} 3`, ctx),
        ]);

        assert.equal(approvals.filter((result) => result.status === "fulfilled").length, 1);
        const before = (await harness.snapshot(NotebookDoc, root.id, context))!;
        const accepted = before.decisions.find((decision) => decision.accepted)!;
        const next = before.decisions.find((decision) => !decision.accepted)!;
        const supersede = module.commands.get("decision-notebook-supersede")!.handler;

        await supersede(`${accepted.id} ${next.id} 4`, ctx);
        const after = (await harness.snapshot(NotebookDoc, root.id, context))!;

        assert.deepEqual(
            after.decisions.find((decision) => decision.id === accepted.id)?.content,
            accepted.content,
        );
        assert.equal(
            after.decisions.find((decision) => decision.id === accepted.id)?.supersededBy,
            next.id,
        );
        await module.commands.get("decision-notebook-open")!.handler("", ctx);
        const view = module.read(request) as { book: typeof after };

        view.book.decisions.length = 0;
        assert.equal((await harness.snapshot(NotebookDoc, root.id, context))!.decisions.length, 3);
        assert.throws(
            () => module.read({ ...request, user: { ...owner, id: "another-owner" } }),
            /decision-notebook-open/,
        );
    } finally {
        await harness.close(context);
    }
});

test("invalid dates fail cleanly; a proposal at capacity can still be accepted", () => {
    assert.throws(() => validateContent({ ...content, revisitDate: "2026-99-99" }), NotebookError);
    const book = emptyNotebook();
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
    for (const decision of book.decisions) {
        approve(book, decision.id, book.revision, "o".repeat(160), "2026-10-18T00:00:00.000Z");
    }

    assert.ok(book.decisions.every((decision) => decision.accepted));
    assert.ok(JSON.stringify(book).length <= 180000);
});
