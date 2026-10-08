#!/usr/bin/env node
// The blueprint tool. Every project carries it in .blueprint/tools/ at the version it uses.
//
//   node tools/blueprint.mjs new <dir> --id myapp --name "My App" --repo owner/myapp --profile static|server [--library auth,audit] [--packages "a b"]
//   node .blueprint/tools/blueprint.mjs render      write all blueprint files from project.conf (build.sh runs it)
//   node .blueprint/tools/blueprint.mjs check       does the project follow the blueprint? (CI runs it)
//   node .blueprint/tools/blueprint.mjs update [--to 1.2.0]   move to another blueprint version
//   node .blueprint/tools/blueprint.mjs verify      compare .blueprint/ with the published version on GitHub
//   node .blueprint/tools/blueprint.mjs logo        make the PNG logos (needs Playwright)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseConf, checkConf, variables, layerFiles, libraryFiles, libraryElements, renderFile, renderText, walk, sha256, CONF_KEYS } from './lib/render.mjs';
import { logoSvg, railSvg, faviconHref } from './make-logo.mjs';
import { runChecks } from './lib/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BP = path.resolve(HERE, '..');                    // the blueprint (repo root or a project's .blueprint/)
const BLUEPRINT_REPO = 'santiagotoro2023/project-blueprint';
// What a project carries in .blueprint/
const DIST = ['BLUEPRINT_VERSION', 'CHANGELOG.md', 'core', 'library', 'template', 'tools', 'spec'];

const say = s => console.log(`\x1b[1;34m==>\x1b[0m ${s}`);
const ok = s => console.log(`\x1b[1;32m ✓ \x1b[0m ${s}`);
const die = s => { console.error(`\x1b[1;31m ✗ \x1b[0m ${s}`); process.exit(1); };

