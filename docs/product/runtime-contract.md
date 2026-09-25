# Product runtime contract
<!-- budget: 16384 bytes, hard -->

Status: delivered demo; public acceptance is recorded in [evidence](../work/evidence/product-2026-09-25/README.md)
and [independent evaluation](evaluation.md).
Source: user goal objective supplied 2026-09-25; ADR-0027 and ADR-0029. This contract supersedes
side-switching administration and the old panel-catalogue demo experience.

## Plugin composition

`host/product.mjs` composes actual Cordis plugins; no business code in the host.
Existing Python ledger and QEP kernels retain their semantics and are reused by a
persistent Python adapter. The previous CLI runtime is a historical development reference; `./run` and the
public workspace service launch this product composition.

| Plugin | Requirements and behavior |
|---|---|
| system/webui | Generic HTTP routing, React component registry, layout, dialogs, notifications, static assets; no procurement logic |
| system/workspace-store | Per-account append-only ledger projections and QEP exchange through existing Python kernels |
| system/accounts | Persistent login, profile, supplier/contractor type, separate admin account, account administration |
| domain/procurement | RFQs, item extraction/import, private costs, quotes, comparison, messages/clarifications, negotiated revisions, human-confirmed award/PO, changes, exports, deadlines |
| system/agent-runtime | Live provider, ledger-recorded complete model context/output, account conversations, contextual recommendations, drafts, preferences, tool execution |
| system/plugin-studio | Natural-language personal plugin/skill generation, editable configurations, lineage-aware Cordis installation/disposal, installed marketplace state, global promotion |
| system/settings | Persisted schema-based global defaults, account overrides, masked credentials, independent settings UI |
| system/plugin-manager | Complete native/child inventory, repository-only catalog, optional lifecycle and dependencies, independent admin UI |
| system/file-store | Account-owned content-addressed upload/download and durable metadata |
| domain/ingestion | Upload, preview, mapping, line review and private RFQ/quote import |
| domain/ingestion-engines | Individually mounted email, Excel, CSV/TSV, document and optional live AI engines |
| system/mail | Account IMAP inbox/sent sync, SMTP send review, attachments, draft/reply and assistant tools |
| system/telegram | Bot messages, attachments, reviewed replies and optional generic activity reminders |
| system/agent-connections | Account MCP HTTP/SSE servers and A2A agents, discovery, reviewed operations and task continuation |
| system/action-center | Durable human decisions, frozen requests, execution receipts and uncertain-delivery recovery |
| system/notifications | Account activity inbox, unread/read state and disposable notification listeners |
| system/agent-workflows | Live multi-agent planning, parallel specialists, synthesis, human questions, durable traces and editable reviewed memory |

All new functionality belongs to these plugins. Existing detailed requirements are
mapped to capability groups in `plugin-requirements.md`; no global functional owner.

## Shared service interfaces

Cordis modules export `name`, `inject`, `apply(ctx, config)`; `ctx.provide()` registers
services. Every route/tool/UI registration uses `ctx.effect(() => disposer)`.
All plugin code lives under its plugin directory. Node bare dependencies can be
resolved via `createRequire(new URL('../../../../host/package.json', import.meta.url))`.

- `ctx.web.route(method, path, handler, {public:false, admin:false})` returns disposer.
  Paths are relative to `/quotagent/api`, with `:id` params. Handler receives
  `{user, body, params, query, req, res}`; return JSON object. Errors throw an Error
  with `status` (default 400). Public routes receive nullable user. JSON response
  is the returned object; no extra envelope. `ctx.web.contribute({id,label,icon,roles,order})`
  registers navigable UI metadata; `GET /api/bootstrap` returns `{user, navigation, extensions, ui}`; `ui` carries refresh and upload limits.
- `ctx.store.list(realm, collection)` / `get(realm,collection,id)` are synchronous
  read projections, returning copies. `put(realm,collection,record,{actor,event}={})`
  is asynchronous and requires `record.id`; every version appends an event.
  `append(realm,type,body,{actor,eventClass}={})` records arbitrary model/approval events.
  `exchange(from,to,collection,record,{actor,event}={})` exchanges only the supplied
  public record through existing QEP endpoints and updates recipient projection.
  `realm` is `user.id`; admin/global records use `system`. `events(realm)` gives copies.
  Store service exposes `root` for plugin artifacts. Never store credentials in ledger.
