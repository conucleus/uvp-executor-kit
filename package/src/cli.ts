#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import type { PreparedSignalContainer, ProductSubmitIntent } from './product.js';
import {
  getSignalContainer,
  getSignalContainerProof,
  hashContainerEvidence,
  listSignalContainers,
  parsePreparedSignalContainer,
  prepareSignalContainer,
  productApiAuthHeadersFromEnv,
  signPreparedSignalContainer,
  submitPreparedSignalContainer,
  summarizePreparedSignalContainer,
  summarizeSignalContainer,
  summarizeSubmittedSignalContainer,
  type ProductApiAuthStatus,
  type ProductApiClientOptions,
} from './product.js';
import { runProductDoctor } from './doctor.js';
import { stringifyForTransport } from './transport.js';
import {
  createHandlersFromExecutorConfig,
  DEFAULT_CALLBACK_TOKEN_ENV,
  DEFAULT_EXECUTOR_TOKEN_ENV,
  loadExecutorConfig,
  startExecutorServer,
} from './server.js';
import {
  ExecutorKitError,
  normalizeAddress,
  normalizeBytes32,
  parsePositiveInteger,
  ValidationError,
} from './validation.js';
import {
  DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV,
  FileStateMachineJobStore,
  createStateMachineHandlersFromConfig,
  createStateMachineWatcher,
  deadLetterStateMachineJob,
  loadStateMachineHandlerConfig,
  retryStateMachineJob,
  stateMachineHandlerConfigToExecutorConfigDTO,
  stateMachineJobToExecutorJobDTO,
  summarizeSupplierOps,
  submitStateMachineSignal,
} from './watcher.js';
import {
  addressFromPrivateKey,
  DEFAULT_WALLET_ADDRESS_ENV,
  DEFAULT_WALLET_PRIVATE_KEY_ENV,
  getFaucetInfo,
  writeWalletEnvFile,
} from './wallet.js';

interface ChainWatchOptions {
  rpcUrl: string;
  stateMachine?: string;
  chainId: string;
  config: string;
  walletAddress?: string;
  privateKeyEnv: string;
  fromBlock?: string;
  pollIntervalMs?: string;
  jobsFile?: string;
  dryRun?: boolean;
  waitForReceipt?: boolean;
}

interface ChainSignalOptions {
  rpcUrl: string;
  stateMachine: string;
  chainId: string;
  privateKeyEnv: string;
  walletAddress?: string;
  orderId: string;
  planId: string;
  source: string;
  stage: string;
  signalName: string;
  payloadHash?: string;
  payloadRef?: string;
  readyEventId?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
  waitForReceipt?: boolean;
}

interface WalletNewOptions {
  envFile: string;
  overwrite?: boolean;
  privateKeyEnv: string;
  addressEnv: string;
}

interface WalletAddressOptions {
  privateKeyEnv: string;
}

interface FaucetInfoOptions {
  network: string;
  address?: string;
}

interface ProductClientCliOptions {
  chainServicesUrl: string;
  principalId?: string;
  authTokenEnv?: string;
  verbose?: boolean;
}

interface ProductClientRuntimeOptions extends ProductApiClientOptions {
  readonly auth?: ProductApiAuthStatus;
}

interface ProductTasksOptions extends ProductClientCliOptions {
  walletAddress: string;
  orderId?: string;
  status?: string;
}

interface ProductTaskGetOptions extends ProductClientCliOptions {
  walletAddress?: string;
}

interface ProductPrepareOptions extends ProductClientCliOptions {
  walletAddress: string;
  evidenceId: string[];
  intent: ProductSubmitIntent;
  preparedFile?: string;
}

interface ProductSubmitOptions extends ProductClientCliOptions {
  prepareId?: string;
  preparedFile: string;
  privateKeyEnv: string;
  walletAddress?: string;
}

type ProductProofOptions = ProductClientCliOptions;

interface ServeOptions {
  config: string;
  host: string;
  port: string;
  executorToken?: string;
  executorTokenEnv: string;
  callbackToken?: string;
  callbackTokenEnv: string;
  readyJson?: boolean;
}

interface ConfigValidateOptions {
  config: string;
  kind: string;
}

interface DoctorOptions {
  chainServicesUrl: string;
  walletAddress?: string;
  taskId?: string;
  submissionId?: string;
  principalId?: string;
  authTokenEnv?: string;
  verbose?: boolean;
}

