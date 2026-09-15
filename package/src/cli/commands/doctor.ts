import type { Command } from 'commander';
import { runProductDoctor } from '../../doctor.js';
import { stringifyForTransport } from '../../transport.js';
import { ValidationError } from '../../validation.js';
import { productClientOptions, type DoctorOptions } from '../options.js';

/** doctor 命令分发（非花费型 Product API 诊断）。 */
export function registerDoctorCommand(program: Command): void {
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
      if (options.taskId && !options.walletAddress) {
        // The option help says --wallet-address is required with --task-id, and
        // the readiness verdict is a lie without it: assignee ownership cannot
        // be checked at all. Enforce instead of printing "Ready to prepare".
        throw new ValidationError('--task-id requires --wallet-address so per-task readiness can verify assignee ownership');
      }
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
}
