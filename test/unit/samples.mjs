// FleetPilot tests: sample values for every setting type (a filled-in form)
const SAMPLE = { path: '/srv/x', name: 'x1', user: 'alice', host: 'example.com', ip: '10.0.0.5', cidr: '10.0.0.0/24', url: 'https://example.com/x', iface: 'eth1', word: 'x', any: 'x', octal: '0644', duration: '1M', cron: '0 3 * * *', ipOrCidr: '10.0.0.0/8', hostport: '10.0.0.5:51820' };
export function sampleValue(f) {
  if (f.type === 'rows') return [Object.fromEntries(f.columns.map(c => [c.key, sampleValue(c)]))];
  if (f.type === 'lines') return [SAMPLE[f.pattern || 'any']];
  if (f.type === 'bool') return true;
  if (f.type === 'number') return f.default ?? 1;
  if (f.type === 'select') return f.options[0][0];
  if (f.type === 'secret') return '1';
  if (f.type === 'textarea') return f.raw ? 'content {{ not a variable }}\n' : 'Some text\n';
  return f.default && typeof f.default === 'string' ? f.default : SAMPLE[f.pattern || 'any'];
}
export const sampleValues = t => Object.fromEntries(t.fields.map(f => [f.key, sampleValue(f)]));
