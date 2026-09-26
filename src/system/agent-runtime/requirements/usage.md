# AI usage statistics
<!-- budget: 8192 bytes, hard -->

Native child `code/product-usage.mjs` owns account token statistics, the `/usage`
read API and `client/usage.jsx`. Runtime mounts it before the provider. The provider
optionally calls `usage.record(user, metadata)` once after its terminal event.
The additive `agent/model-usage` event retains allowlisted call metadata and
normalized counts. Existing model events remain unchanged; see ADR-0031.

The read projection joins historical `agent/model-requested`, `agent/model-completed`
and `agent/model-failed` events by account and callId, then overlays final usage
metadata. Reported usage is retained even when the response fails validation.
Repeated metadata never counts a call twice. Calls lacking a final outcome are
labelled “No final status”; this does not claim they remain active after restart.

Input, output, total, cached input, uncached input, cache-write input and reasoning
output are shown only when the provider reports a valid nonnegative integer.
Missing counts remain null and coverage counts accompany sums. Reported zero is
preserved. Cache and reasoning breakdowns are subsets; they are never added to
input/output totals. Configured-tariff cost estimates are projected separately from recorded call metadata;
unknown pricing stays unknown and currencies remain separate. These estimates are
not invoices. See `controls-and-evaluation.md` for tariff provenance and budgets.

GET `/usage` accepts scope mine/all, inclusive UTC from/to dates, provider, model,
purpose, status, and an admin accountId filter. Default is own account and the last
30 UTC dates. All-account access is checked on the server. Summaries, daily bars,
grouped totals and recent metadata contain no prompts, answers, credentials,
endpoint strings or exception text. Admin scope may identify the account whose
usage is summarized; private procurement facts remain absent. Workflow purposes
group by planner, specialist, report and synthesis, rather than per-run identifiers.

## Executable acceptance

`node src/system/agent-runtime/tests/usage.mjs` must demonstrate:

1. Actual historical event schemas project completed/failed calls, retain usage
   when completion precedes validation failure, and count each call once.
2. Missing usage, zero usage and partially reported usage remain distinct; cache
   aliases are not added together; no unreported values are inferred.
3. Date, model, provider, purpose and status filters select the expected calls.
   Caller scope is isolated; non-admin aggregate/account-filter requests fail.
4. Metadata events reconstruct after real ledger remount; native plugin unload
   removes service, route and navigation registrations.
5. A local HTTP provider fixture exercises the real provider hook for successful,
   malformed, failed and canceled requests when the integrated provider is mounted.

Browser acceptance: open AI usage with real historical provider records, switch
metrics and date/model/status filters, select a chart day, inspect recent calls,
verify unreported usage explanation, and check admin scope/account controls. Record
the reproducible command, screenshot and report under `tmp/agent-experience/usage/`.
No acceptance is claimed until its command has passed.

## Field semantics

DeepSeek `prompt_cache_hit_tokens` aliases `prompt_tokens_details.cached_tokens`;
prompt tokens include cache hits and misses. Its reasoning count is a completion
breakdown. Sources: [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
and [context caching](https://api-docs.deepseek.com/guides/kv_cache/).
OpenAI-compatible usage uses prompt/completion token counts and nested details;
the normalization also accepts the equivalent input/output field names when
reported by a compatible endpoint. Sources: [usage schema](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions/methods/retrieve)
and [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
