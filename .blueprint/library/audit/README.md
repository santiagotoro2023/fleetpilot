# Audit log (`audit`)

Who did what, when and from where: every sign-in, every change, every look at something
sensitive, in one append-only table with a searchable view for administrators. Built for
FleetPilot, where many people change the same infrastructure.

## When to use

- Several people work on the same data and someone must be able to answer "who changed this?".
- Sensitive values are shown or used (passwords, keys): each look is recorded.
- Rules or customers require an audit trail.

## When not to use

- Debugging and operation: that is the server log (`log.info`), not the audit log.
- A history of a record that users browse to undo changes: that is the app's own versions table.
- Apps without accounts (the element needs `auth`).

## API

```js
import { audit, record } from './lib/audit.mjs';
await start({ routes: [auth({ onEvent: record }), audit({ retentionDays: 400 }), items] });
await record(ctx, 'item.deleted', { target: { type: 'item', id: row.id, name: row.title }, reason });
```

`GET /api/audit?q=&actor=&action=&type=&target=&before=&limit=` (newest first, at most 500) for
administrators or whoever `audit({ can: ctx => … })` allows. In the page:

```js
import { auditView } from './lib/audit.js';
auditView(container, { label: action => MY_LABELS[action] });
```

## Rules

- Actions are `area.past_tense` in snake case: `item.deleted`, `host.taken_over`.
- Record after the change succeeded, with the target's name as it was (names change later).
- Never record secrets: keys that look like `password`, `secret`, `token`, `key` or `code` are
  replaced by `(hidden)`; still, do not pass them.
- Rows are never changed; old ones go after the retention time (default 400 days).

## Files

`server/lib/audit.mjs`, `server/migrations-lib/audit/0001_audit_events.sql`, `src/js/lib/audit.js`,
`src/css/lib/audit.css`, `test/unit/lib-audit.test.mjs`