interface JobsFileOptions {
  jobsFile: string;
}

interface JobsListOptions extends JobsFileOptions {
  status?: string;
  supplierId?: string;
}

interface JobsRetryOptions extends ChainWatchOptions {
  operator: string;
  reason?: string;
}

interface JobsDeadLetterOptions extends JobsFileOptions {
  operator: string;
  reason: string;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('uvp-executor')
    .description('UVP EVM checker, executor, and adjudicator CLI')
    .version('0.1.0');

  const wallet = program.command('wallet').description('manage local executor/deployer wallet material');
  wallet
    .command('new')
    .description('create a new wallet and write it to a gitignored env file')
    .option('--env-file <path>', 'env file to write', '.env.local')
    .option('--overwrite', 'replace an existing env file')
    .option('--private-key-env <name>', 'private key env var name', DEFAULT_WALLET_PRIVATE_KEY_ENV)
    .option('--address-env <name>', 'address env var name', DEFAULT_WALLET_ADDRESS_ENV)
    .action(async (options: WalletNewOptions) => {
      const result = await writeWalletEnvFile(options.envFile, {
        privateKeyEnv: options.privateKeyEnv,
        addressEnv: options.addressEnv,
        ...(options.overwrite ? { overwrite: true } : {}),
      });
      console.log(stringifyForTransport({
        wallet: {
          address: result.address,
          envFile: result.envFile,
          privateKeyEnv: result.privateKeyEnv,
          addressEnv: result.addressEnv,
          overwritten: result.overwritten,
        },
      }));
    });

  wallet
    .command('address')
    .description('derive the wallet address from a private key env var')
    .option('--private-key-env <name>', 'private key env var name', DEFAULT_WALLET_PRIVATE_KEY_ENV)
    .action((options: WalletAddressOptions) => {
      const privateKey = process.env[options.privateKeyEnv];
      if (!privateKey) {
        throw new ValidationError(`missing private key env var ${options.privateKeyEnv}`);
      }
      console.log(stringifyForTransport({
        wallet: {
          address: addressFromPrivateKey(privateKey, options.privateKeyEnv),
          privateKeyEnv: options.privateKeyEnv,
        },
      }));
    });

  const faucet = program.command('faucet').description('show testnet faucet guidance');
  faucet
    .command('info')
    .description('print faucet links for a supported testnet')
    .option('--network <name>', 'testnet name', 'base-sepolia')
    .option('--address <address>', 'optional address to fund')
    .action((options: FaucetInfoOptions) => {
      console.log(stringifyForTransport({ faucet: getFaucetInfo(options.network, options.address) }));
    });

  const product = program.command('product').description('operate Product API signal containers');
  product
    .command('tasks')
    .description('list Product API tasks assigned to a wallet')
    .requiredOption('--chain-services-url <url>', 'chain-services Product API base URL')
    .requiredOption('--wallet-address <address>', 'participant wallet address used as the Product API assignee')
    .option('--order-id <id>', 'filter by Product order id')
    .option('--status <status>', 'filter by Product task status')
    .option('--principal-id <id>', 'optional Product API principal id header')
    .option('--auth-token-env <ENV_NAME>', 'env var containing Product API bearer token')
    .option('--verbose', 'include the raw Product API task payload')
    .action(async (options: ProductTasksOptions) => {
      const tasks = await listSignalContainers({
        ...productClientOptions(options),
        walletAddress: options.walletAddress,
        ...(options.orderId ? { orderId: options.orderId } : {}),
        ...(options.status ? { status: options.status } : {}),
      });
      console.log(stringifyForTransport({
        tasks: options.verbose ? tasks : tasks.map((task) => summarizeSignalContainer(task)),
      }));
    });

  const productTask = product.command('task').description('inspect one Product API task');
  productTask
    .command('get <taskId>')
    .description('get one Product API task')
    .requiredOption('--chain-services-url <url>', 'chain-services Product API base URL')
    .option('--wallet-address <address>', 'participant wallet address for local validation')
    .option('--principal-id <id>', 'optional Product API principal id header')
    .option('--auth-token-env <ENV_NAME>', 'env var containing Product API bearer token')
    .option('--verbose', 'include the raw Product API task payload')
    .action(async (taskId: string, options: ProductTaskGetOptions) => {
      const task = await getSignalContainer({
        ...productClientOptions(options),
        taskId,
        ...(options.walletAddress ? { walletAddress: options.walletAddress } : {}),
      });
      console.log(stringifyForTransport({ task: options.verbose ? task : summarizeSignalContainer(task) }));
    });

