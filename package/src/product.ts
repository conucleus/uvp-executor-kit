import { isHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  PRODUCT_SUBMIT_DOMAIN_VERSION,
  PRODUCT_SUBMIT_TYPED_DATA_FIELDS,
  type ProductSubmitTypedData,
  type ProductSubmitTypedDataField,
} from '@uvp-eth/protocol-bindings';
import { hashEvidenceFile, type EvidenceHashResult } from './evidence.js';
import { loadPrivateKeyFromEnv } from './signing.js';
import { UnsupportedChainTargetError, type ChainTarget } from './chain-target.js';
import {
  ExecutorKitError,
  normalizeAddress,
  normalizeBytes32,
  ValidationError,
} from './validation.js';

export type ProductSubmitIntent = 'confirm_stage' | 'reject_stage' | 'raise_dispute' | 'resolve_dispute';

const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as const;

/**
 * The chain-services API server stamps every response (success and
 * error) with this header so executor-side results, errors, and logs can be
 * correlated end to end with server-side request logs.
 */
export const PRODUCT_API_REQUEST_ID_HEADER = 'x-request-id';

export interface ProductApiFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * The transport always sets 'manual': these requests carry the Authorization
   * bearer injected by `--auth-token-env`, and following a 3xx would replay it
   * to whatever host the Location header points at.
   */
  readonly redirect?: 'manual';
}

/**
 * Statuses a manual redirect policy refuses to follow: every 3xx plus the
 * status-0 `opaqueredirect` response a filtered manual redirect yields. Callers
 * treat any of these as a request failure so credentials are never replayed.
 */
export function isProductApiRedirectStatus(status: number): boolean {
  return status === 0 || (status >= 300 && status < 400);
}

/**
 * Response headers as a plain record (lowercase or any casing) or a fetch-like
 * object exposing `get(name)`, so both test stubs and real `Response` objects fit.
 */
export type ProductApiResponseHeaders =
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | { readonly get: (name: string) => string | null | undefined };

export interface ProductApiFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  readonly headers?: ProductApiResponseHeaders;
  text?(): Promise<string>;
  json?(): Promise<unknown>;
}

export type ProductApiFetch = (
  input: string,
  init?: ProductApiFetchInit,
) => Promise<ProductApiFetchResponse>;

export interface ProductApiClientOptions {
  readonly chainServicesUrl: string;
  readonly fetch?: ProductApiFetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly principalId?: string;
}

export interface ProductApiAuthStatus {
  readonly bearerTokenEnv: string;
  readonly bearerTokenConfigured: true;
  readonly redacted: true;
}

export interface ProductApiAuthHeaders {
  readonly headers: Readonly<Record<string, string>>;
  readonly status: ProductApiAuthStatus;
}

export interface ListSignalContainersInput extends ProductApiClientOptions {
  readonly walletAddress: Address | string;
  readonly orderId?: string;
  readonly status?: string;
}

export interface GetSignalContainerInput extends ProductApiClientOptions {
  readonly taskId: string;
  readonly walletAddress?: Address | string;
}

export interface PrepareSignalContainerInput extends ProductApiClientOptions {
  readonly taskId: string;
  readonly walletAddress: Address | string;
  readonly evidenceIds: readonly string[];
  readonly intent: ProductSubmitIntent;
}

export interface SignPreparedSignalContainerInput {
  readonly target?: ChainTarget;
  readonly prepared: PreparedSignalContainer | Record<string, unknown>;
  readonly privateKeyEnv: string;
  readonly walletAddress?: Address | string;
}

export interface SignedPreparedSignalContainer {
  readonly prepareId: string;
  readonly taskId: string;
  readonly walletAddress: Address;
  readonly submitter: Address;
  readonly signature: Hex;
}

export interface SubmitPreparedSignalContainerInput extends ProductApiClientOptions {
  readonly taskId: string;
  readonly prepareId: string;
  readonly signature: Hex | string;
  readonly walletAddress: Address | string;
}

export interface GetSignalContainerProofInput extends ProductApiClientOptions {
  readonly submissionId: string;
}

export interface HashContainerEvidenceInput {
  readonly path: string;
}