- `ctx.accounts.resolve(req)`, `list()` (public profiles), `get(id)`, `update(id,patch)`.
  User shape `{id,email,name,company,role:'contractor'|'supplier'|'admin',preferences:{}}`.
  Demo credentials: `contractor@demo.local`, `supplier@demo.local`, `admin@demo.local`,
  password `demo1234`; secondary supplier `supplier2@demo.local` same password.
  Settings may select one client type; switching gives only that type's experience.
- `ctx.ai.complete(user,{messages,tools?,purpose?})` performs REAL model call and records
  complete request and response in that user's ledger; returns OpenAI chat message.
  `ctx.assistant.tool({name,description,parameters,roles,execute(user,args)})` returns disposer.
  Tools for external commitments return review proposals; they cannot commit.
- `ctx.procurement.snapshot(user)` returns account-specific business data below.
  `ctx.procurement.execute(user, action, input)` supports same actions as HTTP.
- `ctx.studio.list(user)` returns extensions available to user. Every extension uses
  an actual Cordis child context/fiber, with account-scoped UI effects and disposal.
- `ctx.studioRuntime.register(ownerId,descriptor,source)` registers generated pure
  JavaScript and returns its disposer. `run(user,id,input,workspace)` executes the
  registered function with a timeout; studio supplies only the caller's snapshot.

## HTTP and business shapes

Authentication: `POST /auth/login {email,password}`, `/auth/register {email,password,name,company,role}`,
`POST /auth/logout`, `GET /auth/me` => `{user}` (nullable), `PATCH /account {name,company,role,preferences}`.
Account management: admin `GET /admin/users` => `{users}`, `PATCH /admin/users/:id`.

`GET /workspace` => `{rfqs,quotes,orders,messages,changes,activity,contacts,stats}`.
`POST /workspace/:action` => `{ok:true,...}`; then refresh workspace.
Records use `id`, `createdAt`, `updatedAt`; RFQ fields `title,description,deadline,currency,items,status,ownerId,ownerName,supplierIds`;
item `{id,description,quantity,unit}`. Quote `{id,rfqId,supplierId,supplierName,items:[{...item,unitPrice,cost?}],leadDays,paymentTerms,notes,status,total,currency}`.
Never exchange costs/private notes/preferences. Message `{id,rfqId,fromId,fromName,toId,text,kind,createdAt}`.
Order `{id,rfqId,quoteId,supplierId,supplierName,total,currency,status,items,createdAt}`.
Change `{id,orderId,title,description,amount,status,createdAt}`.
Actions:
- `create-rfq` `{title,description,deadline,currency,items,supplierIds}` creates private draft.
- `publish-rfq` `{id,confirmed:true}` sends RFQ to chosen suppliers.
- `save-quote` `{id?,rfqId,items,leadDays,paymentTerms,notes}` creates/edits own private draft.
- `submit-quote` `{id,confirmed:true}` approves and sends supplier quote.
- `send-message` `{rfqId,toId,text,kind?}` (clarification/negotiation/message).
- `award` `{quoteId,confirmed:true}` human approves award and issues order, delivers to supplier.
- `acknowledge-order` `{id,confirmed:true}` supplier acknowledges order.
- `propose-change` `{orderId,title,description,amount}`; `approve-change` `{id,confirmed:true}`.
- `seed-demo` loads labelled account-owned sample records idempotently. Startup initializes
  the built-in demo accounts; ordinary new accounts remain empty.
`GET /workspace/export?rfqId=...` downloads a comparison CSV.

Assistant: `GET /assistant` => `{messages,preferences,provider:{available,model}}`;
`POST /assistant/chat {message,rfqId?}` => `{message,actions?,toolResults?}`.
Message `{id,role,content,createdAt,tools?}`. Tools can prepare RFQ/quote drafts, compare,
remember preferences, draft messages, create extensions and saved workflow skills.
Client displays grounded summaries, source records and actionable draft buttons.
No rule output may be labelled as a model response.

