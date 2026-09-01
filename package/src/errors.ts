import { ValidationError } from './validation.js';

export type ExecutorKitErrorKind =
  | 'unauthorized'
  | 'duplicate_signal'
  | 'rpc_network'
  | 'insufficient_funds'
  | 'nonce_conflict'
  | 'missing_handler'
  | 'validation_failure'
  | 'handler_failure'
  | 'unknown';

/**
 * Explicit machine-readable error codes recognized by the classifier.
 *
 * Codes are honored first (typically via `error.code` on a thrown Error, e.g.
 * `new CodedExecutorKitError('RPC_NETWORK', 'fetch failed')`), but production
 * failures are mostly native viem errors and contract reverts that carry no
 * code at all. After the code lookup, the classifier therefore also matches
 * well-known real-world error texts and revert data (see MESSAGE_PATTERNS):
 * without that, transient network faults would terminally fail jobs and
 * `SignalAlreadyExists()` reverts would land as `unknown` instead of
 * `duplicate_signal`.
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

interface ErrorMessagePattern {
  readonly pattern: RegExp;
  readonly kind: ExecutorKitErrorKind;
  readonly retryable: boolean;
}

/**
 * Message-text patterns for failures that reach the kit without an explicit
 * code: native viem errors, JSON-RPC provider errors, and contract reverts.
 *
 * The list is ordered by priority; for each entry every message along the
 * error's cause chain is tested before the next entry runs. Only well-known
 * real-world error shapes are recognized — anything unrecognized still falls
 * through to the conservative non-retryable fallback instead of guessing.
 */
const MESSAGE_PATTERNS: readonly ErrorMessagePattern[] = [
  // Contract reverts that mean the exact same signal fact already exists.
  // Covers the decoded custom-error name (viem keeps `SignalAlreadyExists()`
  // in the message), the plain sentence form, and the raw 4-byte selector
  // `SignalAlreadyExists()` = 0xa2e92828 when the revert data is not decoded.
  {
    pattern: /SignalAlreadyExists|signal already exists|0xa2e92828/i,
    kind: 'duplicate_signal',
    retryable: false,
  },
  // On-chain authorization reverts (OpenZeppelin custom error names surface
  // verbatim in viem revert messages) and generic auth rejection text.
  {
    pattern: /AccessControlUnauthorizedAccount|OwnableUnauthorizedAccount|\bunauthorized\b/i,
    kind: 'unauthorized',
    retryable: false,
  },
  // Gas shortfalls are deterministic at broadcast time for the current wallet
  // state but recoverable by funding, so the failure stays in the retry lane
  // instead of being archived as deterministic.
  {
    pattern: /insufficient funds|insufficient balance/i,
    kind: 'insufficient_funds',
    retryable: true,
  },
  // Tx-pool and nonce races: a fresh attempt with a recomputed nonce (and the
  // protocol's own SignalAlreadyExists dedupe) makes these safe to retry.
  {
    pattern: /nonce too low|nonce has already been used|replacement transaction underpriced|already known|same hash was already imported/i,
    kind: 'nonce_conflict',
    retryable: true,
  },
  // Transport, RPC, and rate-limit conditions: timeouts, socket errors,
  // HTTP 429/502/503/504, gateway failures, and undici "fetch failed".
  {
    pattern: /\b429\b|too many requests|rate limit|timeout|timed out|\b502\b|\b503\b|\b504\b|bad gateway|service unavailable|gateway timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ECONNABORTED|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|HTTP request failed/i,
    kind: 'rpc_network',
    retryable: true,
  },
];

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

  // ValidationError stays an explicit type-based classification: local input
  // validation must not be re-guessed from its message text.
  if (error instanceof ValidationError) {
    return {
      kind: 'validation_failure',
      message: redactSecretLikeHex(rawMessage || 'validation_failure'),
      retryable: false,
    };
  }

  const matchedPattern = matchMessagePattern(error);
  if (matchedPattern) {
    return {
      kind: matchedPattern.kind,
      message: redactSecretLikeHex(rawMessage || matchedPattern.kind),
      retryable: matchedPattern.retryable,
    };
  }

  // No explicit code and no recognized error text: conservatively non-retryable
  // so unclassifiable failures reach a terminal state for human review rather
  // than being silently retried.
  return {
    kind: fallbackKind,
    message: redactSecretLikeHex(rawMessage || fallbackKind),
    retryable: false,
  };
}

function matchExplicitCode(error: unknown): ExecutorKitErrorCode | undefined {
  for (const current of walkErrorChain(error)) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code)) {
      return code as ExecutorKitErrorCode;
    }
  }
  return undefined;
}

function matchMessagePattern(error: unknown): ErrorMessagePattern | undefined {
  const messages = [...walkErrorChain(error)]
    .map((current) => (current instanceof Error ? current.message : undefined))
    .filter((message): message is string => typeof message === 'string' && message.length > 0);
  for (const entry of MESSAGE_PATTERNS) {
    if (messages.some((message) => entry.pattern.test(message))) {
      return entry;
    }
  }
  return undefined;
}

function* walkErrorChain(error: unknown): Generator<Error> {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    yield current;
    current = current.cause;
  }
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
