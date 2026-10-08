// Logs of the app server (blueprint @@BLUEPRINT_VERSION@@): one JSON object per line on stdout,
// readable by journalctl, docker logs and kubectl logs alike.
import { config } from './config.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[config.logLevel] ?? LEVELS.info;
function write(level, msg, fields = {}) {
  if (LEVELS[level] < min) return;
  const line = { t: new Date().toISOString(), level, msg, ...fields };
  (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}
export const log = {
  debug: (m, f) => write('debug', m, f),
  info: (m, f) => write('info', m, f),
  warn: (m, f) => write('warn', m, f),
  error: (m, f) => write('error', m, f)
};