Studio: `GET /studio` => `{plugins,market,skills}`; `POST /studio/generate {prompt}`;
`POST /studio/:id/:action` where action is load/unload/publish/install/promote/delete/run/configure.
Configure accepts `{name?,description?,spec}` and remounts enabled effects. List entries
include `lineageId`, `scope`, `canManage`, and visible instances; marketplace includes
`installed`, `installedId`, `installedEnabled`, and `installationScope`.
Plugin `{id,name,description,ownerId,kind:'theme'|'widget'|'skill'|'calculator',enabled,published,global,
spec:{...},source?,createdAt}`. Theme spec `{accent,background,surface,text,radius}`;
widget spec `{title,body,items?}`; skill spec `{prompt,steps?}`; calculator spec
`{title,fields:[{name,label,type:'number'|'text',default}],code}` where `code` is actual
model-authored JavaScript `function(input, workspace) { ... return result; }`.
Calculator `POST /studio/:id/run {input:{...}}` returns `{ok:true,result}` using only
the caller's account snapshot. Code runs as a bounded pure function; no platform
formula templates or business-write tools. Source and callable behavior survive
marketplace installation and global promotion (ADR-0028). Generated descriptor
and executable Cordis module are visible for review in the studio. Skills run a new
assistant turn; human commitments still require review. Admin can promote global default.

## Configurable plugins and ingestion

The [follow-up contract](plugin-workspace-contract.md) defines settings, inventory,
file ownership, ingestion formats and additional public acceptance. Configuration
schemas and UI are owned by their plugins, with generic controls from settings.
`GET /settings` lists permitted schemas; `GET/PATCH /settings/:id` reads/saves values,
explicit credential clearing or reset. `GET /plugins` is admin inventory;
`POST /plugins/:id/enable|disable` controls managed optional Cordis fibers.
`GET/POST /files` lists/uploads account files. `GET /ingestion` lists files, parsed
sources and available engines. `POST /ingestion/upload|parse`,
`PATCH /ingestion/:id`, and `POST /ingestion/:id/extract|import` drive the owned GUI.
Source: [ingestion routes](../../src/domain/ingestion/code/index.mjs).

## Connected services and multi-agent work

The [connected-agent contract](connected-agent-contract.md) extends this composition
with mail, messaging, external tools/agents, durable action review and a multi-agent
workroom. Its plugin-owned requirements define exact protocols, settings, API surfaces,
events and limitations. Chat and specialist workers use the same enforced tool policy;
external content is recorded source data. Memories have provenance, revision history,
edit/archive controls and explicit acceptance for model suggestions. Account connection
credentials never inherit from another account. Workroom state survives process restart;
interrupted activity resumes only after a human decision.

## Acceptance from user viewpoint

Browser commands: `node tools/product-e2e.mjs`, `node tools/product-agent-e2e.mjs`,
`node tools/product-studio-e2e.mjs` with `BASE_URL=https://novara.remoteblossom.com/quotagent`.
Raw screenshots remain under `tmp/product-evidence/`; selected reports and screenshots
are versioned with the [acceptance evidence](../work/evidence/product-2026-09-25/README.md).

1. Account login exposes one client's navigation only; admin has separate management.
2. Contractor can create/publish RFQ; supplier sees it, prepares/submits quote;
   contractor compares, approves/issues order; supplier acknowledges. No terminal step.
3. Actual model extracts pasted requirements, produces editable draft, compares specific
   quotes, drafts negotiation, and remembers a preference across reloads.
4. User asks for UI skin; generated plugin loads for that account, unload restores
   appearance, publish appears in market, admin promotes, another account can install.
5. Natural-language automation becomes saved skill and runs through the assistant.
   A requested custom calculator becomes actual generated JavaScript; changing input
   produces the expected numeric result, and publication/install preserve its behavior.
6. Desktop/mobile responsive UI; primary workflow and agent reachable in one click.
7. Independent evaluator tries public UI and records evidence-based preference against
   chat/email alternatives, including remaining limitations. No forced favorable verdict.
