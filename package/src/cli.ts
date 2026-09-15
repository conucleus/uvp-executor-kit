#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { registerChainCommands } from './cli/commands/chain.js';
import { registerConfigValidateCommand } from './cli/commands/config.js';
import { registerDoctorCommand } from './cli/commands/doctor.js';
import { registerJobsCommands } from './cli/commands/jobs.js';
import { registerProductCommands } from './cli/commands/product.js';
import { registerServeCommand } from './cli/commands/serve.js';
import { registerWalletCommands } from './cli/commands/wallet.js';
import { ExecutorKitError } from './validation.js';

// 公共出口保持与拆分前的 cli.ts 完全一致（命令分发已迁入 cli/commands/，
// watcher 装配在 cli/watcher.ts，输出/退出码适配在 cli/output.ts）。
export { chainPollExecutionFailed, executionOutcomeFailed } from './cli/output.js';
export {
  DEFAULT_WATCHER_STATE_DIR,
  EXECUTOR_RUNTIME_ENV,
  resolveRuntimeEnvironment,
  resolveWatcherStorage,
  WATCHER_STATE_DIR_ENV,
  type WatcherStorageResolution,
  type WatcherStorageSummary,
} from './cli/watcher.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('uvp-executor')
    .description('UVP EVM checker, executor, and adjudicator CLI')
    .version('0.1.0');

  registerWalletCommands(program);
  registerProductCommands(program);
  registerServeCommand(program);
  registerConfigValidateCommand(program);
  registerDoctorCommand(program);
  registerJobsCommands(program);
  registerChainCommands(program);

  return program;
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
