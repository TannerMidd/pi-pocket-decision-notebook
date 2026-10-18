# Decision notebook for Pi Pocket

Record a choice and its reasons in the conversation that made it. Pi can propose and search. **Only the owner can accept or supersede a decision.** Accepted contents stay unchanged. A replacement keeps the previous decision and its approval history.

Version **0.2.0** requires **Pi Pocket 0.16.0 or later**, extension API **1**, and Pocket's supplied Pi AI / Pi Durable 1.1 packages. No external service, model call, shell command, credential access, or outside file read is needed to use the owner review UI.

## Install or update

For gallery releases, open **Menu → Extensions → Find extensions**, then select **Decision notebook**. Check the version, read its files, and install it. Only the owner can turn it on in **Menu → Extensions**. Gallery updates are a separate, explicit owner action; a source change in this repository does not publish a gallery update.

For a manual install of this source:

1. Copy these three runtime files into the current Pocket data folder's `extensions/` directory, with this layout:

    ```text
    extensions/
      decision-notebook.ts
      decision-notebook/
        index.js
        style.css
    ```

2. Read the files, then turn on **Decision notebook** in **Menu → Extensions**. The default data folder is `~/.pi-pocket/`; the launcher shows the current **Data** folder.

Do not copy `node_modules`, tests, package files, or `_pocket.d.ts`. Pocket supplies its packages and public type declarations. `decision-notebook/state.ts` is an editor/test compatibility shim, not a production dependency. An old installed copy may remain; the 0.2 entry does not import it.

Update Pocket to 0.16.0 first. All server runtime helpers are inline in `decision-notebook.ts`, so an enabled 0.1 → 0.2 extension update does not depend on a cached helper or require a Pocket restart. Pocket can briefly show the new client with the old backend while files load. The client checks both the Pocket version and notebook response protocol, and refuses actions until they match. Choose **Review pending decision** again, or **Refresh** on an open notebook, after the update completes.

## Use

1. After Pi proposes a decision, stay in the conversation and open **Menu → Review pending decision**, or use that launcher action (Ctrl+K / ⌘+K). This reads the current source fresh and opens its newest pending proposal directly in the review sheet. No notebook page, command, or snapshot preparation is needed.
2. Check the source title, conversation ID, and working folder. **Each notebook belongs only to that conversation.** Other conversations in the same folder do not share it.
3. Read the choice, rationale, alternatives, and optional revisit date. The notebook rail badge and review menu hint show the current conversation's pending count. Updates recover while the tab is visible even when the notebook page is closed. **Menu → Decision notebook**, its rail button, or its launcher action opens search and history; select any row there to review that particular decision.
4. Use **Save edits** to change a pending proposal. Saving never accepts it. Use **Accept decision** only when you agree. Accepted content is read-only.
5. To replace a decision, review a new pending proposal, select the accepted decision to replace, and read the displayed old contents. **Accept and supersede** accepts the new proposal and marks the previous one superseded in one atomic commit. The old text and approval metadata stay unchanged.

To create a proposal yourself, open **Menu → Decision notebook → New proposal**. Save it first, then review and accept it separately. Pi can also create one when asked, for example:

> Propose SQLite for this conversation's local index. Include the reasons, JSONL as an alternative, and a revisit date of 2027-02-28. Use the decision notebook tool.

**Withdraw proposal** removes a pending proposal from active consideration after confirmation. It does not delete its text or ID. Withdrawn proposals cannot be edited or accepted, and still count toward the notebook limit. There is no model tool to edit, withdraw, accept, or supersede.

Search and filter by pending, accepted, superseded, withdrawn, or revisit due. Revisit badges use the current **UTC** date. They are not reminders, and do not start Pi or change decisions. **Export** opens complete Markdown for all states at the displayed revision. Copy it, or select the text manually if the clipboard is unavailable. Export sends nothing to an external service and writes no server file.

### Stale reviews and local drafts

Reads are fresh, not a server cache. A review sheet keeps the source, proposal ID, and revision that it displays. Events, focus/online recovery, and a visible-tab reconciliation read keep reviews and the pending hint current, including while you stay in chat with the notebook closed. Missed events do not grant authority. No proposal opens a sheet by itself; only your review action does.

If the notebook, title, or folder changes, actions stop. **Review latest · keep edits** loads the current review baseline without silently replacing dirty fields. Compare your edits with the saved proposal before saving. If a supersession target is no longer accepted, the selection is cleared and you must choose again. A stale concurrent action fails without a partial change.

Edits are kept in this tab's **session storage**, under `x.decision-notebook.*` keys, separated by owner, conversation, and proposal. They survive closing the sheet, conversation navigation, and a page reload in the same tab. Reopen the same proposal (or **New proposal** for an unsaved new one). Drafts are not synced to other tabs or devices and may be lost when the tab is closed. A storage failure shows a warning; keep the sheet open or copy your edits then. **Discard local edits** clears them explicitly. Drafts from a proposal accepted or withdrawn elsewhere are retained, but cannot change its saved contents.

### Compatibility commands

The normal owner flow uses buttons, not slash commands. These older conversation commands remain available:

