import { ValidationError } from './validation.js';

export type ExecutorKitErrorKind =
  | 'unauthorized'
  | 'duplicate_signal'
  | 'rpc_network'
  | 'missing_handler'
  | 'validation_failure'
  | 'handler_failure'
  | 'unknown';

/**
 * Explicit machine-readable error codes recognized by the classifier.
 *
 * Classification never inspects message text: an error is classified only when
 * it carries one of these codes (typically via `error.code` on a thrown Error,
 * e.g. `new CodedExecutorKitError('RPC_NETWORK', 'fetch failed')`). Anything
 * else is conservatively non-retryable and lands in a terminal state for human
 * review instead of guessing retry semantics from keywords.
 */
export type ExecutorKitErrorCode =
  | 'UNAUTHORIZED'
  | 'DUPLICATE_SIGNAL'
  | 'RPC_NETWORK'
  | 'MISSING_HANDLER'
  | 'VALIDATION_FAILURE'
  | 'HANDLER_FAILURE';

export interface ClassifiedExecutorKitError {
  readonly kind: ExecutorKitErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  /** The explicit code the classification was derived from, when present. */
  readonly code?: ExecutorKitErrorCode;
}

const ERROR_CODE_TABLE: Readonly<
  Record<ExecutorKitErrorCode, { readonly kind: ExecutorKitErrorKind; readonly retryable: boolean }>
> = {
  UNAUTHORIZED: { kind: 'unauthorized', retryable: false },
  DUPLICATE_SIGNAL: { kind: 'duplicate_signal', retryable: false },
  RPC_NETWORK: { kind: 'rpc_network', retryable: true },
  MISSING_HANDLER: { kind: 'missing_handler', retryable: false },
  VALIDATION_FAILURE: { kind: 'validation_failure', retryable: false },
  HANDLER_FAILURE: { kind: 'handler_failure', retryable: false },
};

const KNOWN_ERROR_CODES = new Set<string>(Object.keys(ERROR_CODE_TABLE));

/** An Error carrying an explicit executor-kit classification code. */
export class CodedExecutorKitError extends Error {
  readonly code: ExecutorKitErrorCode;

  constructor(code: ExecutorKitErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CodedExecutorKitError';
    this.code = code;
  }
}

export function classifyExecutorKitError(
  error: unknown,
  fallbackKind: ExecutorKitErrorKind = 'unknown',
): ClassifiedExecutorKitError {
  const rawMessage = errorToMessage(error);

  const matchedCode = matchExplicitCode(error);
  if (matchedCode) {
    const entry = ERROR_CODE_TABLE[matchedCode];
    return {
      kind: entry.kind,
      message: redactSecretLikeHex(rawMessage || matchedCode),
      retryable: entry.retryable,
      code: matchedCode,
    };
  }

  // No explicit code: never guess from message text. ValidationError stays an
  // explicit type-based classification; everything else falls back as strictly
  // non-retryable so unclassifiable failures reach a terminal state for human
  // review rather than being silently retried.
  return {
    kind: error instanceof ValidationError ? 'validation_failure' : fallbackKind,
    message: redactSecretLikeHex(rawMessage || fallbackKind),
    retryable: false,
  };
}

function matchExplicitCode(error: unknown): ExecutorKitErrorCode | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      const code = (current as { readonly code?: unknown }).code;
      if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code)) {
        return code as ExecutorKitErrorCode;
      }
      current = current.cause;
      continue;
    }
    break;
  }
  return undefined;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function redactSecretLikeHex(value: string): string {
  return value
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, '[redacted-32-byte-hex]')
    .replace(/\b[a-fA-F0-9]{64}\b/g, '[redacted-32-byte-hex]');
}
