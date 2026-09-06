import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createStaticSignalHandler,
  type RuntimeDispatchEffect,
  type RuntimeExecutorHandler,
  type RuntimeSignalEnvelope,
} from './runtime.js';
import { ValidationError } from './validation.js';

export const DEFAULT_EXECUTOR_TOKEN_ENV = 'UVP_EXECUTOR_TOKEN';
export const DEFAULT_CALLBACK_TOKEN_ENV = 'UVP_CALLBACK_TOKEN';
export const DEFAULT_CALLBACK_HMAC_SECRET_ENV = 'UVP_CALLBACK_HMAC_SECRET';
export const DEFAULT_CALLBACK_HOST_ALLOWLIST_ENV = 'UVP_EXECUTOR_CALLBACK_HOST_ALLOWLIST';
/** Bounded in-process callback delivery retries before a job lands in callback_failed. */
export const DEFAULT_CALLBACK_MAX_ATTEMPTS = 3;
export const DEFAULT_CALLBACK_RETRY_BASE_DELAY_MS = 250;
export const WEBHOOK_SIGNATURE_HEADER = 'x-uvp-webhook-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-uvp-webhook-timestamp';
export const WEBHOOK_NONCE_HEADER = 'x-uvp-webhook-nonce';
/** Acceptance window for the webhook timestamp; outside it a captured request no longer verifies. */
export const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;
const DEFAULT_WEBHOOK_REPLAY_MAX_NONCES = 10_000;

const LOOPBACK_CALLBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface ExecutorStaticHandlerDefinition {
  readonly source: string;
  readonly stageIdentifier: string;
  readonly signalName: string;
  readonly senderId?: string;
  readonly idempotencyKey?: string;
  readonly traceId?: string;
  readonly payloadRef?: string;
  readonly receivedAt?: string;
}

export interface ExecutorConfig {
  readonly executorId: string;
  readonly handlers: Readonly<Record<string, ExecutorStaticHandlerDefinition>>;
}

export interface ExecutorDispatchRequest {
  readonly dispatchId: string;
  readonly effect: RuntimeDispatchEffect;
  readonly callbackUrl: string;
}

export type ExecutorJobStatus = 'accepted' | 'callback_succeeded' | 'callback_failed' | 'handler_failed';

/**
 * Truthful per-signal callback delivery record: which signals were delivered,
 * how many attempts each took, and the terminal error when delivery was
 * abandoned after exhausting the bounded retries.
 */
export interface ExecutorCallbackDelivery {
  readonly signalIndex: number;
  readonly delivered: boolean;
  readonly attempts: number;
  readonly error?: string;
}

export interface ExecutorJob {
  readonly id: string;
  readonly dispatchId: string;
  readonly hookId: string;
  readonly status: ExecutorJobStatus;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly callbackUrl: string;
  readonly lastError?: string;
  readonly callbacks?: readonly ExecutorCallbackDelivery[];
}

export interface ExecutorJobStore {
  /**
   * Conditional insert: resolves false when a job with the same id already
   * exists. The check and the write are one atomic operation so concurrent
   * duplicate dispatches cannot both pass a read-then-create sequence.
   */
  create(job: ExecutorJob): Promise<boolean>;
  update(
    jobId: string,
    patch: Pick<ExecutorJob, 'status' | 'updatedAt'> & Partial<Pick<ExecutorJob, 'lastError' | 'callbacks'>>,
  ): Promise<void>;
  get(jobId: string): Promise<ExecutorJob | undefined>;
  list(): Promise<readonly ExecutorJob[]>;
}

export interface ExecutorServerOptions {
  readonly executorId: string;
  readonly handlers: Readonly<Record<string, RuntimeExecutorHandler>>;
  readonly executorToken: string;
  readonly callbackToken: string;
  /** Optional shared secret for signing outbound callback bodies. */
  readonly callbackHmacSecret?: string;
  readonly host?: string;
  readonly port?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly jobStore?: ExecutorJobStore;
  readonly callbackHostAllowlist?: readonly string[];
  /** Bounded in-process retry policy for callback POST failures. */
  readonly callbackRetry?: {
    readonly maxAttempts?: number | string;
    readonly baseDelayMs?: number | string;
  };
}

