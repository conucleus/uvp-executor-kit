import { ValidationError } from './validation.js';

export type ExecutorKitErrorKind =
  | 'unauthorized'
  | 'duplicate_signal'
  | 'rpc_network'
  | 'missing_handler'
  | 'validation_failure'
  | 'handler_failure'
  | 'unknown';

export interface ClassifiedExecutorKitError {
  readonly kind: ExecutorKitErrorKind;
  readonly message: string;
  readonly retryable: boolean;
}

export function classifyExecutorKitError(
  error: unknown,
  fallbackKind: ExecutorKitErrorKind = 'unknown',
): ClassifiedExecutorKitError {
  const rawMessage = errorToMessage(error);
  const haystack = collectErrorText(error).toLowerCase();
  const kind = classifyFromText(error, haystack, fallbackKind);

  return {
    kind,
    message: redactSecretLikeHex(rawMessage || kind),
    retryable: kind === 'rpc_network',
  };
}

function classifyFromText(
  error: unknown,
  haystack: string,
  fallbackKind: ExecutorKitErrorKind,
): ExecutorKitErrorKind {
  if (error instanceof ValidationError) {
    return 'validation_failure';
  }

  if (matchesAny(haystack, [
    'unauthorized',
    'not authorized',
    'forbidden',
    'accesscontrol',
    'ownableunauthorizedaccount',
    'permission',
    'not allowed',
    'caller is not',
    'sender is not',
  ])) {
    return 'unauthorized';
  }

  if (matchesAny(haystack, [
    'duplicate',
    'already submitted',
    'already processed',
    'signal already',
    'idempotency',
    'nonce already',
    'replay',
  ])) {
    return 'duplicate_signal';
  }

  if (matchesAny(haystack, [
    'missing handler',
    'handler not found',
    'handler_not_found',
    'no runtime executor handler',
    'no state machine handler',
  ])) {
    return 'missing_handler';
  }

  if (matchesAny(haystack, [
    'validationerror',
    'validation failed',
    'invalid',
    'must be',
    'is required',
    'wrong chain id',
    'payloadhash',
    'payload hash',
  ])) {
    return 'validation_failure';
  }

  if (matchesAny(haystack, [
    'rpc',
    'fetch failed',
    'network',
    'timeout',
    'timed out',
    'econn',
    'enotfound',
    'etimedout',
    'eai_again',
    'socket',
    'rate limit',
    'too many requests',
    '429',
    '502',
    '503',
    '504',
    'gateway',
    'connection',
  ])) {
    return 'rpc_network';
  }

  return fallbackKind;
}

function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      current = current.cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return parts.join(' ');
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function matchesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function redactSecretLikeHex(value: string): string {
  return value
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, '[redacted-32-byte-hex]')
    .replace(/\b[a-fA-F0-9]{64}\b/g, '[redacted-32-byte-hex]');
}
