import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, keccak256, stringToBytes, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { classifyExecutorKitError } from '../src/errors.js';
import {
  createStateMachineWatcher,
  deadLetterStateMachineJob,
  decodeHookReadyLog,
  FileStateMachineJobStore,
  hookReadyEventId,
  loadStateMachineHandlerConfig,
  retryStateMachineJob,
  submitStateMachineSignal,
  stateMachineHandlerConfigToExecutorConfigDTO,
  stateMachineJobToExecutorJobDTO,
  summarizeSupplierOps,
  type StateMachineRawLog,
} from '../src/watcher.js';

const STATE_MACHINE = '0x0000000000000000000000000000000000000001';
const STATE_MACHINE_V2 = '0x0000000000000000000000000000000000000009';
const WALLET_ADDRESS = '0x0000000000000000000000000000000000000002';
const ORDER_ID = `0x${'11'.repeat(32)}` as Hex;
const HOOK_ID = `0x${'22'.repeat(32)}` as Hex;
const STAGE_ID = `0x${'55'.repeat(32)}` as Hex;
const HOOK_NAME_ID = `0x${'66'.repeat(32)}` as Hex;
const TX_HASH = `0x${'33'.repeat(32)}` as Hex;
const PAYLOAD_HASH = `0x${'44'.repeat(32)}` as Hex;
const BUYER_SOURCE_ID = keccak256(stringToBytes('buyer'));
const EXEC_MAIN_CMP_ID = keccak256(stringToBytes('exec.main.cmp'));
const STATE_MACHINE_FIXTURE = JSON.parse(
  readFileSync(new URL('../../../uvp-protocol/contracts/uvp-contracts/fixtures/uvp-state-machine.v0.1.json', import.meta.url), 'utf8'),
) as {
  readonly hashes: {
    readonly artifactHash: Hex;
  };
  readonly events: {
    readonly HookReady: {
      readonly signature: string;
      readonly topic: Hex;
    };
  };
  readonly functions: {
    readonly submitSignal: {
      readonly selector: string;
    };
  };
};