export interface ExecutorServerHandle {
  readonly server: Server;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly jobStore: ExecutorJobStore;
  close(): Promise<void>;
}

interface ExecutorRequestContext {
  readonly executorId: string;
  readonly executorToken: string;
  readonly callbackToken: string;
  readonly callbackHmacSecret?: string;
  readonly callbackHostAllowlist: readonly string[];
  readonly handlers: Readonly<Record<string, RuntimeExecutorHandler>>;
  readonly fetchImpl: typeof fetch;
  readonly now: () => string;
  readonly jobStore: ExecutorJobStore;
  readonly callbackMaxAttempts: number;
  readonly callbackRetryBaseDelayMs: number;
}

const MAX_BODY_BYTES = 1_000_000;

export class InMemoryExecutorJobStore implements ExecutorJobStore {
  private readonly jobs = new Map<string, ExecutorJob>();

  async create(job: ExecutorJob): Promise<boolean> {
    if (this.jobs.has(job.id)) {
      return false;
    }
    this.jobs.set(job.id, structuredClone(job));
    return true;
  }

  async update(
    jobId: string,
    patch: Pick<ExecutorJob, 'status' | 'updatedAt'> & Partial<Pick<ExecutorJob, 'lastError' | 'callbacks'>>,
  ): Promise<void> {
    const current = this.jobs.get(jobId);
    if (!current) {
      return;
    }
    this.jobs.set(jobId, {
      ...current,
      status: patch.status,
      updatedAt: patch.updatedAt,
      ...(patch.lastError ? { lastError: patch.lastError } : {}),
      ...(patch.callbacks ? { callbacks: patch.callbacks } : {}),
    });
  }

  async get(jobId: string): Promise<ExecutorJob | undefined> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  async list(): Promise<readonly ExecutorJob[]> {
    return [...this.jobs.values()]
      .sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt) || left.id.localeCompare(right.id))
      .map((job) => structuredClone(job));
  }
}

export async function loadExecutorConfig(filePath: string): Promise<ExecutorConfig> {
  if (!filePath || filePath.trim().length === 0) {
    throw new ValidationError('config path is required');
  }
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return normalizeExecutorConfig(parsed);
}

export function createHandlersFromExecutorConfig(config: ExecutorConfig): Readonly<Record<string, RuntimeExecutorHandler>> {
  return Object.fromEntries(
    Object.entries(config.handlers).map(([key, handler]) => [
      key,
      createStaticSignalHandler({
        source: handler.source,
        stageIdentifier: handler.stageIdentifier,
        signalName: handler.signalName,
        senderId: handler.senderId ?? config.executorId,
        idempotencyKey: handler.idempotencyKey ?? ((effect) => `${effect.orderId}:${effect.hookId}:${handler.signalName}`),
        ...(handler.traceId ? { traceId: handler.traceId } : {}),
        ...(handler.payloadRef ? { payloadRef: handler.payloadRef } : {}),
        ...(handler.receivedAt ? { receivedAt: handler.receivedAt } : {}),
      }),
    ]),
  );
}

