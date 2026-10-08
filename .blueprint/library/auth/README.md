# Sign-in and accounts (`auth`)

Accounts for a server app: sign-in with user name and password, sessions, a password policy,
two-factor sign-in with an authenticator app (TOTP) and recovery codes, lockouts and rate
limits, administrators who manage the accounts, and the first administrator created with a
one-time setup code. Server and pages in one element, so every app of the family signs in the
same way. Built for FleetPilot.

## When to use

- A server app whose data is not for everyone who can reach it: anything with a login.
- Different people need different rights: the element gives every request a `ctx.user` with
  `isAdmin`; finer rights (roles, scopes) are the app's own tables on top of it.

## When not to use

- Static apps (no server: nothing to sign in to).
- Single sign-on only (OIDC, LDAP): this element signs in against its own accounts.
- Public apps where everyone may read and write.

## API

Server (`server/lib/auth.mjs`):

```js
import { auth, requireAdmin, requireFresh } from './lib/auth.mjs';
await start({ routes: [auth({ onEvent: record, encrypt: secrets.encrypt, decrypt: secrets.decrypt, policy: { totp: 'admins' } }), items] });

app.del('/api/items/:id', async ctx => { requireAdmin(ctx); … });      // 403 for everybody else
app.post('/api/keys/:id/reveal', async ctx => { await requireFresh(ctx); … }); // a code from the last 5 minutes
```

- Every `/api/` route needs a signed-in user (`ctx.user = { id, username, name, isAdmin, totpEnabled, sessionId, pending }`),
  except the sign-in routes and paths given as `open: ['/api/public/…']`. Without one: 401 `signed_out`.
- `onEvent(ctx, action, details)`: `auth.login`, `auth.login_failed`, `auth.password_changed`, `auth.totp_enabled`,
  `auth.user_created`, … (for an audit log, element `audit`).
- `encrypt`/`decrypt`: how TOTP secrets are stored (element `secrets`). Without them they are stored as they are.
- `policy`: the app's defaults; administrators change them in the app (`PUT /api/auth/policy`).
- Also exported: `hashPassword`, `verifyPassword`, `passwordProblems`, `randomPassword`, `totpCode`, `totpMatch`,
  `getPolicy`, `requireUser`.

Routes: `GET /api/auth/state`, `POST /api/auth/setup|login|logout|logout-others|password|verify`,
`POST /api/auth/totp/start|confirm|disable`, `POST /api/auth/recovery-codes`, `GET|DELETE /api/auth/sessions[/:id]`,
for administrators `GET|POST /api/auth/users`, `PATCH|DELETE /api/auth/users/:id`,
`POST /api/auth/users/:id/reset-password|reset-totp`, `GET|PUT /api/auth/policy`.

Web app (`src/js/lib/auth.js`):

```js
import { session, guard, authError, accountView, usersView, policyView, confirmFresh, signOut } from './lib/auth.js';
await session.load();                                   // before startApp()
function route() { clear(); if (guard(main)) return; … } // sign-in, setup, new password, two-factor setup
try { … } catch (e) { if (!authError(e)) toast(e.message); }   // a lapsed session shows the sign-in again
accountView(el);  usersView(el, { extra: u => chips });  policyView(el);
if (await confirmFresh('Show the password')) …          // a fresh code before something sensitive
```

## Rules

- **The first administrator** is created in the browser with the setup code, which the server
  logs at every start while there is no account (`"setup_code"` in the log; the installer prints
  it). `<ID>_SETUP_CODE` sets it explicitly (tests, automation).
- Passwords: scrypt (N 32768, r 8), never logged, never sent back. Length beats character rules:
  the defaults are 12 characters, no well-known passwords, not the own name, not the last 5.
- Messages never tell whether an account exists. Failed sign-ins lock the account for a while
  (policy) and 30 failures from one address in 15 minutes stop that address.
- Sessions: a random token in the `HttpOnly`, `SameSite=Lax` cookie `<id>_session` (`Secure`
  over HTTPS), only its hash in the database; signed out when idle or too old (policy), and on a
  password change everywhere else.
- Users who must change their password or set up two-factor sign-in reach nothing else first.
- Sensitive actions ask again: `requireFresh(ctx)` on the server, `confirmFresh()` in the page.
- Pages: built from the components of the design system; while signed out the rail shows only
  the logo and the theme button (`.auth-out`).

## Files

`server/lib/auth.mjs`, `server/migrations-lib/auth/0001_auth.sql`, `src/js/lib/auth.js`,
`src/css/lib/auth.css`, `test/unit/lib-auth.test.mjs`, `test/browser/lib-auth.test.mjs`; with the
element switched on, `test/lib/auth.mjs` signs the tests in, and the installer prints the setup
code.
