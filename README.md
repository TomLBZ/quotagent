# Quotagent
<!-- budget: 4096 bytes, hard -->

A quotation workspace for contractors and suppliers, built with React and native
Cordis plugins. [Open the demo](https://novara.remoteblossom.com/quotagent/).

Contractors request, compare, negotiate and order. Suppliers prepare quotes, clarify
scope and acknowledge orders. Each account sees one business role; a separate admin
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

1. Compare the two labelled Riverside lighting offers. Ask the assistant to explain
   price, delivery and payment trade-offs, then draft a negotiation message.
2. Paste a project brief into chat and ask for an editable RFQ. Review and publish it.
   In another browser profile, sign in as a supplier, prepare a quote and submit it.
3. Award from the contractor account, acknowledge from the supplier account, and
   propose or approve a change. Commitments require your explicit confirmation.
4. Ask **“Give my workspace a terracotta theme”**, **“Build a landed-cost calculator
   with shipping, duty and tax inputs”**, or **“Save a reusable pre-bid review skill.”**
   In Plugin studio, inspect, run, enable/disable or publish the result.
5. Use the admin account to manage access or promote a shared extension globally.

Built-in demo accounts receive shared, labelled sample records. A newly registered
account starts empty; its supplier/contractor role is selectable in Settings.

## Two levels of AI

**Business assistance:** real model calls use the account’s RFQs, quotes, messages
and remembered preferences. The agent extracts pasted requirements, creates editable
RFQ/quote drafts, compares offers and drafts negotiation messages for review.

**Dynamic customization:** the agent generates personal themes, reference widgets,
workflow skills and executable utilities. For a utility it writes actual JavaScript
logic and input fields; an executable Cordis plugin owns its UI and callable effects.
Users load, unload, publish and install extensions. Admin promotion creates an
independent global copy. Skills save a `SKILL.md` and execute through the assistant.

Current extraction accepts pasted text. Skills run on demand. Generated utilities
are bounded pure functions with number/text inputs, JSON output and the caller’s
workspace context. OCR, inbox sync, scheduled skills and arbitrary server integrations
are outside this composition. See [current scope](docs/product/runtime-contract.md).

## Run locally

Requires Node.js 22.12+ and Python 3.

```sh
./run up
./run status
./run logs
./run down
```

`up` installs missing dependencies and builds the frontend. Use `./run build` after
client edits. Default: `http://127.0.0.1:8093/quotagent/`; select another local port
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

Supply the credential through the named environment variable. `QUOTAGENT_AI_MODEL`
and `QUOTAGENT_AI_URL` override model/endpoint. Manual procurement works without AI
configuration. [Provider implementation](src/system/agent-runtime/code/product-ai.mjs).

[Plugin ownership](docs/product/plugin-requirements.md) maps all **166 historical
requirements** to owners; ownership does not imply feature parity. Older design notes
and evidence describe earlier versions. Current behavior is defined by the
[product contract](docs/product/runtime-contract.md); repository rules are in
[AGENTS.md](AGENTS.md).
