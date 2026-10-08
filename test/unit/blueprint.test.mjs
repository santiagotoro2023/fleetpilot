// Blueprint 1.1.1: the project follows the blueprint (the same check as in CI).
import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['.blueprint/tools/blueprint.mjs', 'check'], { encoding: 'utf8' });
process.stdout.write(r.stdout); process.stderr.write(r.stderr);
if (r.status !== 0) process.exit(1);
console.log('blueprint: check passed');