export interface ProductSignalContainer extends Record<string, unknown> {
  readonly taskId: string;
  readonly orderId: string;
  readonly title: string;
  readonly status: string;
  /** x-request-id echoed by the server response that produced this object. */
  readonly requestId?: string;
}

export interface ProductSubmitHumanSummary extends Record<string, unknown> {
  readonly purpose?: string;
  readonly orderId?: string;
  readonly taskTitle?: string;
  readonly stage?: string;
  readonly action?: string;
  readonly submitter?: Address | string;
  readonly validUntil?: string;
}

export interface PreparedSignalContainer extends Record<string, unknown> {
  readonly prepareId: string;
  readonly taskId: string;
  readonly orderId: string;
  readonly intent: ProductSubmitIntent;
  readonly submitter: Address;
  readonly status: 'prepared';
  readonly expiresAt: string;
  readonly humanSummary: ProductSubmitHumanSummary;
  readonly typedData: ProductSubmitTypedData;
  readonly evidence: readonly Record<string, unknown>[];
  /** x-request-id echoed by the server response that produced this object. */
  readonly requestId?: string;
}

export interface SubmittedSignalContainer extends Record<string, unknown> {
  readonly submissionId: string;
  readonly prepareId: string;
  readonly taskId: string;
  readonly orderId: string;
  readonly status: string;
  /** x-request-id echoed by the server response that produced this object. */
  readonly requestId?: string;
}

export interface ProductTaskSummary {
  readonly taskId: string;
  readonly orderId: string;
  readonly title: string;
  readonly status: string;
  readonly addOnKind?: string;
  readonly orderTitle?: string;
  readonly subtitle?: string;
  readonly assigneeRole?: string;
  readonly assigneeWallet?: string;
  readonly stageName?: string;
  readonly deadline?: string;
  readonly fundingImpact?: string;
  readonly canSubmit?: boolean;
  readonly blockedReason?: string;
  readonly performanceSlotId?: string;
  readonly performanceSlotLabel?: string;
  readonly businessPersonaLabels?: readonly string[];
  readonly primaryActionLabel?: string;
  readonly requiredInputs?: unknown;
  readonly settlementPreview?: unknown;
  readonly capabilityPlugin?: unknown;
  readonly participantRoleLabel?: string;
  readonly participantWallet?: string;
  readonly responsibilityStatements?: unknown;
  readonly proofSummary?: unknown;
  readonly proofRows?: unknown;
}

export interface PreparedSignalContainerSummary {
  readonly prepareId: string;
  readonly taskId: string;
  readonly orderId: string;
  readonly intent: ProductSubmitIntent;
  readonly status: 'prepared';
  readonly expiresAt: string;
  readonly submitter: Address;
  readonly purpose?: string;
  readonly taskTitle?: string;
  readonly stage?: string;
  readonly action?: string;
  readonly validUntil?: string;
  readonly evidence: readonly Record<string, unknown>[];
}

