# Connected services and agent workroom
<!-- budget: 12288 bytes, hard -->

Status: implementation in progress; no acceptance claimed yet.
Source: user objective 2026-09-25, extending the [runtime contract](runtime-contract.md).
User chose local protocol test services for first verification. Real credentials are
entered through the product GUI; public tests must not contact unrelated recipients.

## Functional ownership and acceptance

| Requirement | Plugin owner | Evidence required before completion |
|---|---|---|
| Configurable IMAP/SMTP with in-platform receive, compose, reply and send | system/mail | GUI connects to real local protocol servers, receives a message and attachment, composes/reviews/sends, observes SMTP delivery and durable receipt; AI can read/draft/propose send |
| Messaging connection and notifications | system/telegram + system/notifications | Bot connection validation, actual API update processing/cursor, chat send through human review, unread/read notification UI; polling stops on unload |
| External MCP connections | system/agent-connections | Multiple account-owned connections/settings, official SDK discovery and actual tools/resources/prompts; tool invocation visible to assistant and GUI; effectful calls require review |
| External A2A agents | system/agent-connections | Agent card discovery, real message/task send, status/artifacts, cancellation and input-required continuation through user-facing controls |
| Human-in-the-loop | system/action-center + system/agent-workflows | Durable pending actions show exact destination/input; approve/reject; workflow plan checkpoint and questions pause/resume actual execution; models have no approve tool |
| Multi-agent orchestration | system/agent-workflows | Real model planning, distinct role contexts and parallel independent steps, synthesis, task states/traces, pause/resume/cancel and restart recovery; public complicated quotation task |
| Explicit state and memory | system/agent-workflows + system/agent-runtime | Inspect/edit/archive memories with provenance; active reviewed memory influences later model inputs; run/step/tool/action state survives reload/restart |
| Prompt injection resistance | system/agent-runtime policy module, plus action/connection owners | External email/document/tool/agent content labelled as data; effect policy enforced outside model; injection probes cannot send, approve or silently install memory; limitations documented honestly |

New behavior is supplied by native Cordis plugins and plugin-owned React components.
HTTP/tool/navigation/background work is disposable. Existing ledger and QEP kernel
semantics remain unchanged. Native inventory and Plugin settings expose these owners.

## Shared contracts

`ctx.settings.define` gains `scope:'account'`: built-in defaults plus only the current
account's values/secrets, including for admin. This does not inherit another account's
mailbox or token. Optional `ownerId` limits dynamic connection schemas to their owner
in list/view/get/save. Existing `user` schemas keep global-default inheritance.
Plugin connection credentials never become tool arguments or model context.

`ctx.actions.register({kind,label,execute(user,input,action,{signal})})` returns a
disposer. `propose(user,{kind,title,summary,input,source?,runId?,idempotencyKey?})` stores
an immutable pending request and returns its record. It never executes it. `list/get`
are account scoped. The GUI explicitly approves or rejects; only approval invokes the
registered executor with the frozen input. Record decision, actor, timestamps, result
or failure. Reject retains its reason. Reboot after an interrupted external execution
marks delivery uncertain; never automatically repeat ambiguous sends. Human approval
is not exposed as a model tool. Repeated approval of a completed action is idempotent.

`ctx.notifications.push(user,{type,title,body,link:{view,...context},sourceId?,dedupeKey?})`
appends an account notification. List/unread state, mark read and linked navigation
belong to its UI. Deduplication prevents repeated mail polling from notifying twice.
Optional external notification delivery is a registered, user-configured transport;
sending goes through its recorded policy rather than hidden provider calls.

`ctx.assistant.definitions(user,{delegated:true})` returns allowed OpenAI-format tool
schemas. `invoke(user,{name,arguments,context:{runId,stepId,agentId,source}})` validates
visibility and enforces tool effect metadata outside the model. Effects are `read`,
`draft`, `proposal`, or `write`; delegated workers cannot execute `write` effects.
Unknown effects are excluded from delegated tool sets. Tools can return `action` or
`actions` navigation cards, including `{type:'navigate',input:{view:'approvals',actionId}}`.
A positional invoke alias may support native integrations, with identical checks.

