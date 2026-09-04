# executor-kit

CLI and SDK for executors that produce standard signal containers for
`UVPStateMachine` coordination.

Public status: alpha SDK/CLI. It is the non-browser signal-producer surface for
local and testnet workflows; package metadata and dist-based publishing still
need cleanup before an npm release.

Two co-equal signal-producer surfaces:

- **Chain-native**: watch `UVPStateMachine.HookReady` events, route ready hooks to
  configured handlers, and submit authorized `submitSignal` callback transactions
  from a participant wallet.
- **Product API (PRD105 P0)**: the non-browser signal-producer gate for enterprise
  scripts, supervised AI agents, and future MCP clients. All producers dock at the
  same Product API prepare/sign/submit/proof boundary.

Executor-kit keeps using the same signal-container producer vocabulary as Order
App: list tasks, prepare typed data, sign with an explicit participant key,
submit, and fetch proof. It consumes executor, docked Zhixu, and resource-access
surfaces from Product DTO/Product API.

## Local Commands

```bash
pnpm install
pnpm --filter @uvp-eth/executor-kit test
pnpm --filter @uvp-eth/executor-kit typecheck
pnpm --filter @uvp-eth/executor-kit build
```

## CLI

Create or inspect a local wallet env file:

```bash
uvp-executor wallet new --env-file .env.local
uvp-executor wallet address --private-key-env UVP_ETH_DEPLOYER_PRIVATE_KEY
```

Validate a state-machine executor config:

```bash
uvp-executor config validate \
  --config uvp-executor-kit/package/fixtures/state-machine-executor.config.json
```

Scan once for `HookReady` logs and dry-run callback transactions:

```bash
uvp-executor chain-once \
  --rpc-url http://127.0.0.1:8545 \
  --state-machine 0x0000000000000000000000000000000000000001 \
  --chain-id 31337 \
  --config uvp-executor-kit/package/fixtures/state-machine-executor.config.json \
  --wallet-address 0x0000000000000000000000000000000000000002 \
  --dry-run
```

Run the continuous watcher:

```bash
uvp-executor chain-watch \
  --rpc-url http://127.0.0.1:8545 \
  --state-machine 0x0000000000000000000000000000000000000001 \
  --chain-id 31337 \
  --config uvp-executor-kit/package/fixtures/state-machine-executor.config.json \
  --dry-run
```

By default the chain commands persist watcher state to files so a restart
resumes where the previous process stopped instead of rescanning from
`--from-block`: jobs land in `<state-dir>/jobs.json` and the scan cursor (the
next block to scan) in `<state-dir>/cursor.json`. The state directory defaults
to `./uvp-watcher-state`, overridden by `--state-dir` or the
`UVP_WATCHER_STATE_DIR` env var; `--jobs-file <path>` places the jobs file
exactly at that path with the cursor beside it. The startup log reports the
resolved storage mode and paths. Pass `--job-store memory` to keep jobs and the
cursor in process memory (the pre-ETH-07 behavior); a persisted cursor whose
chain id or state-machine set no longer matches the configuration is ignored
and rewritten on the next successful round.

Build or submit one state-machine signal:

```bash
uvp-executor chain-signal \
  --rpc-url http://127.0.0.1:8545 \
  --state-machine 0x0000000000000000000000000000000000000001 \
  --chain-id 31337 \
  --plan-id 0x2222222222222222222222222222222222222222222222222222222222222222 \
  --order-id 0x1111111111111111111111111111111111111111111111111111111111111111 \
  --source logistics-provider-a \
  --stage export.customs \
  --signal-name cmp \
  --payload-hash 0x3333333333333333333333333333333333333333333333333333333333333333 \
  --wallet-address 0x0000000000000000000000000000000000000002 \
  --dry-run
```

In the three chain examples above, `--dry-run` is an explicit test aid: the
flag only builds and prints what would be sent without broadcasting. The
behavior of the commands is unchanged — without the flag they perform the real
action, and real execution is always the default.

Use Product API task mode for participant-facing signal containers:

```bash
uvp-executor product tasks \
  --chain-services-url http://127.0.0.1:8787 \
  --wallet-address 0x0000000000000000000000000000000000000002 \
  --auth-token-env UVP_PRODUCT_API_AUTH_TOKEN

uvp-executor product task get task_123 \
  --chain-services-url http://127.0.0.1:8787 \
  --wallet-address 0x0000000000000000000000000000000000000002 \
  --auth-token-env UVP_PRODUCT_API_AUTH_TOKEN

uvp-executor product evidence hash ./evidence/customs.json

uvp-executor product prepare task_123 \
  --chain-services-url http://127.0.0.1:8787 \
  --wallet-address 0x0000000000000000000000000000000000000002 \
  --evidence-id ev_123 \
  --intent confirm_stage \
  --prepared-file .uvp-prepared-submit.json \
  --auth-token-env UVP_PRODUCT_API_AUTH_TOKEN

UVP_PARTICIPANT_PRIVATE_KEY=0x... uvp-executor product submit task_123 \
  --chain-services-url http://127.0.0.1:8787 \
  --prepared-file .uvp-prepared-submit.json \
  --private-key-env UVP_PARTICIPANT_PRIVATE_KEY \
  --auth-token-env UVP_PRODUCT_API_AUTH_TOKEN

uvp-executor product proof sub_123 \
  --chain-services-url http://127.0.0.1:8787 \
  --auth-token-env UVP_PRODUCT_API_AUTH_TOKEN

uvp-executor product status sub_123 \
  --chain-services-url http://127.0.0.1:8787 \
  --auth-token-env UVP_PRODUCT_API_AUTH_TOKEN
```

Product commands print JSON summaries for automation. Normal stdout omits
low-level source/signal identifiers; pass `--verbose` when debugging typed data
or the raw Product API payload. `product submit` loads wallet material only from
the explicit `--private-key-env` name and verifies the prepared
`typedData.message.submitter` matches the configured signer before signing.
For authenticated Product APIs, pass `--auth-token-env <ENV_NAME>`; the CLI reads
the bearer token only from that named env var and normal output reports only
redacted auth status where applicable.
Every task, prepare, submit, and proof result (and every `ProductApiError`)
carries the server's `x-request-id` response header as `requestId` when present,
so executor-side calls, errors, and logs can be correlated end to end with
chain-services request logs.
Funding and guarantee placeholder tasks use the same commands; the task summary
keeps capability-plugin metadata, required inputs, settlement placeholder copy, proof
rows, and funding impact language without treating UVP as a custodian,
settlement rail, payment provider, exchange, or guarantor.

Run a non-spending diagnostic before pulling out a private key:

```bash
# Check API reachability only
uvp-executor doctor --chain-services-url http://127.0.0.1:8787

# Check API + proof endpoint shape
uvp-executor doctor \
  --chain-services-url http://127.0.0.1:8787 \
  --submission-id sub_123

# Check API + task visibility for my wallet
uvp-executor doctor \
  --chain-services-url http://127.0.0.1:8787 \
  --wallet-address 0x0000000000000000000000000000000000000002

# Per-task readiness: "Am I authorized? What do I need? What's blocking me?"
uvp-executor doctor \
  --chain-services-url http://127.0.0.1:8787 \
  --wallet-address 0x0000000000000000000000000000000000000002 \
  --task-id task_123 \
  --auth-token-env UVP_PRODUCT_API_AUTH_TOKEN
```

The doctor command needs no private key. It reports reachability, task visibility,
proof-endpoint shape, and per-task readiness (assignee match, canSubmit,
blockedReason, deadline status, required evidence, and a concrete
`nextAction` label: `prepare`, `wait`, `proof`, or `blocked`). Normal output
omits protocol fields and bearer token values; pass `--verbose` for raw API
payloads.

The MCP adapter exposes the same checks via `uvp_doctor`:

```ts
import { createProductMcpAdapter } from '@uvp-eth/executor-kit/mcp';
const uvp = createProductMcpAdapter({ chainServicesUrl: 'http://127.0.0.1:8787' });
const report = await uvp.uvp_doctor({
  walletAddress: '0x...',
  taskId: 'task_123',
});
console.log(report.taskReadiness?.nextActionLabel);
// "Ready to prepare. Run product prepare to build the signal container."
```

Enterprise scripts can use the same SDK helpers without shelling out:

```ts
import {
  listSignalContainers,
  prepareSignalContainer,
  signPreparedSignalContainer,
  submitPreparedSignalContainer,
} from '@uvp-eth/executor-kit';

const chainServicesUrl = 'http://127.0.0.1:8787';
const walletAddress = '0x0000000000000000000000000000000000000002';
const [task] = await listSignalContainers({ chainServicesUrl, walletAddress });
const prepared = await prepareSignalContainer({
  chainServicesUrl,
  taskId: task.taskId,
  walletAddress,
  evidenceIds: ['ev_123'],
  intent: 'confirm_stage',
});
const signed = await signPreparedSignalContainer({
  prepared,
  privateKeyEnv: 'UVP_PARTICIPANT_PRIVATE_KEY',
  walletAddress,
});
await submitPreparedSignalContainer({
  chainServicesUrl,
  taskId: prepared.taskId,
  prepareId: prepared.prepareId,
  signature: signed.signature,
  walletAddress: signed.walletAddress,
});
```

## MCP Gate

