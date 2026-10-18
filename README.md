# Decision notebook for Pi Pocket

Keep the reason for each project choice beside the conversation that made it. Pi can propose and search. The owner must accept each proposal. A new proposal can replace an accepted decision without changing its original contents.

**Local first.** No accounts, external services, network requests, shell commands, or outside file reads. Requires Pi Pocket 0.14.0 or later (extension API 1), with its supplied Pi AI and Pi Durable 1.1 packages. Checked with Pocket 0.15.0 and Node 26.8.2.

## Install

1. In Pi Pocket, open **Menu → Extensions**. Local drop-ins appear here after their files are in the data folder.
2. Copy `decision-notebook.ts` and the complete `decision-notebook/` folder into that data folder's `extensions/` directory. Keep their names and layout. The default is `~/.pi-pocket/extensions/`; `PI_POCKET_DIR` can select another data folder. The launcher shows the current **Data** folder.
3. Read these files before you turn the extension on. In **Menu → Extensions**, turn on **Decision notebook** (`decision-notebook.ts`).

Do not copy `node_modules`, tests, package files, or the development type declaration into the extension folder. Pocket supplies its packages and `_pocket.d.ts`. This repository is ready for the gallery file layout but is **not published** and has no gallery entry yet.

## Use

1. Open a conversation. Ask Pi to record a proposal, for example:

    > Propose using SQLite for this project's local index. Include the reasons, JSONL as an alternative, and a revisit date of 2027-02-28. Use the decision notebook tool.

2. As the owner, send **`/decision-notebook-open`** in that conversation. This binds and refreshes its read-only notebook snapshot.
3. Open **Menu → Decision notebook**, or tap its rail button. It is also in the launcher (Ctrl+K / ⌘+K).
4. Search or filter by pending, accepted, superseded, or revisit due. Read the full choice, reason, and alternatives before approval.
5. Tap **Copy accept command**. Close the page, paste the command into the **same conversation shown on the page**, and send it yourself. Copying does not approve anything. If clipboard access is blocked, select and copy the command from the text box.
6. To replace an accepted decision, first ask Pi for a new proposal. On that proposal's card, select the accepted decision, then tap **Copy supersede command**. Paste and send it in the same conversation. The command accepts the new proposal and marks the old decision as superseded in one commit.
7. Use **Export Markdown** to see the complete notebook, including all states. **Copy Markdown** copies it. The text box also supports manual selection and copying. Export does not send data to another service or write a server file.

Revisit badges use the current UTC calendar date. They are not reminders and do not start Pi. No decisions are changed merely because a date is due.

### Human commands

