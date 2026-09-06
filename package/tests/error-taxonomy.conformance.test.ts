import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  classifyExecutorKitError,
  CodedExecutorKitError,
  type ExecutorKitErrorKind,
} from '../src/errors.js';
import { ValidationError } from '../src/validation.js';
import { chainPollExecutionFailed } from '../src/cli.js';
import { SubmitSignalReceiptError } from '../src/watcher.js';
import type { Hex } from '../src/constants.js';

const TX_HASH: Hex = '0x' + 'ab'.repeat(32);

/**
 * Conformance suite for the unified UVP error taxonomy
 * (uvp-protocol/protocol/uvp-error-taxonomy.v1.json).
 *
 * errors.ts keeps its handwritten tables (the published package must not gain a
 * runtime file dependency outside its own repo), but this suite pins the
 * taxonomy version + sha256 and enforces, in both directions:
 *   1. completeness — every error kind/status the kit can produce appears in
 *      the taxonomy (mirrored closed sets + behavioral probes);
 *   2. consistency — for every taxonomy entry produced by executor-kit, the
 *      classifier's verdict matches the taxonomy attributes field by field
 *      (base attributes merged with the executor-kit producer_overrides).
 *
 * Any edit to the taxonomy table or to errors.ts classification semantics must
 * update both sides in the same change or these tests fail loudly.
 */

const TAXONOMY_VERSION = 'uvp.error-taxonomy.v1';
const TAXONOMY_SHA256 = 'b742667c145f4e14db428405af64b004a6379f46cc440f9fafe2114fc19d30fc';

interface TaxonomyErrorEntry {
  readonly code: string;
  readonly layer: string;
  readonly producers: readonly string[];
  readonly retryable: boolean;
  readonly backoff: string;
  readonly dead_letter: boolean;
  readonly benign_scan_outcome: boolean;
  readonly internal_names?: Readonly<Record<string, readonly string[]>>;
  readonly producer_overrides?: Readonly<Record<string, Record<string, unknown>>>;
}

interface TaxonomyFile {
  readonly version: string;
  readonly errors: readonly TaxonomyErrorEntry[];
}

function taxonomyPath(): string {
  const override = process.env.UVP_ERROR_TAXONOMY_JSON;
  if (override) {
    return override;
  }
  // tests/ -> package -> uvp-executor-kit -> uvp-eth (workspace root)
  const workspaceRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  return join(workspaceRoot, 'uvp-protocol', 'protocol', 'uvp-error-taxonomy.v1.json');
}

function loadTaxonomy(): TaxonomyFile {
  const path = taxonomyPath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `uvp error taxonomy not readable at ${path} (${(error as Error).message}). `
      + 'The table lives in the uvp-protocol repo under protocol/uvp-error-taxonomy.v1.json; '
      + 'run the test from the pnpm workspace or point UVP_ERROR_TAXONOMY_JSON at the file. '
      + 'Do not skip this suite: it is the executor-kit side of the pinned conformance contract.',
    );
  }
  const parsed = JSON.parse(raw) as TaxonomyFile;
  expect(parsed.version).toBe(TAXONOMY_VERSION);
  const digest = createHash('sha256').update(raw).digest('hex');
  expect(digest).toBe(TAXONOMY_SHA256);
  return parsed;
}

const taxonomy = loadTaxonomy();

function entryByCode(code: string): TaxonomyErrorEntry {
  const entry = taxonomy.errors.find((candidate) => candidate.code === code);
  if (!entry) {
    throw new Error(`taxonomy is missing the "${code}" entry`);
  }
  return entry;
}

/** Base attributes merged with the executor-kit producer_overrides patch. */
function attrsForExecutorKit(code: string): TaxonomyErrorEntry & Record<string, unknown> {
  const entry = entryByCode(code);
  if (!entry.producers.includes('executor-kit')) {
    throw new Error(`taxonomy entry "${code}" does not list executor-kit as a producer`);
  }
  return { ...entry, ...(entry.producer_overrides?.['executor-kit'] ?? {}) };
}