  const productEvidence = product.command('evidence').description('operate Product API evidence helpers');
  productEvidence
    .command('hash <path>')
    .description('hash an off-chain evidence file without uploading plaintext')
    .action(async (path: string) => {
      console.log(stringifyForTransport({ evidence: await hashContainerEvidence({ path }) }));
    });

  product
    .command('prepare <taskId>')
    .description('prepare a Product API task submission')
    .requiredOption('--chain-services-url <url>', 'chain-services Product API base URL')
    .requiredOption('--wallet-address <address>', 'participant wallet address')
    .requiredOption('--intent <intent>', 'submit intent: confirm_stage, reject_stage, raise_dispute, or resolve_dispute')
    .option('--evidence-id <id>', 'evidence id to include; repeat for multiple evidence records', collectRepeatedOption, [])
    .option('--prepared-file <path>', 'write the full prepared Product API response for later local signing')
    .option('--principal-id <id>', 'optional Product API principal id header')
    .option('--auth-token-env <ENV_NAME>', 'env var containing Product API bearer token')
    .option('--verbose', 'include typed data and chain identifiers in stdout')
    .action(async (taskId: string, options: ProductPrepareOptions) => {
      const prepared = await prepareSignalContainer({
        ...productClientOptions(options),
        taskId,
        walletAddress: options.walletAddress,
        evidenceIds: options.evidenceId,
        intent: options.intent,
      });
      if (options.preparedFile) {
        await writePreparedSignalContainerFile(options.preparedFile, prepared);
      }
      console.log(stringifyForTransport({
        prepared: options.verbose ? prepared : summarizePreparedSignalContainer(prepared),
        ...(options.preparedFile ? { preparedFile: options.preparedFile } : {}),
      }));
    });

  product
    .command('submit <taskId>')
    .description('sign a prepared Product API task submission and submit it')
    .requiredOption('--chain-services-url <url>', 'chain-services Product API base URL')
    .requiredOption('--prepared-file <path>', 'prepared Product API response written by product prepare --prepared-file')
    .requiredOption('--private-key-env <name>', 'explicit env var containing the participant private key')
    .option('--prepare-id <id>', 'expected prepare id; defaults to the prepared file prepareId')
    .option('--wallet-address <address>', 'expected signer wallet; defaults to the private key address')
    .option('--principal-id <id>', 'optional Product API principal id header')
    .option('--auth-token-env <ENV_NAME>', 'env var containing Product API bearer token')
    .option('--verbose', 'include the raw Product API submission payload')
    .action(async (taskId: string, options: ProductSubmitOptions) => {
      const prepared = await readPreparedSignalContainerFile(options.preparedFile);
      const prepareId = options.prepareId ?? prepared.prepareId;
      if (prepareId !== prepared.prepareId) {
        throw new ValidationError('prepareId does not match prepared file');
      }
      if (taskId !== prepared.taskId) {
        throw new ValidationError('taskId does not match prepared file');
      }
      const signed = await signPreparedSignalContainer({
        prepared,
        privateKeyEnv: options.privateKeyEnv,
        ...(options.walletAddress ? { walletAddress: options.walletAddress } : {}),
      });
      const submission = await submitPreparedSignalContainer({
        ...productClientOptions(options),
        taskId,
        prepareId,
        signature: signed.signature,
        walletAddress: signed.walletAddress,
      });
      console.log(stringifyForTransport({
        submission: options.verbose ? submission : summarizeSubmittedSignalContainer(submission),
      }));
    });

  product
    .command('proof <submissionId>')
    .description('query Product API submission proof/status')
    .requiredOption('--chain-services-url <url>', 'chain-services Product API base URL')
    .option('--principal-id <id>', 'optional Product API principal id header')
    .option('--auth-token-env <ENV_NAME>', 'env var containing Product API bearer token')
    .option('--verbose', 'include the raw Product API submission payload')
    .action(async (submissionId: string, options: ProductProofOptions) => {
      await printProductSubmissionProof(submissionId, options);
    });

