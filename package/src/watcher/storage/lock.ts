import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ExecutorKitError, ValidationError } from '../../validation.js';
import { delay, isNodeError, isProcessAlive } from '../internal.js';

/**
 * Cross-process exclusion for the jobs-file read-modify-write cycle. The whole
 * file is the store, so two processes (or two concurrent CLI invocations, e.g.
 * `jobs retry` against a running watcher) reading the same base and writing
 * their own view would silently drop each other's updates — including
 * broadcasts the audit trail would then lack. The lock is an O_EXCL marker file
 * broken by age (a crashed holder must not block the store forever).
 */
const JOBS_FILE_LOCK_STALE_MS = 10_000;
const JOBS_FILE_LOCK_POLL_MS = 25;
const JOBS_FILE_LOCK_TIMEOUT_MS = 5_000;

export async function withJobsFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  // The jobs file may not exist yet on a first write; its directory must exist
  // before the lock marker can be created beside it.
  await mkdir(dirname(filePath), { recursive: true });
  const deadline = Date.now() + JOBS_FILE_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }
      if (await isStaleJobsFileLock(lockPath)) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ExecutorKitError(
          `timed out acquiring the jobs file lock ${lockPath}: another process holds it; concurrent writers must serialize on one jobs file`,
        );
      }
      await delay(JOBS_FILE_LOCK_POLL_MS);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function isStaleJobsFileLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > JOBS_FILE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export const WATCHER_STATE_DIR_LOCK_FILE_NAME = 'watcher.lock';

export interface WatcherStateDirLock {
  readonly lockPath: string;
  readonly pid: number;
  /** Release is idempotent: a second call is a no-op. */
  release(): Promise<void>;
}

/**
 * 进程级互斥：jobs 文件锁只串行化单次读改写，挡不住两个 watcher 进程共用同一
 * state-dir 时交错扫描与推进同一 cursor（丢事件/回绕扫描）。启动锁是 O_EXCL
 * 标记文件 + pid 存活判定：既有锁的 pid 存活即启动拒绝（报出持有者），
 * pid 不存活即崩溃残留，接管重写；无 pid 可读时退回按文件年龄判陈旧。
 */
export async function acquireWatcherStateDirLock(stateDir: string): Promise<WatcherStateDirLock> {
  if (!stateDir || stateDir.trim().length === 0) {
    throw new ValidationError('state dir path is required');
  }
  await mkdir(stateDir, { recursive: true });
  const lockPath = join(stateDir, WATCHER_STATE_DIR_LOCK_FILE_NAME);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx' });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }
      if (attempt >= 3) {
        throw new ExecutorKitError(
          `timed out acquiring the watcher state dir lock ${lockPath}: the existing lock could not be taken over`,
        );
      }
      const holderPid = await readWatcherStateDirLockPid(lockPath);
      if (holderPid !== undefined && isProcessAlive(holderPid)) {
        throw new ExecutorKitError(
          `watcher state dir ${stateDir} is locked by running process ${holderPid} (${lockPath});`
          + ' concurrent watchers must not share one state dir, stop the holder first',
        );
      }
      // 崩溃残留（pid 已死），或锁无 pid 且已老化到可判定为残留：接管重写。
      const takeOver = holderPid !== undefined || await isStaleJobsFileLock(lockPath);
      if (!takeOver) {
        throw new ExecutorKitError(
          `watcher state dir lock ${lockPath} holds no readable pid and is not stale yet;`
          + ' after confirming no watcher is running, remove the file and retry',
        );
      }
      await rm(lockPath, { force: true }).catch(() => undefined);
      continue;
    }
    let released = false;
    return {
      lockPath,
      pid: process.pid,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        await rm(lockPath, { force: true }).catch(() => undefined);
      },
    };
  }
}

async function readWatcherStateDirLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const content = await readFile(lockPath, 'utf8');
    const pid = Number.parseInt(content.trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