The MCP adapter (`@uvp-eth/executor-kit/mcp`) is a thin wrapper over the Product
API SDK calls. It does not introduce a separate Product API client implementation
or divergent logic.

MCP tools are another supervised signal-producer surface — not a privileged
backend. An AI agent, MCP tool, enterprise system, or script all dock at the same
Product API boundary as the browser Order App. The authorized participant wallet
still produces the business signature; the MCP layer may assist, route, or
automate but must not replace the participant signature.

```ts
import { createProductMcpAdapter } from '@uvp-eth/executor-kit/mcp';

const uvp = createProductMcpAdapter({ chainServicesUrl: 'http://127.0.0.1:8787' });
await uvp.uvp_list_tasks({ walletAddress });
await uvp.uvp_get_task({ taskId: 'task_123' });
await uvp.uvp_hash_evidence({ path: './evidence/customs.json' });
const preparedResult = await uvp.uvp_prepare_signal({
  taskId: 'task_123',
  walletAddress,
  evidenceIds: ['ev_123'],
  intent: 'confirm_stage',
  includeRaw: true,
});
if (!preparedResult.rawPrepared) {
  throw new Error('raw prepared response required for signing');
}
await uvp.uvp_submit_signal({
  prepared: preparedResult.rawPrepared,
  privateKeyEnv: 'UVP_PARTICIPANT_PRIVATE_KEY',
  walletAddress,
});
await uvp.uvp_get_proof({ submissionId: 'sub_123' });
```

Normal adapter results return product summaries and omit typed data, raw
signatures, and source/signal identifiers. Pass `includeRaw: true` only for an
explicit wallet-signing handoff or protocol debugging.

Query and operate local watcher jobs:

```bash
uvp-executor jobs list --jobs-file .uvp-executor-jobs.json
uvp-executor jobs get <jobId> --jobs-file .uvp-executor-jobs.json
uvp-executor jobs retry <jobId> \
  --jobs-file .uvp-executor-jobs.json \
  --rpc-url http://127.0.0.1:8545 \
  --state-machine 0x0000000000000000000000000000000000000001 \
  --chain-id 31337 \
  --config uvp-executor-kit/package/fixtures/state-machine-executor.config.json \
  --operator ops@example.com \
  --dry-run
uvp-executor jobs dead-letter <jobId> \
  --jobs-file .uvp-executor-jobs.json \
  --operator ops@example.com \
  --reason "manual review required"
```

Watcher job semantics:

- Callback transactions wait for the receipt by default (`waitForReceipt`
  defaults to `true`). A job whose transaction was broadcast but not yet
  receipted stays in the non-terminal `submitted` state, so later scans or
  manual retries can observe the real on-chain outcome instead of trusting
  the broadcast. When the receipt step itself fails after a successful
  broadcast (reverted receipt, or waiting for the receipt throws), the error
  carries the broadcast `txHash` and the job's `submissions` record keeps it,
  so "already broadcast" transactions are never dropped from the audit trail.
- Failures are classified from explicit machine-readable error codes first,
  then from well-known real-world error texts and contract revert data
  (for example `SignalAlreadyExists()`, `AccessControlUnauthorizedAccount`,
  `insufficient funds`, nonce conflicts, timeouts, `ECONNRESET`, and HTTP
  429). Transient (retryable) failures retry inside the run and land in
  `failed` when exhausted, which `jobs retry` still accepts; deterministic
  non-retryable failures and unrecognized errors dead-letter for human
  triage via `jobs dead-letter`. A duplicate-signal fact (`SignalAlreadyExists`,
  e.g. on restart replay of an already-committed signal) is not a failure:
  the job is ignored.
- HookReady-topic logs that fail to decode (e.g. from a mixed-version
  deployment) never crash the watcher: the scan skips them, records an
  `ignored` job with the raw log preserved, counts them in poll results and
  `describe()`, and reports them through `onError`. The cursor advances so
  the same log is not rescanned forever.
- Process exit codes are honest: when a scan result carries an error, or any
  job ends in `failed`/`dead_letter`, the process exits with status 1 even
  though result objects were produced without throwing.
- Runtime-host callback delivery has built-in retries: up to 3 attempts with
  exponential backoff from the configured base delay. Multi-signal callback
  runs record per-signal delivery results, so partial success stays visible
  instead of being collapsed into a single outcome.

## SDK Surface

- `createStateMachineWatcher`: watches `HookReady` logs, resolves handlers, and
  submits callback signals.
- `submitStateMachineSignal`: builds and optionally broadcasts
  `UVPStateMachine.submitSignal` transactions.