export async function startExecutorServer(options: ExecutorServerOptions): Promise<ExecutorServerHandle> {
  const bindHost = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const executorToken = requireNonEmpty(options.executorToken, 'executorToken');
  const callbackToken = requireNonEmpty(options.callbackToken, 'callbackToken');
  const callbackHmacSecret = options.callbackHmacSecret?.trim() || undefined;
  const callbackHostAllowlist = options.callbackHostAllowlist ?? parseCallbackHostAllowlist(process.env[DEFAULT_CALLBACK_HOST_ALLOWLIST_ENV]);
  const now = options.now ?? (() => new Date().toISOString());
  const fetchImpl = options.fetchImpl ?? fetch;
  const jobStore = options.jobStore ?? new InMemoryExecutorJobStore();
  const callbackMaxAttempts = normalizeCallbackMaxAttempts(options.callbackRetry?.maxAttempts);
  const callbackRetryBaseDelayMs = normalizeCallbackBaseDelayMs(options.callbackRetry?.baseDelayMs);
  const server = createServer((request, response) => {
    void handleExecutorRequest(
      {
        executorId: options.executorId,
        executorToken,
        callbackToken,
        ...(callbackHmacSecret ? { callbackHmacSecret } : {}),
        callbackHostAllowlist,
        handlers: options.handlers,
        fetchImpl,
        now,
        jobStore,
        callbackMaxAttempts,
        callbackRetryBaseDelayMs,
      },
      request,
      response,
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(port, bindHost, resolve);
  });

  const address = server.address() as AddressInfo;
  const publicHost = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
  const url = `http://${formatHost(publicHost)}:${address.port}`;
  return {
    server,
    url,
    host: publicHost,
    port: address.port,
    jobStore,
    close: () => closeServer(server),
  };
}

async function handleExecutorRequest(
  context: ExecutorRequestContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const apiResponse = await routeExecutorRequest(context, request);
    writeJson(response, apiResponse.status, apiResponse.body);
  } catch (error) {
    writeJson(response, error instanceof UnauthorizedError ? 401 : 400, {
      error: error instanceof UnauthorizedError ? 'unauthorized' : 'bad_request',
      message: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

async function routeExecutorRequest(
  context: ExecutorRequestContext,
  request: IncomingMessage,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (method === 'GET' && url.pathname === '/healthz') {
    return { status: 200, body: { ok: true, service: 'executor-kit', executorId: context.executorId } };
  }

  requireBearerToken(request, context.executorToken);

  if (method === 'GET' && url.pathname === '/v0/jobs') {
    return { status: 200, body: { jobs: await context.jobStore.list() } };
  }

  const jobMatch = /^\/v0\/jobs\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && jobMatch) {
    const job = await context.jobStore.get(decodeURIComponent(jobMatch[1] ?? ''));
    return job ? { status: 200, body: { job } } : { status: 404, body: { error: 'job_not_found' } };
  }

  if (method === 'POST' && url.pathname === '/v0/dispatches') {
    const dispatch = toDispatchRequest(await readJsonBody(request), context.callbackHostAllowlist);
    const handler = resolveHandler(dispatch.effect, context.handlers);
    if (!handler) {
      return {
        status: 404,
        body: { error: 'handler_not_found', hookId: dispatch.effect.hookId },
      };
    }

    const acceptedAt = context.now();
    const job: ExecutorJob = {
      id: dispatch.dispatchId,
      dispatchId: dispatch.dispatchId,
      hookId: dispatch.effect.hookId,
      status: 'accepted',
      acceptedAt,
      updatedAt: acceptedAt,
      callbackUrl: dispatch.callbackUrl,
    };
    if (!(await context.jobStore.create(job))) {
      return { status: 409, body: { error: 'job_already_exists', jobId: job.id } };
    }
    queueMicrotask(() => {
      void processDispatch(context, job, dispatch, handler);
    });
    return { status: 202, body: { job } };
  }

  if (['GET', 'POST'].includes(method)) {
    return { status: 404, body: { error: 'not_found' } };
  }
  return { status: 405, body: { error: 'method_not_allowed' } };
}

async function processDispatch(
  context: Pick<ExecutorRequestContext, 'fetchImpl' | 'now' | 'jobStore' | 'callbackToken' | 'callbackHmacSecret' | 'callbackHostAllowlist' | 'callbackMaxAttempts' | 'callbackRetryBaseDelayMs'>,
  job: ExecutorJob,
  dispatch: ExecutorDispatchRequest,
  handler: RuntimeExecutorHandler,
): Promise<void> {
  try {
    const result = await handler(dispatch.effect, { state: {} });
    if (result.status === 'failed') {
      await context.jobStore.update(job.id, {
        status: 'handler_failed',
        updatedAt: context.now(),
        lastError: result.error,
      });
      return;
    }

    // Validate once up front so a rejected callback URL fails fast instead of
    // being retried; per-signal failures below are delivery failures.
    assertCallbackUrlAllowed(dispatch.callbackUrl, context.callbackHostAllowlist);

    const signals = result.signals ?? [];
    // Each signal is retried independently and recorded truthfully: a partial
    // failure must never erase the fact that earlier signals were delivered.
    const deliveries: ExecutorCallbackDelivery[] = [];
    for (const [signalIndex, signal] of signals.entries()) {
      deliveries.push(await deliverSignalCallback(context, dispatch.callbackUrl, signal, signalIndex));
    }
    const failedDeliveries = deliveries.filter((delivery) => !delivery.delivered);
    await context.jobStore.update(job.id, {
      status: failedDeliveries.length === 0 ? 'callback_succeeded' : 'callback_failed',
      updatedAt: context.now(),
      ...(deliveries.length > 0 ? { callbacks: deliveries } : {}),
      ...(failedDeliveries.length > 0 ? {
        lastError: `callback delivery failed for ${failedDeliveries.length}/${deliveries.length} signal(s)`
          + `${deliveries.length - failedDeliveries.length > 0 ? ` (${deliveries.length - failedDeliveries.length} signal(s) were delivered)` : ''}`
          + `: ${failedDeliveries[0]?.error ?? 'unknown error'}`,
      } : {}),
    });
  } catch (error) {
    await context.jobStore.update(job.id, {
      status: 'callback_failed',
      updatedAt: context.now(),
      lastError: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * POST one signal callback with bounded in-process retries (exponential
 * backoff starting at the configured base delay). Returns the truthful
 * delivery record; only after all attempts are exhausted is the failure
 * reported (with an error log) back to the caller.
 */
async function deliverSignalCallback(
  context: Pick<ExecutorRequestContext, 'fetchImpl' | 'callbackToken' | 'callbackHmacSecret' | 'callbackHostAllowlist' | 'callbackMaxAttempts' | 'callbackRetryBaseDelayMs'>,
  callbackUrl: string,
  signal: RuntimeSignalEnvelope,
  signalIndex: number,
): Promise<ExecutorCallbackDelivery> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= context.callbackMaxAttempts; attempt += 1) {
    try {
      await postSignalCallback(context.fetchImpl, callbackUrl, context.callbackToken, context.callbackHmacSecret, signal, context.callbackHostAllowlist);
      return { signalIndex, delivered: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < context.callbackMaxAttempts && context.callbackRetryBaseDelayMs > 0) {
        await delay(context.callbackRetryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`executor-kit: callback delivery failed for signal ${signalIndex} after ${context.callbackMaxAttempts} attempt(s): ${message}`);
  return { signalIndex, delivered: false, attempts: context.callbackMaxAttempts, error: message };
}

async function postSignalCallback(
  fetchImpl: typeof fetch,
  callbackUrl: string,
  callbackToken: string,
  callbackHmacSecret: string | undefined,
  signal: RuntimeSignalEnvelope,
  callbackHostAllowlist: readonly string[],
): Promise<void> {
  assertCallbackUrlAllowed(callbackUrl, callbackHostAllowlist);
  const body = JSON.stringify({ signal });
  const response = await fetchImpl(callbackUrl, {
    method: 'POST',
    // Never let fetch follow a redirect: the Authorization bearer (and the
    // webhook signature header) would be replayed to whatever host the
    // callback endpoint points at. A 3xx is a delivery failure, full stop.
    redirect: 'manual',
    headers: {
      'authorization': `Bearer ${callbackToken}`,
      'content-type': 'application/json',
      ...(callbackHmacSecret ? webhookSignatureHeaders(callbackHmacSecret, body) : {}),
    },
    body,
  });
  if (!response.ok) {
    // Includes every 3xx (and the status-0 opaqueredirect response a manual
    // redirect policy yields): a redirecting callback endpoint failed.
    throw new Error(`callback endpoint failed with ${response.status}: ${await response.text()}`);
  }
}

/**
 * Timestamp+nonce authenticated HMAC for outbound webhook callbacks.
 *
 * A bare HMAC over the body is replayable forever: capturing (body, signature)
 * is enough to re-deliver the callback at any later time. The MAC therefore
 * covers `timestamp.nonce.body`, the timestamp is rejected outside the
 * acceptance window, and the nonce is single-use per window via the replay
 * guard — a captured request dies with the window.
 */
export interface WebhookSignatureFields {
  /** Unix timestamp in seconds, sent as the timestamp header. */
  readonly timestamp: string;
  /** Random hex nonce, sent as the nonce header. */
  readonly nonce: string;
}

export function newWebhookSignatureFields(nowMs: () => number = Date.now): WebhookSignatureFields {
  return {
    timestamp: Math.floor(nowMs() / 1000).toString(),
    nonce: randomBytes(16).toString('hex'),
  };
}

export function signWebhookBody(
  secret: string,
  body: string | Uint8Array,
  fields: WebhookSignatureFields,
): string {
  return `sha256=${createHmac('sha256', secret)
    .update(webhookSignedPayload(body, fields))
    .digest('hex')}`;
}

function webhookSignedPayload(body: string | Uint8Array, fields: WebhookSignatureFields): string {
  return `${fields.timestamp}.${fields.nonce}.${typeof body === 'string' ? body : Buffer.from(body).toString('utf8')}`;
}

export interface VerifyWebhookSignatureOptions {
  /** Value of the `x-uvp-webhook-timestamp` header (unix seconds). */
  readonly timestamp?: string;
  /** Value of the `x-uvp-webhook-nonce` header. */
  readonly nonce?: string;
  readonly nowMs?: () => number;
  readonly toleranceMs?: number;
}

/**
 * Verify the `x-uvp-webhook-signature` value over the exact raw request body
 * together with its timestamp and nonce headers. Receivers should call this
 * before parsing JSON and reject false, malformed, missing, or stale
 * signatures. Constant-time comparison prevents timing leaks.
 *
 * Fail-closed on absent timestamp/nonce: a legacy body-only signature is
 * exactly the permanently replayable shape this scheme exists to kill.
 */
export function verifyWebhookSignature(
  body: string | Uint8Array,
  signature: string | undefined,
  secret: string,
  options: VerifyWebhookSignatureOptions = {},
): boolean {
  if (!signature || !secret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!match) return false;
  const timestamp = options.timestamp?.trim();
  const nonce = options.nonce?.trim();
  if (!timestamp || !/^(0|[1-9][0-9]{0,9})$/.test(timestamp)) return false;
  if (!nonce || !/^[0-9a-f]{16,64}$/i.test(nonce)) return false;

  const nowMs = (options.nowMs ?? Date.now)();
  const toleranceMs = options.toleranceMs ?? DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_MS;
  const timestampMs = Number(timestamp) * 1000;
  if (Math.abs(nowMs - timestampMs) > toleranceMs) return false;

  const expected = createHmac('sha256', secret)
    .update(webhookSignedPayload(body, { timestamp, nonce }))
    .digest();
  const supplied = Buffer.from(match[1]!, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export interface WebhookReplayGuard {
  /**
   * Record a nonce sighting. Resolves false when the same nonce was already
   * seen inside the acceptance window — the request is a replay.
   */
  observe(nonce: string, timestampMs: number, nowMs?: number): boolean;
}

export function createWebhookReplayGuard(options: {
  readonly toleranceMs?: number;
  readonly maxTrackedNonces?: number;
} = {}): WebhookReplayGuard {
  const toleranceMs = options.toleranceMs ?? DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_MS;
  const maxTrackedNonces = options.maxTrackedNonces ?? DEFAULT_WEBHOOK_REPLAY_MAX_NONCES;
  const seen = new Map<string, number>();
  return {
    observe(nonce: string, timestampMs: number, nowMs: number = Date.now()): boolean {
      const previous = seen.get(nonce);
      if (previous !== undefined && Math.abs(nowMs - previous) <= toleranceMs) {
        return false;
      }
      seen.delete(nonce);
      seen.set(nonce, timestampMs);
      if (seen.size > maxTrackedNonces) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }
      return true;
    },
  };
}

function webhookSignatureHeaders(secret: string, body: string): Record<string, string> {
  const fields = newWebhookSignatureFields();
  return {
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(secret, body, fields),
    [WEBHOOK_TIMESTAMP_HEADER]: fields.timestamp,
    [WEBHOOK_NONCE_HEADER]: fields.nonce,
  };
}

function normalizeExecutorConfig(value: unknown): ExecutorConfig {
  if (!isRecord(value)) {
    throw new ValidationError('executor config must be an object');
  }
  const executorId = asString(value.executorId, 'executorId');
  if (!isRecord(value.handlers)) {
    throw new ValidationError('handlers must be an object');
  }
  return {
    executorId,
    handlers: Object.fromEntries(
      Object.entries(value.handlers).map(([key, handler]) => [key, normalizeHandlerDefinition(handler, `handlers.${key}`)]),
    ),
  };
}

function normalizeHandlerDefinition(value: unknown, path: string): ExecutorStaticHandlerDefinition {
  if (!isRecord(value)) {
    throw new ValidationError(`${path} must be an object`);
  }
  return {
    source: asString(value.source, `${path}.source`),
    stageIdentifier: asString(value.stageIdentifier, `${path}.stageIdentifier`),
    signalName: asString(value.signalName, `${path}.signalName`),
    ...(typeof value.senderId === 'string' ? { senderId: value.senderId } : {}),
    ...(typeof value.idempotencyKey === 'string' ? { idempotencyKey: value.idempotencyKey } : {}),
    ...(typeof value.traceId === 'string' ? { traceId: value.traceId } : {}),
    ...(typeof value.payloadRef === 'string' ? { payloadRef: value.payloadRef } : {}),
    ...(typeof value.receivedAt === 'string' ? { receivedAt: value.receivedAt } : {}),
  };
}

function toDispatchRequest(value: unknown, callbackHostAllowlist: readonly string[]): ExecutorDispatchRequest {
  if (!isRecord(value)) {
    throw new ValidationError('dispatch request must be an object');
  }
  if (typeof value.dispatchId !== 'string' || value.dispatchId.trim().length === 0) {
    throw new ValidationError('dispatchId is required: provide a stable dispatchId so duplicate dispatches can be rejected');
  }
  const effect = toDispatchEffect(value.effect);
  const callbackUrl = asString(value.callbackUrl, 'callbackUrl');
  assertCallbackUrlAllowed(callbackUrl, callbackHostAllowlist);
  return {
    dispatchId: value.dispatchId,
    effect,
    callbackUrl,
  };
}

function toDispatchEffect(value: unknown): RuntimeDispatchEffect {
  if (!isRecord(value) || value.type !== 'HookReady') {
    throw new ValidationError('effect must be a HookReady object');
  }
  return {
    type: 'HookReady',
    eventId: asString(value.eventId, 'effect.eventId'),
    zhixuId: asString(value.zhixuId, 'effect.zhixuId'),
    orderId: asString(value.orderId, 'effect.orderId'),
    hookId: asString(value.hookId, 'effect.hookId'),
    stageIdentifier: asString(value.stageIdentifier, 'effect.stageIdentifier'),
    hookName: asString(value.hookName, 'effect.hookName'),
  };
}

function resolveHandler(
  effect: RuntimeDispatchEffect,
  handlers: Readonly<Record<string, RuntimeExecutorHandler>>,
): RuntimeExecutorHandler | undefined {
  return handlers[`${effect.stageIdentifier}#${effect.hookName}`] ?? handlers[effect.hookId] ?? handlers[effect.stageIdentifier];
}

function requireBearerToken(request: IncomingMessage, token: string | undefined): void {
  const header = request.headers.authorization;
  const provided = typeof header === 'string' ? bearerTokenOf(header) : undefined;
  if (!provided || !token || !secureTokenEquals(provided, token)) {
    throw new UnauthorizedError('missing or invalid bearer token');
  }
}

function bearerTokenOf(header: string): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function secureTokenEquals(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function parseCallbackHostAllowlist(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => normalizeCallbackHost(entry))
    .filter((host) => host.length > 0);
}

export function assertCallbackUrlAllowed(callbackUrl: string, allowlist: readonly string[]): void {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new ValidationError('callbackUrl must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`callbackUrl scheme must be http or https, got ${url.protocol}`);
  }
  const hostname = normalizeCallbackHost(url.hostname);
  if (LOOPBACK_CALLBACK_HOSTS.has(hostname) || allowlist.includes(hostname)) {
    return;
  }
  throw new ValidationError(`callbackUrl host is not allowed: ${hostname}`);
}

function normalizeCallbackHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ValidationError('request body too large');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body, jsonReplacer));
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireNonEmpty(value: string | undefined, fieldName: string): string {
  if (!value || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required`);
  }
  return value;
}

function normalizeCallbackMaxAttempts(value: number | string | undefined): number {
  if (value === undefined) {
    return DEFAULT_CALLBACK_MAX_ATTEMPTS;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ValidationError('callbackRetry.maxAttempts must be a positive integer');
  }
  return parsed;
}

function normalizeCallbackBaseDelayMs(value: number | string | undefined): number {
  if (value === undefined) {
    return DEFAULT_CALLBACK_RETRY_BASE_DELAY_MS;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError('callbackRetry.baseDelayMs must be a non-negative integer');
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class UnauthorizedError extends Error {}