/** Mirrored closed set of ExecutorKitErrorKind, mapped onto taxonomy codes. */
const KIND_TO_TAXONOMY_CODE: Readonly<Record<ExecutorKitErrorKind, string>> = {
  unauthorized: 'unauthorized',
  duplicate_signal: 'duplicate_signal',
  rpc_network: 'rpc_network',
  insufficient_funds: 'insufficient_funds',
  nonce_conflict: 'nonce_conflict',
  missing_handler: 'missing_handler',
  validation_failure: 'malformed_payload',
  handler_failure: 'handler_failure',
  unknown: 'unknown_unclassified',
};

/** Probe that drives the classifier into each reachable kind. */
const KIND_PROBES: Readonly<Record<ExecutorKitErrorKind, () => { readonly kind: ExecutorKitErrorKind; readonly retryable: boolean }>> = {
  unauthorized: () => classifyExecutorKitError(new CodedExecutorKitError('UNAUTHORIZED', 'AccessControlUnauthorizedAccount')),
  duplicate_signal: () => classifyExecutorKitError(new Error('execution reverted: SignalAlreadyExists()')),
  rpc_network: () => classifyExecutorKitError(new Error('fetch failed')),
  insufficient_funds: () => classifyExecutorKitError(new Error('insufficient funds for gas * price + value')),
  nonce_conflict: () => classifyExecutorKitError(new Error('nonce too low')),
  missing_handler: () => classifyExecutorKitError(new Error('no state machine handler for exec#main'), 'missing_handler'),
  validation_failure: () => classifyExecutorKitError(new ValidationError('payloadHash must be a 32-byte hex value')),
  handler_failure: () => classifyExecutorKitError(new CodedExecutorKitError('HANDLER_FAILURE', 'handler failed')),
  unknown: () => classifyExecutorKitError(new Error('no pattern matches this shape at all')),
};

describe('uvp error taxonomy pinning (executor-kit)', () => {
  it('pins the taxonomy version and sha256', () => {
    // Covered inside loadTaxonomy(); this explicit test makes a drift read as
    // a named failure rather than a setup error.
    expect(taxonomy.version).toBe(TAXONOMY_VERSION);
    const digest = createHash('sha256').update(readFileSync(taxonomyPath(), 'utf8')).digest('hex');
    expect(digest).toBe(TAXONOMY_SHA256);
  });
});

