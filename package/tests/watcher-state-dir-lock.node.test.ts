import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, rm as rmFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import {
  acquireWatcherStateDirLock,
  createStateMachineWatcher,
  deadLetterStateMachineJob,
  decodeHookReadyLog,
  FileStateMachineJobStore,
  InMemoryStateMachineJobStore,
  retryStateMachineJob,
  stateMachineJobId,
} from '../src/watcher/index.js';
import { main } from '../src/cli.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watcherEntryUrl = pathToFileURL(join(packageDir, 'src/watcher/storage/lock.ts')).href;
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

describe('watcher 任务级运行认领', () => {
  const machine = '0x1111111111111111111111111111111111111111' as const;
  const word = (hex: string) => `0x${hex.repeat(32)}`;

  async function hookReadyLog(): Promise<Parameters<ReturnType<typeof createStateMachineWatcher>['handleLog']>[0]> {
    const fixture = JSON.parse(await readFile(
      join(packageDir, '../../uvp-protocol/contracts/uvp-contracts/fixtures/uvp-state-machine.v0.10.json'),
      'utf8',
    )) as { events: { HookReady: { topic: string } } };
    return {
      address: machine,
      topics: [fixture.events.HookReady.topic, word('77'), word('11'), word('22')],
      data: `0x${'55'.repeat(32)}${'66'.repeat(32)}`,
      blockNumber: 12n,
      transactionHash: word('33'),
      logIndex: 7,
    };
  }

  it('handler 运行中手工 retry 被拒，handler 不被并发二次执行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-'));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    let effects = 0;
    const build = (handler: () => Promise<void>) => createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: new FileStateMachineJobStore(join(dir, 'jobs.json')),
      handlers: { '*': handler },
    });
    try {
      const running = build(async () => { effects += 1; entered(); await blocked; });
      const manual = build(async () => { effects += 1; });
      const log = await hookReadyLog();
      const active = running.handleLog(log);
      await started;

      const jobId = stateMachineJobId(decodeHookReadyLog(log));
      const duringRun = await manual.config.jobStore.get(jobId);
      assert.equal(duringRun?.status, 'matched', 'precondition: the job is claimed mid-run');
      assert.ok(duringRun?.claim !== undefined, 'precondition: the claim is recorded');

      await assert.rejects(
        retryStateMachineJob(manual, jobId, { operator: 'claim-test' }),
        (error: unknown) => {
          assert.match(String((error as Error).message), /being processed by executor pid/u);
          return true;
        },
      );
      assert.equal(effects, 1, 'the handler must not have been invoked a second time while blocked');

      release();
      await active;
      assert.equal(effects, 1);
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('持有者已死的 matched 认领可被手工 retry 接管（崩溃恢复通道）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-dead-'));
    let effects = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: new FileStateMachineJobStore(join(dir, 'jobs.json')),
      handlers: { '*': async () => { effects += 1; } },
    });
    try {
      const log = await hookReadyLog();
      await watcher.handleLog(log);
      assert.equal(effects, 1);

      const jobId = stateMachineJobId(decodeHookReadyLog(log));
      // 模拟 watcher 进程崩溃：任务停在 matched 且认领 pid 已死。
      const crashedPid = await deadPid();
      await watcher.config.jobStore.update(jobId, {
        status: 'matched',
        updatedAt: new Date().toISOString(),
        claim: { pid: crashedPid, at: new Date().toISOString() },
      });

      const retried = await retryStateMachineJob(watcher, jobId, { operator: 'claim-test' });
      assert.equal(retried.status, 'handled', 'a dead claim must not block the manual recovery channel');
      assert.equal(effects, 2, 'the retry runs the handler exactly once more');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handler 运行中手工 dead-letter 被拒：dead_letter 附带 claim:null 不得清掉活认领', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-deadletter-'));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: new FileStateMachineJobStore(join(dir, 'jobs.json')),
      handlers: { '*': async () => { entered(); await blocked; } },
    });
    try {
      const log = await hookReadyLog();
      const active = watcher.handleLog(log);
      await started;

      const jobId = stateMachineJobId(decodeHookReadyLog(log));
      await assert.rejects(
        deadLetterStateMachineJob(watcher.config.jobStore, jobId, {
          operator: 'claim-test',
          reason: 'operator verdict',
        }),
        (error: unknown) => {
          assert.match(String((error as Error).message), /being processed by executor pid/u);
          return true;
        },
      );
      const duringRun = await watcher.config.jobStore.get(jobId);
      assert.ok(duringRun?.claim, 'the refused dead-letter must leave the live claim intact');

      release();
      const settled = await active;
      assert.equal(settled.job?.status, 'matched', 'the dry-run run still concludes its own outcome');
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('运行收尾终态写入不得覆盖并发落下的操作员 dead-letter 裁决', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-finalize-'));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: new FileStateMachineJobStore(join(dir, 'jobs.json')),
      handlers: { '*': async () => { entered(); await blocked; } },
    });
    try {
      const log = await hookReadyLog();
      const active = watcher.handleLog(log);
      await started;

      // 模拟认领闸读取后、运行结束前落进来的操作员裁决（读-写竞态窗口）：
      // 直接写 store，绕过已被活认领挡住的入口。
      const jobId = stateMachineJobId(decodeHookReadyLog(log));
      const operatorAt = new Date().toISOString();
      await watcher.config.jobStore.update(jobId, {
        status: 'dead_letter',
        updatedAt: operatorAt,
        lastError: { kind: 'unknown', message: 'operator verdict', retryable: false },
        claim: null,
      });

      release();
      const settled = await active;
      assert.equal(settled.job?.status, 'dead_letter', 'the run must not overwrite the operator verdict');
      const stored = await watcher.config.jobStore.get(jobId);
      assert.equal(stored?.status, 'dead_letter');
      assert.equal(stored?.lastError?.message, 'operator verdict', 'the operator reason must survive the run');
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('搁浅的 matched（认领持有者已死）被后续扫描自动接管重跑，而非仅剩人工 retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-run-claim-stranded-'));
    let effects = 0;
    const store = new FileStateMachineJobStore(join(dir, 'jobs.json'));
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:1',
      stateMachineAddress: machine,
      chainId: 31_337,
      walletAddress: wallet,
      privateKeyEnv: 'UVP_RUN_CLAIM_UNUSED_KEY',
      dryRun: true,
      jobStore: store,
      fromBlock: 13n,
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 100n;
        },
        async getLogs() {
          return [];
        },
      },
      handlers: {
        '*': (event) => {
          effects += 1;
          return [{ orderId: event.orderId, source: 'buyer', signalName: 'cmp' }];
        },
      },
    });
    try {
      const log = await hookReadyLog();
      const event = decodeHookReadyLog(log);
      if (!event) {
        throw new Error('test fixture log must decode as HookReady');
      }
      const created = await store.upsertDetected(event, { now: new Date().toISOString(), maxAttempts: 3 });
      // 模拟崩溃残留：matched + 认领写入后、结论性写入前进程死亡。
      await store.update(created.id, {
        status: 'matched',
        updatedAt: new Date().toISOString(),
        matchedKey: '*',
        claim: { pid: await deadPid(), at: new Date().toISOString() },
        expectStatus: 'detected',
      });

      await watcher.pollOnce();

      assert.equal(effects, 1, 'the later-scan pass must take over the stranded matched job');
      const revived = await store.get(created.id);
      assert.equal(revived?.submissions.length, 1, 'the takeover run records its dry-run submission');
      assert.ok(!revived?.claim, 'the concluded run releases the claim');

      // dry-run 收敛：后续扫描不再重跑 handler。
      await watcher.pollOnce();
      assert.equal(effects, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('store 更新的 CAS 守卫：状态或认领不符时拒写并返回 undefined', async () => {
    const store = new InMemoryStateMachineJobStore();
    const log = await hookReadyLog();
    const event = decodeHookReadyLog(log);
    if (!event) {
      throw new Error('test fixture log must decode as HookReady');
    }
    const created = await store.upsertDetected(event, { now: new Date().toISOString(), maxAttempts: 3 });

    assert.equal(await store.update(created.id, {
      updatedAt: new Date().toISOString(),
      status: 'matched',
      expectStatus: 'confirmed',
    }), undefined, 'expectStatus mismatch must reject the write');

    const claimed = await store.update(created.id, {
      updatedAt: new Date().toISOString(),
      status: 'matched',
      claim: { pid: 424_242, at: new Date().toISOString() },
      expectStatus: 'detected',
      expectClaimPid: null,
    });
    assert.ok(claimed?.claim, 'the CAS-accepted write records the claim');

    assert.equal(await store.update(created.id, {
      updatedAt: new Date().toISOString(),
      claim: null,
      expectClaimPid: null,
    }), undefined, 'a claim mismatch must reject the release');

    const released = await store.update(created.id, {
      updatedAt: new Date().toISOString(),
      status: 'failed',
      claim: null,
      expectClaimPid: 424_242,
    });
    assert.equal(released?.status, 'failed');
    assert.equal(released?.claim, undefined, 'the conclusive status write releases the claim');
  });
});
