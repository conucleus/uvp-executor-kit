import { createHash, timingSafeEqual } from 'node:crypto';
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
export const DEFAULT_CALLBACK_HOST_ALLOWLIST_ENV = 'UVP_EXECUTOR_CALLBACK_HOST_ALLOWLIST';

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
  readonly dispatchId?: string;
  readonly effect: RuntimeDispatchEffect;
  readonly callbackUrl: string;
}

export type ExecutorJobStatus = 'accepted' | 'callback_succeeded' | 'callback_failed' | 'handler_failed';

export interface ExecutorJob {
  readonly id: string;
  readonly dispatchId: string;
  readonly hookId: string;
  readonly status: ExecutorJobStatus;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly callbackUrl: string;
  readonly lastError?: string;
}

export interface ExecutorJobStore {
  create(job: ExecutorJob): Promise<void>;
  update(jobId: string, patch: Pick<ExecutorJob, 'status' | 'updatedAt'> & Partial<Pick<ExecutorJob, 'lastError'>>): Promise<void>;
  get(jobId: string): Promise<ExecutorJob | undefined>;
  list(): Promise<readonly ExecutorJob[]>;
}

export interface ExecutorServerOptions {
  readonly executorId: string;
  readonly handlers: Readonly<Record<string, RuntimeExecutorHandler>>;
  readonly executorToken: string;
  readonly callbackToken: string;
  readonly host?: string;
  readonly port?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly jobStore?: ExecutorJobStore;
  readonly callbackHostAllowlist?: readonly string[];
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
  readonly callbackHostAllowlist: readonly string[];
  readonly handlers: Readonly<Record<string, RuntimeExecutorHandler>>;
  readonly fetchImpl: typeof fetch;
  readonly now: () => string;
  readonly jobStore: ExecutorJobStore;
}

const MAX_BODY_BYTES = 1_000_000;

export class InMemoryExecutorJobStore implements ExecutorJobStore {
  private readonly jobs = new Map<string, ExecutorJob>();

  async create(job: ExecutorJob): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
  }

  async update(
    jobId: string,
    patch: Pick<ExecutorJob, 'status' | 'updatedAt'> & Partial<Pick<ExecutorJob, 'lastError'>>,
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
  const callbackHostAllowlist = options.callbackHostAllowlist ?? parseCallbackHostAllowlist(process.env[DEFAULT_CALLBACK_HOST_ALLOWLIST_ENV]);
  const now = options.now ?? (() => new Date().toISOString());
  const fetchImpl = options.fetchImpl ?? fetch;
  const jobStore = options.jobStore ?? new InMemoryExecutorJobStore();
  const server = createServer((request, response) => {
    void handleExecutorRequest(
      {
        executorId: options.executorId,
        executorToken,
        callbackToken,
        callbackHostAllowlist,
        handlers: options.handlers,
        fetchImpl,
        now,
        jobStore,
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
      id: dispatch.dispatchId ?? `${dispatch.effect.orderId}:${dispatch.effect.hookId}:${acceptedAt}`,
      dispatchId: dispatch.dispatchId ?? `${dispatch.effect.orderId}:${dispatch.effect.hookId}`,
      hookId: dispatch.effect.hookId,
      status: 'accepted',
      acceptedAt,
      updatedAt: acceptedAt,
      callbackUrl: dispatch.callbackUrl,
    };
    if (await context.jobStore.get(job.id)) {
      return { status: 409, body: { error: 'job_already_exists', jobId: job.id } };
    }
    await context.jobStore.create(job);
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
  context: Pick<ExecutorRequestContext, 'fetchImpl' | 'now' | 'jobStore' | 'callbackToken' | 'callbackHostAllowlist'>,
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

    for (const signal of result.signals ?? []) {
      await postSignalCallback(context.fetchImpl, dispatch.callbackUrl, context.callbackToken, signal, context.callbackHostAllowlist);
    }
    await context.jobStore.update(job.id, {
      status: 'callback_succeeded',
      updatedAt: context.now(),
    });
  } catch (error) {
    await context.jobStore.update(job.id, {
      status: 'callback_failed',
      updatedAt: context.now(),
      lastError: error instanceof Error ? error.message : String(error),
    });
  }
}

async function postSignalCallback(
  fetchImpl: typeof fetch,
  callbackUrl: string,
  callbackToken: string,
  signal: RuntimeSignalEnvelope,
  callbackHostAllowlist: readonly string[],
): Promise<void> {
  assertCallbackUrlAllowed(callbackUrl, callbackHostAllowlist);
  const response = await fetchImpl(callbackUrl, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${callbackToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ signal }),
  });
  if (!response.ok) {
    throw new Error(`callback endpoint failed with ${response.status}: ${await response.text()}`);
  }
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
  const effect = toDispatchEffect(value.effect);
  const callbackUrl = asString(value.callbackUrl, 'callbackUrl');
  assertCallbackUrlAllowed(callbackUrl, callbackHostAllowlist);
  return {
    effect,
    callbackUrl,
    ...(typeof value.dispatchId === 'string' ? { dispatchId: value.dispatchId } : {}),
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