export interface SubmittedSignalContainerSummary {
  readonly submissionId: string;
  readonly prepareId: string;
  readonly taskId: string;
  readonly orderId: string;
  readonly status: string;
  readonly intent?: string;
  readonly submitter?: string;
  readonly signatureStatus?: string;
  readonly broadcastStatus?: string;
  readonly txHash?: string;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorLabel?: string;
  readonly errorMessage?: string;
  readonly retryable?: boolean;
  readonly retryState?: string;
  readonly deadLetter?: boolean;
  readonly nextRetryAt?: string;
  readonly attemptCount?: number;
  readonly proofRows?: unknown;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export class ProductApiError extends ExecutorKitError {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  /**
   * request id of the failed call, taken from the x-request-id response
   * header (falling back to the id the server embeds in error bodies) so the
   * failure can be matched against server-side logs.
   */
  readonly requestId?: string;

  constructor(status: number, code: string | undefined, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ProductApiError';
    this.status = status;
    if (code !== undefined) {
      this.code = code;
    }
    if (details !== undefined) {
      this.details = details;
    }
    if (requestId !== undefined) {
      this.requestId = requestId;
    }
  }
}

export async function listSignalContainers(input: ListSignalContainersInput): Promise<readonly ProductSignalContainer[]> {
  const walletAddress = normalizeAddress(input.walletAddress, 'walletAddress');
  const { body, requestId } = await requestProductApiJson(input, 'GET', '/product/tasks', undefined, {
    assignee: walletAddress,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...(input.status ? { status: input.status } : {}),
  });
  const record = requireRecord(body, 'Product tasks response');
  const tasks = record.tasks;
  if (!Array.isArray(tasks)) {
    throw new ValidationError('Product tasks response must contain a tasks array');
  }
  // The transport returns a bare array, so every task carries the response's
  // request id to keep "which request produced this row" answerable.
  return tasks.map((task, index) => attachResponseRequestId(parseSignalContainer(task, `tasks[${index}]`), requestId));
}

export async function getSignalContainer(input: GetSignalContainerInput): Promise<ProductSignalContainer> {
  if (input.walletAddress) {
    normalizeAddress(input.walletAddress, 'walletAddress');
  }
  const { body, requestId } = await requestProductApiJson(input, 'GET', `/product/tasks/${encodeURIComponent(requiredText(input.taskId, 'taskId'))}`);
  const record = requireRecord(body, 'Product task response');
  return attachResponseRequestId(parseSignalContainer(record.task, 'task'), requestId);
}

export async function hashContainerEvidence(input: HashContainerEvidenceInput): Promise<EvidenceHashResult> {
  return hashEvidenceFile(requiredText(input.path, 'path'));
}

export async function prepareSignalContainer(input: PrepareSignalContainerInput): Promise<PreparedSignalContainer> {
  const walletAddress = normalizeAddress(input.walletAddress, 'walletAddress');
  const { body, requestId } = await requestProductApiJson(
    input,
    'POST',
    `/product/tasks/${encodeURIComponent(requiredText(input.taskId, 'taskId'))}/prepare-submit`,
    {
      evidenceIds: requireStringList(input.evidenceIds, 'evidenceIds'),
      walletAddress,
      intent: normalizeIntent(input.intent),
    },
  );
  return attachResponseRequestId(parsePreparedSignalContainer(body, 'prepared submission'), requestId);
}

export async function signPreparedSignalContainer(
  input: SignPreparedSignalContainerInput,
): Promise<SignedPreparedSignalContainer> {
  if (input.target === 'solana') {
    throw new UnsupportedChainTargetError('solana', 'solana prepared signal signing is reserved but not implemented');
  }
  const prepared = parsePreparedSignalContainer(input.prepared, 'prepared submission');
  const privateKey = loadProductPrivateKeyFromEnv(input.privateKeyEnv);
  const account = privateKeyToAccount(privateKey);
  const signerAddress = normalizeAddress(account.address, 'privateKeyEnv signer');
  const configuredWallet = normalizeAddress(input.walletAddress ?? signerAddress, 'walletAddress');
  const submitter = normalizeAddress(prepared.typedData.message.submitter, 'typedData.message.submitter');

  if (submitter !== configuredWallet) {
    throw new ValidationError('typedData.message.submitter does not match configured wallet');
  }
  if (prepared.submitter !== submitter) {
    throw new ValidationError('prepared.submitter does not match typedData.message.submitter');
  }
  if (signerAddress !== configuredWallet) {
    throw new ValidationError('private key signer does not match configured wallet');
  }

  const signature = await account.signTypedData(
    prepared.typedData as unknown as Parameters<typeof account.signTypedData>[0],
  );
  return {
    prepareId: prepared.prepareId,
    taskId: prepared.taskId,
    walletAddress: configuredWallet,
    submitter,
    signature,
  };
}

export async function submitPreparedSignalContainer(
  input: SubmitPreparedSignalContainerInput,
): Promise<SubmittedSignalContainer> {
  const signature = normalizeSignature(input.signature);
  const walletAddress = normalizeAddress(input.walletAddress, 'walletAddress');
  const { body, requestId } = await requestProductApiJson(
    input,
    'POST',
    `/product/tasks/${encodeURIComponent(requiredText(input.taskId, 'taskId'))}/submit`,
    {
      prepareId: requiredText(input.prepareId, 'prepareId'),
      signature,
      walletAddress,
    },
  );
  return attachResponseRequestId(parseSubmittedSignalContainer(body, 'submission'), requestId);
}

export async function getSignalContainerProof(
  input: GetSignalContainerProofInput,
): Promise<SubmittedSignalContainer> {
  const { body, requestId } = await requestProductApiJson(
    input,
    'GET',
    `/product/submissions/${encodeURIComponent(requiredText(input.submissionId, 'submissionId'))}`,
  );
  return attachResponseRequestId(parseSubmittedSignalContainer(body, 'submission'), requestId);
}

export function summarizeSignalContainer(task: ProductSignalContainer | Record<string, unknown>): ProductTaskSummary {
  const parsed = parseSignalContainer(task, 'task');
  return {
    taskId: parsed.taskId,
    orderId: parsed.orderId,
    title: parsed.title,
    status: parsed.status,
    ...optionalString(parsed, 'addOnKind'),
    ...optionalString(parsed, 'orderTitle'),
    ...optionalString(parsed, 'subtitle'),
    ...optionalString(parsed, 'assigneeRole'),
    ...optionalString(parsed, 'assigneeWallet'),
    ...optionalString(parsed, 'stageName'),
    ...optionalString(parsed, 'deadline'),
    ...optionalString(parsed, 'fundingImpact'),
    ...optionalBoolean(parsed, 'canSubmit'),
    ...optionalString(parsed, 'blockedReason'),
    ...optionalString(parsed, 'performanceSlotId'),
    ...optionalString(parsed, 'performanceSlotLabel'),
    ...optionalStringArray(parsed, 'businessPersonaLabels'),
    ...optionalString(parsed, 'primaryActionLabel'),
    ...optionalUnknown(parsed, 'requiredInputs'),
    ...optionalUnknown(parsed, 'settlementPreview'),
    ...optionalUnknown(parsed, 'capabilityPlugin'),
    ...optionalString(parsed, 'participantRoleLabel'),
    ...optionalString(parsed, 'participantWallet'),
    ...optionalUnknown(parsed, 'responsibilityStatements'),
    ...optionalUnknown(parsed, 'proofSummary'),
    ...optionalUnknown(parsed, 'proofRows'),
  };
}

export function summarizePreparedSignalContainer(
  prepared: PreparedSignalContainer | Record<string, unknown>,
): PreparedSignalContainerSummary {
  const parsed = parsePreparedSignalContainer(prepared, 'prepared submission');
  const humanSummary = requireRecord(parsed.humanSummary, 'humanSummary');
  return {
    prepareId: parsed.prepareId,
    taskId: parsed.taskId,
    orderId: parsed.orderId,
    intent: parsed.intent,
    status: parsed.status,
    expiresAt: parsed.expiresAt,
    submitter: parsed.submitter,
    ...optionalString(humanSummary, 'purpose'),
    ...optionalString(humanSummary, 'taskTitle'),
    ...optionalString(humanSummary, 'stage'),
    ...optionalString(humanSummary, 'action'),
    ...optionalString(humanSummary, 'validUntil'),
    evidence: parsed.evidence.map(summarizePreparedEvidence),
  };
}

export function summarizeSubmittedSignalContainer(
  submission: SubmittedSignalContainer | Record<string, unknown>,
): SubmittedSignalContainerSummary {
  const parsed = parseSubmittedSignalContainer(submission, 'submission');
  return {
    submissionId: parsed.submissionId,
    prepareId: parsed.prepareId,
    taskId: parsed.taskId,
    orderId: parsed.orderId,
    status: parsed.status,
    ...optionalString(parsed, 'intent'),
    ...optionalString(parsed, 'submitter'),
    ...optionalString(parsed, 'signatureStatus'),
    ...optionalString(parsed, 'broadcastStatus'),
    ...optionalString(parsed, 'txHash'),
    ...optionalString(parsed, 'blockNumber'),
    ...optionalString(parsed, 'errorCode'),
    ...optionalString(parsed, 'errorLabel'),
    ...optionalString(parsed, 'errorMessage'),
    ...optionalBoolean(parsed, 'retryable'),
    ...optionalString(parsed, 'retryState'),
    ...optionalBoolean(parsed, 'deadLetter'),
    ...optionalString(parsed, 'nextRetryAt'),
    ...optionalNumber(parsed, 'attemptCount'),
    ...optionalUnknown(parsed, 'proofRows'),
    ...optionalString(parsed, 'createdAt'),
    ...optionalString(parsed, 'updatedAt'),
  };
}

export function parsePreparedSignalContainer(value: unknown, label = 'prepared submission'): PreparedSignalContainer {
  const record = requireRecord(value, label);
  const typedData = parseProductSubmitTypedData(record.typedData, `${label}.typedData`);
  const submitter = normalizeAddress(requiredString(record, 'submitter', label), `${label}.submitter`);
  const typedDataSubmitter = normalizeAddress(typedData.message.submitter, `${label}.typedData.message.submitter`);
  if (submitter !== typedDataSubmitter) {
    throw new ValidationError(`${label}.submitter must match typedData.message.submitter`);
  }

  return {
    ...record,
    prepareId: requiredString(record, 'prepareId', label),
    taskId: requiredString(record, 'taskId', label),
    orderId: requiredString(record, 'orderId', label),
    intent: normalizeIntent(requiredString(record, 'intent', label)),
    submitter,
    status: requireLiteral(record.status, 'prepared', `${label}.status`),
    expiresAt: requiredString(record, 'expiresAt', label),
    humanSummary: requireRecord(record.humanSummary, `${label}.humanSummary`) as ProductSubmitHumanSummary,
    typedData,
    evidence: requireRecordArray(record.evidence, `${label}.evidence`),
  };
}

export function parseSignalContainer(value: unknown, label = 'task'): ProductSignalContainer {
  const record = requireRecord(value, label);
  return {
    ...record,
    taskId: requiredString(record, 'taskId', label),
    orderId: requiredString(record, 'orderId', label),
    title: requiredString(record, 'title', label),
    status: requiredString(record, 'status', label),
  };
}

export function parseSubmittedSignalContainer(value: unknown, label = 'submission'): SubmittedSignalContainer {
  const record = requireRecord(value, label);
  return {
    ...record,
    submissionId: requiredString(record, 'submissionId', label),
    prepareId: requiredString(record, 'prepareId', label),
    taskId: requiredString(record, 'taskId', label),
    orderId: requiredString(record, 'orderId', label),
    status: requiredString(record, 'status', label),
  };
}

export function loadProductPrivateKeyFromEnv(envName: string): Hex {
  const normalizedEnvName = requiredText(envName, 'privateKeyEnv');
  const privateKey = loadPrivateKeyFromEnv(normalizedEnvName);
  if (!privateKey) {
    throw new ValidationError(`missing private key env var ${normalizedEnvName}`);
  }
  return privateKey;
}

export function productApiAuthHeadersFromEnv(
  authTokenEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): ProductApiAuthHeaders {
  const envName = requiredText(authTokenEnv, 'authTokenEnv');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envName)) {
    throw new ValidationError('authTokenEnv must be an environment variable name');
  }
  const token = env[envName];
  if (!token || token.trim().length === 0) {
    throw new ValidationError(`missing auth token env var ${envName}`);
  }
  const normalizedToken = token.trim();
  if (/[\r\n]/u.test(normalizedToken)) {
    throw new ValidationError(`auth token env var ${envName} must not contain newline characters`);
  }
  return {
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
    },
    status: {
      bearerTokenEnv: envName,
      bearerTokenConfigured: true,
      redacted: true,
    },
  };
}

