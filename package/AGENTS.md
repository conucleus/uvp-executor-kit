# AGENTS.md

## Module Purpose

`uvp-executor-kit/package/` owns the CLI and SDK used by executors, executors,
and adjudicators to receive chain work and submit state-machine responses.

This is the main integration surface for real-world participants.

## Responsibilities

### Chain-native executor surface

- Watch `UVPStateMachine.HookReady` events across active and deprecated
  state-machine deployments.
- Build and submit direct `UVPStateMachine.submitSignal` transactions from an
  authorized wallet.
- Include the emitting state-machine address in watcher job identity and send
  callback transactions back to the state machine that emitted `HookReady`.
- Support local HTTP/webhook adapters for business systems.
- Provide local watcher job storage, retry, dead-letter, and DTO helpers for
  supplier operations.

### Product API signal-producer surface (PRD105 P0)

- Operate standard signal containers through the Product API prepare/sign/submit/proof
  boundary: list tasks, get task, hash evidence, prepare signal container, sign with
  explicit key source, submit signature, read proof/status.
- Treat funding/guarantee placeholder tasks as the same signal-container flow as
  normal tasks (same commands, same proof output).
- SDK exports (`product.ts`) are the canonical non-browser signal-producer surface
  for enterprise scripts, supervised AI agents, and future MCP tools.
- Normal output strips protocol internals (sourceId, signalId, typed data,
  signature, recoveredSubmitter). `--verbose` exposes raw API payloads for debugging
  only.

### MCP adapter boundary (PRD105 P0)

- `mcp.ts` is a thin adapter over `product.ts` SDK calls — not a separate Product
  API implementation.
- Exposes `uvp_list_tasks`, `uvp_get_task`, `uvp_prepare_signal`,
  `uvp_hash_evidence`, `uvp_submit_signal`, `uvp_get_proof`.
- MCP tools are another signal-producer surface, not a privileged backend.
- Normal adapter results return product summaries (no typedData, signatures, or
  low-level identifiers). Pass `includeRaw: true` only for explicit wallet-signing
  handoff or protocol debugging.

## Non-Responsibilities

- Do not custody participant private keys by default.
- Do not decide checker policy.
- Do not bypass contract authorization.
- Do not create state-machine signal authorization; the contract and order
  registration decide it.
- Do not ship legacy escrow payload builders, placeholder notifier watchers, or
  escrow replay commands.
- Do not depend on the existing Go cloud UVP executor code.
- Do not make the MCP adapter a second Product API client implementation with
  divergent logic.

## CLI Rules

- Chain submission commands must display state-machine address, chain id, sender
  address, args, and dry-run status before broadcasting.
- Commands must fail on wrong chain id, missing state-machine address, missing
  wallet identity, malformed bytes32 values, unknown handlers, and unauthorized
  or duplicate signal errors.
- Logs must not print private keys, seed phrases, or raw secrets.

## Testing Expectations

- Chain watcher tests against fixed ABI fixtures.
- CLI tests for wallet, config validation, jobs, and dry-run callback
  submission.
- Webhook/runtime adapter tests.
- Wrong chain id, missing handler, duplicate signal, retry, and dead-letter
  tests.
