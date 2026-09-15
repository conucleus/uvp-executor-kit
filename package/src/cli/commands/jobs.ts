import type { Command } from 'commander';
import { stringifyForTransport } from '../../transport.js';
import { normalizeBytes32, ValidationError } from '../../validation.js';
import {
  DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV,
  FileStateMachineJobStore,
  deadLetterStateMachineJob,
  retryStateMachineJob,
} from '../../watcher/index.js';
import { executionOutcomeFailed, stateMachineJobToExecutorJobDTO } from '../output.js';
import { buildStateMachineWatcherFromCli } from '../watcher.js';
import type {
  JobsDeadLetterOptions,
  JobsFileOptions,
  JobsListOptions,
  JobsRetryOptions,
} from '../options.js';

/** jobs 命令分发（本地 watcher 任务查询与运维）。 */
export function registerJobsCommands(program: Command): void {
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
    .description('retry a detected, failed, callback-pending, submitted, or confirmed state-machine watcher job (confirmed retries resubmit for reorg recovery)')
    .requiredOption('--jobs-file <path>', 'state-machine watcher jobs JSON file')
    .requiredOption('--rpc-url <url>', 'EVM RPC URL')
    .option('--state-machine <address>', 'UVPStateMachine contract address; optional when config stateMachines[] is set')
    .requiredOption('--chain-id <id>', 'expected chain id')
    .requiredOption('--config <path>', 'state machine handler config JSON path')
    .requiredOption('--operator <id>', 'operator id recorded in the job audit trail')
    .option('--reason <text>', 'optional retry reason recorded in the job audit trail')
    .option('--wallet-address <address>', 'executor wallet address shown as submitSignal sender in dry-run')
    .option('--private-key-env <name>', 'environment variable containing the callback tx private key', DEFAULT_STATE_MACHINE_PRIVATE_KEY_ENV)
    .option('--dry-run', 'build submitSignal tx requests without broadcasting')
    .option('--wait-for-receipt', 'wait for tx receipt after broadcasting')
    .action(async (jobId: string, options: JobsRetryOptions) => {
      // README 承诺 file 模式下不停机手工重投：retry 不取 state-dir 启动锁
      // （与运行中的 watcher 共存）。并发安全由任务级运行认领承担：正在被
      // 其它执行器运行的任务会被拒绝，只有空闲或持有者已崩溃的任务可接管。
      const { watcher } = await buildStateMachineWatcherFromCli(options, { holdStateDirLock: false });
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
}
