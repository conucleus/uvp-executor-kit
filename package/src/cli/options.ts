import {
  productApiAuthHeadersFromEnv,
  type ProductApiAuthStatus,
  type ProductApiClientOptions,
  type ProductSubmitIntent,
} from '../product.js';
import { ValidationError } from '../validation.js';

export interface ChainWatchOptions {
  rpcUrl: string;
  stateMachine?: string;
  chainId: string;
  config: string;
  walletAddress?: string;
  privateKeyEnv: string;
  fromBlock?: string;
  pollIntervalMs?: string;
  confirmations?: string;
  /** Declared runtime environment; non-local values make --confirmations mandatory (no silent default 1). */
  runtimeEnv?: string;
  reorgWindow?: string;
  getLogsBlockSpan?: string;
  jobsFile?: string;
  /** file (default) persists jobs and the scan cursor under --state-dir; memory keeps jobs and cursor in process memory. */
  jobStore?: string;
  stateDir?: string;
  dryRun?: boolean;
  waitForReceipt?: boolean;
}

export interface ChainSignalOptions {
  rpcUrl: string;
  stateMachine: string;
  chainId: string;
  privateKeyEnv: string;
  walletAddress?: string;
  orderId: string;
  planId: string;
  source: string;
  stage: string;
  signalName: string;
  payloadHash?: string;
  payloadRef?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
  waitForReceipt?: boolean;
}

export interface WalletNewOptions {
  envFile: string;
  overwrite?: boolean;
  privateKeyEnv: string;
  addressEnv: string;
}

export interface WalletAddressOptions {
  privateKeyEnv: string;
}

export interface FaucetInfoOptions {
  network: string;
  address?: string;
}

export interface ProductClientCliOptions {
  chainServicesUrl: string;
  principalId?: string;
  authTokenEnv?: string;
  verbose?: boolean;
}

export interface ProductClientRuntimeOptions extends ProductApiClientOptions {
  readonly auth?: ProductApiAuthStatus;
}

export interface ProductTasksOptions extends ProductClientCliOptions {
  walletAddress: string;
  orderId?: string;
  status?: string;
}

export interface ProductTaskGetOptions extends ProductClientCliOptions {
  walletAddress?: string;
}

export interface ProductPrepareOptions extends ProductClientCliOptions {
  walletAddress: string;
  evidenceId: string[];
  intent: ProductSubmitIntent;
  preparedFile?: string;
}

export interface ProductSubmitOptions extends ProductClientCliOptions {
  prepareId?: string;
  preparedFile: string;
  privateKeyEnv: string;
  walletAddress?: string;
  expectedChainId?: string;
  expectedVerifyingContract?: string;
}

export type ProductProofOptions = ProductClientCliOptions;

export interface ServeOptions {
  config: string;
  host: string;
  port: string;
  executorTokenEnv: string;
  callbackTokenEnv: string;
  callbackHmacSecretEnv: string;
  readyJson?: boolean;
}

export interface ConfigValidateOptions {
  config: string;
  kind: string;
}

export interface DoctorOptions {
  chainServicesUrl: string;
  walletAddress?: string;
  taskId?: string;
  submissionId?: string;
  principalId?: string;
  authTokenEnv?: string;
  verbose?: boolean;
}

export interface JobsFileOptions {
  jobsFile: string;
}

export interface JobsListOptions extends JobsFileOptions {
  status?: string;
  supplierId?: string;
}

export interface JobsRetryOptions extends ChainWatchOptions {
  operator: string;
  reason?: string;
}

export interface JobsDeadLetterOptions extends JobsFileOptions {
  operator: string;
  reason: string;
}

export function productClientOptions(options: ProductClientCliOptions): ProductClientRuntimeOptions {
  const auth = options.authTokenEnv
    ? productApiAuthHeadersFromEnv(options.authTokenEnv)
    : undefined;
  return {
    chainServicesUrl: options.chainServicesUrl,
    ...(options.principalId ? { principalId: options.principalId } : {}),
    ...(auth ? { headers: auth.headers, auth: auth.status } : {}),
  };
}

export function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function readSecretFromEnv(envName: string, label: string): string {
  const secret = process.env[envName];
  if (!secret || secret.trim().length === 0) {
    throw new ValidationError(`missing ${label}: set ${envName}`);
  }
  return secret;
}

export function parsePort(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError('port must be a non-negative integer');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new ValidationError('port must be between 0 and 65535');
  }
  return port;
}

/** confirmations allows 0 (tip scanning for throwaway local chains). */
export function parseNonNegativeIntegerOption(value: string, fieldName: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(`${fieldName} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${fieldName} must be a non-negative safe integer`);
  }
  return parsed;
}

export function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const shutdown = (): void => {
      close().then(resolve, reject);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
