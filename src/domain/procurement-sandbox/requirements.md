# Procurement demonstration scenario
<!-- budget: 4096 bytes, hard -->

Owner: native domain/procurement-sandbox. Registers a disposable scenario with system/sandbox; supplies an isolated Cordis composition and domain-owned sequence. No host/Core business logic.

Acceptance: run ordinary create/publish RFQ, two private quote drafts and submissions, deterministic comparison, award proposal, supplier confirmation, separate same-party reviewer grant and buyer signature, and supplier acknowledgement through existing services. Generate a second open request for experimentation. Seed receipt lists every step/status and synthetic actor; approvals are explicitly simulated examples. Costs remain supplier-private and every public transfer uses current QEP. No real account profile, credentials or business data are copied. AI starts unconfigured with operator defaults disabled; live outbound messaging/remote transport plugins are absent. Contractor and supplier each see only their perspective. Every runtime registration disposes on reset/unload. Evidence comes from the sandbox native/GUI checks, not a fabricated model or business improvement metric.

Verification: `node src/system/sandbox/tests/isolation.mjs` and `node src/system/sandbox/tests/browser.mjs` passed with real native writers and visible browser actions; report mapping in `docs/work/evidence/g8-isolated-sandbox.md`.
