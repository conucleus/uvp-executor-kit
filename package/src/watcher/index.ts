/**
 * Watcher-domain public surface. Pure re-export barrel: it preserves the exact
 * export set the former src/watcher.ts exposed (DTO mappers moved to
 * cli/output.ts and are re-exported by the package index), while the
 * implementation lives in the lifecycle modules below.
 */
export { STATE_MACHINE_ABI } from '@uvp-eth/protocol-bindings';

export {
  HOOK_READY_TOPIC,
  decodeHookReadyLog,
  hookReadyEventId,
  type StateMachineArtifactIndex,
  type StateMachineHookMetadata,
  type StateMachineHookReady,
  type StateMachineRawLog,
  type StateMachineSignalMetadata,
} from '../signal/decode.js';

export {
  DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV,
  buildSubmitStateMachineSignalCall,
  type StateMachinePublicClient,
  type StateMachineSignal,
  type StateMachineSignalCallArgs,
  type SubmitStateMachineSignalCall,
  type SubmitStateMachineSignalConfig,
} from '../signal/build.js';

export {
  SubmitSignalReceiptError,
  submitStateMachineSignal,
  type SubmitStateMachineSignalResult,
} from '../signal/submit.js';

export {
  POLL_FAILURE_BACKOFF_MULTIPLIER_CAP,
  StateMachineWatcher,
  DEFAULT_STATE_MACHINE_POLL_INTERVAL_MS,
  createStateMachineWatcher,
  type StateMachineDeploymentWatcherConfig,
  type StateMachineLogProcessResult,
  type StateMachinePollResult,
  type StateMachineRuntimeEnvironment,
  type StateMachineWatchHandle,
  type StateMachineWatcherConfig,
} from './watcher.js';

export {
  createStateMachineHandlersFromConfig,
  getStateMachineHandlerKeys,
  loadStateMachineHandlerConfig,
  resolveStateMachineHandler,
  type DeferredBroadcastOutcome,
  type ExecutorCallbackMode,
  type StateMachineHandlerConfig,
  type StateMachineHookReadyHandler,
  type StateMachineHookReadyHandlerContext,
  type StateMachineHookReadyHandlerResult,
  type StateMachineStaticHandlerDefinition,
  type StateMachineStaticSignalDefinition,
} from './execution/handler.js';

export {
  DEFAULT_RESEND_BACKOFF_BASE_DELAY_MS,
  DEFAULT_RESEND_BACKOFF_MAX_DELAY_MS,
  retryStateMachineJob,
  type StateMachineJobRetryOptions,
  type StateMachineResendBackoffConfig,
  type StateMachineRetryConfig,
} from './jobs/retry.js';

export {
  deadLetterStateMachineJob,
  type StateMachineJobDeadLetterOptions,
} from './jobs/deadletter.js';

export {
  stateMachineJobId,
  type StateMachineJobManualAction,
  type StateMachineJobPatch,
  type StateMachineJobStatus,
  type StateMachineJobStore,
  type StateMachineJobSubmission,
  type StateMachineWatcherJob,
} from './jobs/model.js';

export { InMemoryStateMachineJobStore } from './storage/memory.js';
export { FileStateMachineJobStore } from './storage/file.js';

export {
  WATCHER_STATE_DIR_LOCK_FILE_NAME,
  acquireWatcherStateDirLock,
  type WatcherStateDirLock,
} from './storage/lock.js';

export {
  FileStateMachineCursorStore,
  type StateMachineCursorCheckpoint,
  type StateMachineCursorContext,
  type StateMachineCursorLoadResult,
  type StateMachineCursorState,
  type StateMachineCursorStore,
} from './storage/cursor.js';

export { DEFAULT_FINALITY_CONFIRMATIONS, DEFAULT_REORG_WINDOW_BLOCKS } from './scan/reorg.js';
export { DEFAULT_GET_LOGS_BLOCK_SPAN } from './scan/logs.js';