describe('executor-kit classification completeness against the taxonomy', () => {
  it('maps every ExecutorKitErrorKind onto an existing taxonomy entry produced by executor-kit', () => {
    for (const [kind, code] of Object.entries(KIND_TO_TAXONOMY_CODE)) {
      const attrs = attrsForExecutorKit(code);
      expect(attrs.retryable, `${kind} -> ${code}.retryable`).toBe(attrs.retryable); // entry exists and is readable
      expect(typeof attrs.dead_letter, `${kind} -> ${code}.dead_letter`).toBe('boolean');
    }
    // The mirrored kind set must stay exhaustive: 9 kinds today.
    expect(Object.keys(KIND_TO_TAXONOMY_CODE)).toHaveLength(9);
  });

  it('can reach every kind through the real classifier (no dead taxonomy entries)', () => {
    const observed = new Set<ExecutorKitErrorKind>();
    for (const [kind, probe] of Object.entries(KIND_PROBES) as [ExecutorKitErrorKind, () => { kind: ExecutorKitErrorKind; retryable: boolean }][]) {
      const classified = probe();
      observed.add(classified.kind);
      expect(classified.kind, `probe for ${kind} must classify as ${kind}`).toBe(kind);
    }
    expect([...observed].sort()).toEqual(Object.keys(KIND_TO_TAXONOMY_CODE).sort());
  });

  it('covers every taxonomy entry that lists executor-kit as a producer', () => {
    const producedCodes = new Set(Object.values(KIND_TO_TAXONOMY_CODE));
    // Conditions without a dedicated kind in executor-kit: a reverted receipt
    // surfaces as SubmitSignalReceiptError and is classified through the
    // conservative fallback; a receipt-wait transport failure is classified
    // through its cause chain (e.g. rpc_network). Both are probed below.
    const fallbackCoveredCodes = new Set(['transaction_reverted', 'transaction_receipt_unknown']);
    const taxonomyExecutorKitCodes = taxonomy.errors
      .filter((entry) => entry.producers.includes('executor-kit'))
      .map((entry) => entry.code);
    for (const code of taxonomyExecutorKitCodes) {
      const covered = producedCodes.has(code) || fallbackCoveredCodes.has(code);
      expect(covered, `taxonomy entry "${code}" lists executor-kit but no kind maps to it`).toBe(true);
    }
  });

  it('classifies a reverted receipt through the non-retryable terminal lane (transaction_reverted)', () => {
    const attrs = attrsForExecutorKit('transaction_reverted');
    const classified = classifyExecutorKitError(
      new SubmitSignalReceiptError(TX_HASH, 'submitSignal transaction receipt status reverted'),
    );
    // No dedicated kind: the revert fact rides the conservative fallback.
    expect(classified.kind).toBe('unknown');
    expect(classified.retryable).toBe(attrs.retryable);
    // Lane derived from the classification must match the taxonomy dead_letter
    // attribute (jobStatusForError semantics: non-retryable, non-benign -> dead_letter).
    const lane = classified.retryable ? 'failed' : 'dead_letter';
    expect(lane).toBe(attrs.dead_letter ? 'dead_letter' : 'failed');
  });

  it('classifies a receipt-wait transport failure as retryable with the txHash kept (transaction_receipt_unknown)', () => {
    const attrs = attrsForExecutorKit('transaction_receipt_unknown');
    const classified = classifyExecutorKitError(new SubmitSignalReceiptError(
      TX_HASH,
      `submitSignal transaction receipt wait failed for ${TX_HASH}: Request timed out.`,
      { cause: new Error('Request timed out.') },
    ));
    expect(classified.kind).toBe('rpc_network');
    expect(classified.retryable).toBe(attrs.retryable);
    expect(attrs.dead_letter).toBe(false);
  });

  it('pins the state-machine job status lanes that consume the classification', () => {
    // jobStatusForError semantics (watcher.ts): benign kinds -> `ignored`,
    // retryable -> `failed`, non-retryable -> `dead_letter`. Pinned here via
    // the taxonomy lane attributes; the behavior itself is exercised by
    // watcher.test.ts. isRetriableStateMachineJobStatus accepts exactly
    // failed/matched/submitted — the retryable lane plus the two open lanes.
    const retriableJobStatuses = ['failed', 'matched', 'submitted'] as const;
    expect(retriableJobStatuses).toHaveLength(3);
    const benignCodes = taxonomy.errors
      .filter((entry) => entry.producers.includes('executor-kit'))
      .filter((entry) => attrsForExecutorKit(entry.code).benign_scan_outcome === true)
      .map((entry) => entry.code);
    expect(benignCodes.sort()).toEqual(['duplicate_signal', 'missing_handler']);
  });
});

