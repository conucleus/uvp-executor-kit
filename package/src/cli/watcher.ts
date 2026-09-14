import { dirname, join, resolve } from 'node:path';
import {
  normalizeAddressChecksummed,
  parsePositiveInteger,
  ValidationError,
} from '../validation.js';
import { stringifyForTransport } from '../transport.js';
import {
  FileStateMachineCursorStore,
  FileStateMachineJobStore,
  acquireWatcherStateDirLock,
  createStateMachineHandlersFromConfig,
  createStateMachineWatcher,
  loadStateMachineHandlerConfig,
  type StateMachineCursorStore,
  type StateMachineJobStore,
  type StateMachineRuntimeEnvironment,
  type WatcherStateDirLock,
} from '../watcher/index.js';
import { parseNonNegativeIntegerOption, type ChainWatchOptions } from './options.js';

/** Default watcher state directory relative to the process working directory. */
export const DEFAULT_WATCHER_STATE_DIR = './uvp-watcher-state';
/** Env var overriding the default watcher state directory (the --state-dir flag wins over it). */
export const WATCHER_STATE_DIR_ENV = 'UVP_WATCHER_STATE_DIR';
/**
 * Declared runtime environment for watcher invocations (local, testnet,
 * staging, production) — same value set as chain-services
 * CHAIN_SERVICES_RUNTIME_ENV. Non-local values forbid the silent finality
 * default of 1 confirmation.
 */
export const EXECUTOR_RUNTIME_ENV = 'UVP_EXECUTOR_RUNTIME_ENV';

/**
 * Resolve the declared runtime environment: --runtime-env wins over the env
 * var; neither set keeps the local caliber (default finality allowed).
 */
export function resolveRuntimeEnvironment(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): StateMachineRuntimeEnvironment | undefined {
  const raw = (flagValue ?? env[EXECUTOR_RUNTIME_ENV])?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (raw === 'local' || raw === 'testnet' || raw === 'staging' || raw === 'production') {
    return raw;
  }
  throw new ValidationError(`--runtime-env / ${EXECUTOR_RUNTIME_ENV} must be local, testnet, staging, or production (got ${raw})`);
}

/**
 * What the CLI builds for watcher state. `file` (default) persists both
 * the job store and the scan cursor so a restart resumes instead of rescanning;
 * `memory` keeps jobs and the cursor in process memory.
 */
export type WatcherStorageSummary =
  | { readonly mode: 'memory' }
  | {
    readonly mode: 'file';
    readonly stateDir: string;
    readonly jobsFile: string;
    readonly cursorFile: string;
  };

export interface WatcherStorageResolution {
  readonly summary: WatcherStorageSummary;
  readonly jobStore?: StateMachineJobStore;
  readonly cursorStore?: StateMachineCursorStore;
}

/**
 * Resolve where the CLI keeps watcher state.
 *
 * - `--job-store memory` opts out of persistence entirely.
 * - `--jobs-file <path>` pins the exact jobs path; the cursor lives
 *   beside it as `<dir>/cursor.json` so one directory is one watcher state.
 * - Otherwise jobs and cursor live in `--state-dir` (flag), then
 *   UVP_WATCHER_STATE_DIR (env), then `./uvp-watcher-state`.
 */
export function resolveWatcherStorage(
  options: Pick<ChainWatchOptions, 'jobStore' | 'stateDir' | 'jobsFile'>,
  env: NodeJS.ProcessEnv = process.env,
): WatcherStorageResolution {
  const mode = options.jobStore ?? 'file';
  if (mode !== 'file' && mode !== 'memory') {
    throw new ValidationError(`--job-store must be "file" or "memory", got ${mode}`);
  }
  if (mode === 'memory') {
    return { summary: { mode: 'memory' } };
  }

  const stateDir = options.jobsFile
    ? dirname(resolve(options.jobsFile))
    : resolve(options.stateDir ?? env[WATCHER_STATE_DIR_ENV] ?? DEFAULT_WATCHER_STATE_DIR);
  const jobsFile = options.jobsFile ? resolve(options.jobsFile) : join(stateDir, 'jobs.json');
  const cursorFile = join(stateDir, 'cursor.json');
  return {
    summary: {
      mode: 'file',
      stateDir,
      jobsFile,
      cursorFile,
    },
    jobStore: new FileStateMachineJobStore(jobsFile),
    cursorStore: new FileStateMachineCursorStore(cursorFile),
  };
}

