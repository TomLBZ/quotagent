# Quotagent
<!-- budget: 4096 bytes, hard -->

A React and Cordis quotation workspace for contractors and suppliers. [Open the demo](https://novara.remoteblossom.com/quotagent/).

Each account has one business role. A separate admin manages users and global extensions.
[Architecture and source map](docs/product/architecture.md).

## Try it

Use the login page’s demo buttons. All demo passwords are **`demo1234`**.

| Account | Workspace |
|---|---|
| `contractor@demo.local` | Northstar Construction |
| `supplier@demo.local` | Summit Supply |
| `supplier2@demo.local` | Atlas Materials |
| `admin@demo.local` | Server administration |

1. Compare the labelled Riverside offers; ask the agent to explain trade-offs.
2. Ask for an RFQ draft, review and publish it. Sign in as a supplier to quote.
3. Award as contractor, acknowledge as supplier, then propose/approve changes.
   Commitments require your confirmation.
4. Ask **“Give my workspace a terracotta theme”**, **“Build a landed-cost calculator
   with shipping, duty and tax inputs”**, or **“Save a reusable pre-bid review skill.”**
   In Plugin studio, inspect, run, enable/disable or publish the result.
5. Open **Ingest documents**, upload an email, Excel/CSV sheet or document, review
   the extracted lines and create a private RFQ or quote. Use **Extract with AI** for
   unstructured source text. Drafts remain editable before any commitment.
6. Open **Email**, **Telegram** or **Agent connections** to configure your own mailbox,
   bot, MCP servers and A2A agents. Read, draft and review sends without leaving the app.
7. In **Agent workroom**, delegate a quotation comparison to specialists. Review the
   plan, answer questions, inspect traces and manage account memory. **Review actions**
   holds proposed sends, remote calls and commitments until you approve them.

Demo accounts have labelled samples. New accounts start empty.

## Two levels of AI

**Business assistance:** real model calls use the account’s RFQs, quotes, messages
and editable account memory. The agent reads incoming mail, extracts requirements,
creates drafts, compares offers and prepares reviewed actions. Multi-agent runs retain
plans, specialist context, human feedback and a synthesized decision brief.

**Dynamic customization:** the agent generates personal themes, reference widgets,
workflow skills and executable utilities. Utilities contain generated JavaScript, inputs and callable Cordis effects.
Users load, unload, publish and install extensions. Admin promotion creates an
independent global copy. Skills save a `SKILL.md` and execute through the assistant.

Files and mail attachments enter the ingestion workspace for editable line extraction.
Generated utilities are bounded pure functions; skills run on demand. OCR, scheduled
skills and arbitrary generated server code remain outside this composition.
[Connection setup and limits](docs/product/connected-agent-contract.md) include IMAP/SMTP,
Telegram Bot API, MCP HTTP/SSE and A2A. OAuth consent and MCP stdio are not implemented.

## Run locally

Requires Node.js 22.12+ and Python 3.

```sh
./run up
./run status
./run logs
./run down
```

`up` installs missing dependencies and builds the frontend. Rebuild client edits with `./run build`. Default: `http://127.0.0.1:8093/quotagent/`; select another local port
with `--port`. Accounts, ledgers and generated artifacts survive restarts under
`tmp/product-data/`; override with `QUOTAGENT_PRODUCT_DATA`.

The provider reads `/workspace/config.yaml` or `QUOTAGENT_CONFIG`:

```yaml
llm:
  provider: openai
  model: YOUR_MODEL_ID
api_keys:
  openai:
    env: OPENAI_API_KEY
    base_url: https://api.openai.com/v1
```

**Plugin settings** stores model defaults/preferences and account connection credentials.
Personal model endpoints need personal keys. `QUOTAGENT_AI_MODEL` and
`QUOTAGENT_AI_URL` override model/endpoint. Manual procurement works without AI.

[Plugin ownership](docs/product/plugin-requirements.md) and [current scope](docs/product/runtime-contract.md).
Rules: [AGENTS.md](AGENTS.md).
