import { chmod, readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  getSignalContainer,
  getSignalContainerProof,
  hashContainerEvidence,
  listSignalContainers,
  parsePreparedSignalContainer,
  prepareSignalContainer,
  signPreparedSignalContainer,
  submitPreparedSignalContainer,
  summarizePreparedSignalContainer,
  summarizeSignalContainer,
  summarizeSubmittedSignalContainer,
  type PreparedSignalContainer,
} from '../../product.js';
import { stringifyForTransport } from '../../transport.js';
import { parsePositiveInteger, ValidationError } from '../../validation.js';
import {
  collectRepeatedOption,
  productClientOptions,
  type ProductPrepareOptions,
  type ProductProofOptions,
  type ProductSubmitOptions,
  type ProductTaskGetOptions,
  type ProductTasksOptions,
} from '../options.js';

/** product 命令分发（Product API signal containers）。 */
export function registerProductCommands(program: Command): void {
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
    .option('--expected-chain-id <id>', 'expected chain id anchoring the prepared typedData domain; signing fails closed on mismatch')
    .option('--expected-verifying-contract <address>', 'expected verifying contract anchoring the prepared typedData domain; signing fails closed on mismatch')
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
        // 域锚（对齐浏览器端调用方）：锚来自操作方按部署配置声明的
        // 选项，不从 prepared 载荷自取（循环信任）。
        ...(options.expectedChainId !== undefined || options.expectedVerifyingContract !== undefined
          ? {
              expectedDomain: {
                ...(options.expectedChainId !== undefined ? { chainId: parsePositiveInteger(options.expectedChainId, 'expectedChainId') } : {}),
                ...(options.expectedVerifyingContract !== undefined ? { verifyingContract: options.expectedVerifyingContract } : {}),
              },
            }
          : {}),
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

async function writePreparedSignalContainerFile(path: string, prepared: PreparedSignalContainer): Promise<void> {
  await writeFile(path, `${stringifyForTransport({ prepared })}\n`, { mode: 0o600 });
  // writeFile's `mode` only applies to files it creates: overwriting an
  // existing (possibly looser) prepared file must re-assert the owner-only
  // mode, matching wallet.ts.
  await chmod(path, 0o600);
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