  product
    .command('status <submissionId>')
    .description('query Product API submission status/proof')
    .requiredOption('--chain-services-url <url>', 'chain-services Product API base URL')
    .option('--principal-id <id>', 'optional Product API principal id header')
    .option('--auth-token-env <ENV_NAME>', 'env var containing Product API bearer token')
    .option('--verbose', 'include the raw Product API submission payload')
    .action(async (submissionId: string, options: ProductProofOptions) => {
      await printProductSubmissionProof(submissionId, options);
    });

  program
    .command('serve')
    .description('start a local executor HTTP server')
    .requiredOption('--config <path>', 'executor config JSON path')
    .option('--host <host>', 'host to bind', '127.0.0.1')
    .option('--port <port>', 'port to bind', '0')
    .option('--executor-token <token>', 'bearer token for executor dispatch API')
    .option('--executor-token-env <name>', 'env var containing executor dispatch bearer token', DEFAULT_EXECUTOR_TOKEN_ENV)
    .option('--callback-token <token>', 'bearer token for executor callback endpoint')
    .option('--callback-token-env <name>', 'env var containing executor callback bearer token', DEFAULT_CALLBACK_TOKEN_ENV)
    .option('--ready-json', 'print a ready JSON line after the server starts')
    .action(async (options: ServeOptions) => {
      const config = await loadExecutorConfig(options.config);
      const handle = await startExecutorServer({
        executorId: config.executorId,
        handlers: createHandlersFromExecutorConfig(config),
        executorToken: readSecret(options.executorToken, options.executorTokenEnv, 'executor token'),
        callbackToken: readSecret(options.callbackToken, options.callbackTokenEnv, 'callback token'),
        host: options.host,
        port: parsePort(options.port),
      });
      if (options.readyJson) {
        console.log(stringifyForTransport({
          ready: {
            service: 'executor-kit',
            executorId: config.executorId,
            url: handle.url,
          },
        }));
      }
      await waitForShutdown(() => handle.close());
    });

  const config = program.command('config').description('validate executor-kit config files');
  config
    .command('validate')
    .description('validate a state-machine or HTTP executor config JSON file')
    .requiredOption('--config <path>', 'executor config JSON path')
    .option('--kind <auto|state-machine|http>', 'config kind', 'auto')
    .action(async (options: ConfigValidateOptions) => {
      const result = await validateConfigFromCli(options);
      console.log(stringifyForTransport({ config: result }));
    });

  program
    .command('doctor')
    .description('non-spending Product API diagnostic for signal producers')
    .requiredOption('--chain-services-url <url>', 'chain-services Product API base URL')
    .option('--wallet-address <address>', 'participant wallet address for task-visibility and readiness checks')
    .option('--task-id <id>', 'specific task id for per-task readiness analysis (requires --wallet-address)')
    .option('--submission-id <id>', 'submission id for proof-endpoint shape check')
    .option('--principal-id <id>', 'optional Product API principal id header')
    .option('--auth-token-env <ENV_NAME>', 'env var containing Product API bearer token')
    .option('--verbose', 'include raw Product API payloads in checks')
    .action(async (options: DoctorOptions) => {
      const report = await runProductDoctor({
        ...productClientOptions(options),
        ...(options.walletAddress ? { walletAddress: options.walletAddress } : {}),
        ...(options.taskId ? { taskId: options.taskId } : {}),
        ...(options.submissionId ? { submissionId: options.submissionId } : {}),
        ...(options.verbose ? { verbose: true } : {}),
      });
      if (!report.ok) {
        process.exitCode = 1;
      }
      console.log(stringifyForTransport(report));
    });

  const jobs = program.command('jobs').description('query and operate local state-machine watcher jobs');
  jobs
    .command('list')
    .description('list jobs from a local watcher jobs file')
    .requiredOption('--jobs-file <path>', 'state-machine watcher jobs JSON file')
    .option('--status <status>', 'filter by ExecutorJobDTO status')
    .option('--supplier-id <id>', 'filter by supplier id')
    .action(async (options: JobsListOptions) => {
      const store = new FileStateMachineJobStore(options.jobsFile);
      const allJobs = (await store.list()).map((job) => stateMachineJobToExecutorJobDTO(job));
      const filtered = allJobs.filter((job) => {
        if (options.status && job.status !== options.status) {
          return false;
        }
        if (options.supplierId && job.supplierId !== options.supplierId) {
          return false;
        }
        return true;
      });
      console.log(stringifyForTransport({ jobs: filtered }));
    });

