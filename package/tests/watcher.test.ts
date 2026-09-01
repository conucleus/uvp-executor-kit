import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, keccak256, stringToBytes, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { classifyExecutorKitError, CodedExecutorKitError } from '../src/errors.js';
import {
  buildSubmitStateMachineSignalCall,
  createStateMachineWatcher,
  deadLetterStateMachineJob,
  decodeHookReadyLog,
  FileStateMachineJobStore,
  hookReadyEventId,
  loadStateMachineHandlerConfig,
  MAX_CONSECUTIVE_POLL_FAILURES,
  retryStateMachineJob,
  submitStateMachineSignal,
  stateMachineHandlerConfigToExecutorConfigDTO,
  stateMachineJobToExecutorJobDTO,
  summarizeSupplierOps,
  type StateMachinePublicClient,
  type StateMachineRawLog,
} from '../src/watcher.js';
import { ValidationError } from '../src/validation.js';

const STATE_MACHINE = '0x0000000000000000000000000000000000000001';
const STATE_MACHINE_V2 = '0x0000000000000000000000000000000000000009';
const WALLET_ADDRESS = '0x0000000000000000000000000000000000000002';
const ORDER_ID = `0x${'11'.repeat(32)}` as Hex;
const PLAN_ID = `0x${'77'.repeat(32)}` as Hex;
const HOOK_ID = `0x${'22'.repeat(32)}` as Hex;
const STAGE_ID = `0x${'55'.repeat(32)}` as Hex;
const HOOK_NAME_ID = `0x${'66'.repeat(32)}` as Hex;
const TX_HASH = `0x${'33'.repeat(32)}` as Hex;
const PAYLOAD_HASH = `0x${'44'.repeat(32)}` as Hex;
const BUYER_SOURCE_ID = keccak256(stringToBytes('buyer'));
const EXEC_MAIN_CMP_ID = keccak256(stringToBytes('exec.main.cmp'));
const STATE_MACHINE_FIXTURE = JSON.parse(
  readFileSync(new URL('../../../uvp-protocol/contracts/uvp-contracts/fixtures/uvp-state-machine.v0.8.json', import.meta.url), 'utf8'),
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

  it('throws with the original context when a HookReady-topic log fails to decode', () => {
    const broken = { ...hookReadyLog(), data: '0xdeadbeef' as Hex };

    expect(() => decodeHookReadyLog(broken, artifactIndex())).toThrow(/failed to decode HookReady log data/);
  });

  it('still skips logs without the HookReady topic', () => {
    const otherTopic = keccak256(stringToBytes('Other(uint256)'));
    const unrelated = { ...hookReadyLog(), topics: [otherTopic, ORDER_ID] };

    expect(decodeHookReadyLog(unrelated, artifactIndex())).toBeUndefined();
  });

  it('refuses to derive event ids from zero values when transactionHash or logIndex is missing', () => {
    expect(() => hookReadyEventId({ transactionHash: null, logIndex: 7 })).toThrow(/transactionHash/);
    expect(() => hookReadyEventId({ transactionHash: TX_HASH, logIndex: null })).toThrow(/logIndex/);
    expect(() => hookReadyEventId({ transactionHash: TX_HASH })).toThrow(/logIndex/);
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
            planId: PLAN_ID,
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
    // Audit #10: planId is the first submitSignal argument.
    expect(submission.request.args).toEqual([
      PLAN_ID,
      ORDER_ID,
      BUYER_SOURCE_ID,
      EXEC_MAIN_CMP_ID,
      PAYLOAD_HASH,
      expect.any(String),
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
          planId: PLAN_ID,
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
          planId: PLAN_ID,
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

  it('skips and counts a log that cannot be normalized instead of aborting the round', async () => {
    const errors: unknown[] = [];
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
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'buyer',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
      onError: (error) => {
        errors.push(error);
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

    // The malformed log is skipped (it has no usable identity, so it cannot be
    // persisted), the healthy log is still handled, and the cursor advances so
    // the malformed log is not rescanned forever.
    expect(poll.decodeFailures).toBe(1);
    expect(poll.results[0]?.status).toBe('ignored');
    expect(poll.results[0]?.decodeFailure).toBe(true);
    expect(poll.results[0]?.error?.kind).toBe('validation_failure');
    expect(poll.results[0]?.job).toBeUndefined();
    expect(poll.results[1]?.status).toBe('handled');
    expect(errors).toHaveLength(1);
    expect(watcher.describe().nextBlock).toBe('13');
    expect(watcher.describe().decodeFailures).toBe(1);
  });

  it('isolates an undecodable HookReady log as a persisted ignored job with the raw log preserved', async () => {
    const broken = { ...hookReadyLog(), data: '0xdeadbeef' as Hex };
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': () => {
          throw new Error('isolated log must not reach a handler');
        },
      },
    });

    const first = await watcher.handleLog(broken);
    const second = await watcher.handleLog(broken);

    expect(first.status).toBe('ignored');
    expect(first.decodeFailure).toBe(true);
    expect(first.error?.kind).toBe('validation_failure');
    expect(first.error?.message).toContain('failed to decode HookReady log data');
    expect(first.job?.status).toBe('ignored');
    expect(first.job?.orderId).toBe(`0x${'00'.repeat(32)}`);
    expect(first.job?.raw).toEqual(broken);
    // Rescanning the same log is idempotent: same job, still terminal ignored.
    expect(second.job?.id).toBe(first.job?.id);
    expect(second.job?.status).toBe('ignored');
    expect(await watcher.config.jobStore.list()).toHaveLength(1);
  });

  it('keeps watching when every round re-scans the same undecodable log', async () => {
    let polls = 0;
    let aborted = false;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      fromBlock: 10,
      dryRun: true,
      handlers: {
        '*': () => undefined,
      },
      pollIntervalMs: 1,
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          // A new block every round so each poll rescans a range that still
          // contains the undecodable log (restart/rescan semantics).
          return 12n + BigInt(polls);
        },
        async getLogs() {
          polls += 1;
          return [{ ...hookReadyLog(), data: '0xdeadbeef' as Hex }];
        },
      },
    });

    const handle = await watcher.start();
    void handle.done.catch(() => {
      aborted = true;
    });

    // Far more consecutive rounds than MAX_CONSECUTIVE_POLL_FAILURES: decode
    // failures must never count as failed polls or abort the loop.
    const deadline = Date.now() + 500;
    while (polls < 12 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(polls).toBeGreaterThanOrEqual(12);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(aborted).toBe(false);

    // The isolated decision persists: exactly one ignored job for the log.
    const jobs = await watcher.config.jobStore.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('ignored');
    const described = watcher.describe() as { decodeFailures?: number };
    expect(described.decodeFailures).toBeGreaterThanOrEqual(12);

    await handle.stop();
  });

  it('keeps the first-round fail-fast behavior when the initial poll fails', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      handlers: {
        '*': () => undefined,
      },
      pollIntervalMs: 1,
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          return 12n;
        },
        async getLogs() {
          throw new Error('rpc down');
        },
      },
    });

    await expect(watcher.start()).rejects.toThrow('rpc down');
  });

  it('stops the watch loop and surfaces a fatal error after more consecutive failed polls than the threshold', async () => {
    const errors: unknown[] = [];
    let polls = 0;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      handlers: {
        '*': () => undefined,
      },
      pollIntervalMs: 1,
      onError: (error) => {
        errors.push(error);
      },
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          polls += 1;
          if (polls === 1) {
            return 12n;
          }
          throw new Error(`rpc down ${polls}`);
        },
        async getLogs() {
          return [];
        },
      },
    });

    const handle = await watcher.start();
    await expect(handle.done).rejects.toThrow(/consecutive failed polls.*rpc down/s);

    // Threshold failures are reported through onError before the fatal abort.
    expect(errors.length).toBe(MAX_CONSECUTIVE_POLL_FAILURES + 1);

    const observedErrors = errors.length;
    const observedPolls = polls;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(errors.length).toBe(observedErrors);
    expect(polls).toBe(observedPolls);
  });

  it('keeps watching when a successful round resets the consecutive-failure count', async () => {
    const script = ['ok', 'fail', 'fail', 'ok', 'fail', 'fail', 'ok'] as const;
    let polls = 0;
    let aborted = false;
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      handlers: {
        '*': () => undefined,
      },
      pollIntervalMs: 1,
      publicClient: {
        async getChainId() {
          return 31_337;
        },
        async getBlockNumber() {
          polls += 1;
          const step = script[Math.min(polls - 1, script.length - 1)];
          if (step === 'fail') {
            throw new Error(`rpc down ${polls}`);
          }
          return 12n;
        },
        async getLogs() {
          return [];
        },
      },
    });

    const handle = await watcher.start();
    void handle.done.catch(() => {
      aborted = true;
    });

    const deadline = Date.now() + 2_000;
    while (polls < script.length + 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(polls).toBeGreaterThanOrEqual(script.length + 2);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(aborted).toBe(false);

    await handle.stop();
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

  it('dead-letters coded unauthorized jobs without automatic retry', async () => {
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
          throw new CodedExecutorKitError('UNAUTHORIZED', 'AccessControlUnauthorizedAccount submitter');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    // Deterministic non-retryable failures dead-letter for human triage instead
    // of parking in the retryable `failed` lane.
    expect(attempts).toBe(1);
    expect(result.job?.status).toBe('dead_letter');
    expect(stateMachineJobToExecutorJobDTO(result.job!).status).toBe('dead_letter');
    expect(result.error?.kind).toBe('unauthorized');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
  });

  it('classifies real revert texts thrown by handlers and dead-letters them without retry', async () => {
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
          // Native viem revert text without an explicit executor-kit code.
          throw new Error('Call revert exception: execution reverted: SignalAlreadyExists()');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    // duplicate_signal is a dedupe fact, not a failure: the job lands in the
    // terminal ignored state even though the handler itself ran.
    expect(attempts).toBe(1);
    expect(result.status).toBe('handled');
    expect(result.job?.status).toBe('ignored');
    expect(result.error?.kind).toBe('duplicate_signal');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.code).toBeUndefined();
  });

  it('keeps unclassifiable handler failures conservatively non-retryable in dead_letter', async () => {
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
          throw new Error('handler exploded in a way no pattern matches');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    // A single attempt, no auto retry, and no keyword-derived kind: without an
    // explicit code or a recognized error text the failure is conservatively
    // non-retryable and dead-letters for human review.
    // 'handler_failure' is the explicit structural fallback for thrown handlers,
    // not a message-text guess.
    expect(attempts).toBe(1);
    expect(result.job?.status).toBe('dead_letter');
    expect(result.error?.kind).toBe('handler_failure');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.code).toBeUndefined();
  });

  it('retries coded rpc_network handler failures and leaves the job in the retryable failed lane', async () => {
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
          throw new CodedExecutorKitError('RPC_NETWORK', 'fetch failed ECONNRESET');
        },
      },
    });

    const result = await watcher.handleLog(hookReadyLog());

    // Transient failures exhaust their in-run retries into `failed`, the one
    // failure state that `jobs retry` still accepts.
    expect(attempts).toBe(2);
    expect(result.job?.status).toBe('failed');
    expect(result.error?.kind).toBe('rpc_network');
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('RPC_NETWORK');
  });

  it('re-opens a failed job through the manual retry channel', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'buyer',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });
    const initial = await watcher.handleLog(hookReadyLog());
    const jobId = initial.job?.id;
    if (!jobId) {
      throw new Error('expected job id');
    }
    // Simulate an earlier transient failure: the job sits in `failed` with a
    // retry budget remaining.
    await watcher.config.jobStore.update(jobId, {
      status: 'failed',
      attempts: 1,
      updatedAt: '2026-04-28T00:00:01.000Z',
      lastError: {
        kind: 'rpc_network',
        message: 'fetch failed ECONNRESET',
        retryable: true,
      },
    });

    const retried = await retryStateMachineJob(watcher, jobId, {
      operator: 'ops@example.com',
      reason: 'rpc recovered',
    });
    expect(retried.status).toBe('handled');
    expect(retried.job?.status).toBe('matched');
    expect(retried.job?.lastError).toBeUndefined();
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
        retry: { maxAttempts: 2 },
        jobStore: store,
        now: () => '2026-04-28T00:00:00.000Z',
        handlers: {
          '*': () => {
            throw new CodedExecutorKitError('RPC_NETWORK', 'fetch failed ECONNRESET');
          },
        },
      });
      const failed = await failedWatcher.handleLog(hookReadyLog());
      const jobId = failed.job?.id;
      if (!jobId) {
        throw new Error('expected failed job id');
      }

      // Transient failures exhaust into `failed`, the retriable lane.
      expect(failed.job?.status).toBe('failed');
      expect(stateMachineJobToExecutorJobDTO(failed.job).status).toBe('failed');
      const persistedAfterFailure = await store.get(jobId);
      expect(persistedAfterFailure?.status).toBe('failed');
      expect(persistedAfterFailure?.attempts).toBe(2);

      // A manual retry past the recorded attempt budget dead-letters with the
      // operator action preserved, instead of silently re-running.
      const overLimit = await retryStateMachineJob(failedWatcher, jobId, {
        operator: 'ops@example.com',
        reason: 'pushing past the attempt budget',
        now: () => '2026-04-28T00:00:30.000Z',
      });
      expect(overLimit.job?.status).toBe('dead_letter');
      expect(overLimit.error?.message).toContain('retry limit reached');
      const persistedAfterOverLimit = await store.get(jobId);
      expect(persistedAfterOverLimit?.manualActions).toEqual([
        {
          action: 'retry',
          operator: 'ops@example.com',
          at: '2026-04-28T00:00:30.000Z',
          reason: 'pushing past the attempt budget',
        },
      ]);
      expect(summarizeSupplierOps({ supplierId: 'logistics-provider-a', walletAddress: WALLET_ADDRESS }, [persistedAfterOverLimit!]))
        .toMatchObject({
          supplierId: 'logistics-provider-a',
          activeJobs: 0,
          failedJobs: 1,
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
          planId: PLAN_ID,
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

  it('keeps unconfirmed submissions non-terminal so rescans and retries can still observe them', async () => {
    const watcher = createStateMachineWatcher({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      dryRun: true,
      artifact: artifactIndex(),
      // Every run (handler + each submission) consumes attempts; give this test
      // a generous budget so the manual retry below stays inside the limit.
      retry: { maxAttempts: 12 },
      handlers: {
        '*': (event) => ({
          planId: PLAN_ID,
          orderId: event.orderId,
          source: 'buyer',
          signalName: 'exec.main.cmp',
          payloadHash: PAYLOAD_HASH,
        }),
      },
    });
    const first = await watcher.handleLog(hookReadyLog());
    const jobId = first.job?.id;
    if (!jobId) {
      throw new Error('expected job id');
    }
    // Simulate a broadcast whose receipt was never observed.
    await watcher.config.jobStore.update(jobId, {
      status: 'submitted',
      updatedAt: '2026-04-28T00:00:02.000Z',
    });

    // A rescan of the same HookReady log reprocesses the open job instead of ignoring it.
    const rescan = await watcher.handleLog(hookReadyLog());
    expect(rescan.status).toBe('handled');
    expect(rescan.job?.id).toBe(jobId);

    // Manual retry accepts an unconfirmed submitted job.
    const retried = await retryStateMachineJob(watcher, jobId, {
      operator: 'ops@example.com',
      reason: 'receipt never observed',
    });
    expect(retried.status).toBe('handled');
    expect(retried.job?.status).toBe('matched');
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
      planId: PLAN_ID,
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
    // Audit #10: planId leads the ABI arguments.
    expect(result.request.args.slice(0, 5)).toEqual([
      PLAN_ID,
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
      planId: PLAN_ID,
      orderId: ORDER_ID,
      source: 'seller',
      signalName: 'ship.pickup.done',
      payloadHash: PAYLOAD_HASH,
    });

    expect(result.dryRun).toBe(true);
  });

  it('refuses to build a submitSignal tx when the signal has no plan id', async () => {
    // Audit #10 negative: submitSignal(planId, ...) is plan-scoped. A missing
    // planId (or the builder's zero placeholder) must fail loudly instead of
    // producing a tx that can only revert on the on-chain (planId, orderId)
    // existence check.
    for (const broken of [
      {},
      { planId: `0x${'00'.repeat(32)}` as Hex },
    ]) {
      await expect(submitStateMachineSignal({
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
        ...broken,
      })).rejects.toThrow(/planId/);
    }
    expect(() => buildSubmitStateMachineSignalCall({
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
    }, {
      orderId: ORDER_ID,
      source: 'seller',
      signalName: 'ship.pickup.done',
    })).toThrow(/planId is required/);
  });

  it('fails the job instead of submitting when neither handler nor job carries a plan id', async () => {
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

    // No planId anywhere: nothing may be broadcast, and the job records the
    // structural reason so the operator can fix the handler config.
    expect(result.submissions).toHaveLength(0);
    expect(result.job?.status).toBe('dead_letter');
    expect(result.error?.message).toContain('planId is required');
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
  it('honors explicit error codes before any text matching', () => {
    expect(classifyExecutorKitError(new CodedExecutorKitError('UNAUTHORIZED', 'AccessControlUnauthorizedAccount submitter')))
      .toMatchObject({ kind: 'unauthorized', retryable: false, code: 'UNAUTHORIZED' });
    expect(classifyExecutorKitError(new CodedExecutorKitError('DUPLICATE_SIGNAL', 'SignalAlreadySubmitted')))
      .toMatchObject({ kind: 'duplicate_signal', retryable: false, code: 'DUPLICATE_SIGNAL' });
    expect(classifyExecutorKitError(new CodedExecutorKitError('RPC_NETWORK', 'fetch failed ECONNREFUSED')))
      .toMatchObject({ kind: 'rpc_network', retryable: true, code: 'RPC_NETWORK' });
    expect(classifyExecutorKitError(new CodedExecutorKitError('MISSING_HANDLER')))
      .toMatchObject({ kind: 'missing_handler', retryable: false, code: 'MISSING_HANDLER' });

    // The code is honored across a wrapped cause chain.
    const wrapped = new Error('submission failed', { cause: new CodedExecutorKitError('RPC_NETWORK', 'timeout') });
    expect(classifyExecutorKitError(wrapped)).toMatchObject({ kind: 'rpc_network', retryable: true, code: 'RPC_NETWORK' });
  });

  it('classifies real viem and ethereum error texts without explicit codes', () => {
    // Contract revert: decoded custom-error name for an already-known signal.
    expect(classifyExecutorKitError(new Error('Call revert exception: execution reverted: SignalAlreadyExists()')))
      .toMatchObject({ kind: 'duplicate_signal', retryable: false });
    // Raw revert data carrying the SignalAlreadyExists() selector 0xa2e92828.
    expect(classifyExecutorKitError(new Error('execution reverted: 0xa2e92828')))
      .toMatchObject({ kind: 'duplicate_signal', retryable: false });
    // OpenZeppelin authorization revert names surface verbatim in viem messages.
    expect(classifyExecutorKitError(new Error('AccessControlUnauthorizedAccount submitter')))
      .toMatchObject({ kind: 'unauthorized', retryable: false });
    // Gas shortfall: recoverable by funding, so it stays in the retry lane.
    expect(classifyExecutorKitError(new Error('insufficient funds for gas * price + value')))
      .toMatchObject({ kind: 'insufficient_funds', retryable: true });
    // Tx-pool and nonce races: transient broadcast conditions.
    expect(classifyExecutorKitError(new Error('nonce too low')))
      .toMatchObject({ kind: 'nonce_conflict', retryable: true });
    expect(classifyExecutorKitError(new Error('nonce has already been used')))
      .toMatchObject({ kind: 'nonce_conflict', retryable: true });
    // Transport and rate-limit conditions.
    expect(classifyExecutorKitError(new Error('connect ECONNREFUSED 127.0.0.1:8545')))
      .toMatchObject({ kind: 'rpc_network', retryable: true });
    expect(classifyExecutorKitError(new Error('HTTP request failed with status 429: Too Many Requests')))
      .toMatchObject({ kind: 'rpc_network', retryable: true });
    expect(classifyExecutorKitError(new Error('Request timed out.')))
      .toMatchObject({ kind: 'rpc_network', retryable: true });
    expect(classifyExecutorKitError(new Error('fetch failed')))
      .toMatchObject({ kind: 'rpc_network', retryable: true });
    expect(classifyExecutorKitError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8545'), { code: 'ECONNREFUSED' })))
      .toMatchObject({ kind: 'rpc_network', retryable: true });
    // The text is recognized across a wrapped cause chain (viem nests causes).
    const wrapped = new Error('submission failed', { cause: new Error('fetch failed: socket hang up') });
    expect(classifyExecutorKitError(wrapped)).toMatchObject({ kind: 'rpc_network', retryable: true });
  });

  it('keeps unrecognized failures conservatively non-retryable for human review', () => {
    // Plain errors with no recognized shape keep their message but get no
    // keyword-derived classification.
    expect(classifyExecutorKitError(new Error('handler exploded in a way no pattern matches'))).toEqual({
      kind: 'unknown',
      message: 'handler exploded in a way no pattern matches',
      retryable: false,
    });

    // ValidationError remains an explicit type-based classification.
    expect(classifyExecutorKitError(new ValidationError('payloadHash must be a 32-byte hex value')))
      .toMatchObject({ kind: 'validation_failure', retryable: false });
  });
});

describe('submitSignal receipt visibility', () => {
  const KEY_ENV = 'UVP_RECEIPT_TEST_PRIVATE_KEY';
  const TEST_PRIVATE_KEY = `0x${'ab'.repeat(32)}`;
  const SIGNAL = {
    planId: PLAN_ID,
    orderId: ORDER_ID,
    source: 'buyer',
    signalName: 'exec.main.cmp',
    payloadHash: PAYLOAD_HASH,
  };

  it('defaults waitForReceipt to true while still honoring an explicit false', () => {
    const base = {
      rpcUrl: 'http://127.0.0.1:8545',
      stateMachineAddress: STATE_MACHINE,
      chainId: 31_337,
      walletAddress: WALLET_ADDRESS,
      handlers: {},
    };
    expect(createStateMachineWatcher(base).config.waitForReceipt).toBe(true);
    expect(createStateMachineWatcher({ ...base, waitForReceipt: false }).config.waitForReceipt).toBe(false);
  });

  it('throws loudly when the submitSignal transaction receipt reverts', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      await expect(submitStateMachineSignal({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'reverted' }),
      }, SIGNAL)).rejects.toThrow(/submitSignal transaction receipt status reverted/);
      expect(stub.methods).toContain('eth_sendRawTransaction');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('routes a real SignalAlreadyExists revert on replay into an ignored job instead of failed', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    // Restart replay of an already-committed signal: the chain rejects the
    // resubmission with the real contract revert text.
    const stub = await startJsonRpcStub({
      estimateGasError: { code: 3, message: 'execution reverted: SignalAlreadyExists()' },
    });
    try {
      const watcher = createStateMachineWatcher({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        artifact: artifactIndex(),
        retry: { maxAttempts: 3 },
        handlers: {
          '*': (event) => ({
            planId: PLAN_ID,
            orderId: event.orderId,
            source: 'buyer',
            signalName: 'exec.main.cmp',
            payloadHash: PAYLOAD_HASH,
          }),
        },
      });

      const result = await watcher.handleLog(hookReadyLog());

      // The duplicate is a dedupe fact, not a failure: recognized from the real
      // revert text without any explicit code, and the job is ignored.
      expect(result.status).toBe('ignored');
      expect(result.job?.status).toBe('ignored');
      expect(result.error?.kind).toBe('duplicate_signal');
      expect(result.error?.retryable).toBe(false);
      expect(result.error?.message).toContain('SignalAlreadyExists');
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('reports confirmed:true only after a successful receipt', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const result = await submitStateMachineSignal({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: fakeReceiptClient(31_337, { status: 'success' }),
      }, SIGNAL);
      if (result.dryRun) {
        throw new Error('expected a broadcast result');
      }
      expect(result.txHash).toBe(TX_HASH);
      expect(result.confirmed).toBe(true);
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
  });

  it('leaves the submission unconfirmed when no receipt can be waited for instead of claiming success', async () => {
    process.env[KEY_ENV] = TEST_PRIVATE_KEY;
    const stub = await startJsonRpcStub();
    try {
      const result = await submitStateMachineSignal({
        rpcUrl: stub.url,
        stateMachineAddress: STATE_MACHINE,
        chainId: 31_337,
        privateKeyEnv: KEY_ENV,
        publicClient: {
          async getChainId() {
            return 31_337;
          },
          async getBlockNumber() {
            return 12n;
          },
          async getLogs() {
            return [];
          },
        },
      }, SIGNAL);
      if (result.dryRun) {
        throw new Error('expected a broadcast result');
      }
      expect(result.txHash).toBe(TX_HASH);
      expect(result.confirmed).toBeUndefined();
    } finally {
      await stub.close();
      delete process.env[KEY_ENV];
    }
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

type JsonRpcRequest = { readonly id?: unknown; readonly method?: string };

/**
 * Minimal JSON-RPC endpoint so viem's wallet transport can broadcast locally
 * without a real chain; only the broadcast path is exercised this way — receipt
 * waiting comes from an injected StateMachinePublicClient.
 */
async function startJsonRpcStub(options: {
  readonly estimateGasError?: { readonly code: number; readonly message: string };
} = {}): Promise<{
  readonly url: string;
  readonly methods: string[];
  close(): Promise<void>;
}> {
  const methods: string[] = [];
  const handlers: Record<string, () => unknown> = {
    eth_call: () => '0x',
    eth_estimateGas: () => '0x5208',
    eth_gasPrice: () => '0x3b9aca00',
    eth_getTransactionCount: () => '0x0',
    eth_sendRawTransaction: () => TX_HASH,
    eth_blockNumber: () => '0xc',
    eth_chainId: () => '0x7a69',
    eth_maxPriorityFeePerGas: () => '0x3b9aca00',
    eth_getBlockByNumber: () => ({
      number: '0xc',
      hash: TX_HASH,
      parentHash: `0x${'00'.repeat(32)}`,
      nonce: `0x${'00'.repeat(8)}`,
      sha3Uncles: `0x${'00'.repeat(32)}`,
      logsBloom: `0x${'00'.repeat(256)}`,
      transactionsRoot: `0x${'00'.repeat(32)}`,
      stateRoot: `0x${'00'.repeat(32)}`,
      receiptsRoot: `0x${'00'.repeat(32)}`,
      miner: '0x0000000000000000000000000000000000000000',
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      size: '0x0',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      timestamp: '0x5f5e100',
      transactions: [],
      uncles: [],
    }),
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as JsonRpcRequest | readonly JsonRpcRequest[];
      const respondOne = (body: JsonRpcRequest, id: unknown) => {
        methods.push(body.method ?? '');
        if (body.method === 'eth_estimateGas' && options.estimateGasError) {
          return {
            jsonrpc: '2.0',
            id: body.id ?? id ?? 1,
            error: options.estimateGasError,
          };
        }
        return {
          jsonrpc: '2.0',
          id: body.id ?? id ?? 1,
          result: (handlers[body.method ?? ''] ?? (() => null))(),
        };
      };
      const payload = Array.isArray(parsed)
        ? parsed.map((entry, index) => respondOne(entry, index + 1))
        : [respondOne(parsed, 1)];
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(Array.isArray(parsed) ? payload : payload[0]));
    })().catch(() => {
      response.statusCode = 500;
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('json-rpc stub did not bind to a TCP address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    methods,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function fakeReceiptClient(chainId: number, receipt: { readonly status?: string }): StateMachinePublicClient {
  return {
    async getChainId() {
      return chainId;
    },
    async getBlockNumber() {
      return 12n;
    },
    async getLogs() {
      return [];
    },
    async waitForTransactionReceipt() {
      return receipt;
    },
  };
}
