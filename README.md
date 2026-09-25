# Quotagent
<!-- budget: 4096 bytes, hard -->

A React and Cordis quotation workspace for contractors and suppliers. [Open the demo](https://novara.remoteblossom.com/quotagent/).

Contractors request, compare and order. Suppliers quote, clarify and acknowledge. Each account sees one business role; a separate admin
manages users, permissions and global extensions.
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
6. Configure credentials and preferences in **Plugin settings**. Admins can inspect
   all application plugins, manage optional engines or promote a shared extension.

Demo accounts have labelled samples. New accounts start empty; choose one client role
in Settings.

## Two levels of AI

**Business assistance:** real model calls use the account’s RFQs, quotes, messages
and remembered preferences. The agent extracts pasted requirements, creates editable
RFQ/quote drafts, compares offers and drafts negotiation messages for review.

**Dynamic customization:** the agent generates personal themes, reference widgets,
workflow skills and executable utilities. Utilities contain generated JavaScript, inputs and callable Cordis effects.
Users load, unload, publish and install extensions. Admin promotion creates an
independent global copy. Skills save a `SKILL.md` and execute through the assistant.

Extraction accepts pasted text and uploaded EML/MBOX/MSG, XLSX/XLS, CSV/TSV, DOCX,
text PDF, TXT, HTML and JSON files. Email attachments are parsed too. Skills run on demand. Generated utilities
are bounded pure functions with number/text inputs, JSON output and the caller’s
workspace context. OCR, live inbox sync, scheduled skills and arbitrary server integrations
are outside this composition. See [current scope](docs/product/runtime-contract.md).

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

Plugin settings saves global/personal model credentials. Personal endpoints need
personal keys. Environment credentials also work. `QUOTAGENT_AI_MODEL`
and `QUOTAGENT_AI_URL` override model/endpoint. Manual procurement works without AI
configuration. [Provider implementation](src/system/agent-runtime/code/product-ai.mjs).

[Plugin ownership](docs/product/plugin-requirements.md) maps all **166 historical
requirements** to owners; ownership does not imply feature parity. Current scope: [product contract](docs/product/runtime-contract.md).
Rules: [AGENTS.md](AGENTS.md).