  jobs
    .command('get <jobId>')
    .description('show one job from a local watcher jobs file')
    .requiredOption('--jobs-file <path>', 'state-machine watcher jobs JSON file')
    .action(async (jobId: string, options: JobsFileOptions) => {
      const store = new FileStateMachineJobStore(options.jobsFile);
      const job = await store.get(normalizeBytes32(jobId, 'jobId'));
      if (!job) {
        throw new ValidationError(`job ${jobId} not found`);
      }
      console.log(stringifyForTransport({ job: stateMachineJobToExecutorJobDTO(job), rawJob: job }));
    });

  jobs
    .command('retry <jobId>')
    .description('retry a failed or callback-pending state-machine watcher job')
    .requiredOption('--jobs-file <path>', 'state-machine watcher jobs JSON file')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .requiredOption('--state-machine <address>', 'UVPStateMachine contract address')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--config <path>', 'state machine handler config JSON path')
    .requiredOption('--operator <id>', 'operator id recorded in the job audit trail')
    .option('--reason <text>', 'optional retry reason recorded in the job audit trail')
    .option('--wallet-address <address>', 'executor wallet address shown as submitSignal sender in dry-run')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--dry-run', 'build submitSignal tx requests without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (jobId: string, options: JobsRetryOptions) => {
      const watcher = await buildStateMachineWatcherFromCli(options);
      const result = await retryStateMachineJob(watcher, jobId, {
        operator: options.operator,
        ...(options.reason ? { reason: options.reason } : {}),
      });
      console.log(stringifyForTransport({ retry: result }));
      if (executionOutcomeFailed(result)) {
        process.exitCode = 1;
      }
    });

  jobs
    .command('dead-letter <jobId>')
    .description('move a local watcher job to dead_letter and preserve the operator reason')
    .requiredOption('--jobs-file <path>', 'state-machine watcher jobs JSON file')
    .requiredOption('--operator <id>', 'operator id recorded in the job audit trail')
    .requiredOption('--reason <text>', 'dead-letter reason')
    .action(async (jobId: string, options: JobsDeadLetterOptions) => {
      const store = new FileStateMachineJobStore(options.jobsFile);
      const job = await deadLetterStateMachineJob(store, jobId, {
        operator: options.operator,
        reason: options.reason,
      });
      console.log(stringifyForTransport({ job: stateMachineJobToExecutorJobDTO(job), rawJob: job }));
    });

  program
    .command('chain-once')
    .description('scan UVPStateMachine HookReady logs once and submit callback txs')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .option('--state-machine <address>', 'UVPStateMachine contract address; optional when config stateMachines[] is set')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--config <path>', 'state machine handler config JSON path')
    .option('--wallet-address <address>', 'executor wallet address shown as submitSignal sender in dry-run')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--from-block <uint>', 'first block to scan')
    .option('--jobs-file <path>', 'persist watcher jobs to a local JSON file')
    .option('--dry-run', 'build submitSignal tx requests without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (options: ChainWatchOptions) => {
      const watcher = await buildStateMachineWatcherFromCli(options);
      const poll = await watcher.pollOnce();
      console.log(stringifyForTransport({ watcher: watcher.describe(), poll }));
      // Honest exit code: submission errors folded into the poll result (or
      // failed/dead-lettered jobs) must not masquerade as a successful run.
      if (chainPollExecutionFailed(poll)) {
        process.exitCode = 1;
      }
    });

  program
    .command('chain-watch')
    .description('poll UVPStateMachine HookReady logs and submit callback txs')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .option('--state-machine <address>', 'UVPStateMachine contract address; optional when config stateMachines[] is set')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--config <path>', 'state machine handler config JSON path')
    .option('--wallet-address <address>', 'executor wallet address shown as submitSignal sender in dry-run')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--from-block <uint>', 'first block to scan')
    .option('--poll-interval-ms <ms>', 'polling interval in milliseconds')
    .option('--jobs-file <path>', 'persist watcher jobs to a local JSON file')
    .option('--dry-run', 'build submitSignal tx requests without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (options: ChainWatchOptions) => {
      const watcher = await buildStateMachineWatcherFromCli(options);
      console.log(stringifyForTransport({ watcher: watcher.describe() }));
      const handle = await watcher.start();
      try {
        // A fatal watch-loop abort (consecutive poll failures) rejects handle.done and
        // propagates out of this command so the process exits non-zero.
        await Promise.race([
          handle.done,
          waitForShutdown(async () => {
            await handle.stop();
          }),
        ]);
      } finally {
        await handle.stop();
      }
    });

  program
    .command('chain-signal')
    .description('build and optionally submit one UVPStateMachine submitSignal tx')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .requiredOption('--state-machine <address>', 'UVPStateMachine contract address')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .option('--wallet-address <address>', 'executor wallet address shown as submitSignal sender in dry-run')
    .requiredOption('--order-id <bytes32>', 'order id')
    .requiredOption('--plan-id <bytes32>', 'plan id the order belongs to (plan-scoped submitSignal ABI; zero placeholder is rejected)')
    .requiredOption('--source <source>', 'signal source')
    .requiredOption('--stage <stageIdentifier>', 'stage identifier')
    .requiredOption('--signal-name <signalName>', 'signal name')
    .option('--payload-hash <bytes32>', 'off-chain payload hash')
    .option('--payload-ref <uri>', 'unsupported: rejected because submitSignal cannot carry an off-chain payload reference')
    .option('--ready-event-id <bytes32>', 'HookReady event id')
    .option('--idempotency-key <key>', 'idempotency key')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--dry-run', 'build the submitSignal tx request without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (options: ChainSignalOptions) => {
      if (options.payloadRef) {
        // The frozen UVPStateMachine v0.8 ABI has no payloadRef input, so this
        // flag would be silently dropped and the operator would walk away with
        // a "submitted" success that never carried the reference. Fail loudly;
        // only the 32-byte payloadHash goes on chain.
        throw new ValidationError(
          '--payload-ref is not supported by chain-signal: submitSignal(planId, orderId, sourceId, signalId, payloadHash, idempotencyKey) has no reference field, so the flag would be silently dropped. Keep only the 32-byte --payload-hash on chain and record the off-chain payload reference in your own job/evidence store next to it.',
        );
      }
      const result = await submitStateMachineSignal({
        rpcUrl: options.rpcUrl,
        stateMachineAddress: options.stateMachine,
        chainId: parsePositiveInteger(options.chainId, 'chainId'),
        ...(options.walletAddress ? { walletAddress: options.walletAddress } : {}),
        privateKeyEnv: options.privateKeyEnv,
        dryRun: options.dryRun ?? false,
        ...(options.waitForReceipt !== undefined ? { waitForReceipt: options.waitForReceipt } : {}),
      }, {
        planId: options.planId,
        orderId: options.orderId,
        source: options.source,
        stageIdentifier: options.stage,
        signalName: options.signalName,
        ...(options.payloadHash ? { payloadHash: options.payloadHash } : {}),
        ...(options.readyEventId ? { readyEventId: options.readyEventId } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      console.log(stringifyForTransport({ stateMachineSignal: result }));
    });

  return program;
}

function productClientOptions(options: ProductClientCliOptions): ProductClientRuntimeOptions {
  const auth = options.authTokenEnv
    ? productApiAuthHeadersFromEnv(options.authTokenEnv)
    : undefined;
  return {
    chainServicesUrl: options.chainServicesUrl,
    ...(options.principalId ? { principalId: options.principalId } : {}),
    ...(auth ? { headers: auth.headers, auth: auth.status } : {}),
  };
}

async function printProductSubmissionProof(submissionId: string, options: ProductProofOptions): Promise<void> {
  const submission = await getSignalContainerProof({
    ...productClientOptions(options),
    submissionId,
  });
  console.log(stringifyForTransport({
    submission: options.verbose ? submission : summarizeSubmittedSignalContainer(submission),
  }));
}

function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

async function writePreparedSignalContainerFile(path: string, prepared: PreparedSignalContainer): Promise<void> {
  await writeFile(path, `${stringifyForTransport({ prepared })}\n`, { mode: 0o600 });
}

async function readPreparedSignalContainerFile(path: string): Promise<PreparedSignalContainer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError('prepared file must contain JSON');
    }
    throw error;
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'prepared' in parsed) {
    return parsePreparedSignalContainer((parsed as { prepared: unknown }).prepared, 'prepared file prepared');
  }
  return parsePreparedSignalContainer(parsed, 'prepared file');
}