- `buildSubmitStateMachineSignalCall`: returns deterministic dry-run call data.
- `decodeHookReadyLog` and `hookReadyEventId`: normalize state-machine logs.
- `InMemoryStateMachineJobStore` and `FileStateMachineJobStore`: record watcher
  job state for retries, dead-lettering, and Product/Ops projection.
- `FileStateMachineCursorStore`: persists the watcher scan cursor (pass it as
  `cursorStore` to `createStateMachineWatcher`) so a restarted watcher resumes
  instead of rescanning from `fromBlock`; without it the cursor stays in memory.
- `stateMachineHandlerConfigToExecutorConfigDTO`,
  `stateMachineJobToExecutorJobDTO`, and `summarizeSupplierOps`: product-facing
  DTO helpers.
- `hashEvidenceFile`: hashes off-chain evidence without storing plaintext.
- `listSignalContainers`, `getSignalContainer`, `prepareSignalContainer`,
  `signPreparedSignalContainer`, `submitPreparedSignalContainer`, and
  `getSignalContainerProof`: thin Product API task helpers for future MCP
  adapters.
- `createProductMcpAdapter`: exposes `uvp_list_tasks`, `uvp_get_task`,
  `uvp_prepare_signal`, `uvp_hash_evidence`, `uvp_submit_signal`, and
  `uvp_get_proof` as a thin Product API SDK adapter.
- `loadPrivateKeyFromEnv`: loads a wallet key from an explicit env var without
  logging it.

## Product API Dock Boundary

Participant add-on manifests are Store metadata. The kit does not expose an
`AddOnClient` or any business-specific add-on SDK; app and integration surfaces
should dock into the same low-level Product API boundaries:

- Signal submit: `POST /product/tasks/:taskId/prepare-submit`, wallet signs the
  returned EIP-712 typed data, then `POST /product/tasks/:taskId/submit`.
- Executor patch: `POST /product/tasks/:taskId/prepare-stage-executor-patch`,
  wallet signs the returned patch typed data, then
  `POST /product/tasks/:taskId/submit-stage-executor-patch`.
- Resource patch: `POST /product/tasks/:taskId/prepare-stage-resource-patch`,
  wallet signs the returned patch typed data, then
  `POST /product/tasks/:taskId/submit-stage-resource-patch`.

The manifest action is only a declarative mapping from page inputs to one of
these protocol API calls. Permission still comes from Product API projection,
order-level authorization, participant wallet signatures, and contract checks.

## ABI Boundary

`createStateMachineWatcher` uses the fixed `UVPStateMachine v0.9` compact-hook
ABI recorded in
`uvp-protocol/contracts/uvp-contracts/fixtures/uvp-state-machine.v0.9.json`:

- `HookReady(bytes32 planId, bytes32 orderId, bytes32 hookId, bytes32 stageId, bytes32 hookName)`;
- `submitSignal(bytes32 planId, bytes32 orderId, bytes32 sourceId, bytes32 signalId, bytes32 payloadHash, bytes32 idempotencyKey)`.

`planId` is part of the event and submit boundary. It must be retained with the
watcher job and never inferred from a bare `orderId`; the same state machine can
contain the same order id under different plans.

There is no payload-reference input in this ABI, and the contract is frozen:
`chain-signal --payload-ref` is rejected up front instead of silently dropping
the reference. Only the 32-byte `payloadHash` goes on chain; record any
off-chain payload reference in your own job/evidence store (the runtime
callback envelope's `payloadRef` field is the off-chain channel for it).

The contract also exposes `submitSignalFor(...)` and
EIP-712 typed-data builders for gas-relay adapters. This package does not
build a separate signed payload model; relayed business signatures must
stay aligned with the contract's current EIP-712 digest.

### Zero `payloadHash` Semantics

In `submitSignal(bytes32 ..., bytes32 payloadHash, bytes32 ...)`, the value
`bytes32(0)` (`0x0000000000000000000000000000000000000000000000000000000000000000`)
is the **protocol-defined encoding of "no payload"**. It is a legitimate
constant of the `UVPStateMachine` protocol — not a runtime fallback or default.

Consequently, when a handler/config signal definition omits `payloadHash`, the
kit encodes exactly `bytes32(0)`: this is the producer's explicit declaration
that the signal carries no off-chain payload, and it is indistinguishable on
chain from a producer passing the zero hash by hand. Any non-empty payload must
be declared with its full 32-byte hash.


## Boundaries

- The kit does not create order-level authorization. Orders must already bind
  submitter wallets to source/signal permissions on `UVPStateMachine`.
- The kit does not custody private keys. CLI commands read only explicit env
  vars and never print secrets.
- The kit does not run escrow, release, refund, exchange, or payment-provider
  flows.
- Runtime-host callback envelopes are a local reference harness. Chain events
  remain the source of truth for the EVM track.