function parseProductSubmitTypedData(value: unknown, label: string): ProductSubmitTypedData {
  const record = requireRecord(value, label);
  const domain = requireRecord(record.domain, `${label}.domain`);
  const types = requireRecord(record.types, `${label}.types`);
  const message = requireRecord(record.message, `${label}.message`);
  const primaryType = requiredString(record, 'primaryType', label);
  if (primaryType !== 'UVPStateMachineSignal') {
    throw new ValidationError(`${label}.primaryType must be UVPStateMachineSignal`);
  }
  // The typed data is exactly what the participant wallet signs, so any drift
  // from the frozen canonical shape (extra/missing/renamed fields, type drift)
  // changes what is signed or how it verifies. Reject all of it instead of
  // silently dropping unknown keys.
  requireExactKeys(domain, ['name', 'version', 'chainId', 'verifyingContract'], `${label}.domain`);
  requireExactKeys(types, ['UVPStateMachineSignal'], `${label}.types`);
  const domainName = requiredString(domain, 'name', `${label}.domain`);
  if (domainName !== 'UVPStateMachine') {
    throw new ValidationError(`${label}.domain.name must be UVPStateMachine`);
  }
  const domainVersion = requiredString(domain, 'version', `${label}.domain`);
  if (domainVersion !== PRODUCT_SUBMIT_DOMAIN_VERSION) {
    throw new ValidationError(`${label}.domain.version must be ${PRODUCT_SUBMIT_DOMAIN_VERSION}`);
  }
  const chainId = domain.chainId;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new ValidationError(`${label}.domain.chainId must be a positive safe integer`);
  }
  const fields = parseTypedDataFields(types.UVPStateMachineSignal, `${label}.types.UVPStateMachineSignal`);
  requireExactKeys(message, PRODUCT_SUBMIT_TYPED_DATA_FIELDS.map((field) => field.name), `${label}.message`);
  const planId = normalizeBytes32(requiredString(message, 'planId', `${label}.message`), `${label}.message.planId`);
  if (planId === ZERO_BYTES32) {
    // The signature commits to (planId, orderId) and the contract
    // verifies plan existence, so a zero-planId prepared submission could only
    // produce a signature that can never land. The protocol-bindings builder's
    // optional-planId zero default exists solely for shape-checking gates; a
    // signer must never accept it.
    throw new ValidationError(`${label}.message.planId must be a non-zero bytes32 plan id: the zero placeholder cannot satisfy the on-chain (planId, orderId) existence check`);
  }
  return {
    domain: {
      name: domainName,
      version: domainVersion,
      chainId,
      verifyingContract: normalizeAddress(
        requiredString(domain, 'verifyingContract', `${label}.domain`),
        `${label}.domain.verifyingContract`,
      ),
    },
    types: {
      UVPStateMachineSignal: fields,
    },
    primaryType,
    message: {
      planId,
      orderId: normalizeBytes32(requiredString(message, 'orderId', `${label}.message`), `${label}.message.orderId`),
      sourceId: normalizeBytes32(requiredString(message, 'sourceId', `${label}.message`), `${label}.message.sourceId`),
      signalId: normalizeBytes32(requiredString(message, 'signalId', `${label}.message`), `${label}.message.signalId`),
      payloadHash: normalizeBytes32(requiredString(message, 'payloadHash', `${label}.message`), `${label}.message.payloadHash`),
      idempotencyKey: normalizeBytes32(
        requiredString(message, 'idempotencyKey', `${label}.message`),
        `${label}.message.idempotencyKey`,
      ),
      submitter: normalizeAddress(requiredString(message, 'submitter', `${label}.message`), `${label}.message.submitter`),
      deadline: validateFutureDeadline(requiredString(message, 'deadline', `${label}.message`), `${label}.message.deadline`),
    },
  };
}

