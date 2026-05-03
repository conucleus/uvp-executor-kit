import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

describe('executor CLI', () => {
  it('accepts the pnpm argument separator before wallet commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-'));
    const envFile = join(dir, '.env.local');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };

    try {
      await main(['node', 'uvp-executor', '--', 'wallet', 'new', '--env-file', envFile]);
      const output = JSON.parse(logs[0] ?? '{}') as { wallet?: { envFile?: string } };
      expect(output.wallet?.envFile).toBe(resolve(envFile));
      expect(await readFile(envFile, 'utf8')).toContain('UVP_ETH_DEPLOYER_PRIVATE_KEY=0x');
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates standard state-machine executor configs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-config-'));
    const configPath = join(dir, 'executor.json');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };

    try {
      await writeFile(configPath, JSON.stringify({
        supplierId: 'logistics-provider-a',
        executorId: 'logistics-provider-a',
        walletAddress: '0x0000000000000000000000000000000000000002',
        chainId: 84532,
        stateMachineAddress: '0x0000000000000000000000000000000000000001',
        callbackMode: 'auto',
        dryRun: true,
        authTokenRef: 'UVP_EXECUTOR_TOKEN',
        handlers: {
          'export.customs#START': {
            signals: [
              {
                source: 'logistics-provider-a',
                stageIdentifier: 'export.customs',
                signalName: 'cmp',
              },
            ],
          },
        },
      }));

      await main(['node', 'uvp-executor', 'config', 'validate', '--config', configPath]);
      const output = JSON.parse(logs[0] ?? '{}') as {
        config?: {
          valid?: boolean;
          kind?: string;
          handlerCount?: number;
          signalCount?: number;
          supplier?: {
            supplierId?: string;
            attestationStatus?: string;
          };
          wallet?: {
            configured?: boolean;
            address?: string;
          };
          stageCapabilities?: Array<{
            key?: string;
            stageIdentifiers?: string[];
            signalCount?: number;
          }>;
        };
      };
      expect(output.config).toMatchObject({
        valid: true,
        kind: 'state-machine',
        handlerCount: 1,
        signalCount: 1,
        supplier: {
          supplierId: 'logistics-provider-a',
          attestationStatus: 'not_checked',
        },
        wallet: {
          configured: true,
          address: '0x0000000000000000000000000000000000000002',
        },
      });
      expect(output.config?.stageCapabilities?.[0]).toMatchObject({
        key: 'export.customs#START',
        stageIdentifiers: ['export.customs'],
        signalCount: 1,
      });
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists and dead-letters local watcher jobs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-cli-jobs-'));
    const jobsFile = join(dir, 'jobs.json');
    const jobId = `0x${'aa'.repeat(32)}`;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };

    try {
      await writeFile(jobsFile, JSON.stringify({
        version: 1,
        jobs: [
          {
            id: jobId,
            eventId: `0x${'bb'.repeat(32)}`,
            orderId: `0x${'11'.repeat(32)}`,
            hookId: `0x${'22'.repeat(32)}`,
            stageId: `0x${'33'.repeat(32)}`,
            stageIdentifier: 'export.customs',
            hookName: 'START',
            supplierId: 'logistics-provider-a',
            status: 'failed',
            attempts: 1,
            maxAttempts: 3,
            detectedAt: '2026-04-28T00:00:00.000Z',
            updatedAt: '2026-04-28T00:00:01.000Z',
            submissions: [],
            lastError: {
              kind: 'unauthorized',
              message: 'AccessControlUnauthorizedAccount submitter',
              retryable: false,
            },
          },
        ],
      }));

      await main(['node', 'uvp-executor', 'jobs', 'list', '--jobs-file', jobsFile]);
      const listed = JSON.parse(logs[0] ?? '{}') as {
        jobs?: Array<{ jobId?: string; status?: string; supplierId?: string }>;
      };
      expect(listed.jobs?.[0]).toMatchObject({
        jobId,
        status: 'failed',
        supplierId: 'logistics-provider-a',
      });

      await main([
        'node',
        'uvp-executor',
        'jobs',
        'dead-letter',
        jobId,
        '--jobs-file',
        jobsFile,
        '--operator',
        'ops@example.com',
        '--reason',
        'manual review required',
      ]);
      const deadLettered = JSON.parse(logs[1] ?? '{}') as {
        job?: { status?: string; lastError?: { message?: string } };
        rawJob?: { manualActions?: Array<{ action?: string; operator?: string; reason?: string }> };
      };
      expect(deadLettered.job).toMatchObject({
        status: 'dead_letter',
        lastError: {
          message: 'manual review required',
        },
      });
      expect(deadLettered.rawJob?.manualActions?.[0]).toMatchObject({
        action: 'dead_letter',
        operator: 'ops@example.com',
        reason: 'manual review required',
      });
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
