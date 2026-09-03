import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WATCHER_STATE_DIR,
  chainPollExecutionFailed,
  executionOutcomeFailed,
  main,
  resolveWatcherStorage,
  WATCHER_STATE_DIR_ENV,
} from '../src/cli.js';
import { FileStateMachineCursorStore, FileStateMachineJobStore } from '../src/watcher.js';
import { ValidationError } from '../src/validation.js';

const RETRY_STATE_MACHINE = '0x0000000000000000000000000000000000000001';
const RETRY_WALLET = '0x0000000000000000000000000000000000000002';
const RETRY_ORDER_ID = `0x${'11'.repeat(32)}` as Hex;
const RETRY_PLAN_ID = `0x${'77'.repeat(32)}` as Hex;
const RETRY_HOOK_ID = `0x${'22'.repeat(32)}` as Hex;
const RETRY_STAGE_ID = `0x${'55'.repeat(32)}` as Hex;
const RETRY_HOOK_NAME_ID = `0x${'66'.repeat(32)}` as Hex;
const RETRY_TX_HASH = `0x${'33'.repeat(32)}` as Hex;
const HOOK_READY_TOPIC = keccak256(stringToBytes('HookReady(bytes32,bytes32,bytes32,bytes32,bytes32)'));
const RETRY_RAW_LOG = {
  address: RETRY_STATE_MACHINE,
  data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [RETRY_STAGE_ID, RETRY_HOOK_NAME_ID]),
  topics: [HOOK_READY_TOPIC, RETRY_PLAN_ID, RETRY_ORDER_ID, RETRY_HOOK_ID],
  blockNumber: '12',
  transactionHash: RETRY_TX_HASH,
  logIndex: '7',
};
const RETRY_EVENT_ID = keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'uint256' }],
  [RETRY_TX_HASH, 7n],
));
const RETRY_JOB_ID = keccak256(encodeAbiParameters(
  [
    { type: 'address' },
    { type: 'bytes32' },
    { type: 'bytes32' },
    { type: 'bytes32' },
  ],
  [RETRY_STATE_MACHINE, RETRY_ORDER_ID, RETRY_HOOK_ID, RETRY_EVENT_ID],
));