function args(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opt[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

const bpVersion = dir => fs.readFileSync(path.join(dir, 'BLUEPRINT_VERSION'), 'utf8').trim();

/** The project around the current directory (or --dir) */
function project(dir = process.cwd()) {
  let d = path.resolve(dir);
  while (!fs.existsSync(path.join(d, 'project.conf'))) {
    const up = path.dirname(d);
    if (up === d) die('No project.conf found here or above. Start a project with: node tools/blueprint.mjs new <dir> …');
    d = up;
  }
  const conf = parseConf(fs.readFileSync(path.join(d, 'project.conf'), 'utf8'));
  const errors = checkConf(conf);
  if (errors.length) die(`project.conf:\n  ${errors.join('\n  ')}`);
  const version = fs.existsSync(path.join(d, 'VERSION')) ? fs.readFileSync(path.join(d, 'VERSION'), 'utf8').trim() : '0.1.0';
  const bpDir = path.join(d, '.blueprint');
  const vars = variables(conf, { version, blueprintVersion: fs.existsSync(path.join(bpDir, 'BLUEPRINT_VERSION')) ? bpVersion(bpDir) : bpVersion(BP) });
  const logo = { pattern: conf.LOGO_PATTERN, colors: conf.LOGO_COLORS.split(',') };
  vars.LOGO_RAIL_SVG = railSvg(logo);
  vars.FAVICON_HREF = faviconHref(logo);
  vars.LIBRARY = conf.LIBRARY || '';
  // Stylesheets of the library elements, between base.css and app.css
  const lib = fs.existsSync(bpDir) ? bpDir : BP;
  vars.LIBRARY_CSS = libraryElements(lib, vars).filter(e => fs.existsSync(path.join(e.dir, 'files', 'src', 'css', 'lib', `${e.name}.css`)))
    .map(e => `<link rel="stylesheet" href="css/lib/${e.name}.css">`).join('\n');
  return { dir: d, conf, version, bpDir, vars };
}

// ---------------------------------------------------------------- .blueprint/ and its manifest
function manifest(dir) {
  return walk(dir).filter(f => f !== 'MANIFEST').map(f => `${sha256(fs.readFileSync(path.join(dir, f)))}  ${f}`).join('\n') + '\n';
}
function vendor(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const item of DIST) fs.cpSync(path.join(from, item), path.join(to, item), { recursive: true });
  fs.writeFileSync(path.join(to, 'MANIFEST'), manifest(to));
}
export function integrity(dir) {
  const want = fs.readFileSync(path.join(dir, 'MANIFEST'), 'utf8');
  const have = manifest(dir);
  if (want === have) return [];
  const a = new Set(want.trim().split('\n')), b = new Set(have.trim().split('\n'));
  return [...[...a].filter(x => !b.has(x)).map(x => `missing or changed: ${x.slice(66)}`), ...[...b].filter(x => !a.has(x)).map(x => `added or changed: ${x.slice(66)}`)];
}

// ---------------------------------------------------------------- Rendering
/** Every file the blueprint owns in a project: [{ dest, content }] */
export function coreOutput(bpDir, vars) {
  // A core file that renders empty (all of it inside @@IF lib:…@@ of an element that is off) is not written
  const out = [...layerFiles(bpDir, 'core', vars).filter(f => !f.dest.startsWith('_blocks/')), ...libraryFiles(bpDir, vars)].map(f => ({ dest: f.dest, content: renderFile(f, vars) })).filter(f => f.content.length > 0);
  // The logo: always made from LOGO_PATTERN and LOGO_COLORS
  const opts = { pattern: vars.LOGO_PATTERN, colors: vars.LOGO_COLORS.split(',') };
  for (const theme of ['light', 'dark']) out.push({ dest: `assets/logo/${vars.APP_ID}-icon-${theme}.svg`, content: Buffer.from(logoSvg({ ...opts, theme }) + '\n') });
  return out.sort((a, b) => a.dest.localeCompare(b.dest));
}
/** Managed blocks: <!-- blueprint:NAME --> … <!-- /blueprint:NAME --> inside project-owned files */
export function blocks(bpDir, vars) {
  return layerFiles(bpDir, 'core', vars).filter(f => f.dest.startsWith('_blocks/')).map(f => {
    const [, file, name] = f.dest.match(/^_blocks\/(.+)\.([a-z-]+)\.block$/) || [];
    if (!file) throw new Error(`Block file name must be _blocks/<file>.<name>.block: ${f.dest}`);
    return { file: file.replace(/__/g, '/'), name, content: renderFile(f, vars).toString().replace(/\n+$/, '') };
  });
}
export function applyBlock(text, b) {
  const re = new RegExp(`(<!-- blueprint:${b.name} -->)[\\s\\S]*?(<!-- /blueprint:${b.name} -->)`);
  if (!re.test(text)) return null;
  return text.replace(re, (_, a, z) => `${a}\n${b.content}\n${z}`);
}

function render(p, { quiet = false } = {}) {
  const lockFile = path.join(p.dir, 'blueprint.lock');
  const old = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : { files: [] };
  const deviated = deviatedFiles(p.dir);
  const out = coreOutput(p.bpDir, p.vars);
  let written = 0;
  for (const f of out) {
    const to = path.join(p.dir, f.dest);
    if (deviated.has(f.dest)) { if (!quiet) console.log(`    kept (approved deviation): ${f.dest}`); continue; }
    if (fs.existsSync(to) && fs.readFileSync(to).equals(f.content)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, f.content);
    if (/\.(sh)$/.test(f.dest) || f.dest === 'build.sh') fs.chmodSync(to, 0o755);
    written++;
    if (!quiet) console.log(`    ${f.dest}`);
  }
  // Files the blueprint wrote before but no longer has
  const now = new Set(out.map(f => f.dest));
  for (const f of old.files || []) {
    if (now.has(f) || !fs.existsSync(path.join(p.dir, f)) || deviated.has(f)) continue;
    fs.rmSync(path.join(p.dir, f));
    console.log(`    removed (no longer part of this project's blueprint files): ${f}`);
    // and the folders that became empty
    for (let d = path.dirname(path.join(p.dir, f)); d.startsWith(p.dir + path.sep) && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d);
  }
  for (const b of blocks(p.bpDir, p.vars)) {
    const file = path.join(p.dir, b.file);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8'), next = applyBlock(text, b);
    if (next !== null && next !== text) { fs.writeFileSync(file, next); written++; if (!quiet) console.log(`    ${b.file} (block ${b.name})`); }
  }
  // Migrations, once recorded, keep their checksum: check fails if one is changed or removed later
  const lock = { blueprint: p.vars.BLUEPRINT_VERSION, profile: p.conf.APP_PROFILE, files: [...now] };
  if (p.conf.APP_PROFILE === 'server') {
    const migs = (old.migrations || []).slice();
    for (const f of walk(path.join(p.dir, 'server/migrations')).filter(f => f.endsWith('.sql'))) {
      if (!migs.some(m => m.file === f)) migs.push({ file: f, sha256: sha256(fs.readFileSync(path.join(p.dir, 'server/migrations', f))) });
    }
    lock.migrations = migs;
  }
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  return written;
}

/** Paths listed in DEVIATIONS.md as approved deviations ("## File: path") */
export function deviatedFiles(dir) {
  const f = path.join(dir, 'DEVIATIONS.md');
  if (!fs.existsSync(f)) return new Set();
  return new Set([...fs.readFileSync(f, 'utf8').matchAll(/^## File: `?([^`\n]+?)`?\s*$/gm)].map(m => m[1].trim()));
}

// ---------------------------------------------------------------- Commands
async function cmdNew(pos, opt) {
  const dir = pos[0] && path.resolve(pos[0]);
  if (!dir) die('Where? node tools/blueprint.mjs new <dir> --id … --name … --repo … --profile static|server');
  if (fs.existsSync(dir) && fs.readdirSync(dir).filter(f => f !== '.git').length) die(`${dir} is not empty.`);
  const id = opt.id || path.basename(dir);
  const conf = {
    APP_ID: id,
    APP_NAME: opt.name || id.replace(/(^|-)([a-z])/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase()),
    APP_TAGLINE: opt.tagline || 'One sentence that says what this app does.',
    APP_DESCRIPTION: opt.description || 'Two sentences for the container image and the Helm chart: what the app is and who it is for.',
    APP_REPO: opt.repo || `santiagotoro2023/${id}`,
    APP_PROFILE: opt.profile || 'static',
    APP_PORT: String(opt.port || 8080),
    APP_KEYWORDS: opt.keywords || 'web app',
    APP_DATA_NOTE: opt['data-note'] || (opt.profile === 'server' ? 'All data lives in the PostgreSQL database and survives updates.' : 'Everything users do is stored in their browser and survives updates.'),
    LOGO_PATTERN: opt.pattern || 'bars',
    LOGO_COLORS: opt.colors || 'blue,green,brown,orange'
  };
  // Library elements and packages already at the start: the template wires them in
  if (opt.library) conf.LIBRARY = String(opt.library);
  if (opt.packages) conf.APP_PACKAGES = String(opt.packages);
  const errors = checkConf(conf);
  if (errors.length) die(`Settings:\n  ${errors.join('\n  ')}`);
  say(`New ${conf.APP_PROFILE} project ${conf.APP_NAME} in ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  const order = Object.keys(CONF_KEYS);
  fs.writeFileSync(path.join(dir, 'project.conf'), '# Blueprint settings of this project (see .blueprint/spec/03-repository.md, "project.conf").\n# Every blueprint file is rendered from them: change them, then run build.sh.\n' + [...order, 'LIBRARY', 'APP_PACKAGES'].filter(k => k in conf).map(k => `${k}="${conf[k].replace(/(["\\$`])/g, '\\$1')}"`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'VERSION'), '0.1.0\n');
  vendor(BP, path.join(dir, '.blueprint'));
  const p = project(dir);
  for (const f of layerFiles(p.bpDir, 'template', p.vars)) {
    const to = path.join(dir, f.dest);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, renderFile(f, p.vars));
    if (f.dest.endsWith('.sh')) fs.chmodSync(to, 0o755);
  }
  render(p, { quiet: true });
  // The lockfile of the dependencies (CI installs exactly these), and the PNG logos when Playwright is there
  try { execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio: 'ignore' }); ok('package-lock.json'); }
  catch { console.log('    package-lock.json: run "npm install" in the project once the network is there'); }
  try {
    const { makePngs } = await import('./make-logo.mjs');
    await makePngs({ name: conf.APP_ID, pattern: conf.LOGO_PATTERN, colors: conf.LOGO_COLORS.split(','), out: path.join(dir, 'assets/logo') });
  } catch { console.log('    PNG logos: run "npm install", then node .blueprint/tools/blueprint.mjs logo'); }
  ok(`Created. Next: cd ${path.relative(process.cwd(), dir) || '.'} && npm install && bash build.sh && node test/run.mjs`);
}

