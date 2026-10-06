import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lockLocation } from '../lib/session-lock.mjs';

const extension = fileURLToPath(new URL('../index.ts', import.meta.url));
const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lock-agent-test-'));
const root = path.join(testAgentDir, 'session-locks');
const pi = process.env.PI_TEST_BIN || 'pi';
const testEnv = { ...process.env, PI_CODING_AGENT_DIR: testAgentDir, PI_OFFLINE: '1' };
after(() => fs.rmSync(testAgentDir, { recursive: true, force: true }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0;

class Client {
  constructor(session) {
    this.proc = spawn(pi, ['--mode', 'rpc', '--offline', '--no-extensions', '--no-mcp', '--no-skills',
      '--no-context-files', '-e', extension, '--session', session], { cwd: os.tmpdir(), env: testEnv });
    this.events = [];
    this.waiters = new Map();
    this.stderr = '';
    this.proc.stderr.on('data', chunk => this.stderr += chunk);
    let buffer = '';
    this.proc.stdout.on('data', chunk => {
      buffer += chunk;
      let n;
      while ((n = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
        if (!line) continue;
        const record = JSON.parse(line);
        this.events.push(record);
        if (record.type === 'response' && record.id && this.waiters.has(record.id)) {
          this.waiters.get(record.id)(record);
          this.waiters.delete(record.id);
        }
      }
    });
  }
  async request(command) {
    const id = `test-${++sequence}`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout for ${command.type}: ${this.stderr}`)), 10000);
      this.waiters.set(id, record => { clearTimeout(timer); resolve(record); });
    });
    this.proc.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    return response;
  }
  async stop() {
    if (this.proc.exitCode !== null) return;
    this.proc.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => this.proc.kill(), 5000);
      this.proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

test('two isolated Pi RPC clients: conflict, prompt/bash guards, switch, stale reclaim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-lock-integration-'));
  const session = path.join(dir, 'one.jsonl');
  const other = path.join(dir, 'two.jsonl');
  const clients = [];
  try {
    const first = new Client(session); clients.push(first);
    assert.equal((await first.request({ type: 'get_state' })).success, true, first.stderr);
    const lock = path.join(lockLocation(root, session).lockDir, 'owner.json');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, first.proc.pid);

    const second = new Client(session); clients.push(second);
    assert.equal((await second.request({ type: 'get_state' })).success, true, second.stderr);
    assert.ok(second.events.some(e => e.method === 'notify' && e.notifyType === 'error'), JSON.stringify(second.events));
    const blocked = await second.request({ type: 'prompt', message: 'Do not call a model' });
    assert.equal(blocked.data.disposition, 'handled', JSON.stringify(blocked));
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, first.proc.pid);
    const bash = await second.request({ type: 'bash', command: `touch ${path.join(dir, 'must-not-exist')}` });
    assert.equal(bash.success, false, JSON.stringify(bash));
    assert.equal(fs.existsSync(path.join(dir, 'must-not-exist')), false);
    assert.equal(fs.existsSync(session), false, 'blocked bash must not persist a replacement result');

    const moved = await second.request({ type: 'switch_session', sessionPath: other });
    assert.equal(moved.data.cancelled, false, JSON.stringify(moved));
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockLocation(root, other).lockDir, 'owner.json'), 'utf8')).pid, second.proc.pid);
    const refused = await second.request({ type: 'switch_session', sessionPath: session });
    assert.equal(refused.data.cancelled, true, JSON.stringify(refused));

    // A process that exits leaves its lock; the next process proves it is dead.
    await first.stop();
    const reclaimed = await second.request({ type: 'switch_session', sessionPath: session });
    assert.equal(reclaimed.data.cancelled, false, JSON.stringify(reclaimed));
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, second.proc.pid);
    assert.equal(fs.existsSync(lockLocation(root, other).lockDir), false, 'old session lock released');
    // Seed only our temporary fixture, without making a provider request.
    const ownedState = (await second.request({ type: 'get_state' })).data;
    const timestamp = new Date().toISOString();
    fs.writeFileSync(session, [
      { type: 'session', version: 3, id: ownedState.sessionId, timestamp, cwd: dir },
      { type: 'message', id: 'abcd1234', parentId: null, timestamp, message: { role: 'user', content: 'test seed', timestamp: Date.now() } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    await second.request({ type: 'switch_session', sessionPath: session });
    const cloned = await second.request({ type: 'clone' });
    assert.equal(cloned.success, true, JSON.stringify(cloned));
    assert.equal(cloned.data.cancelled, false, JSON.stringify(cloned));
    const cloneFile = (await second.request({ type: 'get_state' })).data.sessionFile;
    assert.equal(fs.existsSync(lockLocation(root, session).lockDir), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockLocation(root, cloneFile).lockDir, 'owner.json'), 'utf8')).pid, second.proc.pid);
    await second.request({ type: 'switch_session', sessionPath: session });
    assert.equal(fs.existsSync(lockLocation(root, cloneFile).lockDir), false);
    fs.rmSync(cloneFile, { force: true });
    const fresh = await second.request({ type: 'new_session' });
    assert.equal(fresh.data.cancelled, false, JSON.stringify(fresh));
    const freshFile = (await second.request({ type: 'get_state' })).data.sessionFile;
    assert.equal(fs.existsSync(lockLocation(root, session).lockDir), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockLocation(root, freshFile).lockDir, 'owner.json'), 'utf8')).pid, second.proc.pid);
    await second.request({ type: 'switch_session', sessionPath: session });
    assert.equal(fs.existsSync(lockLocation(root, freshFile).lockDir), false);
    assert.ok(!second.events.some(e => e.type === 'extension_error' && e.event !== 'user_bash'), JSON.stringify(second.events.filter(e => e.type === 'extension_error')));
  } finally {
    await Promise.all(clients.map(client => client.proc.exitCode === null ? client.stop() : undefined));
    // These paths were created exclusively for this test; no active process remains.
    for (const file of [session, other]) fs.rmSync(lockLocation(root, file).lockDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isolated TUI reload retains identity and CLI initial prompt is blocked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lock-tui-'));
  const session = path.join(dir, 'session.jsonl');
  const socket = `pi-lock-test-${process.pid}`;
  const tmux = (...args) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = ['env', `PI_CODING_AGENT_DIR=${testAgentDir}`, 'PI_OFFLINE=1', pi, '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '-e', extension, '--session', session].map(quote).join(' ');
  try {
    tmux('new-session', '-d', '-s', 'test', '-x', '160', '-y', '40', command);
    const ownerFile = path.join(lockLocation(root, session).lockDir, 'owner.json');
    for (let i = 0; i < 100 && !fs.existsSync(ownerFile); i++) await pause(100);
    const before = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    tmux('send-keys', '-t', 'test', '/reload', 'Enter');
    await pause(1800);
    const screen = tmux('capture-pane', '-p', '-t', 'test');
    assert.ok(!/Failed to load|extension error/i.test(screen), screen);
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')), before);
    tmux('send-keys', '-t', 'test', '/session-lock', 'Enter');
    await pause(600);
    assert.match(tmux('capture-pane', '-p', '-t', 'test'), /owned by this Pi process/);
    const cli = spawnSync(pi, ['--print', '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '-e', extension, '--session', session, 'This prompt must be blocked'], { cwd: dir, env: testEnv, encoding: 'utf8', timeout: 8000 });
    assert.equal(cli.error, undefined, `CLI failed/timed out: ${cli.stderr}`);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(fs.existsSync(session), false, 'blocked CLI must not create the session file');
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')), before);
  } finally {
    try { tmux('kill-server'); } catch {}
    fs.rmSync(lockLocation(root, session).lockDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
