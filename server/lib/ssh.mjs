// FleetPilot: SSH keys and certificates with ssh-keygen (from openssh-client, APP_PACKAGES), and
// the first login to a new host with a password (OpenSSH asks SSH_ASKPASS, no sshpass needed).
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A private folder for one operation, removed afterwards */
export async function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(process.env.FLEETPILOT_TMP || os.tmpdir(), 'fp-'));
  fs.chmodSync(dir, 0o700);
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** A new ed25519 key pair in OpenSSH format: { privateKey, publicKey, fingerprint } */
export async function newKeyPair(comment = 'fleetpilot') {
  return withTemp(async dir => {
    const f = path.join(dir, 'key');
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', f]);
    const publicKey = fs.readFileSync(`${f}.pub`, 'utf8').trim();
    return { privateKey: fs.readFileSync(f, 'utf8'), publicKey, fingerprint: await fingerprint(publicKey) };
  });
}

/** SHA256:… of a public key */
export async function fingerprint(publicKey) {
  return withTemp(async dir => {
    const f = path.join(dir, 'k.pub');
    fs.writeFileSync(f, publicKey.trim() + '\n');
    const { stdout } = await run('ssh-keygen', ['-l', '-f', f]);
    return stdout.split(' ')[1];
  });
}

/**
 * Signs a public key with a CA: a user certificate (principals = who it may log in as) or a host
 * certificate (principals = the host's names). Returns the certificate line.
 */
export async function signKey({ caPrivateKey, publicKey, identity, principals, validity = '+1h', host = false }) {
  return withTemp(async dir => {
    const ca = path.join(dir, 'ca'), pub = path.join(dir, 'k.pub');
    fs.writeFileSync(ca, caPrivateKey, { mode: 0o600 });
    fs.writeFileSync(pub, publicKey.trim() + '\n');
    const args = ['-q', '-s', ca, '-I', identity, '-n', principals.join(','), '-V', validity, '-z', String(crypto.randomInt(1, 2 ** 31))];
    if (host) args.push('-h');
    await run('ssh-keygen', [...args, pub]);
    return fs.readFileSync(path.join(dir, 'k-cert.pub'), 'utf8').trim();
  });
}

/** What a certificate says (valid until, principals) */
export async function certInfo(cert) {
  return withTemp(async dir => {
    const f = path.join(dir, 'c-cert.pub');
    fs.writeFileSync(f, cert.trim() + '\n');
    const { stdout } = await run('ssh-keygen', ['-L', '-f', f]);
    const valid = stdout.match(/Valid: from (\S+) to (\S+)/);
    const principals = (stdout.match(/Principals:\s*\n((?:\s{16,}\S+\n?)+)/) || [, ''])[1].split('\n').map(s => s.trim()).filter(Boolean);
    return { validTo: valid?.[2] || null, principals };
  });
}

/**
 * Runs a command on a host over SSH with a password (the first contact of a take-over).
 * The password reaches ssh through SSH_ASKPASS, never on a command line. New host keys are
 * accepted and written to knownHosts. Resolves { code, stdout, stderr }.
 */
export async function sshWithPassword({ host, port = 22, user, password, command, knownHosts, timeout = 30, signal }) {
  return withTemp(async dir => {
    const askpass = path.join(dir, 'askpass');
    fs.writeFileSync(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$FP_ASKPASS"\n', { mode: 0o700 });
    const args = [
      '-o', 'BatchMode=no', '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'NumberOfPasswordPrompts=1', '-o', `ConnectTimeout=${timeout}`, '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
      '-p', String(port), '-l', user, host, command
    ];
    return new Promise((resolve, reject) => {
      const p = spawn('ssh', args, {
        env: { PATH: process.env.PATH, HOME: dir, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0', FP_ASKPASS: password },
        stdio: ['ignore', 'pipe', 'pipe'], signal
      });
      let stdout = '', stderr = '';
      p.stdout.on('data', d => { stdout += d; });
      p.stderr.on('data', d => { stderr += d; });
      const t = setTimeout(() => p.kill('SIGKILL'), (timeout + 60) * 1000);
      p.on('error', e => { clearTimeout(t); reject(e); });
      p.on('close', code => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    });
  });
}

/** The host keys of a host (ssh-keyscan), as known_hosts lines */
export async function scanHostKeys(host, port = 22) {
  const { stdout } = await run('ssh-keyscan', ['-T', '10', '-p', String(port), '-t', 'ed25519,ecdsa,rsa', host]).catch(e => ({ stdout: e.stdout || '' }));
  return stdout.split('\n').filter(l => l && !l.startsWith('#')).join('\n');
}
