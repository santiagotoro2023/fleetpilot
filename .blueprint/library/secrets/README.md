# Secrets at rest (`secrets`)

Passwords, private keys, API tokens and other sensitive values are stored **encrypted** in
PostgreSQL (AES-256-GCM). The key lives outside the database, so a stolen database dump or
backup is useless without it. Taken from FleetPilot's vault.

## When to use

- The app stores values that would do harm in the wrong hands: passwords and keys for other
  systems, API tokens, TOTP secrets, personal data the owner wants protected beyond the
  database's own access control.

## When not to use

- Passwords of the app's own users: those are hashed (scrypt, library element `auth`), never
  encrypted.
- Data that must be searched or sorted in the database: encrypted values can only be read whole.
- Static apps: there is no server and no key.

## API

```js
import { secrets, setupSecrets } from './lib/secrets.mjs';
await start({ routes: [setupSecrets, items] });   // server/main.mjs: checks the key at start

const token = secrets.encrypt('s3cret');          // 'v1.<key id>.<iv>.<tag>.<data>', store as text
secrets.decrypt(token);                           // 's3cret'
secrets.needsRotation(token);                     // made with the previous key: encrypt again
```

`createCipher(key, [previousKeys])`, `newKey()` and `parseKey()` are there for tests and tools.
`node server/lib/secrets.mjs --new-key` prints a new key.

**The key** (32 random bytes in base64):

| Deployment | Where the key comes from |
|---|---|
| Debian installer | created once in `/var/lib/<id>/<id>.key` (mode 640, root:<id>); kept by updates and `--uninstall`, removed only by `--uninstall --purge` |
| Docker Compose | created by the app on its first start in the volume `keys` |
| Helm | a Secret `<release>-key`, generated once and never deleted by `helm uninstall`; or `secretKey.existingSecret` |
| Kubernetes manifest | the Secret `<id>-key`: put a new key in before the first apply |
| Anything else | `<ID>_SECRET_KEY`, or `<ID>_SECRET_KEY_FILE` (created when missing and nothing is encrypted yet) |

## Rules

- **Back the key up apart from the database backups.** Without it, the encrypted values in a
  backup cannot be read. The installer says where it is.
- The first key is recorded (only its id, in `secret_keys`). A different key stops the app with
  a clear message instead of making data unreadable: a lost key file is never replaced silently.
- **Changing the key:** set the new one, give the old one as `<ID>_SECRET_KEY_PREVIOUS`, let the
  app encrypt everything again (every value with `needsRotation()`), then remove the old key.
- Never log decrypted values, never send them to the browser unless a person explicitly asked
  to see one (and the app records that, for example with the element `audit`).

## Files

`server/lib/secrets.mjs`, `server/migrations-lib/secrets/0001_secret_keys.sql`,
`test/unit/lib-secrets.test.mjs`; with the element switched on, the installer, the image, Compose,
Helm and the Kubernetes manifest provide the key (blocks `@@IF lib:secrets@@` in core).