async function buildStateMachineWatcherFromCli(options: ChainWatchOptions) {
  const config = await loadStateMachineHandlerConfig(options.config);
  const configuredStateMachines = config.stateMachines ?? [];
  const stateMachineAddress = options.stateMachine
    ? normalizeAddress(options.stateMachine, 'stateMachine')
    : config.stateMachineAddress ?? configuredStateMachines[0]?.stateMachineAddress;
  if (!stateMachineAddress) {
    throw new ValidationError('missing state machine address: pass --state-machine or set stateMachines[] in config');
  }
  return createStateMachineWatcher({
    rpcUrl: options.rpcUrl,
    stateMachineAddress,
    stateMachines: configuredStateMachines.length > 0
      ? configuredStateMachines
      : [{ stateMachineAddress }],
    chainId: parsePositiveInteger(options.chainId, 'chainId'),
    ...(config.supplierId ?? config.executorId ? { supplierId: config.supplierId ?? config.executorId } : {}),
    ...(options.walletAddress ? { walletAddress: normalizeAddress(options.walletAddress, 'walletAddress') } : config.walletAddress ? { walletAddress: config.walletAddress } : {}),
    privateKeyEnv: options.privateKeyEnv,
    handlers: createStateMachineHandlersFromConfig(config),
    ...(config.artifact ? { artifact: config.artifact } : {}),
    ...(config.retry ? { retry: config.retry } : {}),
    ...(options.jobsFile ? { jobStore: new FileStateMachineJobStore(options.jobsFile) } : {}),
        dryRun: options.dryRun ?? config.dryRun ?? false,
        ...(options.waitForReceipt !== undefined ? { waitForReceipt: options.waitForReceipt } : {}),
    ...(options.fromBlock ? { fromBlock: options.fromBlock } : {}),
    ...(options.pollIntervalMs ? { pollIntervalMs: parsePositiveInteger(options.pollIntervalMs, 'pollIntervalMs') } : {}),
    onPoll: (poll) => {
      console.log(stringifyForTransport({ poll }));
    },
    onError: (error) => {
      console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    },
  });
}

