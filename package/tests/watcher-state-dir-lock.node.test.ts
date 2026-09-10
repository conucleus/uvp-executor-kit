import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, rm as rmFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { acquireWatcherStateDirLock } from '../src/watcher.js';
import { main } from '../src/cli.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watcherEntryUrl = pathToFileURL(join(packageDir, 'src/watcher.ts')).href;
const stateMachine = '0x1111111111111111111111111111111111111111' as const;
const wallet = '0x2222222222222222222222222222222222222222' as const;

/** Minimal JSON-RPC chain stub: chainId + movable head + empty getLogs, enough for a dry-run scan. */
async function startChainStub(): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        id?: unknown;
        method?: string;
      };
      let result: unknown = null;
      if (parsed.method === 'eth_chainId') {
        result = '0x7a69';
      } else if (parsed.method === 'eth_blockNumber') {
        result = '0xd';
      } else if (parsed.method === 'eth_getLogs') {
        result = [];
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
    })().catch(() => {
      response.statusCode = 500;
      response.end('{}');
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('chain stub did not bind to a TCP address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise) => {
      server.closeAllConnections();
      server.close(() => resolvePromise());
    }),
  };
}

async function writeHandlerConfig(dir: string): Promise<string> {
  const configPath = join(dir, 'executor.json');
  await writeFile(configPath, JSON.stringify({
    supplierId: 'lock-test-supplier',
    walletAddress: wallet,
    chainId: 31_337,
    stateMachineAddress: stateMachine,
    handlers: {
      '*': { signals: [{ source: 'buyer', stageIdentifier: 'exec.main', signalName: 'cmp' }] },
    },
  }));
  return configPath;
}

function chainOnceArgv(input: { readonly stubUrl: string; readonly configPath: string; readonly stateDir: string }): string[] {
  return [
    'node', 'uvp-executor', 'chain-once',
    '--rpc-url', input.stubUrl,
    '--state-machine', stateMachine,
    '--chain-id', '31337',
    '--config', input.configPath,
    '--wallet-address', wallet,
    '--dry-run',
    '--state-dir', input.stateDir,
  ];
}

