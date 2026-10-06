import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { acquireSessionLock, canonicalSessionPath, createOwner, inspectSessionLock, lockLocation, releaseSessionLock } from '../lib/session-lock.mjs';

const roots = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lock-test-'));
  roots.push(dir);
  const session = path.join(dir, 'session.jsonl');
  fs.writeFileSync(session, '');
  return { dir, session, root: path.join(dir, 'locks') };
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function overwrite(root, session, patch) {
  const file = path.join(lockLocation(root, session).lockDir, 'owner.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }));
}

test('exclusive create, same-process reacquisition, safe release', () => {
  const { root, session } = fixture();
  const self = createOwner();
  const first = acquireSessionLock(root, session, self);
  assert.equal(first.status, 'owned');
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(first.lockDir, 'owner.json')).mode & 0o777, 0o600);
  assert.equal(acquireSessionLock(root, session, self).status, 'owned');
  assert.equal(inspectSessionLock(root, session, createOwner()).status, 'live');
  assert.equal(acquireSessionLock(root, session, createOwner()).status, 'live');
  assert.equal(releaseSessionLock(root, session, createOwner()), false);
  assert.equal(releaseSessionLock(root, session, self), true);
  assert.equal(acquireSessionLock(root, session, createOwner()).status, 'owned');
});

test('dead PID and changed boot ID are reclaimed', () => {
  const { root, session } = fixture();
  const self = createOwner();
  acquireSessionLock(root, session, self);
  overwrite(root, session, { pid: 2147483647, ownerId: randomUUID() });
  assert.equal(acquireSessionLock(root, session, self).status, 'owned');
  overwrite(root, session, { bootId: randomUUID(), ownerId: randomUUID() });
  assert.equal(acquireSessionLock(root, session, self).status, 'owned');
});

test('unknown, malformed, remote, and partial locks fail closed', () => {
  const { root, session } = fixture();
  const self = createOwner();
  const { lockDir } = acquireSessionLock(root, session, self);
  overwrite(root, session, { hostname: 'different-host' });
  assert.equal(acquireSessionLock(root, session, self).status, 'unknown');
  overwrite(root, session, { sessionPath: '/wrong/path' });
  assert.equal(acquireSessionLock(root, session, self).status, 'unknown');
  fs.writeFileSync(path.join(lockDir, 'owner.json'), '{broken');
  assert.equal(acquireSessionLock(root, session, self).status, 'unknown');
  fs.unlinkSync(path.join(lockDir, 'owner.json'));
  assert.equal(acquireSessionLock(root, session, self).status, 'unknown');
});

test('canonical path includes symlinks and absent session basename', () => {
  const { dir, session } = fixture();
  fs.symlinkSync(dir, path.join(dir, 'alias'));
  assert.equal(canonicalSessionPath(path.join(dir, 'alias', 'session.jsonl')), session);
  assert.equal(canonicalSessionPath(path.join(dir, 'alias', 'future.jsonl')), path.join(dir, 'future.jsonl'));
  assert.equal(canonicalSessionPath(path.join(dir, 'missing', 'deeper', 'future.jsonl')), path.join(dir, 'missing', 'deeper', 'future.jsonl'));
});

test('reclaim guard fails closed', () => {
  const { root, session } = fixture();
  const self = createOwner();
  const { lockDir } = acquireSessionLock(root, session, self);
  overwrite(root, session, { pid: 2147483647, ownerId: randomUUID() });
  fs.mkdirSync(`${lockDir}.reclaim`);
  assert.equal(acquireSessionLock(root, session, self).status, 'unknown');
});

// Two independent processes contend for the same demonstrably stale owner.
test('concurrent stale reclaim produces exactly one live owner', async () => {
  const { root, session } = fixture();
  const { lockDir } = acquireSessionLock(root, session, createOwner());
  overwrite(root, session, { pid: 2147483647, ownerId: randomUUID() });
  const modulePath = fileURLToPath(new URL('../lib/session-lock.mjs', import.meta.url));
  const code = `import { acquireSessionLock, createOwner } from ${JSON.stringify(modulePath)};
    const result = acquireSessionLock(process.argv[1], process.argv[2], createOwner());
    process.stdout.write(result.status + '\\n');
    setTimeout(() => process.exit(0), 1000);`;
  function child() {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', code, root, session]);
      let output = '', error = '';
      proc.stdout.on('data', chunk => output += chunk);
      proc.stderr.on('data', chunk => error += chunk);
      proc.on('error', reject);
      proc.on('exit', (status) => status === 0 ? resolve(output.trim()) : reject(new Error(error)));
    });
  }
  const results = await Promise.all([child(), child()]);
  assert.equal(results.filter(x => x === 'owned').length, 1, JSON.stringify(results));
  assert.ok(results.every(x => ['owned', 'live', 'unknown'].includes(x)));
  assert.ok(fs.existsSync(path.join(lockDir, 'owner.json')));
});