describe('state machine chain watcher', () => {
  it('decodes HookReady logs', () => {
    const log = hookReadyLog();
    const event = decodeHookReadyLog(log, artifactIndex());

    expect(STATE_MACHINE_FIXTURE.hashes.artifactHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(STATE_MACHINE_FIXTURE.events.HookReady.signature).toBe('HookReady(bytes32,bytes32,bytes32,bytes32)');
    expect(event).toMatchObject({
      type: 'HookReady',
      stateMachineAddress: STATE_MACHINE,
      orderId: ORDER_ID,
      hookId: HOOK_ID,
      stageId: STAGE_ID,
      hookNameId: HOOK_NAME_ID,
      stageIdentifier: 'exec.main',
      hookName: 'START',
      blockNumber: 12n,
      transactionHash: TX_HASH,
      logIndex: 7n,
    });
    expect(event?.eventId).toBe(hookReadyEventId(log));
  });

  it('routes by stage, hook, and source before dry-running callback txs', async () => {
    const matchedKeys: string[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        'exec.main#START': (event, context) => {
          matchedKeys.push(context.matchedKey);
          return {
            orderId: event.orderId,
            source: 'buyer',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          };
        },
        [HOOK_ID]: () => {
          throw new Error('less specific handler should not run');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());
    const submission = result.submissions[0];
    if (!submission || !submission.dryRun) {
      throw new Error('expected a dry-run submission');
    }

    expect(result.status).toBe('handled');
    expect(result.matchedKey).toBe('exec.main#START');
    expect(result.job?.status).toBe('matched');
    expect(result.job?.matchedKey).toBe('exec.main#START');
    expect(matchedKeys).toEqual(['exec.main#START']);
    expect(submission.request.functionName).toBe('submitSignal');
    expect(submission.request.args.slice(0, 4)).toEqual([
      ORDER_ID,
      BUYER_SOURCE_ID,
      EXEC_MAIN_CMP_ID,
      PAYLOAD_HASH,
    ]);
  });

  it('polls with an injected public client instead of a real network', async () => {
    const getLogsCalls: unknown[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          orderId: event.orderId,
          source: 'buyer',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs(args) {
          getLogsCalls.push(args);
          return [hookReadyLog()];
        },
      },
    });

    const poll = await watcher.pollOnce();

    expect(poll.fromBlock).toBe(10n);
    expect(poll.toBlock).toBe(12n);
    expect(poll.scannedLogs).toBe(1);
    expect(poll.results[0]?.status).toBe('handled');
    expect(poll.results[0]?.job?.status).toBe('matched');
    expect(getLogsCalls).toEqual([
      {
        address: STATE_MACHINE,
        fromBlock: 10n,
        toBlock: 12n,
      },
    ]);
  });

  it('polls all configured state machines and sends callbacks to the emitting contract', async () => {
    const getLogsCalls: unknown[] = [];
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      stateMachines: [
        { stateMachineAddress: STATE_MACHINE, status: 'deprecated' },
        { stateMachineAddress: STATE_MACHINE_V2, status: 'active' },
      ],
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          orderId: event.orderId,
          source: 'buyer',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs(args) {
          getLogsCalls.push(args);
          return [hookReadyLog(args.address)];
        },
      },
    });

    const poll = await watcher.pollOnce();
    const requests = poll.results.map((result) => result.submissions[0]?.dryRun ? result.submissions[0].request : undefined);

    expect(poll.scannedLogs).toBe(2);
    expect(getLogsCalls).toEqual([
      { address: STATE_MACHINE, fromBlock: 10n, toBlock: 12n },
      { address: STATE_MACHINE_V2, fromBlock: 10n, toBlock: 12n },
    ]);
    expect(poll.results.map((result) => result.event?.stateMachineAddress)).toEqual([STATE_MACHINE, STATE_MACHINE_V2]);
    expect(poll.results[0]?.job?.id).not.toBe(poll.results[1]?.job?.id);
    expect(requests.map((request) => request?.address)).toEqual([STATE_MACHINE, STATE_MACHINE_V2]);
  });

  it('keeps polling when one HookReady log cannot be normalized', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          orderId: event.orderId,
          source: 'buyer',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs() {
          return [
            { ...hookReadyLog(), logIndex: -1 },
            hookReadyLog(),
          ];
        },
      },
    });

    const poll = await watcher.pollOnce();

    expect(poll.scannedLogs).toBe(2);
    expect(poll.results[0]?.status).toBe('skipped');
    expect(poll.results[0]?.error?.kind).toBe('validation_failure');
    expect(poll.results[1]?.status).toBe('handled');
  });

  it('records ignored jobs for missing handlers and does not process terminal jobs again', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {},
    });

    const first = await watcher.handleLog(hookReadyLog());
    const second = await watcher.handleLog(hookReadyLog());

    expect(first.status).toBe('ignored');
    expect(first.job?.status).toBe('ignored');
    expect(first.error?.kind).toBe('missing_handler');
    expect(second.status).toBe('ignored');
    expect(second.job?.id).toBe(first.job?.id);
    expect(await watcher.config.jobStore.list()).toHaveLength(1);
  });

  it('reports an unknown stage as a missing-handler job', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: {
        hooksByHookId: {
          [HOOK_ID]: {
            stageIdentifier: 'unknown.stage',
            hookName: 'START',
          },
        },
      },
      handlers: {
        'exec.main#START': () => {
          throw new Error('known stage handler should not run');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    expect(result.status).toBe('ignored');
    expect(result.job?.status).toBe('ignored');
    expect(result.error?.kind).toBe('missing_handler');
    expect(result.error?.message).toContain('unknown.stage#START');
  });

  it('marks unauthorized jobs as failed without automatic retry', async () => {
    let attempts = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      retry: { maxAttempts: 3 },
      handlers: {
        '*': () => {
          attempts += 1;
          throw new Error('AccessControlUnauthorizedAccount submitter');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    expect(attempts).toBe(1);
    expect(result.job?.status).toBe('failed');
    expect(result.error?.kind).toBe('unauthorized');
    expect(result.error?.retryable).toBe(false);
  });

  it('retries retryable handler failures before dead-lettering the job', async () => {
    let attempts = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      retry: { maxAttempts: 2 },
      handlers: {
        '*': () => {
          attempts += 1;
          throw new Error('fetch failed ECONNRESET');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    expect(attempts).toBe(2);
    expect(result.job?.status).toBe('dead_letter');
    expect(result.error?.kind).toBe('rpc_network');
    expect(result.error?.retryable).toBe(true);
  });

  it('persists jobs, maps DTO status, and supports manual retry/dead-letter audit actions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-machine-jobs-'));
    const jobsFile = join(dir, 'jobs.json');
    try {
      const store = new FileStateMachineJobStore(jobsFile);
      const failedWatcher = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        supplierId: 'logistics-provider-a',
        walletAddress: WALLET_ADDRESS,
        dryRun: true,
        artifact: artifactIndex(),
        retry: { maxAttempts: 3 },
        jobStore: store,
        now: () => '2026-04-28T00:00:00.000Z',
        handlers: {
          '*': () => {
            throw new Error('AccessControlUnauthorizedAccount submitter');
          },
        },
      });
      const failed = await failedWatcher.handleLog(hookReadyLog());
      const jobId = failed.job?.id;
      if (!jobId) {
        throw new Error('expected failed job id');
      }

      expect(failed.job?.status).toBe('failed');
      expect(stateMachineJobToExecutorJobDTO(failed.job).status).toBe('failed');

      const retryWatcher = createStateMachineWatcher({
        rpcUrl: 'http://127.0.0.1:8545',
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        supplierId: 'logistics-provider-a',
        walletAddress: WALLET_ADDRESS,
        dryRun: true,
        artifact: artifactIndex(),
        retry: { maxAttempts: 3 },
        jobStore: store,
        now: () => '2026-04-28T00:01:00.000Z',
        handlers: {
          '*': (event) => ({
            orderId: event.orderId,
            source: 'buyer',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const retried = await retryStateMachineJob(retryWatcher, jobId, {
        operator: 'ops@example.com',
        reason: 'authorization granted',
        now: () => '2026-04-28T00:00:30.000Z',
      });

      expect(retried.job?.status).toBe('matched');
      expect(stateMachineJobToExecutorJobDTO(retried.job!).status).toBe('callback_pending');
      const persistedAfterRetry = await store.get(jobId);
      expect(persistedAfterRetry?.lastError).toBeUndefined();
      expect(persistedAfterRetry?.manualActions).toEqual([
        {
          action: 'retry',
          operator: 'ops@example.com',
          at: '2026-04-28T00:00:30.000Z',
          reason: 'authorization granted',
        },
      ]);
      expect(summarizeSupplierOps({ supplierId: 'logistics-provider-a', walletAddress: WALLET_ADDRESS }, [persistedAfterRetry!]))
        .toMatchObject({
          supplierId: 'logistics-provider-a',
          activeJobs: 1,
          failedJobs: 0,
          confirmedSignals: 0,
        });

      const deadLetter = await deadLetterStateMachineJob(store, jobId, {
        operator: 'ops@example.com',
        reason: 'manual review required',
        now: () => '2026-04-28T00:02:00.000Z',
      });

      expect(deadLetter.status).toBe('dead_letter');
      expect(deadLetter.lastError?.message).toBe('manual review required');
      expect(deadLetter.manualActions?.map((action) => action.action)).toEqual(['retry', 'dead_letter']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not retry confirmed jobs', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          orderId: event.orderId,
          source: 'buyer',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });
    const result = await watcher.handleLog(hookReadyLog());
    const jobId = result.job?.id;
    if (!jobId) {
      throw new Error('expected job id');
    }
    await watcher.config.jobStore.update(jobId, {
      status: 'confirmed',
      updatedAt: '2026-04-28T00:00:00.000Z',
    });

    await expect(retryStateMachineJob(watcher, jobId, {
      operator: 'ops@example.com',
    })).rejects.toThrow('cannot be retried from status confirmed');
  });
});

describe('state machine callback tx helper', () => {
  it('generates submitSignal call args in dry-run mode', async () => {
    const result = await submitStateMachineSignal({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: '31337',
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY',
      dryRun: true,
    }, {
      orderId: ORDER_ID,
      source: 'seller',
      signalName: 'ship.pickup.done',
      payloadHash: PAYLOAD_HASH,
      readyEventId: HOOK_ID,
      idempotencyKey: 'order-1:pickup:done',
    });

    if (!result.dryRun) {
      throw new Error('expected dry-run result');
    }

    expect(result.request.address).toBe(STATE_MACHINE);
    expect(result.request.from).toBe(WALLET_ADDRESS);
    expect(result.request.chainId).toBe(31_337);
    expect(result.request.functionName).toBe('submitSignal');
    expect(result.request.data.slice(0, 10)).toBe(STATE_MACHINE_FIXTURE.functions.submitSignal.selector);
    expect(result.request.args.slice(0, 4)).toEqual([
      ORDER_ID,
      keccak256(stringToBytes('seller')),
      keccak256(stringToBytes('ship.pickup.done')),
      PAYLOAD_HASH,
    ]);
    expect(result.request.data).toMatch(/^0x[0-9a-f]+$/);
  });

  it('does not call the network or require a private key in dry-run mode', async () => {
    const result = await submitStateMachineSignal({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: '31337',
      walletAddress: WALLET_ADDRESS,
      privateKeyEnv: 'UVP_TEST_PRIVATE_KEY_NOT_SET',
      dryRun: true,
      publicClient: {
        async getChainId() {
          throw new Error('dry-run should not read chain id');
        },
        async getBlockNumber() {
          throw new Error('dry-run should not read block number');
        },
        async getLogs() {
          throw new Error('dry-run should not read logs');
        },
      },
    }, {
      orderId: ORDER_ID,
      source: 'seller',
      signalName: 'ship.pickup.done',
      payloadHash: PAYLOAD_HASH,
    });

    expect(result.dryRun).toBe(true);
  });
});

describe('state machine executor config', () => {
  it('loads the standard production-boundary config shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-machine-config-'));
    const configPath = join(dir, 'executor.json');
    try {
      await writeFile(configPath, JSON.stringify({
        supplierId: 'logistics-provider-a',
        executorId: 'logistics-provider-a',
        walletAddress: WALLET_ADDRESS,
        chainId: 84_532,
        stateMachineAddress: STATE_MACHINE,
        stateMachines: [
          { stateMachineAddress: STATE_MACHINE, deploymentId: `0x${'01'.repeat(32)}`, status: 'deprecated' },
          { stateMachineAddress: STATE_MACHINE_V2, deploymentId: `0x${'02'.repeat(32)}`, status: 'active' },
        ],
        chainServicesUrl: 'http://127.0.0.1:3001',
        stages: ['export.customs'],
        callbackMode: 'auto',
        dryRun: true,
        authTokenRef: 'UVP_EXECUTOR_TOKEN',
        retry: {
          maxAttempts: 4,
          baseDelayMs: 0,
        },
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

      const config = await loadStateMachineHandlerConfig(configPath);

      expect(config).toMatchObject({
        supplierId: 'logistics-provider-a',
        executorId: 'logistics-provider-a',
        walletAddress: WALLET_ADDRESS,
        chainId: 84_532,
        stateMachineAddress: STATE_MACHINE,
        stateMachines: [
          { stateMachineAddress: STATE_MACHINE, deploymentId: `0x${'01'.repeat(32)}`, status: 'deprecated' },
          { stateMachineAddress: STATE_MACHINE_V2, deploymentId: `0x${'02'.repeat(32)}`, status: 'active' },
        ],
        callbackMode: 'auto',
        dryRun: true,
        authTokenRef: 'UVP_EXECUTOR_TOKEN',
        retry: {
          maxAttempts: 4,
          baseDelayMs: 0,
        },
      });
      expect(config.handlers['export.customs#START']?.signals[0]).toMatchObject({
        source: 'logistics-provider-a',
        stageIdentifier: 'export.customs',
        signalName: 'cmp',
      });
      expect(stateMachineHandlerConfigToExecutorConfigDTO(config)).toMatchObject({
        supplierId: 'logistics-provider-a',
        walletAddress: WALLET_ADDRESS,
        chainId: 84_532,
        stateMachineAddress: STATE_MACHINE,
        stateMachines: [
          { stateMachineAddress: STATE_MACHINE, deploymentId: `0x${'01'.repeat(32)}`, status: 'deprecated' },
          { stateMachineAddress: STATE_MACHINE_V2, deploymentId: `0x${'02'.repeat(32)}`, status: 'active' },
        ],
        chainServicesUrl: 'http://127.0.0.1:3001',
        stages: ['export.customs'],
        signals: ['export.customs.cmp'],
        callbackMode: 'auto',
        dryRun: true,
        authTokenRef: 'UVP_EXECUTOR_TOKEN',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects short signal names without a stage identifier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-state-machine-config-'));
    const configPath = join(dir, 'executor.json');
    try {
      await writeFile(configPath, JSON.stringify({
        handlers: {
          'export.customs#START': {
            signals: [
              {
                source: 'logistics-provider-a',
                signalName: 'cmp',
              },
            ],
          },
        },
      }));

      await expect(loadStateMachineHandlerConfig(configPath))
        .rejects.toThrow('stageIdentifier is required');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('executor error classification', () => {
  it('classifies production submission failures conservatively from messages', () => {
    expect(classifyExecutorKitError(new Error('AccessControlUnauthorizedAccount submitter')).kind).toBe('unauthorized');
    expect(classifyExecutorKitError(new Error('SignalAlreadySubmitted duplicate')).kind).toBe('duplicate_signal');
    expect(classifyExecutorKitError(new Error('fetch failed ECONNREFUSED')).kind).toBe('rpc_network');
    expect(classifyExecutorKitError(new Error('handler_not_found')).kind).toBe('missing_handler');
    expect(classifyExecutorKitError(new Error('payloadHash must be a 32-byte hex value')).kind).toBe('validation_failure');
  });
});

function hookReadyLog(address = STATE_MACHINE): StateMachineRawLog {
  return {
    address,
    data: encodeAbiParameters(
      [
        { type: 'bytes32' },
      ],
      [HOOK_NAME_ID],
    ),
    topics: [
      keccak256(stringToHex(STATE_MACHINE_FIXTURE.events.HookReady.signature)),
      ORDER_ID,
      HOOK_ID,
      STAGE_ID,
    ],
    blockNumber: 12n,
    transactionHash: TX_HASH,
    logIndex: 7,
  };
}

function artifactIndex() {
  return {
    hooksByHookId: {
      [HOOK_ID]: {
        stageIdentifier: 'exec.main',
        hookName: 'START',
      },
    },
  };
}