describe('executor CLI', () => {
  it('accepts the pnpm argument separator before wallet commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-'));
    const envFile = join(dir, '.env.local');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };

    try {
      await main(['node', 'uvp-executor', '--', 'wallet', 'new', '--env-file', envFile]);
      const output = JSON.parse(logs[0] ?? '{}') as { wallet?: { envFile?: string } };
      expect(output.wallet?.envFile).toBe(resolve(envFile));
      expect(await readFile(envFile, 'utf8')).toContain('UVP_ETH_DEPLOYER_PRIVATE_KEY=0x');
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates standard state-machine executor configs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-config-'));
    const configPath = join(dir, 'executor.json');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };

    try {
      await writeFile(configPath, JSON.stringify({
        supplierId: 'logistics-provider-a',
        executorId: 'logistics-provider-a',
        walletAddress: '0x0000000000000000000000000000000000000002',
        chainId: 84532,
        stateMachineAddress: '0x0000000000000000000000000000000000000001',
        callbackMode: 'auto',
        dryRun: true,
        authTokenRef: 'UVP_EXECUTOR_TOKEN',
        handlers: {
          'export.customs#START': {
            signals: [
              {
                source: 'logistics-provider-a',
                stageIdentifier: 'export.customs',
                signalName: 'cmp',
              },
            ],
          },
        },
      }));

      await main(['node', 'uvp-executor', 'config', 'validate', '--config', configPath]);
      const output = JSON.parse(logs[0] ?? '{}') as {
        config?: {
          valid?: boolean;
          kind?: string;
          handlerCount?: number;
          signalCount?: number;
          supplier?: {
            supplierId?: string;
          };
          wallet?: {
            configured?: boolean;
            address?: string;
          };
          stageCapabilities?: Array<{
            key?: string;
            stageIdentifiers?: string[];
            signalCount?: number;
          }>;
        };
      };
      expect(output.config).toMatchObject({
        valid: true,
        kind: 'state-machine',
        handlerCount: 1,
        signalCount: 1,
        supplier: {
          supplierId: 'logistics-provider-a',
        },
        wallet: {
          configured: true,
          address: '0x0000000000000000000000000000000000000002',
        },
      });
      expect(output.config?.stageCapabilities?.[0]).toMatchObject({
        key: 'export.customs#START',
        stageIdentifiers: ['export.customs'],
        signalCount: 1,
      });
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists and dead-letters local watcher jobs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-jobs-'));
    const jobsFile = join(dir, 'jobs.json');
    const jobId = `0x${'aa'.repeat(32)}`;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };

    try {
      await writeFile(jobsFile, JSON.stringify({
        version: 1,
        jobs: [
          {
            id: jobId,
            eventId: `0x${'bb'.repeat(32)}`,
            orderId: `0x${'11'.repeat(32)}`,
            hookId: `0x${'22'.repeat(32)}`,
            stageId: `0x${'33'.repeat(32)}`,
            stageIdentifier: 'export.customs',
            hookName: 'START',
            supplierId: 'logistics-provider-a',
            status: 'failed',
            attempts: 1,
            maxAttempts: 3,
            detectedAt: '2026-04-28T00:00:00.000Z',
            updatedAt: '2026-04-28T00:00:01.000Z',
            submissions: [],
            lastError: {
              kind: 'unauthorized',
              message: 'AccessControlUnauthorizedAccount submitter',
              retryable: false,
            },
          },
        ],
      }));

      await main(['node', 'uvp-executor', 'jobs', 'list', '--jobs-file', jobsFile]);
      const listed = JSON.parse(logs[0] ?? '{}') as {
        jobs?: Array<{ jobId?: string; status?: string; supplierId?: string }>;
      };
      expect(listed.jobs?.[0]).toMatchObject({
        jobId,
        status: 'failed',
        supplierId: 'logistics-provider-a',
      });

      await main([
        'node',
        'uvp-executor',
        'jobs',
        'dead-letter',
        jobId,
        '--jobs-file',
        jobsFile,
        '--operator',
        'ops@example.com',
        '--reason',
        'manual review required',
      ]);
      const deadLettered = JSON.parse(logs[1] ?? '{}') as {
        job?: { status?: string; lastError?: { message?: string } };
        rawJob?: { manualActions?: Array<{ action?: string; operator?: string; reason?: string }> };
      };
      expect(deadLettered.job).toMatchObject({
        status: 'dead_letter',
        lastError: {
          message: 'manual review required',
        },
      });
      expect(deadLettered.rawJob?.manualActions?.[0]).toMatchObject({
        action: 'dead_letter',
        operator: 'ops@example.com',
        reason: 'manual review required',
      });
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('rejects chain-signal --payload-ref instead of silently dropping it', async () => {
    // The frozen submitSignal ABI has no payloadRef field; before this guard the
    // flag was parsed, discarded, and the command reported success anyway.
    await expect(main([
      'node',
      'uvp-executor',
      'chain-signal',
      '--rpc-url',
      'http://127.0.0.1:8545',
      '--state-machine',
      RETRY_STATE_MACHINE,
      '--chain-id',
      '31337',
      '--order-id',
      RETRY_ORDER_ID,
      '--plan-id',
      RETRY_PLAN_ID,
      '--source',
      'buyer',
      '--stage',
      'exec.main',
      '--signal-name',
      'cmp',
      '--payload-hash',
      `0x${'44'.repeat(32)}`,
      '--payload-ref',
      'ipfs://payload',
      '--wallet-address',
      RETRY_WALLET,
      '--dry-run',
    ])).rejects.toThrow(/--payload-ref is not supported by chain-signal/);
  });
});

