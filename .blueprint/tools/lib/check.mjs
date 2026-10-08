// `blueprint check`: does a project follow the blueprint? Returns a list of problems.
import fs from 'node:fs';
import path from 'node:path';
import { walk, sha256 } from './render.mjs';

const read = (p, f) => fs.existsSync(path.join(p.dir, f)) ? fs.readFileSync(path.join(p.dir, f), 'utf8') : null;

// The allowed dependencies per profile. Anything else needs an approved deviation.
const ALLOWED = {
  static: { dependencies: [], devDependencies: ['playwright'] },
  server: { dependencies: ['pg'], devDependencies: ['playwright'] }
};
const README_SECTIONS = ['Installation', 'Debian installer', "Let's Encrypt", 'Your data is safe', 'Logo', 'Development'];
const BLOCK_MARKERS = [['README.md', 'install'], ['README.md', 'logo'], ['README.md', 'development'], ['CLAUDE.md', 'rules'], ['src/index.html', 'head'], ['src/index.html', 'logo']];

/** Approved deviations: "## <title>" sections with "Approved:" and "Reason:" lines */
export function deviations(p) {
  const text = read(p, 'DEVIATIONS.md');
  if (text === null) return { list: [], problems: ['DEVIATIONS.md is missing (it may say "None.")'] };
  const list = [], problems = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const title = part.split('\n')[0].trim();
    const approved = (part.match(/^Approved:\s*(.+)$/m) || [])[1];
    const reason = (part.match(/^Reason:\s*(.+)$/m) || [])[1];
    if (!approved || !/\d{4}-\d{2}-\d{2}/.test(approved)) problems.push(`DEVIATIONS.md "${title}": needs a line "Approved: <who>, <YYYY-MM-DD>"`);
    if (!reason || reason.length < 20) problems.push(`DEVIATIONS.md "${title}": needs a line "Reason: …" that explains why`);
    const file = (title.match(/^File: `?([^`]+?)`?$/) || [])[1];
    const dep = (title.match(/^Dependency: `?([^`\s]+)`?$/) || [])[1];
    list.push({ title, file, dep, text: part });
  }
  return { list, problems };
}