| Command                                                               | Effect                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `/decision-notebook-open`                                             | Open the current notebook in matching visible owner tabs.         |
| `/decision-notebook-accept <proposal-id> <revision>`                  | Accept a pending proposal at the exact current revision.          |
| `/decision-notebook-supersede <accepted-id> <proposal-id> <revision>` | Accept a proposal and retain the previous decision as superseded. |

Pocket checks conversation access; the extension also checks the authenticated **owner** role. A repeated or stale acceptance command fails. Review the latest notebook before trying again. There is no automatic approval policy or background acceptance.

### Pi tools

- **`decision_notebook_propose`**: title, `chosenOption`, rationale, optional alternatives, and optional `revisitDate` (`YYYY-MM-DD`). Creates one pending proposal in the calling conversation. A replay of the same durable tool call cannot create another entry, including after that proposal is withdrawn.
- **`decision_notebook_list`**: optional `query`, `status` (`all`, `proposal`, `accepted`, `superseded`, `withdrawn`, `revisit`), and `offset`. Returns up to 20 matches. Only this read tool has `readOnlyHint` and can run in Plan mode.

Neither tool accepts a conversation ID, file path, folder, or approval action. Authorized guests can ask Pi to use the tools in their conversation, but cannot approve. Tool results go to the model provider and may contain decision text and approving person IDs. List output is labelled as untrusted data and fenced with `host.text.defang`. Notes are data, not instructions.

## Data, API, and access

- Authority is one native Pi Durable document per conversation: kind `x.decision-notebook.notebook`, version **1**, scope `conversation`, history `latest`, fork `initial`. These stored settings are unchanged from 0.1. **Forks start with an empty notebook**; they do not inherit decisions or approvals.
- The extension does not scan transcripts, files, other conversations, or project folders. There is no folder-wide or global decision search.
- The owner-only client uses public `pocket` UI and API methods. The server uses Pocket 0.16's public **conversation-bound request** `snapshot`, `context`, and `commit` APIs. It does not retain request contexts or commit functions, use private endpoints, inspect the database/config/tokens, or impersonate a person.
- `GET /api/x/decision-notebook/notebook/:source` reads the fresh document, source title/folder, and Markdown. `POST` at the same route creates, edits, withdraws, or accepts a proposal. Each write includes the displayed source metadata and exact notebook revision. Supersession includes the target ID. Revision and content-state checks and document edits are in one transaction. Source comparisons use the fresh bound request metadata. Writes are awaited before returning.
- Both routes and the browser module have `access: "owner"`. Pocket checks sign-in, `X-Pocket`, source visibility, and (for writes) steering and the current turn. Guests, viewers, and session-limited invitees cannot use these owner routes or UI. Browser-provided folder/title values are comparison values, never authority.
- Accepted contents cannot be edited or deleted. Supersession adds only the replacement link. Pending edits and withdrawals are human actions; withdrawals add metadata and retain the ID for replay detection. No IDs or accepted history are pruned.
- Disabling/removing the extension does not remove its durable documents. There is no authoritative server cache to lose on reload or restart.

### Limits and security boundary

New human proposals use 16 cryptographic random bytes from `crypto.getRandomValues`, including on plain-HTTP LAN connections. Recovered drafts keep their existing IDs. If secure ID generation fails, the review sheet shows an error and no proposal is saved; there is no `Math.random` fallback.

At most **100 entries** and **180,000 UTF-16 code units of serialized document JSON**, including IDs and metadata, per conversation. New proposals and pending edits reserve worst-case future approval/withdrawal/supersession metadata and the full safe-integer revision width. Editing no longer relies on the old 200-revision assumption. Existing data is not migrated or pruned. The revision counter stops safely at `Number.MAX_SAFE_INTEGER`; it cannot wrap or lose exactness. Use a new conversation when full.

Title: 160 characters; chosen option: 1,000; rationale: 2,400; at most four alternatives of 500 each. Title, choice, rationale, and provided alternatives cannot be blank. The owner form uses one alternative per line. Revisit dates must be real dates. Search is limited to 160 characters. Control characters are refused except tabs and line breaks.

This is **not a tamper-proof audit log**. The owner can change data through shell access or remove a conversation in Pocket. Other server extensions have the same OS rights. Pi with unrestricted shell or credentials is outside this extension's boundary. Human-only approval means the model tools have no acceptance operation and owner mutations check the authenticated person, not text that claims to be the owner. Do not record secrets that must not reach the model provider or people who can read the conversation.

## Development

Use Node **22.19 or later** with built-in TypeScript stripping:

```sh
npm install
npm run check
npm test
npm run format:check
node --check decision-notebook.ts
node --check decision-notebook/index.js
```

A gitignored `node_modules` link to a matching Pocket checkout can replace `npm install`. `_pocket.d.ts` is the exact public declaration from Pocket 0.16.0, used only for development. The check covers the server, shim, browser JavaScript, and tests. Runtime imports are only supported package names and Node's crypto module; no machine-specific path ships.

Three lean fixtures check SQLite reopen/replay and conversation isolation; fresh owner mutation/revision/supersession/withdrawal guards; and malformed dates plus worst-case capacity at a large revision. They use temporary storage with no live data or model provider. Browser/runtime smoke checks must also use an isolated Pocket copy and scripted provider, not the owner's install. Desktop or 390px emulation is not physical-phone testing or proof of real-model behavior.

## License

MIT. See [LICENSE](LICENSE).
