# Getting started
<!-- budget: 6144 bytes, hard -->

Open [Quotagent](https://novara.remoteblossom.com/quotagent/) and sign in. A new
account starts empty and has one business perspective: contractor or supplier.
Administration uses a separate account. Public demo credentials are listed in the
[root README](../../README.md).

Your home emphasizes the AI assistant and the next work to do. Start with a request
such as “Draft an RFQ for these items” or “Compare these quotations and explain what
is missing.” The assistant can read your accessible records, make editable drafts
and prepare actions for review. Manual business controls also work without a model.

Use **Try demo** to enter your account's isolated, fictional quotation-to-order
example. Review the listed steps before generating it. All tabs for that account
share demo mode; the visible banner offers **Exit demo**. Reset and clear affect
only that account's demonstration data. AI credentials start empty there. The login
page's shared sample accounts and this isolated sandbox are different experiences.

**Review actions** holds proposed sends and commitments. Inspect the exact content,
source and recipient before deciding. Independent review is required for the
specified commercial commitments and authority changes. An agent cannot grant a
human approval. Waiting, failure and uncertain delivery remain visible.

During an assistant turn use **Pause**, **Stop**, **Resume** and the follow-up
control. A request already sent to a remote provider may finish before cancellation
is observed. Completed receipts remain available; stopping is not an undo operation.
**AI usage** shows reported tokens, coverage and explicitly priced estimates.

Choose a layout, palette and spacing in **Workspace style**. Search navigation with
the command palette; shared links still require the recipient's own access. Lists
with collection controls support search, filters, saved personal views and CSV
columns. **Help** offers a walkthrough for the signed-in role.

Connections belong to the account configuring them. Open **Plugin settings** for
provider credentials; **Email**, **Telegram** and **Agent connections** expose
mailbox, bot, MCP and A2A setup. Use local protocol test services before connecting
real accounts. Sending and externally effective remote actions require review.
No OAuth consent flow or MCP stdio connector is provided by this composition.

The installable app caches its shell only when explicitly enabled. Offline mode
cannot read cached business records or queue writes for replay. Reconnect before
continuing a business action.

Sources: [role-guide plugin](../../src/system/user-guide/requirements/README.md),
[assistant](../../src/system/agent-runtime/requirements/product.md),
[controls](../../src/system/agent-runtime/requirements/controls.md),
[sandbox](../../src/system/sandbox/requirements.md),
[connections](../../src/system/agent-connections/requirements/functional.md),
[offline contract](../../src/system/webui/requirements/offline.md).
