import { ValidationError } from './validation.js';

export interface RuntimeDispatchEffect {
  readonly type: 'HookReady';
  readonly eventId: string;
  readonly zhixuId: string;
  readonly orderId: string;
  readonly hookId: string;
  readonly stageIdentifier: string;
  readonly hookName: string;
}

export interface RuntimeDispatchContext {
  readonly state: unknown;
}

export interface RuntimeSignalEnvelope {
  readonly zhixuId: string;
  readonly orderId: string;
  readonly source: string;
  readonly stageIdentifier: string;
  readonly signalName: string;
  readonly senderId: string;
  readonly idempotencyKey?: string;
  readonly traceId?: string;
  readonly payloadRef?: string;
  readonly receivedAt?: string;
}

export interface RuntimeDispatchSuccess {
  readonly status: 'succeeded';
  readonly signals?: readonly RuntimeSignalEnvelope[];
}

export interface RuntimeDispatchFailure {
  readonly status: 'failed';
  readonly error: string;
}

export type RuntimeDispatchResult = RuntimeDispatchSuccess | RuntimeDispatchFailure;

export interface RuntimeDispatcher {
  dispatch(effect: RuntimeDispatchEffect, context: RuntimeDispatchContext): Promise<RuntimeDispatchResult>;
}

export type RuntimeExecutorHandler = (
  effect: RuntimeDispatchEffect,
  context: RuntimeDispatchContext,
) => RuntimeDispatchResult | Promise<RuntimeDispatchResult>;

export interface RuntimeDispatcherOptions {
  readonly handlers?: Readonly<Record<string, RuntimeExecutorHandler>>;
  readonly defaultHandler?: RuntimeExecutorHandler;
}

export interface BuildRuntimeSignalEnvelopeInput {
  readonly zhixuId: string;
  readonly orderId: string;
  readonly source: string;
  readonly stageIdentifier: string;
  readonly signalName: string;
  readonly senderId: string;
  readonly idempotencyKey?: string;
  readonly traceId?: string;
  readonly payloadRef?: string;
  readonly receivedAt?: string;
}

export interface StaticSignalHandlerOptions
  extends Omit<BuildRuntimeSignalEnvelopeInput, 'zhixuId' | 'orderId' | 'idempotencyKey' | 'receivedAt'> {
  readonly zhixuId?: string;
  readonly orderId?: string;
  readonly idempotencyKey?: string | ((effect: RuntimeDispatchEffect) => string);
  readonly receivedAt?: string | (() => string);
}

export function createRuntimeDispatcher(options: RuntimeDispatcherOptions = {}): RuntimeDispatcher {
  return {
    async dispatch(effect, context): Promise<RuntimeDispatchResult> {
      const handler = resolveRuntimeHandler(effect, options);
      if (!handler) {
        return {
          status: 'failed',
          error: `no runtime executor handler for ${effect.hookId}`,
        };
      }

      try {
        return await handler(effect, context);
      } catch (error) {
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export function createStaticSignalHandler(options: StaticSignalHandlerOptions): RuntimeExecutorHandler {
  validateStaticSignalOptions(options);
  return (effect) => {
    const receivedAt = typeof options.receivedAt === 'function' ? options.receivedAt() : options.receivedAt;
    const idempotencyKey = typeof options.idempotencyKey === 'function'
      ? options.idempotencyKey(effect)
      : options.idempotencyKey;

    return {
      status: 'succeeded',
      signals: [
        buildRuntimeSignalEnvelope({
          zhixuId: options.zhixuId ?? effect.zhixuId,
          orderId: options.orderId ?? effect.orderId,
          source: options.source,
          stageIdentifier: options.stageIdentifier,
          signalName: options.signalName,
          senderId: options.senderId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(options.traceId ? { traceId: options.traceId } : {}),
          ...(options.payloadRef ? { payloadRef: options.payloadRef } : {}),
          ...(receivedAt ? { receivedAt } : {}),
        }),
      ],
    };
  };
}

export function buildRuntimeSignalEnvelope(input: BuildRuntimeSignalEnvelopeInput): RuntimeSignalEnvelope {
  requireNonEmpty(input.zhixuId, 'zhixuId');
  requireNonEmpty(input.orderId, 'orderId');
  requireNonEmpty(input.source, 'source');
  requireNonEmpty(input.stageIdentifier, 'stageIdentifier');
  requireNonEmpty(input.signalName, 'signalName');
  requireNonEmpty(input.senderId, 'senderId');
  validateStageSignal(input.stageIdentifier, input.signalName);
  validateIsoDate(input.receivedAt, 'receivedAt');

  return {
    zhixuId: input.zhixuId,
    orderId: input.orderId,
    source: input.source,
    stageIdentifier: input.stageIdentifier,
    signalName: input.signalName,
    senderId: input.senderId,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.payloadRef ? { payloadRef: input.payloadRef } : {}),
    ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
  };
}

function resolveRuntimeHandler(
  effect: RuntimeDispatchEffect,
  options: RuntimeDispatcherOptions,
): RuntimeExecutorHandler | undefined {
  const handlers = options.handlers ?? {};
  return (
    handlers[`${effect.stageIdentifier}#${effect.hookName}`] ??
    handlers[effect.hookId] ??
    handlers[effect.stageIdentifier] ??
    options.defaultHandler
  );
}

function validateStaticSignalOptions(options: StaticSignalHandlerOptions): void {
  requireNonEmpty(options.source, 'source');
  requireNonEmpty(options.stageIdentifier, 'stageIdentifier');
  requireNonEmpty(options.signalName, 'signalName');
  requireNonEmpty(options.senderId, 'senderId');
  validateStageSignal(options.stageIdentifier, options.signalName);
}

function validateStageSignal(stageIdentifier: string, signalName: string): void {
  const stageParts = stageIdentifier.split('.');
  if (stageParts.length !== 2 || stageParts.some((part) => part.trim().length === 0)) {
    throw new ValidationError('stageIdentifier must be task.stage');
  }

  const signalParts = signalName.split('.');
  if (signalParts.length !== 3 || signalParts.some((part) => part.trim().length === 0)) {
    throw new ValidationError('signalName must be task.stage.signal');
  }

  if (`${signalParts[0]}.${signalParts[1]}` !== stageIdentifier) {
    throw new ValidationError(`signalName ${signalName} does not belong to stage ${stageIdentifier}`);
  }
}

function validateIsoDate(value: string | undefined, fieldName: string): void {
  if (value === undefined) {
    return;
  }
  if (Number.isNaN(new Date(value).getTime())) {
    throw new ValidationError(`${fieldName} must be an ISO date string`);
  }
}

function requireNonEmpty(value: string | undefined, fieldName: string): void {
  if (!value || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required`);
  }
}
