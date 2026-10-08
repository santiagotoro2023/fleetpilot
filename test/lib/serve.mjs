// A small static file server for tests and local development: the web app from src/
// with the same headers, health check and fallback as nginx in production.
//   node test/lib/serve.mjs [port]        then open http://localhost:8080
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'";
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': CSP
};
export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp'
};

export function serve({ root, port = 0, host = '127.0.0.1', version = 'dev' }) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra }); res.end(req.method === 'HEAD' ? undefined : body); };
    if (url.pathname === '/healthz') return send(200, 'text/plain', 'ok\n');
    if (url.pathname === '/site.json' && !fs.existsSync(path.join(root, 'site.json'))) return send(200, 'application/json', JSON.stringify({ version }) + '\n', { 'Cache-Control': 'no-store' });
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) return send(403, 'text/plain', 'forbidden\n');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) file = path.join(root, 'index.html');   // like try_files … /index.html
    const ext = path.extname(file);
    send(200, TYPES[ext] || 'application/octet-stream', fs.readFileSync(file), /\.(js|css|json|html)$/.test(ext) ? { 'Cache-Control': 'no-cache' } : {});
  });
  return new Promise(res => server.listen(port, host, () => res({ port: server.address().port, close: () => server.close() })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const s = await serve({ root: path.join(here, '..', '..', 'src'), port: Number(process.argv[2] || 8080), host: '0.0.0.0' });
  console.log(`Serving src/ on http://localhost:${s.port}/`);
}