/**
 * Compare the parsed typed-data field table against the frozen canonical
 * `PRODUCT_SUBMIT_TYPED_DATA_FIELDS`: same length, same order, same names and
 * types, and no extra keys per field. Any drift between the prepare response and
 * the protocol the wallet would sign for is rejected loudly.
 */
function parseTypedDataFields(value: unknown, label: string): readonly ProductSubmitTypedDataField[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must be an array`);
  }
  const fields = value.map((field, index) => {
    const record = requireRecord(field, `${label}[${index}]`);
    requireExactKeys(record, ['name', 'type'], `${label}[${index}]`);
    return {
      name: requiredString(record, 'name', `${label}[${index}]`),
      type: requiredString(record, 'type', `${label}[${index}]`),
    };
  });
  const canonical = PRODUCT_SUBMIT_TYPED_DATA_FIELDS;
  if (fields.length !== canonical.length) {
    throw new ValidationError(
      `${label} must contain exactly ${canonical.length} fields for UVPStateMachineSignal, got ${fields.length}`,
    );
  }
  for (const [index, expected] of canonical.entries()) {
    const actual = fields[index];
    if (!actual || actual.name !== expected.name || actual.type !== expected.type) {
      throw new ValidationError(
        `${label}[${index}] must be { name: ${expected.name}, type: ${expected.type} } but got { name: ${actual?.name ?? 'missing'}, type: ${actual?.type ?? 'missing'} }`,
      );
    }
  }
  return fields;
}

/**
 * `deadline` is a uint256 unix-seconds timestamp in the signature message.
 * Reject non-decimal formats and already-expired deadlines so an expired
 * prepared submission fails at parse/sign time instead of at the chain.
 */
function validateFutureDeadline(value: string, label: string): string {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new ValidationError(`${label} must be a base-10 unix-seconds uint string`);
  }
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(value) <= nowSeconds) {
    throw new ValidationError(`${label} must be a unix timestamp in the future`);
  }
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      throw new ValidationError(`${label} has unexpected field ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!(key in record)) {
      throw new ValidationError(`${label} is missing field ${key}`);
    }
  }
}