describe('executor-kit classification consistency against the taxonomy', () => {
  const CASES: readonly {
    readonly code: string;
    readonly run: () => { readonly kind: ExecutorKitErrorKind; readonly retryable: boolean };
  }[] = [
    { code: 'insufficient_funds', run: () => classifyExecutorKitError(new Error('insufficient funds for gas * price + value')) },
    { code: 'duplicate_signal', run: () => classifyExecutorKitError(new Error('Call revert exception: execution reverted: SignalAlreadyExists()')) },
    { code: 'duplicate_signal', run: () => classifyExecutorKitError(new CodedExecutorKitError('DUPLICATE_SIGNAL', 'signal already exists')) },
    { code: 'nonce_conflict', run: () => classifyExecutorKitError(new Error('replacement transaction underpriced')) },
    { code: 'nonce_conflict', run: () => classifyExecutorKitError(new Error('already known')) },
    { code: 'rpc_network', run: () => classifyExecutorKitError(new CodedExecutorKitError('RPC_NETWORK', 'connect ECONNREFUSED 127.0.0.1:8545')) },
    { code: 'rpc_network', run: () => classifyExecutorKitError(new Error('HTTP request failed with status 429: Too Many Requests')) },
    { code: 'unauthorized', run: () => classifyExecutorKitError(new Error('AccessControlUnauthorizedAccount submitter')) },
    { code: 'missing_handler', run: () => classifyExecutorKitError(new Error('no state machine handler for exec#main'), 'missing_handler') },
    { code: 'malformed_payload', run: () => classifyExecutorKitError(new ValidationError('payloadHash must be a 32-byte hex value')) },
    { code: 'malformed_payload', run: () => classifyExecutorKitError(new Error('undecodable log data'), 'validation_failure') },
    { code: 'handler_failure', run: () => classifyExecutorKitError(new CodedExecutorKitError('HANDLER_FAILURE')) },
    { code: 'unknown_unclassified', run: () => classifyExecutorKitError(new Error('handler exploded in a way no pattern matches')) },
  ];

  for (const testCase of CASES) {
    it(`classifies like the taxonomy says for ${testCase.code}`, () => {
      const attrs = attrsForExecutorKit(testCase.code);
      const classified = testCase.run();
      expect(classified.retryable).toBe(attrs.retryable);
      // The observed kind must be one of the kinds mapped onto this taxonomy code.
      const kindsForCode = Object.entries(KIND_TO_TAXONOMY_CODE)
        .filter(([, entryCode]) => entryCode === testCase.code)
        .map(([kind]) => kind);
      expect(kindsForCode).toContain(classified.kind);
    });
  }

  it('matches the taxonomy retryable verdicts exactly (executor-kit overrides applied)', () => {
    const expectations: readonly [string, boolean][] = [
      ['insufficient_funds', true],
      ['nonce_conflict', true],
      ['rpc_network', true],
      ['duplicate_signal', false],
      ['unauthorized', false],
      ['missing_handler', false],
      ['malformed_payload', false],
      ['handler_failure', false],
      ['unknown_unclassified', false],
    ];
    for (const [code, retryable] of expectations) {
      expect(attrsForExecutorKit(code).retryable, code).toBe(retryable);
    }
    // The executor-kit override for nonce_conflict is the deliberate divergence
    // from the chain-services relayer (duplicate_transaction, non-retryable).
    expect(entryByCode('nonce_conflict').retryable).toBe(false);
    expect(attrsForExecutorKit('nonce_conflict').retryable).toBe(true);
  });
});

describe('executor-kit benign scan outcomes against the taxonomy', () => {
  it('exits success for exactly the taxonomy-benign kinds', () => {
    const benignKinds = ['missing_handler', 'duplicate_signal'];
    for (const kind of benignKinds) {
      expect(
        chainPollExecutionFailed({ results: [{ error: { kind } }] }),
        `${kind} is a benign scan outcome in the taxonomy and must not fail a scan`,
      ).toBe(false);
    }
    // Everything else that executor-kit produces must fail a scan.
    const benignCodes = taxonomy.errors
      .filter((entry) => entry.producers.includes('executor-kit'))
      .filter((entry) => attrsForExecutorKit(entry.code).benign_scan_outcome === true)
      .map((entry) => entry.code);
    expect(benignCodes.sort()).toEqual(['duplicate_signal', 'missing_handler']);
    for (const kind of ['rpc_network', 'insufficient_funds', 'unauthorized', 'unknown', 'validation_failure'] as const) {
      expect(
        chainPollExecutionFailed({ results: [{ error: { kind } }] }),
        `${kind} is not benign in the taxonomy and must fail the scan`,
      ).toBe(true);
    }
  });
});