export function runChecks(p, { integrity, coreOutput, blocks, applyBlock }) {
  const problems = [];
  const P = s => problems.push(s);

  // 1. .blueprint/ is exactly a published blueprint (nothing edited by hand)
  if (!fs.existsSync(path.join(p.bpDir, 'MANIFEST'))) P('.blueprint/ is missing or has no MANIFEST');
  else for (const x of integrity(p.bpDir)) P(`.blueprint/ was changed by hand: ${x}`);

  const dev = deviations(p);
  problems.push(...dev.problems);
  const devFiles = new Set(dev.list.map(d => d.file).filter(Boolean));
  const devDeps = new Set(dev.list.map(d => d.dep).filter(Boolean));

  // 2. Every file the blueprint owns is exactly as rendered from project.conf and VERSION
  for (const f of coreOutput(p.bpDir, p.vars)) {
    const have = fs.existsSync(path.join(p.dir, f.dest)) ? fs.readFileSync(path.join(p.dir, f.dest)) : null;
    if (devFiles.has(f.dest)) continue;
    if (!have) P(`missing blueprint file: ${f.dest} (run build.sh)`);
    else if (!have.equals(f.content)) P(`blueprint file differs: ${f.dest} (run build.sh; to change it on purpose, see spec/11-deviations.md)`);
  }
  for (const f of devFiles) if (!coreOutput(p.bpDir, p.vars).some(o => o.dest === f)) P(`DEVIATIONS.md names ${f}, which is not a blueprint file`);

  // 3. Managed blocks in README.md and CLAUDE.md
  for (const [file, name] of BLOCK_MARKERS) {
    const text = read(p, file);
    if (text === null) { P(`${file} is missing`); continue; }
    if (!text.includes(`<!-- blueprint:${name} -->`) || !text.includes(`<!-- /blueprint:${name} -->`)) P(`${file}: the block <!-- blueprint:${name} --> … <!-- /blueprint:${name} --> is missing`);
  }
  for (const b of blocks(p.bpDir, p.vars)) {
    const text = read(p, b.file);
    if (text === null) continue;
    const next = applyBlock(text, b);
    if (next !== null && next !== text) P(`${b.file}: the block "${b.name}" differs from the blueprint (run build.sh)`);
  }

  // 4. Required files and structure
  const need = ['project.conf', 'VERSION', 'README.md', 'CLAUDE.md', 'DEVIATIONS.md', 'package.json', '.gitignore', 'src/index.html', 'src/css/app.css', 'src/js/app.js', 'installer/app.sh', `${p.conf.APP_ID}-install.sh`, 'blueprint.lock',
    `assets/logo/${p.conf.APP_ID}-icon-light.png`, `assets/logo/${p.conf.APP_ID}-icon-dark.png`];
  if (p.conf.APP_PROFILE === 'static') need.push('src/js/store.js');
  if (p.conf.APP_PROFILE === 'server') need.push('server/main.mjs', 'package-lock.json');
  for (const f of need) if (read(p, f) === null && !fs.existsSync(path.join(p.dir, f))) P(`missing: ${f}`);
  if (!/^\d+\.\d+\.\d+$/.test(p.version)) P(`VERSION must be semantic: MAJOR.MINOR.PATCH, found "${p.version}"`);
  for (const d of ['test/unit', 'test/browser']) {
    const own = walk(path.join(p.dir, d)).filter(f => f.endsWith('.test.mjs') && f !== 'blueprint.test.mjs');
    if (!own.length) P(`${d}/ has no tests of this app (besides blueprint.test.mjs)`);
  }
  const gi = read(p, '.gitignore') || '';
  for (const g of ['node_modules/', 'test/.output/']) if (!gi.split('\n').includes(g)) P(`.gitignore must contain ${g}`);

  // 5. README: the title, the tagline, the sections in order
  const readme = read(p, 'README.md') || '';
  if (!readme.startsWith(`# ${p.conf.APP_NAME}\n\n${p.conf.APP_TAGLINE}\n`)) P(`README.md must start with "# ${p.conf.APP_NAME}", an empty line and the tagline from project.conf`);
  let at = 0;
  for (const s of README_SECTIONS) {
    const i = readme.search(new RegExp(`^#{2,3} ${s.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}$`, 'm'));
    if (i < 0) P(`README.md: section "${s}" is missing`);
    else if (i < at) P(`README.md: section "${s}" is out of order (${README_SECTIONS.join(' → ')})`);
    else at = i;
  }
  if (!/^## What's inside$/m.test(readme)) P('README.md: section "What\'s inside" (what the app does, in detail) is missing');

  // 6. The shell in src/index.html
  const html = read(p, 'src/index.html') || '';
  const must = [
    ['<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>', 'the start of the page (doctype, lang="en", charset, viewport, title)'],
    ['<body>\n<div class="app">\n  <nav class="rail" aria-label="Main navigation">\n<!-- blueprint:logo -->', 'the rail with the logo first'],
    ['    <span class="spacer"></span>\n    <button id="theme" type="button" title="Light or dark"></button>\n  </nav>\n  <main class="main"></main>\n</div>', 'spacer, theme button and main area'],
    ["document.querySelectorAll('[data-icon]').forEach(e => e.innerHTML = I[e.dataset.icon]);", 'the icon script at the end']
  ];
  for (const [s, what] of must) if (!html.includes(s)) P(`src/index.html: ${what} is not as in the blueprint template`);
  const entries = [...html.matchAll(/^    <a href="#\/[^"]*" data-nav="[a-z-]+"><span data-icon="[a-z0-9-]+"><\/span>([^<]+)<\/a>$/gm)].map(m => m[1]);
  if (entries.length < 2 || entries.length > 6) P(`src/index.html: the rail needs 2 to 6 menu entries in the template's form, found ${entries.length}`);
  for (const e of entries) if (e.length > 9) P(`src/index.html: menu label "${e}" is longer than 9 characters`);
  if (/<(script|link)[^>]+(src|href)="(https?:)?\/\//.test(html)) P('src/index.html loads something from another server');

  // 7. The app's own CSS and JS stay inside the design system
  for (const f of walk(path.join(p.dir, 'src')).filter(f => f.endsWith('.css') && f !== 'css/base.css')) {
    const css = read(p, `src/${f}`);
    const devOk = devFiles.has(`src/${f}`);
    if (devOk) continue;
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = [...noComments.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]).filter(h => !/^#fff(fff)?$/i.test(h));
    if (hex.length) P(`src/${f}: colors must come from the tokens of base.css (var(--…)), found ${[...new Set(hex)].join(', ')}`);
    if (/font-family\s*:/.test(noComments.replace(/font-family:\s*var\(--(font|mono)\)/g, ''))) P(`src/${f}: font-family other than var(--font) or var(--mono)`);
    if (/@import|@font-face/.test(noComments)) P(`src/${f}: @import and @font-face belong to base.css only`);
    const shadows = [...noComments.matchAll(/box-shadow\s*:\s*([^;]+);/g)].map(m => m[1].trim()).filter(v => !/^(var\(--shadow\)|none|(inset )?0 0 0 [1-3]px (var\(--[a-z0-9-]+\)|color-mix\(.+\)))$/.test(v));
    if (shadows.length) P(`src/${f}: box-shadow other than var(--shadow) or a thin ring: ${shadows[0]}`);
  }
  for (const f of walk(path.join(p.dir, 'src')).filter(f => /\.(js|html)$/.test(f) && !f.startsWith('js/core/'))) {
    const t = read(p, `src/${f}`);
    if (/(https?:)?\/\/(cdn|unpkg|cdnjs|fonts\.googleapis|fonts\.gstatic)/.test(t)) P(`src/${f}: loads from a CDN`);
  }

  // 7b. Library elements are used only when they are switched on in project.conf (LIBRARY)
  const used = new Set((p.conf.LIBRARY || '').split(',').filter(Boolean));
  for (const f of walk(path.join(p.dir, 'src')).filter(f => /\.(js|html|css)$/.test(f))) {
    for (const m of (read(p, `src/${f}`) || '').matchAll(/(?:js|css)\/lib\/([a-z][a-z0-9-]*)\.(?:js|css)|\.\/lib\/([a-z][a-z0-9-]*)\.js/g)) {
      const name = m[1] || m[2];
      if (!used.has(name)) P(`src/${f} uses the library element "${name}", which is not in LIBRARY in project.conf`);
    }
  }

  // 8. Dependencies
  let pkg = {};
  try { pkg = JSON.parse(read(p, 'package.json') || '{}'); } catch { P('package.json is not valid JSON'); }
  const allowed = ALLOWED[p.conf.APP_PROFILE];
  for (const kind of ['dependencies', 'devDependencies']) {
    for (const d of Object.keys(pkg[kind] || {})) if (!allowed[kind].includes(d) && !devDeps.has(d)) P(`package.json: ${kind} "${d}" is not in the blueprint (allowed: ${allowed[kind].join(', ') || 'none'}); it needs an approved deviation "## Dependency: ${d}"`);
  }
  if (pkg.type !== 'module') P('package.json: "type": "module" is required');
  for (const [k, v] of Object.entries({ test: 'node test/run.mjs', 'test:browser': 'node test/run.mjs --browser', build: 'bash build.sh', check: 'node .blueprint/tools/blueprint.mjs check' })) {
    if ((pkg.scripts || {})[k] !== v) P(`package.json: script "${k}" must be "${v}"`);
  }

  // 9. Server profile: migrations and database
  if (p.conf.APP_PROFILE === 'server') {
    const mig = walk(path.join(p.dir, 'server/migrations'));
    if (!mig.length) P('server/migrations/ is empty: the schema starts with 0001_<name>.sql');
    mig.forEach((f, i) => {
      if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(f)) P(`server/migrations/${f}: name must be NNNN_lowercase_name.sql`);
      else if (Number(f.slice(0, 4)) !== i + 1) P(`server/migrations/${f}: numbers must run 0001, 0002, … without gaps`);
    });
    const lock = read(p, 'blueprint.lock');
    const known = lock ? (JSON.parse(lock).migrations || []) : [];
    for (const m of known) {
      if (!mig.includes(m.file)) P(`server/migrations/${m.file} was removed: migrations are never deleted or renamed`);
      else if (sha256(fs.readFileSync(path.join(p.dir, 'server/migrations', m.file))) !== m.sha256) P(`server/migrations/${m.file} was changed after it was recorded: add a new migration instead (spec/07-backend.md)`);
    }
    for (const f of walk(path.join(p.dir, 'server')).filter(f => f.endsWith('.mjs') || f.endsWith('.js'))) {
      const t = read(p, `server/${f}`);
      if (/from ['"](sqlite3?|better-sqlite3|mysql2?|mariadb|redis|ioredis|mongodb|mongoose|knex|sequelize|typeorm|prisma|express|fastify|koa)['"]/.test(t) && !dev.list.some(d => d.dep && t.includes(`'${d.dep}'`))) P(`server/${f}: uses a library outside the blueprint (needs an approved deviation)`);
    }
  }
  return problems;
}