export async function buildStateMachineWatcherFromCli(
  options: ChainWatchOptions,
  builderOptions: {
    /**
     * jobs retry 按 README 承诺与运行中的 watcher 共存：不取 state-dir
     * 启动锁。并发安全由任务级运行认领承担——retry 拒绝正在被其它执行器
     * 运行的任务（认领 pid 存活），只有在任务空闲或持有者已崩溃时才接管。
     */
    readonly holdStateDirLock?: boolean;
  } = {},
): Promise<{
  watcher: ReturnType<typeof createStateMachineWatcher>;
  storage: WatcherStorageSummary;
  /** Held for the process lifetime in file mode; release on exit (including signal shutdown). */
  stateLock?: WatcherStateDirLock | undefined;
}> {
  const config = await loadStateMachineHandlerConfig(options.config);
  const configuredStateMachines = config.stateMachines ?? [];
  if (options.stateMachine && configuredStateMachines.length > 0) {
    // Coexistence of --state-machine and config stateMachines[] is ambiguous:
    // a silent config override of the flag for the scan set would leave the
    // operator believing machine A was watched while only the config set was
    // scanned. Refuse and make the operator pick one source of truth instead
    // of guessing.
    throw new ValidationError(
      `--state-machine ${options.stateMachine} conflicts with stateMachines[] in ${options.config}`
      + ' (the flag would be silently ignored by the scan set); configure the scanned state machines in exactly one place',
    );
  }
  const stateMachineAddress = options.stateMachine
    ? normalizeAddressChecksummed(options.stateMachine, 'stateMachine')
    : config.stateMachineAddress ?? configuredStateMachines[0]?.stateMachineAddress;
  if (!stateMachineAddress) {
    throw new ValidationError('missing state machine address: pass --state-machine or set stateMachines[] in config');
  }
  const storage = resolveWatcherStorage(options);
  // 非 local 声明会禁止 finality 静默默认（watcher 强检）：环境口径在取锁
  // 之前解析，非法值直接拒绝。
  const runtimeEnvironment = resolveRuntimeEnvironment(options.runtimeEnv);
  // File 模式下 state-dir 由一个 watcher 进程独占：启动即取进程锁，
  // 既有锁的持有进程存活时直接拒绝（fail-closed），崩溃残留锁接管。
  const stateLock = storage.summary.mode === 'file' && builderOptions.holdStateDirLock !== false
    ? await acquireWatcherStateDirLock(storage.summary.stateDir)
    : undefined;
  try {
    const effectiveDryRun = options.dryRun ?? config.dryRun ?? false;
    if (options.dryRun === undefined && config.dryRun === true) {
      // The config-level dryRun silently overrides the documented "real
      // execution is the default" contract for every invocation that omits the
      // flag; make the effective mode visible instead.
      console.error(
        `warning: dryRun:true in ${options.config} is active; nothing is broadcast until it is removed or --dry-run is passed explicitly`,
      );
    }
    const watcher = createStateMachineWatcher({
      rpcUrl: options.rpcUrl,
      stateMachineAddress,
      stateMachines: configuredStateMachines.length > 0
        ? configuredStateMachines
        : [{ stateMachineAddress }],
      chainId: parsePositiveInteger(options.chainId, 'chainId'),
      ...(config.supplierId ?? config.executorId ? { supplierId: config.supplierId ?? config.executorId } : {}),
      ...(options.walletAddress ? { walletAddress: normalizeAddressChecksummed(options.walletAddress, 'walletAddress') } : config.walletAddress ? { walletAddress: config.walletAddress } : {}),
      privateKeyEnv: options.privateKeyEnv,
      handlers: createStateMachineHandlersFromConfig(config),
      ...(config.artifact ? { artifact: config.artifact } : {}),
      ...(config.retry ? { retry: config.retry } : {}),
      ...(storage.jobStore ? { jobStore: storage.jobStore } : {}),
      ...(storage.cursorStore ? { cursorStore: storage.cursorStore } : {}),
      dryRun: effectiveDryRun,
      ...(options.waitForReceipt !== undefined ? { waitForReceipt: options.waitForReceipt } : {}),
      ...(options.fromBlock ? { fromBlock: options.fromBlock } : {}),
      ...(options.pollIntervalMs ? { pollIntervalMs: parsePositiveInteger(options.pollIntervalMs, 'pollIntervalMs') } : {}),
      ...(options.confirmations !== undefined ? { confirmations: parseNonNegativeIntegerOption(options.confirmations, 'confirmations') } : {}),
      ...(runtimeEnvironment ? { runtimeEnvironment } : {}),
      ...(options.reorgWindow !== undefined ? { reorgWindow: parsePositiveInteger(options.reorgWindow, 'reorgWindow') } : {}),
      ...(options.getLogsBlockSpan !== undefined ? { getLogsBlockSpan: parsePositiveInteger(options.getLogsBlockSpan, 'getLogsBlockSpan') } : {}),
      onPoll: (poll) => {
        console.log(stringifyForTransport({ poll }));
      },
      onError: (error) => {
        console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      },
    });
    return { watcher, storage: storage.summary, stateLock };
  } catch (error) {
    // 取锁之后的任何构造/参数解析失败都必须先释放锁再抛出——泄漏的
    // watcher.lock 会把下一个进程（含同主机的手工 jobs retry）拒之门外。
    await stateLock?.release();
    throw error;
  }
}
