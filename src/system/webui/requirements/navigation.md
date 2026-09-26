# Native workspace navigation
<!-- budget: 8192 bytes, hard -->

Owner `system/webui`; page behavior and safe link context belong to each registered
plugin. Retained outcomes: FR-UXWEB-001, SUPPLEMENT-001/009/024 and relevant
accessibility clauses from design 29. Source: `client/core.jsx`, `routing.mjs`,
`navigation.jsx`. Old side-switching shortcuts are superseded by authenticated
account pages under ADR-0027.

| Outcome | Acceptance |
|---|---|
| Reopen the exact work context | A page declares `linkKeys`; navigation persists only these fields in the fragment. Reload and browser back/forward restore them. Draft text and credentials are never implicitly serialized. |
| Share a useful link | A toolbar dialog shows the URL and explains that recipients need their own account and existing access; the link does not grant access. Unavailable pages and inaccessible records show an explicit explanation. |
| Find tools without browsing long menus | Searchable command palette includes available pages and disposable plugin commands. Commands may declare page, role, shortcut and a context predicate; hidden/unloaded capabilities are absent. |
| Keyboard and modal use | Ctrl/Cmd+K opens commands, Alt+H opens home, Alt+R refreshes. Plugin shortcuts never fire while typing or behind a dialog. Modal focus stays inside, underlying content is inert, Escape closes the top dialog and focus returns to its trigger. |
| Mobile and screen reader use | Current navigation uses aria-current, breadcrumb is labelled, skip link reaches main, dialog buttons and controls have 44px mobile targets. |

Acceptance: `node src/system/webui/tests/navigation-browser.mjs` against a native
server. Test real context navigation, reload/back, permission explanation, role
availability, keyboard/modal focus and 390px layout. Reports distinguish local
integration from public deployment. These are targets until evidence is recorded.
