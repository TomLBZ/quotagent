# Native sign-in cooldown evidence
<!-- budget: 4096 bytes, hard -->

Owner `system/accounts`; retained FR-ADMIN-008 outcome defined in
`src/system/accounts/requirements/sign-in.md`.

`node src/system/accounts/tests/sign-in.mjs`, 2026-09-26, exit0:
[two groups PASS](native.json) using actual Cordis HTTP, account persistence and
session cookies. Five normalized-email failures cause a bounded30-second cooldown;
even correct credentials produce no session during it. Other accounts remain
available. An injected clock tests just-before/exact expiry; a new explicit login
is still required, and success resets failure history. No wall-clock wait or
browser cooldown claim is inferred from that clock-controlled test.
