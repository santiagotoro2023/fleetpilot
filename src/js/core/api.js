// Calls to the API of the app server (blueprint 1.1.1).
//   const items = await api.get('/api/items')
//   await api.post('/api/items', { title: 'New' })
// Errors arrive as Error with the server's message (show it with toast(e.message)).
async function call(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error(data?.error?.message || `The server answered ${r.status}.`);
    e.status = r.status; e.code = data?.error?.code;
    throw e;
  }
  return data;
}
export const api = {
  get: path => call('GET', path),
  post: (path, body) => call('POST', path, body ?? {}),
  put: (path, body) => call('PUT', path, body ?? {}),
  patch: (path, body) => call('PATCH', path, body ?? {}),
  del: path => call('DELETE', path)
};
