# Bounded failed sign-in cooldown
<!-- budget: 4096 bytes, hard -->

Native owner `system/accounts`. Retained outcome FR-ADMIN-008: repeated failed
authentication has a bounded cooldown; the old inline administrator-token elevation
mechanism remains superseded by separate authenticated accounts under ADR-0027.

Five failed sign-ins for the same normalized email within five minutes cause a
30-second cooldown. Missing, wrong, disabled and cooling-down accounts return the
same response. Even a correct password cannot create a session during cooldown;
elapsed time never creates a session automatically. A successful subsequent login
clears the failure count. This transient, bounded map is disposed with the account
plugin; it is not a persistent account lock or a model-visible fact.

Acceptance: `node src/system/accounts/tests/sign-in.mjs` uses actual native HTTP,
account persistence and cookies, advancing an injected clock to exercise expiry
without a wall-clock sleep. It asserts refusal has no session cookie, subsequent
success requires a new explicit correct-password request and another account can
still sign in.
