import type { Command } from 'commander';
import { stringifyForTransport } from '../../transport.js';
import { parsePositiveInteger, ValidationError } from '../../validation.js';
import {
  DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV,
  submitStateMachineSignal,
} from '../../watcher/index.js';
import { chainPollExecutionFailed } from '../output.js';
import {
  waitForShutdown,
  type ChainSignalOptions,
  type ChainWatchOptions,
} from '../options.js';
import {
  buildStateMachineWatcherFromCli,
  DEFAULT_WATCHER_STATE_DIR,
  EXECUTOR_RUNTIME_ENV,
  WATCHER_STATE_DIR_ENV,
} from '../watcher.js';

/** chain-once / chain-watch / chain-signal 命令分发。 */
export function registerChainCommands(program: Command): void {
  program
    .command('chain-once')
    .description('scan UVPStateMachine HookReady logs once and submit callback txs')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .option('--state-machine <address>', 'UVPStateMachine contract address; optional when config stateMachines[] is set')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--config <path>', 'state machine handler config JSON path')
    .option('--wallet-address <address>', 'executor wallet address shown as submitSignal sender in dry-run')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--from-block <uint>', 'first block to scan; on restart a persisted scan cursor takes precedence')
    .option('--confirmations <n>', 'finality buffer in blocks: scan only up to head - n (0 restores tip scanning); defaults to 1 only for local/undeclared runtime envs and must be passed explicitly for non-local ones')
    .option('--runtime-env <env>', `declared runtime environment (local, testnet, staging, production); non-local values make an explicit --confirmations mandatory (default: $${EXECUTOR_RUNTIME_ENV} or local caliber)`)
    .option('--reorg-window <blocks>', 'bounded reorg checkpoint window for the common-ancestor rollback', '64')
    .option('--max-get-logs-block-span <blocks>', 'max blocks per eth_getLogs request; deeper ranges are chunked', '9999')
    .option('--jobs-file <path>', 'watcher jobs JSON file (default: <state-dir>/jobs.json)')
    .option('--state-dir <path>', `watcher state directory holding jobs.json and cursor.json (default: $${WATCHER_STATE_DIR_ENV} or ${DEFAULT_WATCHER_STATE_DIR})`)
    .option('--job-store <file|memory>', 'watcher job store: file persists jobs and scan cursor across restarts, memory keeps them in-process', 'file')
    .option('--dry-run', 'build submitSignal tx requests without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (options: ChainWatchOptions) => {
      const { watcher, storage, stateLock } = await buildStateMachineWatcherFromCli(options);
      try {
        const poll = await watcher.pollOnce();
        console.log(stringifyForTransport({ watcher: watcher.describe(), storage, poll }));
        // Honest exit code: submission errors folded into the poll result (or
        // failed/dead-lettered jobs) must not masquerade as a successful run.
        if (chainPollExecutionFailed(poll)) {
          process.exitCode = 1;
        }
      } finally {
        await stateLock?.release();
      }
    });

  program
    .command('chain-watch')
    .description('poll UVPStateMachine HookReady logs and submit callback txs')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .option('--state-machine <address>', 'UVPStateMachine contract address; optional when config stateMachines[] is set')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--config <path>', 'state machine handler config JSON path')
    .option('--wallet-address <address>', 'executor wallet address shown as submitSignal sender in dry-run')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--from-block <uint>', 'first block to scan; on restart a persisted scan cursor takes precedence')
    .option('--poll-interval-ms <ms>', 'polling interval in milliseconds')
    .option('--confirmations <n>', 'finality buffer in blocks: scan only up to head - n (0 restores tip scanning); defaults to 1 only for local/undeclared runtime envs and must be passed explicitly for non-local ones')
    .option('--runtime-env <env>', `declared runtime environment (local, testnet, staging, production); non-local values make an explicit --confirmations mandatory (default: $${EXECUTOR_RUNTIME_ENV} or local caliber)`)
    .option('--reorg-window <blocks>', 'bounded reorg checkpoint window for the common-ancestor rollback', '64')
    .option('--max-get-logs-block-span <blocks>', 'max blocks per eth_getLogs request; deeper ranges are chunked', '9999')
    .option('--jobs-file <path>', 'watcher jobs JSON file (default: <state-dir>/jobs.json)')
    .option('--state-dir <path>', `watcher state directory holding jobs.json and cursor.json (default: $${WATCHER_STATE_DIR_ENV} or ${DEFAULT_WATCHER_STATE_DIR})`)
    .option('--job-store <file|memory>', 'watcher job store: file persists jobs and scan cursor across restarts, memory keeps them in-process', 'file')
    .option('--dry-run', 'build submitSignal tx requests without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (options: ChainWatchOptions) => {
      const { watcher, storage, stateLock } = await buildStateMachineWatcherFromCli(options);
      try {
        console.log(stringifyForTransport({ watcher: watcher.describe(), storage }));
        const handle = await watcher.start();
        try {
          // handle.done resolves on stop(); persistent poll failures are
          // reported through the watcher's onError (stderr) with capped
          // exponential backoff instead of aborting the loop.
          await Promise.race([
            handle.done,
            waitForShutdown(async () => {
              await handle.stop();
            }),
          ]);
        } finally {
          await handle.stop();
        }
      } finally {
        // 取锁与 finally 之间的一切失败路径（describe/start 抛错）都必须
        // 释放 state-dir 锁，否则泄漏的 watcher.lock 拒绝下一个进程。
        await stateLock?.release();
      }
    });

  program
    .command('chain-signal')
    .description('build and optionally submit one UVPStateMachine submitSignal tx')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .requiredOption('--state-machine <address>', 'UVPStateMachine contract address')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .option('--wallet-address <address>', 'executor wallet address shown as submitSignal sender in dry-run')
    .requiredOption('--order-id <bytes32>', 'order id')
    .requiredOption('--plan-id <bytes32>', 'plan id the order belongs to (plan-scoped submitSignal ABI; zero placeholder is rejected)')
    .requiredOption('--source <source>', 'signal source')
    .requiredOption('--stage <stageIdentifier>', 'stage identifier')
    .requiredOption('--signal-name <signalName>', 'signal name')
    .option('--payload-hash <bytes32>', 'off-chain payload hash')
    .option('--payload-ref <uri>', 'unsupported: rejected because submitSignal cannot carry an off-chain payload reference')
    .option('--idempotency-key <key>', 'idempotency key')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--dry-run', 'build the submitSignal tx request without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (options: ChainSignalOptions) => {
      if (options.payloadRef) {
        // The frozen UVPStateMachine v0.10 ABI has no payloadRef input, so this
        // flag would be silently dropped and the operator would walk away with
        // a "submitted" success that never carried the reference. Fail loudly;
        // only the 32-byte payloadHash goes on chain.
        throw new ValidationError(
          '--payload-ref is not supported by chain-signal: submitSignal(planId, orderId, sourceId, signalId, payloadHash, idempotencyKey) has no reference field, so the flag would be silently dropped. Keep only the 32-byte --payload-hash on chain and record the off-chain payload reference in your own job/evidence store next to it.',
        );
      }
      const result = await submitStateMachineSignal({
        rpcUrl: options.rpcUrl,
        stateMachineAddress: options.stateMachine,
        chainId: parsePositiveInteger(options.chainId, 'chainId'),
        ...(options.walletAddress ? { walletAddress: options.walletAddress } : {}),
        privateKeyEnv: options.privateKeyEnv,
        dryRun: options.dryRun ?? false,
        ...(options.waitForReceipt !== undefined ? { waitForReceipt: options.waitForReceipt } : {}),
      }, {
        planId: options.planId,
        orderId: options.orderId,
        source: options.source,
        stageIdentifier: options.stage,
        signalName: options.signalName,
        ...(options.payloadHash ? { payloadHash: options.payloadHash } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      console.log(stringifyForTransport({ stateMachineSignal: result }));
    });
}
