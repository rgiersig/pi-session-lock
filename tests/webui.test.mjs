import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { lockLocation } from '../lib/session-lock.mjs';

const require = createRequire(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.resolve(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch {}
  }
}
function findWebui() {
  // An explicit path is authoritative: a typo should fail, not silently skip.
  if (process.env.PI_TEST_WEBUI_BIN) return path.resolve(process.env.PI_TEST_WEBUI_BIN);
  try {
    return path.join(path.dirname(require.resolve('@firstpick/pi-package-webui')), 'bin/pi-webui.mjs');
  } catch {}
  const executable = onPath('pi-webui');
  if (executable) return executable;
  const local = path.join(os.homedir(), '.local/share/pi-webui/node_modules/@firstpick/pi-package-webui/bin/pi-webui.mjs');
  return fs.existsSync(local) ? local : undefined;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const webui = process.env.PI_TEST_WEBUI === '0' ? undefined : findWebui();
test('optional installed WebUI: HTTP/SSE conflict and input guard', {
  skip: !webui ? 'Pi WebUI absent or test disabled (PI_TEST_WEBUI=0); set PI_TEST_WEBUI_BIN for custom installations' : false,
  timeout: 45000,
}, async () => {
  assert.ok(fs.existsSync(webui), `WebUI executable not found: ${webui}`);
  const pi = process.env.PI_TEST_BIN ? path.resolve(process.env.PI_TEST_BIN) : onPath('pi');
  assert.ok(pi, 'Installed WebUI requires pi on PATH or PI_TEST_BIN');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lock-webui-test-'));
  const agentDir = path.join(dir, 'agent');
  fs.mkdirSync(agentDir);
  const session = path.join(dir, 'test.jsonl');
  const root = path.join(agentDir, 'session-locks');
  const extension = fileURLToPath(new URL('../index.ts', import.meta.url));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1',
    PI_WEBUI_RPC_SUPERVISOR: '0', PI_WEBUI_STARTUP_PROBE: '1', PI_WEBUI_REMOTE_AUTH: '0' };
  const args = ['--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '-e', extension, '--session', session];
  const children = [];
  const abort = new AbortController();
  let reading;
  function start(command, arguments_) {
    const child = spawn(command, arguments_, { cwd: dir, env, detached: true });
    child.diagnostics = '';
    child.stderr.on('data', chunk => child.diagnostics += chunk);
    child.stdout.on('data', chunk => child.diagnostics += chunk);
    child.on('error', error => child.diagnostics += String(error));
    children.push(child);
    return child;
  }
  function alive(child) {
    assert.ok(child.pid && child.exitCode === null && child.signalCode === null, child.diagnostics);
  }
  async function stop(child) {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    // Only this fixture's process group; clean up descendants as well.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  try {
    const owner = start(pi, ['--mode', 'rpc', ...args]);
    const record = path.join(lockLocation(root, session).lockDir, 'owner.json');
    for (let n = 0; n < 100 && !fs.existsSync(record); n++) { alive(owner); await pause(100); }
    assert.ok(fs.existsSync(record), `Owner did not acquire lock: ${owner.diagnostics}`);
    const before = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.equal(before.pid, owner.pid);
    const base = `http://127.0.0.1:${await freePort()}`;
    const port = new URL(base).port;
    const server = start(webui.endsWith('.mjs') || webui.endsWith('.js') ? process.execPath : webui,
      [...(webui.endsWith('.mjs') || webui.endsWith('.js') ? [webui] : []), '--pi', pi, '--host', '127.0.0.1',
        '--port', port, '--cwd', dir, '--name', 'Session-Lock TEST', '--', ...args]);
    let ready = false;
    for (let n = 0; n < 100; n++) {
      alive(server);
      try {
        const response = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await pause(100);
    }
    assert.ok(ready, `WebUI startup failed: ${server.diagnostics}`);
    const stream = await fetch(`${base}/api/events`, { signal: abort.signal });
    assert.ok(stream.ok);
    let events = '';
    reading = (async () => {
      try { for await (const chunk of stream.body) events += Buffer.from(chunk).toString(); }
      catch (error) { if (!abort.signal.aborted) throw error; }
    })();
    for (const message of ['/session-lock', 'TEST: must be blocked without a model call']) {
      const response = await fetch(`${base}/api/prompt`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }), signal: AbortSignal.timeout(10000),
      });
      assert.ok(response.ok);
      const result = await response.json();
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.data?.disposition, 'handled', JSON.stringify(result));
      assert.equal(result.tab?.sessionFile, session);
      assert.notEqual(result.tab?.pid, owner.pid);
    }
    for (let n = 0; n < 50 && !events.includes('Input blocked:'); n++) await pause(100);
    assert.match(events, /Session in use by PID/);
    assert.match(events, /Input blocked:/);
    assert.equal(fs.existsSync(session), false, 'Blocked WebUI must not create a JSONL file');
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), before);
  } finally {
    abort.abort();
    if (reading) await reading;
    await Promise.all(children.map(stop));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
