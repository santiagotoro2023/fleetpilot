// Any JSON value as a compact, URL safe string, for links that carry data after the #
// (share links, moving data to another address). Nothing is uploaded: browsers never
// send the part after the # to a server.
const toB64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const fromB64 = s => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(bin, c => c.charCodeAt(0)); };
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

/** 'z' + deflated base64url, or 'j' + plain base64url where the browser cannot compress */
export async function pack(value) {
  const json = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  if (typeof CompressionStream === 'function') return 'z' + toB64(await pipe(json, new CompressionStream('deflate-raw')));
  return 'j' + toB64(json);
}
export async function unpack(code) {
  const kind = code[0], bytes = fromB64(code.slice(1));
  const raw = kind === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
  return JSON.parse(new TextDecoder().decode(raw));
}
