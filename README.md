# uvp-executor-kit

Executor tooling boundary.

This domain owns CLI and SDK code used by external executors to watch chain events,
prepare callbacks, validate configuration, and submit authorized state-machine
signals.

- `package/`: current executor-kit workspace package.

## Development Topology

This repository is mounted by `uvp-eth` as a Git submodule. The package depends
on `@uvp-eth/protocol-bindings`, which is owned by `uvp-protocol`.

Use the `uvp-eth` umbrella checkout for local integration development so pnpm can
resolve that cross-repository `workspace:*` dependency. A standalone checkout
requires `@uvp-eth/protocol-bindings` to be published or linked into an
equivalent local workspace.

Relayers and executors may submit transactions, but business actions must remain
signed by authorized participant keys.

Executor-kit is the non-browser signal-container producer boundary. It consumes
Product DTO/Product API actions and produces signed executor signals through
the same prepare/sign/submit/proof flow as the browser Order App.