`ctx.workflows.start/list/get/control` owns durable runs. Start receives
`{objective,rfqId?,checkpoint:true}`. Controls include pause, resume, cancel, answer and
feedback. Each role worker has its own retained message context; ready independent
steps can run concurrently. Planner and synthesis use actual model calls. Human
questions persist before pausing. Interrupted runs recover paused rather than repeat
external effects. Traces expose plans, tools, source references and outputs, not hidden
chain-of-thought. A trace belongs to exactly one account/run/step/agent.

`ctx.memory.list/context/put/remove` owns explicit memories with revision and source
`{kind:'human'|'assistant'|'workflow',reference?,runId?,evidence?}`. Manual GUI edits are
active; `suggest()` creates a review action for model-suggested memories. Only approved
active records enter model context. Removal archives a record; history remains.

## Service-specific behavior

Mail settings cover inbound/outbound host, port, TLS mode, account identities and
credentials, mailbox, sync interval and bounded message count. Sync deduplicates by
mailbox identity and server UID validity/UID, parses actual MIME and stores source and
attachments. Reconnect, failures and last sync are visible. Sending records recipient,
subject/body/attachments and delivery receipt; external text cannot request sending by
itself. Draft content is editable before a review action is proposed.

Telegram settings cover bot token, configured chat, endpoint and polling preferences.
Updates persist before cursor acknowledgment. Show the configured bot, conversations,
received content and send outcome. Polling is bounded/abortable; webhook conflicts and
rate-limit responses are visible. A bot token is not a user-account login or permission
to receive arbitrary personal chats. Supported attachment handling must be documented.

MCP uses the current official SDK for Streamable HTTP and an explicit SSE option.
Connection settings include endpoint and credentials; discover real server capabilities.
Tools/resources/prompts remain account-owned external content. Read-only annotations
alone are not authority to execute arbitrary outbound operations; the chosen connection
policy determines what can run automatically and what needs review. No automatic full
workspace or private-cost export to remote services. Local stdio process launch is not
required for this external-server surface and must not be implied by the UI.

A2A uses card-advertised bindings and the official SDK. Preserve task/context/message
IDs and remote state/artifacts. Input-required is a real pending user decision, with
follow-up sent to the same task/context. Remote task cancellation is exposed and recorded.
Protocol compatibility/version support must match current sources and runtime evidence.

## Trust and durability

External sources and their instructions remain untrusted data, including tool metadata
and remote agent answers. Separate trusted app instructions from account/source JSON;
never elevate an email's text into a system instruction. Credential values are excluded.
Role/account restrictions, tool effect checks, approval execution and memory acceptance
are enforced by code, not only prompts. Keep source identity and suspicious-content
warnings for review without silently discarding ordinary quoted correspondence.

New additive event families: `actions/*`, `notifications/*`, `mail/*`, `telegram/*`,
`connections/*`, `workflows/*`, `agent-memory/*`, `agent-policy/*`. Exact event names live
with the owning plugin requirements. All facts entering model context are recorded
before use; model request/output events continue to capture complete prompt context.
This is layered resistance, not a guarantee that a model will never follow malicious
text. Guidance: [OWASP prompt injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

## Verification and delivery

Use real local IMAP/SMTP servers and official MCP/A2A fixture implementations; use a
local Telegram API fixture, explicitly labelled a fixture. Verify transport requests,
responses, durable state, account separation and disposal, not just mocked service calls.
Use the configured real model for public agent/workroom journeys. At the approved public
URL, separately exercise client and admin flows, review external actions, inspect traces
and memory, and verify recovery after restart. Publish commands, output summaries and
screenshots under a new evidence folder. Normal feature commits are pushed/read back;
ignored progress/handover preserve unfinished scope across continuations.