function cmdRender() {
  const p = project();
  const n = render(p);
  ok(n ? `${n} file(s) written from blueprint ${p.vars.BLUEPRINT_VERSION}` : `All blueprint files up to date (blueprint ${p.vars.BLUEPRINT_VERSION})`);
}

function cmdCheck(opt) {
  const p = project();
  const problems = runChecks(p, { integrity, coreOutput, blocks, applyBlock, deviatedFiles });
  if (problems.length) {
    console.error(`\x1b[1;31m ✗ \x1b[0m ${problems.length} problem(s) with blueprint ${p.vars.BLUEPRINT_VERSION}:`);
    for (const x of problems) console.error(`    - ${x}`);
    console.error('    Fix them, or run build.sh if a blueprint file is out of date. A deliberate deviation needs an approved entry in DEVIATIONS.md.');
    process.exit(1);
  }
  ok(`${p.conf.APP_NAME} follows blueprint ${p.vars.BLUEPRINT_VERSION} (${p.conf.APP_PROFILE} profile)`);
}

function download(ref, to) {
  const url = `https://codeload.github.com/${BLUEPRINT_REPO}/tar.gz/${ref}`;
  fs.mkdirSync(to, { recursive: true });
  try { execFileSync('sh', ['-c', `curl -fsSL "${url}" | tar -xz -C "${to}" --strip-components=1`], { stdio: ['ignore', 'ignore', 'inherit'] }); }
  catch { die(`Could not download ${url}`); }
  return to;
}
const tagRef = v => /^\d+\.\d+\.\d+$/.test(v) ? `refs/tags/v${v}` : v;