async function validateConfigFromCli(options: ConfigValidateOptions): Promise<Record<string, unknown>> {
  const kind = options.kind.trim();
  if (!['auto', 'state-machine', 'http'].includes(kind)) {
    throw new ValidationError('config kind must be auto, state-machine, or http');
  }

  if (kind === 'http') {
    return summarizeHttpExecutorConfig(await loadExecutorConfig(options.config));
  }

  if (kind === 'state-machine') {
    return summarizeStateMachineExecutorConfig(await loadStateMachineHandlerConfig(options.config));
  }

  try {
    return summarizeStateMachineExecutorConfig(await loadStateMachineHandlerConfig(options.config));
  } catch (stateMachineError) {
    try {
      return summarizeHttpExecutorConfig(await loadExecutorConfig(options.config));
    } catch {
      throw stateMachineError;
    }
  }
}

function summarizeStateMachineExecutorConfig(config: Awaited<ReturnType<typeof loadStateMachineHandlerConfig>>): Record<string, unknown> {
  const signalCount = Object.values(config.handlers)
    .reduce((count, handler) => count + handler.signals.length, 0);
  const executorConfig = stateMachineHandlerConfigToExecutorConfigDTO(config);
  const stateMachineCount = config.stateMachines?.length ?? (config.stateMachineAddress ? 1 : 0);
  const warnings = [
    ...(config.supplierId ?? config.executorId ? [] : ['supplierId/executorId is not set']),
    ...(config.walletAddress ? [] : ['walletAddress is not set; dry-run will need --wallet-address or a private key env var']),
    ...(config.chainId ? [] : ['chainId is not set in config; CLI --chain-id will be used']),
    ...(stateMachineCount > 0 ? [] : ['stateMachineAddress/stateMachines is not set in config; CLI --state-machine will be used']),
  ];

  return {
    valid: true,
    kind: 'state-machine',
    executorConfig,
    supplier: {
      supplierId: executorConfig.supplierId ?? 'unknown-supplier',
      callbackMode: executorConfig.callbackMode,
      authTokenRef: executorConfig.authTokenRef ?? null,
    },
    wallet: {
      configured: Boolean(config.walletAddress),
      address: config.walletAddress ?? null,
      chainId: config.chainId ?? null,
      stateMachineAddress: config.stateMachineAddress ?? null,
      stateMachines: config.stateMachines ?? [],
    },
    stageCapabilities: summarizeStageCapabilities(config.handlers),
    opsSummary: summarizeSupplierOps(config, []),
    ...(config.executorId ? { executorId: config.executorId } : {}),
    ...(config.supplierId ? { supplierId: config.supplierId } : {}),
    ...(config.walletAddress ? { walletAddress: config.walletAddress } : {}),
    ...(config.chainId ? { chainId: config.chainId } : {}),
    ...(config.stateMachineAddress ? { stateMachineAddress: config.stateMachineAddress } : {}),
    callbackMode: executorConfig.callbackMode,
    dryRun: executorConfig.dryRun,
    handlerCount: Object.keys(config.handlers).length,
    signalCount,
    retry: {
      maxAttempts: config.retry?.maxAttempts ?? 3,
      baseDelayMs: config.retry?.baseDelayMs ?? 0,
    },
    warnings,
  };
}