/**
 * Internal transport result: the parsed JSON body plus the server's request id
  * Read from the response headers when present.
 */
interface ProductApiJsonResult {
  readonly body: unknown;
  readonly requestId?: string | undefined;
}

async function requestProductApiJson(
  input: ProductApiClientOptions,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  query?: Readonly<Record<string, string | undefined>>,
): Promise<ProductApiJsonResult> {
  const fetchFn = resolveProductApiFetch(input.fetch);
  const url = productApiUrl(input.chainServicesUrl, path, query);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...input.headers,
  };
  if (input.principalId && input.principalId.trim().length > 0) {
    headers['x-uvp-principal-id'] = input.principalId.trim();
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetchFn(url, {
    method,
    headers,
    // Never let fetch follow a redirect: these headers carry the Authorization
    // bearer from --auth-token-env, and a 3xx would replay it to whatever host
    // the Location header points at. A redirect is a request failure, full stop.
    redirect: 'manual',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (isProductApiRedirectStatus(response.status)) {
    // Covers every 3xx and the status-0 opaqueredirect response a manual
    // redirect policy yields: the request must fail instead of leaking the
    // bearer to the redirect target.
    throw new ProductApiError(
      response.status,
      'redirect',
      `Product API request for ${path} was answered with HTTP ${response.status} instead of a direct response; redirects are refused so the Authorization bearer is never replayed to the redirect target`,
    );
  }
  const payload = await readProductApiBody(response);
  if (!response.ok) {
    throw productApiErrorFromResponse(response, payload);
  }
  return {
    body: payload,
    requestId: productApiResponseRequestId(response),
  };
}

export function resolveProductApiFetch(fetchFn?: ProductApiFetch): ProductApiFetch {
  if (fetchFn) {
    return fetchFn;
  }
  const globalFetch = globalThis.fetch as unknown as ProductApiFetch | undefined;
  if (typeof globalFetch !== 'function') {
    throw new ValidationError('fetch is not available; provide a Product API fetch implementation');
  }
  return globalFetch;
}

function productApiUrl(
  chainServicesUrl: string,
  path: string,
  query?: Readonly<Record<string, string | undefined>>,
): string {
  const base = requiredText(chainServicesUrl, 'chainServicesUrl');
  try {
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    const url = new URL(path.replace(/^\/+/u, ''), normalizedBase);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value.length > 0) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  } catch {
    throw new ValidationError('chainServicesUrl must be an absolute URL');
  }
}

async function readProductApiBody(response: ProductApiFetchResponse): Promise<unknown> {
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (text.trim().length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }
  if (typeof response.json === 'function') {
    return response.json();
  }
  return undefined;
}

function productApiErrorFromResponse(response: ProductApiFetchResponse, payload: unknown): ProductApiError {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const code = typeof record.error === 'string' ? record.error : undefined;
  const message = typeof record.message === 'string' && record.message.trim().length > 0
    ? record.message
    : `Product API request failed with HTTP ${response.status}`;
  // The x-request-id response header is authoritative; the id the
  // server embeds in error bodies is the fallback when headers are unavailable.
  const requestId = productApiResponseRequestId(response)
    ?? (typeof record.requestId === 'string' && record.requestId.trim().length > 0 ? record.requestId.trim() : undefined);
  return new ProductApiError(response.status, code, message, record.details, requestId);
}

/**
 * Read the server's request id from the response headers. Supports both
 * fetch-like header objects (`headers.get(name)`, as returned by real fetch
 * implementations) and plain records with any key casing.
 */
export function productApiResponseRequestId(response: ProductApiFetchResponse): string | undefined {
  return readResponseHeader(response, PRODUCT_API_REQUEST_ID_HEADER);
}

function readResponseHeader(response: ProductApiFetchResponse, name: string): string | undefined {
  const headers = response.headers;
  if (!headers) {
    return undefined;
  }
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const value = (get as (headerName: string) => string | null | undefined).call(headers, name);
    const text = typeof value === 'string' ? value.trim() : undefined;
    return text ? text : undefined;
  }
  if (typeof headers !== 'object') {
    return undefined;
  }
  for (const [key, value] of Object.entries(headers as Readonly<Record<string, string | readonly string[] | undefined>>)) {
    if (key.toLowerCase() !== name) {
      continue;
    }
    const raw = Array.isArray(value) ? value[0] : value;
    const text = typeof raw === 'string' ? raw.trim() : undefined;
    if (text) {
      return text;
    }
  }
  return undefined;
}