| Command                                                               | Effect                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/decision-notebook-open`                                             | Bind/refresh this conversation's UI snapshot.                      |
| `/decision-notebook-accept <proposal-id> <revision>`                  | Accept a pending proposal.                                         |
| `/decision-notebook-supersede <accepted-id> <proposal-id> <revision>` | Accept the new proposal and retain the old decision as superseded. |

These are conversation commands, checked by Pocket for session access and by this extension for the **owner** role. Guests and viewers cannot open or approve through these commands. Approval commands use the notebook revision shown in the page. If another proposal or approval changes the notebook, an old command fails without a partial change. Run `/decision-notebook-open`, review the new snapshot, and copy a new command. A repeated acceptance command also fails rather than applying twice.

### Pi tools

- **`decision_notebook_propose`**: title, `chosenOption`, rationale, optional alternatives, optional `revisitDate` (`YYYY-MM-DD`). Creates one pending proposal in the calling conversation. Replaying the same durable tool call cannot create a second entry.
- **`decision_notebook_list`**: optional `query`, `status` (`all`, `proposal`, `accepted`, `superseded`, `revisit`), and `offset`. Returns up to 20 matching entries. Only this read tool has `readOnlyHint` and can run in Plan mode.

Neither tool accepts a conversation ID, file path, project folder, or approval action. Authorized guests can ask Pi to use these tools in their conversation. They cannot approve with the notebook tools. Tool results go to the model provider; they can include decision text and the approving person's ID. The list labels notes as untrusted data, and fences them with `host.text.defang`. Notes must not be followed as instructions.

## Data and access

- Authority is **one native Pi Durable document per conversation**, kind `x.decision-notebook.notebook`, version 1. It uses `history: "latest"` and `fork: "initial"`. **A fork starts with an empty notebook**; it does not inherit decisions or approvals.
- The extension does not scan transcripts, files, other conversations, or project folders. A shared working directory does not give shared notebook access. There is no global search.
- Accepted content fields cannot be edited or deleted through this extension. Supersession adds a link and keeps the old content, acceptance time, and approving person ID. A new proposal is required for new contents. There is no proposal edit/delete action either.
- The page and its only route are **owner-only**. The owner runs the open command in an authorized conversation before its snapshot is available. The route also checks the owner role and that the binding belongs to that person's ID. Guests with access to all sessions still cannot use the page. Session-limited invitees cannot load module pages/routes under Pocket's current API.
- `GET /api/x/decision-notebook/notebook/:conversation` returns a copied read-only snapshot and its Markdown. It has no mutation operation. The usual Pocket sign-in and `X-Pocket` header checks apply. The browser uses only `pocket.api` to this own route and public `pocket` UI methods.
- No local/session browser storage is used. A bound snapshot is kept in server memory for up to 50 conversation/person bindings; the oldest binding is removed when that limit is reached. It contains only this module's own decision data. It is not the source of truth. Active tools and commands refresh an existing binding after a commit, with revision ordering and a targeted change event. The page shows the copied revision and snapshot time.
- Extension reload, disable, or server restart discards these UI copies, **not the durable notebook**. Run the open command again. **Reload snapshot** reads the current copy only; it cannot read a Durable document directly. Reopening/refreshing with the command is the recovery path if an update is missed.

### Public API constraint

The public `Host` API has no database/session resolver. A route request has no conversation context, document reader, or commit function. The browser cannot invoke a human command through the public extension API. This module does not bypass those limits.

Instead, tools and human commands use their supported document APIs. The explicit open command creates a derived, user-bound read-only copy for the UI. The page generates approval commands for the human to send. It does **not** retain a command's commit function, use host internals, call Pocket's private HTTP API, open a second database, read credentials, or accept a browser-provided working directory.

### Limits and security boundary

- At most **100 decisions** and **180,000 UTF-16 code units of complete serialized document JSON**, including IDs and metadata, per conversation. Proposal admission reserves worst-case future acceptance and supersession metadata for every entry, so existing proposals remain approvable when proposal capacity is full. New proposals that exceed this reserved bound fail. Export or start a new conversation when full; this version cannot prune entries.
- Title: 160 characters; chosen option: 1,000; rationale: 2,400; at most four alternatives of 500 each. Title, choice, rationale, and each provided alternative must not be blank. Revisit dates must be real dates. Search is limited to 160 characters. Control characters are refused (tab and line breaks are allowed).
- All version checks, approvals, and supersession links are in one transaction. Proposal IDs derive from the durable task and call IDs and remain stored for replay detection. Cache writes reject older revisions.
- The owner can still change or delete data through shell access, disable the extension, or remove a conversation through Pocket itself. Other server extensions run with the same OS rights. This is **not** a tamper-proof audit log or a security boundary against a compromised owner, another module, or Pi with unrestricted shell/credential access. Human-only approval here means there is no model approval tool and notebook approval commands check the authenticated owner.
- Disabling/removing the extension does not remove stored documents. Back up Pocket data through your normal backup process. No secret should be put in a decision if it must not reach the model provider or people who can read that conversation.

## Development

Use Node 22.19 or later with built-in TypeScript stripping. From this repository:

```sh
npm install
npm run check
npm test
```

The dependency list supplies development types and Pocket's public packages; no global tools are required. `_pocket.d.ts` is a development copy of Pocket's exact public declarations. Refresh it from the Pocket version you target. It is type-only and is not part of the gallery runtime payload. `npm run check` checks the module, runtime helper, browser JavaScript, declarations, and tests with `tsconfig.json`.

When developing next to an existing Pocket checkout, a gitignored `node_modules` symlink to that checkout's dependencies is an alternative to `npm install`. The runtime code has no machine-specific imports.

The three lean tests use only public package APIs: SQLite reopen/replay and conversation isolation; owner approval/version/supersession and snapshot boundaries; malformed dates and the exact document size bound. They use temporary storage, no model provider and no live Pocket data. No browser tests are bundled. A manual smoke test on an isolated Pocket 0.15 copy checked desktop/mobile layout, a tool-created proposal, the copied approval command, and owner acceptance. Separate HTTP checks confirmed that guests and viewers cannot reach the route. Recheck the page on an **isolated Pocket copy** before sharing a changed version. Set `PI_POCKET_DIR` to a new temporary data folder if you run a separate Pocket server; do not test on an owner's install.

A helper `.ts` change needs a Pocket restart after installation, as described in Pocket's drop-in docs. Ask the owner to use **Menu → Restart server**. Never restart their server from this repository's tests.

## License

MIT. See [LICENSE](LICENSE).