function summarizeStageCapabilities(
  handlers: Awaited<ReturnType<typeof loadStateMachineHandlerConfig>>['handlers'],
): readonly Record<string, unknown>[] {
  return Object.entries(handlers).map(([key, handler]) => {
    const [stageFromKey, hookName] = key.includes('#') ? key.split('#', 2) : [key, undefined];
    const stageIdentifiers = new Set<string>();
    if (stageFromKey && stageFromKey !== '*' && !stageFromKey.startsWith('0x')) {
      stageIdentifiers.add(stageFromKey);
    }
    for (const signal of handler.signals) {
      if (signal.stageIdentifier) {
        stageIdentifiers.add(signal.stageIdentifier);
      }
    }
    return {
      key,
      stageIdentifiers: [...stageIdentifiers],
      hookName: hookName ?? null,
      signalCount: handler.signals.length,
      signals: handler.signals.map((signal) => ({
        source: signal.source ?? null,
        stageIdentifier: signal.stageIdentifier ?? null,
        signalName: signal.signalName ?? null,
        sourceId: signal.sourceId ?? null,
        signalId: signal.signalId ?? null,
      })),
    };
  });
}

function summarizeHttpExecutorConfig(config: Awaited<ReturnType<typeof loadExecutorConfig>>): Record<string, unknown> {
  return {
    valid: true,
    kind: 'http',
    executorId: config.executorId,
    handlerCount: Object.keys(config.handlers).length,
  };
}

function readSecret(value: string | undefined, envName: string, label: string): string {
  const secret = value ?? process.env[envName];
  if (!secret || secret.trim().length === 0) {
    throw new ValidationError(`missing ${label}: pass --${label.replaceAll(' ', '-')} or set ${envName}`);
  }
  return secret;
}

function parsePort(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError('port must be a non-negative integer');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new ValidationError('port must be between 0 and 65535');
  }
  return port;
}

function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const shutdown = (): void => {
      close().then(resolve, reject);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

/**
 * True when one log-processing outcome carries an error or ended in a terminal
 * failure state. Used to drive honest process exit codes: a chain-once scan or
 * jobs retry whose callback submission failed must exit non-zero even though
 * the result object itself was produced without throwing.
 */
export function executionOutcomeFailed(result: {
  readonly error?: unknown;
  readonly job?: { readonly status?: string };
}): boolean {
  return Boolean(result.error)
    || result.job?.status === 'failed'
    || result.job?.status === 'dead_letter';
}

export function chainPollExecutionFailed(poll: {
  readonly results?: readonly {
    readonly error?: unknown;
    readonly job?: { readonly status?: string };
  }[];
}): boolean {
  return (poll.results ?? []).some(executionOutcomeFailed);
}

export async function main(argv = process.argv): Promise<void> {
  const runtime = argv[0] ?? 'node';
  const script = argv[1] ?? 'uvp-executor';
  const normalizedArgv = argv.length > 2 && argv[2] === '--'
    ? [runtime, script, ...argv.slice(3)]
    : argv;
  await buildProgram().parseAsync(normalizedArgv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof ExecutorKitError) {
      console.error(`${error.name}: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    throw error;
  });
}