function changelogBetween(file, from, to) {
  if (!fs.existsSync(file)) return '';
  const parts = fs.readFileSync(file, 'utf8').split(/^(?=## )/m);
  const cmp = (a, b) => a.split('.').map(Number).reduce((r, x, i) => r || x - Number(b.split('.')[i] || 0), 0);
  return parts.filter(s => { const v = (s.match(/^## (\d+\.\d+\.\d+)/) || [])[1]; return v && cmp(v, from) > 0 && cmp(v, to) <= 0; }).join('');
}

function cmdUpdate(opt) {
  const p = project();
  const from = p.vars.BLUEPRINT_VERSION;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-'));
  let src;
  if (opt.from) src = path.resolve(opt.from);                       // a local checkout of project-blueprint
  else {
    let to = opt.to;
    if (!to) {
      try { to = execFileSync('sh', ['-c', `curl -fsSL https://raw.githubusercontent.com/${BLUEPRINT_REPO}/main/BLUEPRINT_VERSION`]).toString().trim(); }
      catch { die('Could not ask GitHub for the newest blueprint version. Name it with --to 1.2.0'); }
    }
    say(`Downloading blueprint ${to}`);
    src = download(tagRef(to), tmp);
  }
  const to = bpVersion(src);
  if (to === from && !opt.force) { ok(`Already on blueprint ${to}`); return; }
  const notes = changelogBetween(path.join(src, 'CHANGELOG.md'), from, to);
  say(`Blueprint ${from} → ${to}`);
  vendor(src, p.bpDir);
  // Render with the tool of the new version: it may know markers this one does not
  const r = spawnSync(process.execPath, [path.join(p.bpDir, 'tools', 'blueprint.mjs'), 'render'], { cwd: p.dir, encoding: 'utf8' });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  if (r.status !== 0) die('Rendering with the new blueprint failed (see above).');
  if (notes) console.log(`\nWhat changed (read the "Projects must" lines):\n\n${notes.trim().replace(/^/gm, '  ')}\n`);
  console.log('Next: bash build.sh, run all tests, fix what check reports, then commit:');
  console.log(`  git commit -am "Blueprint ${to}"`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

function cmdVerify() {
  const p = project();
  const v = p.vars.BLUEPRINT_VERSION;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-'));
  say(`Comparing .blueprint/ with blueprint ${v} on GitHub`);
  const src = download(tagRef(v), path.join(tmp, 'src'));
  const ref = path.join(tmp, 'ref');
  vendor(src, ref);
  const a = fs.readFileSync(path.join(ref, 'MANIFEST'), 'utf8'), b = fs.readFileSync(path.join(p.bpDir, 'MANIFEST'), 'utf8');
  fs.rmSync(tmp, { recursive: true, force: true });
  if (a !== b) die(`.blueprint/ differs from the published blueprint ${v}. Restore it with: node .blueprint/tools/blueprint.mjs update --to ${v} --force`);
  ok(`.blueprint/ is exactly blueprint ${v} as published`);
}

async function cmdLogo() {
  const p = project();
  const { makePngs } = await import('./make-logo.mjs');
  await makePngs({ name: p.conf.APP_ID, pattern: p.conf.LOGO_PATTERN, colors: p.conf.LOGO_COLORS.split(','), out: path.join(p.dir, 'assets/logo') });
}

export { render, project, vendor, manifest };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { pos, opt } = args(process.argv.slice(2));
  const cmd = pos.shift();
  try {
    if (cmd === 'new') await cmdNew(pos, opt);
    else if (cmd === 'render') cmdRender();
    else if (cmd === 'check') cmdCheck(opt);
    else if (cmd === 'update') cmdUpdate(opt);
    else if (cmd === 'verify') cmdVerify();
    else if (cmd === 'logo') await cmdLogo();
    else { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(cmd ? 1 : 0); }
  } catch (e) { die(e.message); }
}