/**
 * Attach the response's request id to a parsed result object without
 * disturbing shapes when the header was absent (the requestId key is simply
 * not added).
 */
function attachResponseRequestId<T extends Record<string, unknown>>(value: T, requestId: string | undefined): T {
  if (requestId === undefined) {
    return value;
  }
  return { ...value, requestId };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ValidationError(`${label} must be a JSON object`);
}

function requireRecordArray(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must be an array`);
  }
  return value.map((item, index) => requireRecord(item, `${label}[${index}]`));
}

function requiredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${label}.${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredText(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringList(value: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw new ValidationError(`${label} must be a non-empty array of strings`);
  }
  return value.map((item) => item.trim());
}

function requireLiteral<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new ValidationError(`${label} must be ${expected}`);
  }
  return expected;
}

function normalizeIntent(value: string): ProductSubmitIntent {
  const intent = requiredText(value, 'intent');
  if (intent === 'confirm_stage' || intent === 'reject_stage' || intent === 'raise_dispute' || intent === 'resolve_dispute') {
    return intent;
  }
  throw new ValidationError('intent must be confirm_stage, reject_stage, raise_dispute, or resolve_dispute');
}

function normalizeSignature(value: string): Hex {
  if (!isHex(value)) {
    throw new ValidationError('signature must be a hex string');
  }
  return value as Hex;
}

function optionalString(record: Record<string, unknown>, field: string): Record<string, string> {
  const value = record[field];
  return typeof value === 'string' ? { [field]: value } : {};
}

function optionalStringArray(record: Record<string, unknown>, field: string): Record<string, readonly string[]> {
  const value = record[field];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? { [field]: value } : {};
}

function optionalBoolean(record: Record<string, unknown>, field: string): Record<string, boolean> {
  const value = record[field];
  return typeof value === 'boolean' ? { [field]: value } : {};
}

function optionalNumber(record: Record<string, unknown>, field: string): Record<string, number> {
  const value = record[field];
  return typeof value === 'number' ? { [field]: value } : {};
}

function optionalUnknown(record: Record<string, unknown>, field: string): Record<string, unknown> {
  return record[field] !== undefined ? { [field]: record[field] } : {};
}

function summarizePreparedEvidence(record: Record<string, unknown>): Record<string, unknown> {
  return {
    ...optionalString(record, 'evidenceId'),
    ...optionalString(record, 'payloadHash'),
    ...optionalString(record, 'payloadRef'),
    ...optionalString(record, 'verificationStatus'),
  };
}
