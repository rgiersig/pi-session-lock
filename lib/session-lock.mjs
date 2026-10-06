// Advisory, local Linux-only session lock primitives. No Pi lifecycle hooks here.
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BOOT_ID = '/proc/sys/kernel/random/boot_id';

function processStartTicks(pid) {
  // The comm field is parenthesized and may contain spaces or closing parentheses.
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new Error('Malformed process stat');
  const fields = stat.slice(close + 2).trim().split(/\s+/); // begins at field 3
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('Missing process start time'); // field 22
  return fields[19];
}

export function createOwner(ownerId = randomUUID()) {
  if (typeof ownerId !== 'string' || !ownerId) throw new Error('Invalid owner ID');
  return {
    version: 1,
    ownerId,
    pid: process.pid,
    hostname: os.hostname(),
    bootId: fs.readFileSync(BOOT_ID, 'utf8').trim(),
    processStartTicks: processStartTicks(process.pid),
  };
}

export function canonicalSessionPath(sessionPath) {
  const absolute = path.resolve(sessionPath);
  // A new Pi session file may not exist until its first write.
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const missing = [];
    let parent = absolute;
    while (!fs.existsSync(parent)) {
      missing.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
    return path.join(fs.realpathSync(parent), ...missing);
  }
}

function validOwner(owner, sessionPath) {
  return owner && owner.version === 1 && typeof owner.ownerId === 'string' && owner.ownerId.length > 0 &&
    Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.hostname === 'string' && owner.hostname.length > 0 &&
    typeof owner.bootId === 'string' && owner.bootId.length > 0 &&
    typeof owner.processStartTicks === 'string' && /^\d+$/.test(owner.processStartTicks) &&
    owner.sessionPath === sessionPath && typeof owner.acquiredAt === 'string';
}

function readOwner(lockDir, sessionPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    return validOwner(owner, sessionPath) ? owner : undefined;
  } catch {
    return undefined;
  }
}

function sameProcess(owner, self) {
  return owner.ownerId === self.ownerId && owner.pid === self.pid && owner.hostname === self.hostname &&
    owner.bootId === self.bootId && owner.processStartTicks === self.processStartTicks;
}

function liveness(owner, self) {
  if (owner.hostname !== self.hostname) return 'unknown';
  if (owner.bootId !== self.bootId) return 'dead';
  try {
    return processStartTicks(owner.pid) === owner.processStartTicks ? 'live' : 'dead';
  } catch (error) {
    return error.code === 'ENOENT' ? 'dead' : 'unknown';
  }
}

export function lockLocation(lockRoot, sessionPath) {
  const canonical = canonicalSessionPath(sessionPath);
  const key = createHash('sha256').update(canonical).digest('hex');
  return { sessionPath: canonical, lockDir: path.join(lockRoot, `${key}.lock`) };
}

function state(lockDir, sessionPath, self) {
  let stat;
  try { stat = fs.lstatSync(lockDir); } catch (error) {
    if (error.code === 'ENOENT') return { status: 'absent' };
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: 'unknown' };
  const owner = readOwner(lockDir, sessionPath);
  if (!owner) return { status: 'unknown' };
  if (sameProcess(owner, self)) return { status: 'owned', owner };
  return { status: liveness(owner, self), owner };
}

export function inspectSessionLock(lockRoot, sessionPath, self) {
  const location = lockLocation(lockRoot, sessionPath);
  return { ...location, ...state(location.lockDir, location.sessionPath, self) };
}

function makeLock(lockDir, sessionPath, self) {
  fs.mkdirSync(lockDir, { mode: 0o700 }); // atomic exclusive create
  try {
    const owner = { ...self, sessionPath, acquiredAt: new Date().toISOString() };
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: 'owned', owner };
  } catch (error) {
    // Do not remove a partially initialized lock: another process may have observed it.
    throw error;
  }
}

/** Returns owned, live, or unknown. `live` never changes an existing lock. */
export function acquireSessionLock(lockRoot, sessionPath, self) {
  const location = lockLocation(lockRoot, sessionPath);
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const { lockDir } = location;
  try { return { ...location, ...makeLock(lockDir, location.sessionPath, self) }; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }

  let current = state(lockDir, location.sessionPath, self);
  if (current.status === 'owned' || current.status === 'live' || current.status === 'unknown') {
    return { ...location, ...current };
  }

  // Serialize stale-owner reclamation. A crash holding this guard is fail-closed:
  // human intervention is preferable to an unsafe automatic guard takeover.
  const guard = `${lockDir}.reclaim`;
  try { fs.mkdirSync(guard, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') return { ...location, status: 'unknown', reason: 'reclaim in progress' };
    throw error;
  }
  try {
    current = state(lockDir, location.sessionPath, self);
    if (current.status !== 'dead') return { ...location, ...current };
    const stale = `${lockDir}.stale-${randomUUID()}`;
    fs.renameSync(lockDir, stale);
    try {
      return { ...location, ...makeLock(lockDir, location.sessionPath, self) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return { ...location, ...state(lockDir, location.sessionPath, self) };
    } finally {
      fs.rmSync(stale, { recursive: true, force: true });
    }
  } finally {
    fs.rmdirSync(guard);
  }
}

/** Release only a lock still owned by this exact process; never remove another owner's lock. */
export function releaseSessionLock(lockRoot, sessionPath, self) {
  const { lockDir, sessionPath: canonical } = lockLocation(lockRoot, sessionPath);
  if (state(lockDir, canonical, self).status !== 'owned') return false;
  // An owned, live process cannot be reclaimed; do not remove unknown or changed records.
  fs.unlinkSync(path.join(lockDir, 'owner.json'));
  fs.rmdirSync(lockDir);
  return true;
}
