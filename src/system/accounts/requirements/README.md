# Accounts
<!-- budget: 4096 bytes, hard -->

Owner of login, registration, logout, profile settings, one client role per account,
and administrator user/permission management. Source: `docs/design/architecture.md`.

Implementation: `../code/product.mjs`. Password hashes and sessions live in the local
runtime account store. Preferences exposed to assistants are recorded in the account
ledger. Public profiles exclude credentials and sessions. Route and navigation
registrations are Cordis effects and disappear when the plugin unloads.

Administrator permission flags have functional meaning: `workspace:read-only`
denies `workspace:write`, `assistant:disabled` denies `assistant:use`, and
`plugins:disabled` denies `plugins:manage`. `accounts.can(user, capability)` reads
the current account state. Empty permissions allow normal client capabilities.

User acceptance: runtime contract checks 1 and 3, executed through the public browser
workflow. Demo account passwords are deliberately documented as `demo1234`.
