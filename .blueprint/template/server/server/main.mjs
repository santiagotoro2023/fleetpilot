// @@APP_NAME@@: the app server. The blueprint's core (server/core/) does configuration,
// database, migrations and HTTP; this file only lists the API of this app (server/api/).
import { start } from './core/server.mjs';
@@IF lib:secrets@@
import { secrets, setupSecrets } from './lib/secrets.mjs';
@@END@@
@@IF lib:auth@@
import { auth } from './lib/auth.mjs';
@@END@@
@@IF lib:audit@@
import { audit, record } from './lib/audit.mjs';
@@END@@
@@IF lib:jobs@@
import { startJobs, stopJobs } from './lib/jobs.mjs';
@@END@@
import items from './api/items.mjs';

await start({
  routes: [
@@IF lib:secrets@@
    setupSecrets,
@@END@@
@@IF lib:auth@@
@@IF lib:audit@@
@@IF lib:secrets@@
    auth({ onEvent: record, encrypt: secrets.encrypt, decrypt: secrets.decrypt }),
@@ELSE@@
    auth({ onEvent: record }),
@@END@@
    audit(),
@@ELSE@@
@@IF lib:secrets@@
    auth({ encrypt: secrets.encrypt, decrypt: secrets.decrypt }),
@@ELSE@@
    auth(),
@@END@@
@@END@@
@@END@@
    items
  ],
@@IF lib:jobs@@
  onStart: () => startJobs(),
  onStop: stopJobs
@@END@@
});