/** A pid that is definitely not alive: take it from an already-exited child process. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()));
  if (pid === undefined) {
    throw new Error('child process did not expose a pid');
  }
  return pid;
}

describe('watcher state-dir 进程锁', () => {
  it('同 state-dir 第二个 watcher 启动即拒绝，报出持有 pid 与锁路径；释放后可重启', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-'));
    try {
      const first = await acquireWatcherStateDirLock(dir);
      const lockPath = join(dir, 'watcher.lock');
      assert.equal(first.lockPath, lockPath);
      assert.equal(await readFile(lockPath, 'utf8'), `${process.pid}\n`);

      await assert.rejects(
        acquireWatcherStateDirLock(dir),
        (error: unknown) => {
          assert.match(String((error as Error).message), new RegExp(`process ${process.pid}`));
          assert.match(String((error as Error).message), /watcher\.lock/u);
          return true;
        },
      );

      await first.release();
      assert.equal(await rmFile(join(dir, 'watcher.lock')).then(() => 'still-there', () => 'removed'), 'removed');
      const restarted = await acquireWatcherStateDirLock(dir);
      await restarted.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('陈旧锁（pid 不存活）启动时接管并重写为当前 pid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-stale-'));
    try {
      const lockPath = join(dir, 'watcher.lock');
      await writeFile(lockPath, `${await deadPid()}\n`);
      const lock = await acquireWatcherStateDirLock(dir);
      assert.equal(await readFile(lockPath, 'utf8'), `${process.pid}\n`);
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('持锁进程退出（含 SIGTERM 清理）后，同 state-dir 的 watcher 可以启动', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-proc-'));
    const logs: string[] = [];
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    const stub = await startChainStub();
    const childScript = join(dir, 'holder.mts');
    await writeFile(childScript, [
      'const mod = await import(process.argv[2]);',
      'const lock = await mod.acquireWatcherStateDirLock(process.argv[3]);',
      'console.log("holder-ready");',
      "process.on('SIGTERM', () => { void lock.release().then(() => process.exit(0)); });",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));

    const child = spawn(process.execPath, ['--import', 'tsx', childScript, watcherEntryUrl, dir], {
      cwd: packageDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childOutput = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      childOutput += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      childOutput += String(chunk);
    });

    const configPath = await writeHandlerConfig(dir);
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error(`holder child never became ready: ${childOutput}`)), 30_000);
        child.once('exit', () => {
          clearTimeout(timer);
          rejectPromise(new Error(`holder child exited before locking: ${childOutput}`));
        });
        child.stdout?.on('data', (chunk: Buffer) => {
          if (String(chunk).includes('holder-ready')) {
            clearTimeout(timer);
            resolvePromise();
          }
        });
      });

      // 持有进程存活期间：第二个 watcher（CLI chain-once）启动即拒绝。
      await assert.rejects(
        main(chainOnceArgv({ stubUrl: stub.url, configPath, stateDir: dir })),
        /locked by running process/u,
      );

      // SIGTERM 让持有进程退出；其清理路径必须移除锁文件。
      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolvePromise) => child.once('exit', (exitCode) => resolvePromise(exitCode)));
      assert.equal(code, 0);
      assert.equal(await readFile(join(dir, 'watcher.lock'), 'utf8').then(() => 'still-there', () => 'removed'), 'removed');

      // 持有进程退出后：同 state-dir 重启成功（锁被 CLI 取得并在运行后释放）。
      await main(chainOnceArgv({ stubUrl: stub.url, configPath, stateDir: dir }));
      assert.equal(process.exitCode, undefined);
      assert.equal(await readFile(join(dir, 'watcher.lock'), 'utf8').then(() => 'still-there', () => 'removed'), 'removed');
    } finally {
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGKILL');
      }
      await stub.close();
      console.log = originalLog;
      process.exitCode = previousExitCode;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('取锁后的构造/参数解析失败必须释放锁——泄漏的 watcher.lock 会拒绝下一个进程', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-release-'));
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = () => {};
    const stub = await startChainStub();
    const configPath = await writeHandlerConfig(dir);
    try {
      // --chain-id abc 在锁取得之后才解析失败（ValidationError）。
      await assert.rejects(
        main(chainOnceArgv({ stubUrl: stub.url, configPath, stateDir: dir }).map(
          (arg, index, all) => (all[index - 1] === '--chain-id' ? 'abc' : arg),
        )),
        /chainId/u,
      );
      // 失败路径不得泄漏 watcher.lock：锁文件已移除，下一个进程可启动。
      assert.equal(await readFile(join(dir, 'watcher.lock'), 'utf8').then(() => 'still-there', () => 'removed'), 'removed');
      const lock = await acquireWatcherStateDirLock(dir);
      await lock.release();
    } finally {
      await stub.close();
      console.log = originalLog;
      process.exitCode = previousExitCode;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('jobs retry 不取 state-dir 启动锁：持锁 watcher 存活时仍可执行（README 承诺）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-lock-retry-'));
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = () => {};
    const stub = await startChainStub();
    const configPath = await writeHandlerConfig(dir);
    const holder = await acquireWatcherStateDirLock(dir);
    try {
      const jobId = '0x' + 'ab'.repeat(32);
      // 持锁进程存活：jobs retry 不因 state-dir 锁被拒——按业务事实失败
      // （job 不存在），而不是 "locked by running process"。
      await assert.rejects(
        main([
          'node', 'uvp-executor', 'jobs', 'retry', jobId,
          '--jobs-file', join(dir, 'jobs.json'),
          '--rpc-url', stub.url,
          '--state-machine', stateMachine,
          '--chain-id', '31337',
          '--config', configPath,
          '--operator', 'lock-test-operator',
        ]),
        (error: unknown) => {
          const message = String((error as Error).message);
          assert.ok(!message.includes('locked by running process'), `retry must not be rejected by the state-dir lock: ${message}`);
          assert.match(message, /job .* not found/u);
          return true;
        },
      );
    } finally {
      await holder.release();
      await stub.close();
      console.log = originalLog;
      process.exitCode = previousExitCode;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