describe('honest execution exit codes', () => {
  it('flags poll outcomes that carry errors or terminal failure states', () => {
    expect(chainPollExecutionFailed({ results: [{ status: 'handled', submissions: [] }] })).toBe(false);
    expect(chainPollExecutionFailed({
      results: [{
        status: 'ignored',
        submissions: [],
        error: { kind: 'missing_handler', message: 'no state machine handler', retryable: false },
      }],
    })).toBe(true);
    expect(executionOutcomeFailed({})).toBe(false);
    expect(executionOutcomeFailed({ job: { status: 'failed' } })).toBe(true);
    expect(executionOutcomeFailed({ job: { status: 'dead_letter' } })).toBe(true);
    expect(executionOutcomeFailed({ job: { status: 'confirmed' } })).toBe(false);
  });

  it('leaves the exit code unset when jobs retry succeeds offline in dry-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-exit-ok-'));
    const jobsFile = join(dir, 'jobs.json');
    const configPath = join(dir, 'executor.json');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await writeFile(jobsFile, JSON.stringify({
        version: 1,
        jobs: [{
          id: RETRY_JOB_ID,
          eventId: RETRY_EVENT_ID,
          orderId: RETRY_ORDER_ID,
          planId: RETRY_PLAN_ID,
          hookId: RETRY_HOOK_ID,
          stageId: RETRY_STAGE_ID,
          stageIdentifier: 'exec.main',
          hookName: 'START',
          status: 'failed',
          attempts: 1,
          maxAttempts: 3,
          detectedAt: '2026-04-28T00:00:00.000Z',
          updatedAt: '2026-04-28T00:00:01.000Z',
          submissions: [],
          raw: RETRY_RAW_LOG,
        }],
      }));
      await writeFile(configPath, JSON.stringify({
        supplierId: 'logistics-provider-a',
        walletAddress: RETRY_WALLET,
        chainId: 31_337,
        stateMachineAddress: RETRY_STATE_MACHINE,
        artifact: {
          hooksByHookId: {
            [RETRY_HOOK_ID]: { stageIdentifier: 'exec.main', hookName: 'START' },
          },
        },
        handlers: {
          '*': {
            signals: [{ source: 'buyer', stageIdentifier: 'exec.main', signalName: 'cmp' }],
          },
        },
      }));

      await main([
        'node', 'uvp-executor', 'jobs', 'retry', RETRY_JOB_ID,
        '--jobs-file', jobsFile,
        '--rpc-url', 'http://127.0.0.1:8545',
        '--state-machine', RETRY_STATE_MACHINE,
        '--chain-id', '31337',
        '--config', configPath,
        '--operator', 'ops@example.com',
        '--wallet-address', RETRY_WALLET,
        '--dry-run',
      ]);

      const output = JSON.parse(logs[0] ?? '{}') as { retry?: { status?: string; job?: { status?: string } } };
      expect(output.retry?.status).toBe('handled');
      expect(output.retry?.job?.status).toBe('matched');
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when jobs retry ends with an error while still printing the full result JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-exit-fail-'));
    const jobsFile = join(dir, 'jobs.json');
    const configPath = join(dir, 'executor.json');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await writeFile(jobsFile, JSON.stringify({
        version: 1,
        jobs: [{
          id: RETRY_JOB_ID,
          eventId: RETRY_EVENT_ID,
          orderId: RETRY_ORDER_ID,
          planId: RETRY_PLAN_ID,
          hookId: RETRY_HOOK_ID,
          stageId: RETRY_STAGE_ID,
          stageIdentifier: 'exec.main',
          hookName: 'START',
          status: 'failed',
          attempts: 1,
          maxAttempts: 3,
          detectedAt: '2026-04-28T00:00:00.000Z',
          updatedAt: '2026-04-28T00:00:01.000Z',
          submissions: [],
          raw: RETRY_RAW_LOG,
        }],
      }));
      // No handler matches exec.main#START: the outcome carries an error and
      // the job is ignored — the process must not pretend this succeeded.
      await writeFile(configPath, JSON.stringify({
        supplierId: 'logistics-provider-a',
        walletAddress: RETRY_WALLET,
        chainId: 31_337,
        stateMachineAddress: RETRY_STATE_MACHINE,
        artifact: {
          hooksByHookId: {
            [RETRY_HOOK_ID]: { stageIdentifier: 'exec.main', hookName: 'START' },
          },
        },
        handlers: {
          'nomatch.stage#X': {
            signals: [{ source: 'buyer', stageIdentifier: 'nomatch.stage', signalName: 'cmp' }],
          },
        },
      }));

      await main([
        'node', 'uvp-executor', 'jobs', 'retry', RETRY_JOB_ID,
        '--jobs-file', jobsFile,
        '--rpc-url', 'http://127.0.0.1:8545',
        '--state-machine', RETRY_STATE_MACHINE,
        '--chain-id', '31337',
        '--config', configPath,
        '--operator', 'ops@example.com',
        '--wallet-address', RETRY_WALLET,
        '--dry-run',
      ]);

      const output = JSON.parse(logs[0] ?? '{}') as {
        retry?: { status?: string; error?: { kind?: string }; job?: { status?: string } };
      };
      expect(output.retry?.status).toBe('ignored');
      expect(output.retry?.error?.kind).toBe('missing_handler');
      expect(output.retry?.job?.status).toBe('ignored');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('watcher state storage (ETH-07)', () => {
  it('defaults to the file-backed state directory and honors flag, env, and jobs-file overrides', () => {
    const previousEnv = process.env[WATCHER_STATE_DIR_ENV];
    delete process.env[WATCHER_STATE_DIR_ENV];
    try {
      const defaults = resolveWatcherStorage({});
      expect(defaults.summary).toEqual({
        mode: 'file',
        stateDir: resolve(process.cwd(), DEFAULT_WATCHER_STATE_DIR),
        jobsFile: resolve(process.cwd(), DEFAULT_WATCHER_STATE_DIR, 'jobs.json'),
        cursorFile: resolve(process.cwd(), DEFAULT_WATCHER_STATE_DIR, 'cursor.json'),
      });
      expect(defaults.jobStore).toBeInstanceOf(FileStateMachineJobStore);
      expect(defaults.cursorStore).toBeInstanceOf(FileStateMachineCursorStore);
      expect(defaults.jobStore?.kind).toBe('file');
      expect(defaults.cursorStore?.kind).toBe('file');

      const fromEnv = resolveWatcherStorage({}, { [WATCHER_STATE_DIR_ENV]: '/tmp/env-state' });
      expect(fromEnv.summary.mode).toBe('file');
      expect(fromEnv.summary.mode === 'file' && fromEnv.summary.stateDir).toBe(resolve('/tmp/env-state'));

      const fromFlag = resolveWatcherStorage({ stateDir: '/tmp/flag-state' }, { [WATCHER_STATE_DIR_ENV]: '/tmp/env-state' });
      expect(fromFlag.summary.mode === 'file' && fromFlag.summary.stateDir).toBe(resolve('/tmp/flag-state'));

      const explicitJobs = resolveWatcherStorage({ jobsFile: '/var/uvp/jobs.json' });
      expect(explicitJobs.summary).toEqual({
        mode: 'file',
        stateDir: '/var/uvp',
        jobsFile: '/var/uvp/jobs.json',
        cursorFile: '/var/uvp/cursor.json',
      });

      const memory = resolveWatcherStorage({ jobStore: 'memory' });
      expect(memory.summary).toEqual({ mode: 'memory' });
      expect(memory.jobStore).toBeUndefined();
      expect(memory.cursorStore).toBeUndefined();

      expect(() => resolveWatcherStorage({ jobStore: 'redis' })).toThrow(ValidationError);
    } finally {
      if (previousEnv === undefined) {
        delete process.env[WATCHER_STATE_DIR_ENV];
      } else {
        process.env[WATCHER_STATE_DIR_ENV] = previousEnv;
      }
    }
  });

  it('chain-once persists jobs and the scan cursor and resumes after a restart without rescanning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-state-'));
    const stateDir = join(dir, 'state');
    const configPath = join(dir, 'executor.json');
    const logs: string[] = [];
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    const previousEnv = process.env[WATCHER_STATE_DIR_ENV];
    process.exitCode = undefined;
    process.env[WATCHER_STATE_DIR_ENV] = stateDir;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    const stub = await startChainStub();

    try {
      await writeFile(configPath, JSON.stringify({
        supplierId: 'logistics-provider-a',
        walletAddress: RETRY_WALLET,
        chainId: 31_337,
        stateMachineAddress: RETRY_STATE_MACHINE,
        artifact: {
          hooksByHookId: {
            [RETRY_HOOK_ID]: { stageIdentifier: 'exec.main', hookName: 'START' },
          },
        },
        handlers: {
          '*': {
            signals: [{ source: 'buyer', stageIdentifier: 'exec.main', signalName: 'cmp' }],
          },
        },
      }));
      const argv = (extra: string[] = []) => [
        'node', 'uvp-executor', 'chain-once',
        '--rpc-url', stub.url,
        '--state-machine', RETRY_STATE_MACHINE,
        '--chain-id', '31337',
        '--config', configPath,
        '--wallet-address', RETRY_WALLET,
        '--from-block', '10',
        '--dry-run',
        ...extra,
      ];

      // First run (head at block 12): scans 10..12 and persists state.
      await main(argv());
      const firstRun = JSON.parse(logs[0] ?? '{}') as {
        watcher?: { nextBlock?: string; cursorStore?: string; jobStore?: string };
        storage?: { mode?: string; stateDir?: string; jobsFile?: string; cursorFile?: string };
        poll?: { fromBlock?: string; scannedLogs?: number };
      };
      expect(firstRun.storage).toEqual({
        mode: 'file',
        stateDir: resolve(stateDir),
        jobsFile: join(resolve(stateDir), 'jobs.json'),
        cursorFile: join(resolve(stateDir), 'cursor.json'),
      });
      expect(firstRun.watcher?.cursorStore).toBe('file');
      expect(firstRun.watcher?.jobStore).toBe('file');
      expect(firstRun.watcher?.nextBlock).toBe('13');
      expect(firstRun.poll?.fromBlock).toBe('10');
      // Honest exit code: the config-only handler has no planId, so the dry-run
      // submission fails with validation_failure (dead_letter). The log was
      // still fully processed — the cursor advances below.
      expect(process.exitCode).toBe(1);

      const storedCursor = JSON.parse(
        await readFile(join(stateDir, 'cursor.json'), 'utf8'),
      ) as { cursor?: string; chainId?: number; stateMachines?: string[] };
      expect(storedCursor).toMatchObject({
        cursor: '13',
        chainId: 31_337,
        stateMachines: [RETRY_STATE_MACHINE.toLowerCase()],
      });
      const storedJobs = JSON.parse(await readFile(join(stateDir, 'jobs.json'), 'utf8')) as {
        jobs?: Array<{ status?: string; lastError?: { kind?: string } }>;
      };
      expect(storedJobs.jobs).toHaveLength(1);
      expect(storedJobs.jobs?.[0]?.status).toBe('dead_letter');
      expect(storedJobs.jobs?.[0]?.lastError?.kind).toBe('validation_failure');

      // Restart (new process, head advanced to 15): resumes from the persisted
      // cursor at block 13; the confirmed 10..12 range is not rescanned.
      logs.length = 0;
      stub.setHeadBlock('0xf');
      await main(argv());
      const secondRun = JSON.parse(logs[0] ?? '{}') as {
        watcher?: { nextBlock?: string };
        poll?: { fromBlock?: string; toBlock?: string; scannedLogs?: number };
      };
      expect(secondRun.poll?.fromBlock).toBe('13');
      expect(secondRun.poll?.toBlock).toBe('15');
      expect(secondRun.poll?.scannedLogs).toBe(0);
      expect(secondRun.watcher?.nextBlock).toBe('16');
      expect(stub.getLogsCalls).toEqual([
        { address: RETRY_STATE_MACHINE, fromBlock: '0xa', toBlock: '0xc' },
        { address: RETRY_STATE_MACHINE, fromBlock: '0xd', toBlock: '0xf' },
      ]);
    } finally {
      stub.close();
      console.log = originalLog;
      process.exitCode = previousExitCode;
      if (previousEnv === undefined) {
        delete process.env[WATCHER_STATE_DIR_ENV];
      } else {
        process.env[WATCHER_STATE_DIR_ENV] = previousEnv;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('chain-once --job-store memory keeps watcher state out of the state dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-memory-'));
    const stateDir = join(dir, 'state');
    const configPath = join(dir, 'executor.json');
    const logs: string[] = [];
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    const stub = await startChainStub();

    try {
      await writeFile(configPath, JSON.stringify({
        supplierId: 'logistics-provider-a',
        walletAddress: RETRY_WALLET,
        chainId: 31_337,
        stateMachineAddress: RETRY_STATE_MACHINE,
        artifact: {
          hooksByHookId: {
            [RETRY_HOOK_ID]: { stageIdentifier: 'exec.main', hookName: 'START' },
          },
        },
        handlers: {
          '*': {
            signals: [{ source: 'buyer', stageIdentifier: 'exec.main', signalName: 'cmp' }],
          },
        },
      }));

      await main([
        'node', 'uvp-executor', 'chain-once',
        '--rpc-url', stub.url,
        '--state-machine', RETRY_STATE_MACHINE,
        '--chain-id', '31337',
        '--config', configPath,
        '--wallet-address', RETRY_WALLET,
        '--from-block', '10',
        '--dry-run',
        '--job-store', 'memory',
        '--state-dir', stateDir,
      ]);

      const run = JSON.parse(logs[0] ?? '{}') as {
        watcher?: { cursorStore?: string; jobStore?: string };
        storage?: { mode?: string };
      };
      expect(run.storage).toEqual({ mode: 'memory' });
      expect(run.watcher?.cursorStore).toBe('memory');
      expect(run.watcher?.jobStore).toBe('memory');
      await expect(readFile(join(stateDir, 'cursor.json'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(stateDir, 'jobs.json'), 'utf8')).rejects.toThrow();
      // Same honest exit as the file run: the dry-run submission itself lacks a
      // planId; the point here is that nothing was written to the state dir.
      expect(process.exitCode).toBe(1);
    } finally {
      stub.close();
      console.log = originalLog;
      process.exitCode = previousExitCode;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Minimal JSON-RPC chain stub for chain-once: serves eth_chainId,
 * eth_blockNumber (movable head), and eth_getLogs. The stub chain carries one
 * HookReady event at block 12 for the RETRY_* fixtures above.
 */
async function startChainStub(): Promise<{
  readonly url: string;
  readonly getLogsCalls: Array<{ address?: string; fromBlock?: string; toBlock?: string }>;
  setHeadBlock(hex: string): void;
  close(): Promise<void>;
}> {
  let head = '0xc';
  const getLogsCalls: Array<{ address?: string; fromBlock?: string; toBlock?: string }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        id?: unknown;
        method?: string;
        params?: Readonly<readonly unknown[]>;
      };
      let result: unknown = null;
      if (parsed.method === 'eth_chainId') {
        result = '0x7a69';
      } else if (parsed.method === 'eth_blockNumber') {
        result = head;
      } else if (parsed.method === 'eth_getLogs') {
        const filter = (parsed.params?.[0] ?? {}) as {
          address?: string;
          fromBlock?: string;
          toBlock?: string;
        };
        getLogsCalls.push({ address: filter.address, fromBlock: filter.fromBlock, toBlock: filter.toBlock });
        const from = Number.parseInt(filter.fromBlock ?? '0x0', 16);
        result = Number.isFinite(from) && from <= 12 ? [hookReadyRpcLog()] : [];
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
    })().catch(() => {
      response.statusCode = 500;
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('chain stub did not bind to a TCP address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    getLogsCalls,
    setHeadBlock(hex: string) {
      head = hex;
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function hookReadyRpcLog() {
  return {
    address: RETRY_STATE_MACHINE,
    topics: [HOOK_READY_TOPIC, RETRY_PLAN_ID, RETRY_ORDER_ID, RETRY_HOOK_ID],
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [RETRY_STAGE_ID, RETRY_HOOK_NAME_ID]),
    blockNumber: '0xc',
    blockHash: `0x${'ee'.repeat(32)}`,
    transactionHash: RETRY_TX_HASH,
    transactionIndex: '0x0',
    logIndex: '0x7',
    removed: false,
  };
}
