// Global advisory session lock; not a Pi-Core hard write lock.
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import os from 'node:os';
import path from 'node:path';
import { acquireSessionLock, canonicalSessionPath, createOwner, inspectSessionLock, releaseSessionLock } from './lib/session-lock.mjs';

const identityKey = Symbol.for('pi.agent.session-lock.owner.v1');
const globalIdentity = globalThis as unknown as Record<symbol, ReturnType<typeof createOwner> | undefined>;
const self = globalIdentity[identityKey] ??= createOwner();
const root = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'session-locks');

type Result = ReturnType<typeof acquireSessionLock>;

export default function (pi: ExtensionAPI) {
  let active: string | undefined;
  let result: Result | undefined;
  let lastWarning: string | undefined;

  const describe = (state: Result) => state.status === 'live'
    ? `Session in use by PID ${state.owner.pid} on ${state.owner.hostname}`
    : `Session lock uncertain (${state.reason ?? 'missing or unreadable owner'}); no input accepted`;

  function display(ctx: ExtensionContext, next: Result) {
    result = next;
    const problem = next.status !== 'owned';
    ctx.ui.setStatus('session-lock', problem ? `🔒 ${next.status === 'live' ? `PID ${next.owner.pid}` : 'unknown'}` : undefined);
    if (problem) {
      const warning = `${next.sessionPath}: ${describe(next)}`;
      if (warning !== lastWarning) {
        ctx.ui.notify(warning, 'error');
        lastWarning = warning;
      }
    } else {
      lastWarning = undefined;
    }
  }

  function check(ctx: ExtensionContext) {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) {
      result = undefined;
      ctx.ui.setStatus('session-lock', undefined);
      return;
    }
    try {
      const next = acquireSessionLock(root, file, self);
      display(ctx, next);
      if (active && active !== next.sessionPath) releaseSessionLock(root, active, self);
      active = next.status === 'owned' ? next.sessionPath : undefined;
    } catch (error) {
      const warning = `Session lock failed: ${String(error)}`;
      result = undefined;
      ctx.ui.setStatus('session-lock', '🔒 error');
      if (warning !== lastWarning) ctx.ui.notify(warning, 'error');
      lastWarning = warning;
    }
  }

  pi.on('session_start', (event, ctx) => {
    check(ctx);
    if (event.previousSessionFile && canonicalSessionPath(event.previousSessionFile) !== result?.sessionPath) {
      // Session replacement creates a fresh extension instance. The previous
      // instance cannot release its lock safely in session_shutdown (reload
      // uses the same shutdown event); the new instance releases it here.
      releaseSessionLock(root, event.previousSessionFile, self);
    }
  });
  pi.on('session_before_switch', (event, ctx) => {
    if (!event.targetSessionFile) return;
    try {
      const target = inspectSessionLock(root, event.targetSessionFile, self);
      if (target.status !== 'live' && target.status !== 'unknown') return;
      ctx.ui.notify(`Cannot resume ${target.sessionPath}: ${describe(target)}`, 'error');
    } catch (error) {
      ctx.ui.notify(`Cannot verify target session lock: ${String(error)}`, 'error');
    }
    return { cancel: true };
  });
  // A new Pi session has a target path even before its JSONL has been created.
  // Check again for each input (including WebUI RPC input) to detect removal or takeover.
  pi.on('input', (_event, ctx) => {
    check(ctx);
    if (!ctx.sessionManager.getSessionFile() || result?.status === 'owned') return { action: 'continue' };
    ctx.ui.notify('Input blocked: session lock is not owned by this Pi process.', 'error');
    return { action: 'handled' };
  });
  pi.on('user_bash', (_event, ctx) => {
    check(ctx);
    if (!ctx.sessionManager.getSessionFile() || result?.status === 'owned') return;
    // Returning a BashResult would itself be recorded in the conflicted JSONL.
    // user_bash handler errors fail closed in Pi, unlike notification handlers.
    throw new Error('Blocked: this Pi process does not own the session lock.');
  });
  pi.on('session_before_compact', (_event, ctx) => {
    check(ctx);
    if (ctx.sessionManager.getSessionFile() && result?.status !== 'owned') return { cancel: true };
  });
  pi.on('session_before_tree', (_event, ctx) => {
    check(ctx);
    if (ctx.sessionManager.getSessionFile() && result?.status !== 'owned') return { cancel: true };
  });
  pi.on('session_shutdown', (event, ctx) => {
    // /reload destroys extension state but not the process. Release only for a
    // successful session replacement, on the following session_start instead.
    if (event.reason === 'quit' || event.reason === 'reload') ctx.ui.setStatus('session-lock', undefined);
  });
  pi.registerCommand('session-lock', {
    description: 'Show the advisory lock status of this session',
    handler: async (_args, ctx) => {
      check(ctx);
      ctx.ui.notify(result ? `${result.sessionPath}: ${result.status === 'owned' ? 'owned by this Pi process' : describe(result)}` : 'No session lock available', result?.status === 'owned' ? 'info' : 'warning');
    },
  });
  pi.registerCommand('session-lock-override', {
    description: 'Retry reclaiming a demonstrably stale session lock (never a live owner)',
    handler: async (_args, ctx) => {
      check(ctx);
      ctx.ui.notify(result?.status === 'owned' ? 'Session lock owned.' : 'No takeover: lock is live, ambiguous, or unavailable.', result?.status === 'owned' ? 'info' : 'warning');
    },
  });
}
