import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { runProductDoctor } from '../src/doctor.js';
import {
  type ProductApiFetch,
  type ProductApiFetchResponse,
} from '../src/product.js';
import { privateKeyToAccount } from 'viem/accounts';

const privateKey = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const account = privateKeyToAccount(privateKey);
const submitter = account.address;

function bytes32(suffix: string): `0x${string}` {
  return `0x${suffix.padStart(64, '0')}`;
}

function jsonResponse(body: unknown, status = 200): ProductApiFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe('Product API doctor', () => {
  it('runs reachability check and reports ok when the Product API responds', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({ tasks: [] });
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      fetch,
    });

    expect(report.chainServicesUrl).toBe('http://chain.local/api');
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ ok: true, label: 'reachability' });
    expect(report.ok).toBe(true);
    expect(report.timestamp).toBeTypeOf('string');
    // no secrets leaked
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('0x');
  });

  it('reports task visibility when a wallet address is provided', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({
        tasks: [
          {
            taskId: 'task_1',
            orderId: 'order_1',
            title: 'Confirm customs release',
            status: 'open',
          },
          {
            taskId: 'task_2',
            orderId: 'order_2',
            title: 'Verify shipment docs',
            status: 'open',
          },
        ],
      });
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      walletAddress: submitter,
      fetch,
    });

    expect(report.checks).toHaveLength(2);
    const taskCheck = report.checks.find((c) => c.label === 'task-visibility');
    expect(taskCheck).toMatchObject({ ok: true, label: 'task-visibility' });
    expect(taskCheck?.detail).toContain('2 task(s)');
    expect(report.walletAddress).toBe(submitter);
    expect(report.tasks).toHaveLength(2);
    expect(report.tasks?.[0]).toMatchObject({ taskId: 'task_1', title: 'Confirm customs release' });
    expect(report.ok).toBe(true);
    // normal output strips raw fields
    expect(report.rawTasks).toBeUndefined();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sourceId');
    expect(serialized).not.toContain('signalId');
  });

  it('reports zero tasks gracefully', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({ tasks: [] });
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      walletAddress: submitter,
      fetch,
    });

    const taskCheck = report.checks.find((c) => c.label === 'task-visibility');
    expect(taskCheck?.ok).toBe(true);
    expect(taskCheck?.detail).toContain('No tasks visible');
    expect(report.tasks).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it('reports proof endpoint shape for a given submission id', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      if (url.includes('/product/tasks')) {
        return jsonResponse({ tasks: [] });
      }
      return jsonResponse({
        submissionId: 'sub_1',
        prepareId: 'prep_1',
        taskId: 'task_1',
        orderId: 'order_1',
        status: 'confirmed',
        txHash: bytes32('44'),
        proofRows: [{ label: 'Transaction', value: bytes32('44') }],
      });
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      submissionId: 'sub_1',
      fetch,
    });

    const proofCheck = report.checks.find((c) => c.label === 'proof-endpoint');
    expect(proofCheck).toMatchObject({ ok: true, label: 'proof-endpoint' });
    expect(proofCheck?.detail).toContain('confirmed');
    expect(report.proof).toMatchObject({ submissionId: 'sub_1', status: 'confirmed' });
    expect(report.ok).toBe(true);
    // normal output strips raw fields
    expect(report.rawProof).toBeUndefined();
  });

  it('includes raw fields in verbose mode', async () => {
    const sourceIdHex = bytes32('02');
    const signalIdHex = bytes32('03');
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      if (url.includes('/product/tasks')) {
        return jsonResponse({
          tasks: [
            {
              taskId: 'task_1',
              orderId: 'order_1',
              title: 'Confirm customs release',
              status: 'open',
              sourceId: sourceIdHex,
              signalId: signalIdHex,
            },
          ],
        });
      }
      return jsonResponse({
        submissionId: 'sub_1',
        prepareId: 'prep_1',
        taskId: 'task_1',
        orderId: 'order_1',
        status: 'confirmed',
        sourceId: sourceIdHex,
        signalId: signalIdHex,
        txHash: bytes32('44'),
      });
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      walletAddress: submitter,
      submissionId: 'sub_1',
      verbose: true,
      fetch,
    });

    expect(report.rawTasks).toBeDefined();
    expect(report.rawTasks?.[0]?.sourceId).toBe(sourceIdHex);
    expect(report.rawProof).toBeDefined();
    expect(report.rawProof?.sourceId).toBe(sourceIdHex);
  });

  it('reports failure when the Product API is unreachable', async () => {
    const fetch: ProductApiFetch = async () => {
      throw new Error('fetch failed');
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      fetch,
    });

    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ ok: false, label: 'reachability' });
    expect(report.checks[0]?.detail).toContain('fetch failed');
    expect(report.ok).toBe(false);
  });

  it('reports task-visibility failure independently of reachability', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'unauthorized', message: 'Not authorized' }) };
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      walletAddress: submitter,
      fetch,
    });

    const reachCheck = report.checks.find((c) => c.label === 'reachability');
    const taskCheck = report.checks.find((c) => c.label === 'task-visibility');
    expect(reachCheck?.ok).toBe(true);
    expect(taskCheck?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('classifies network errors during task visibility check', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      throw new Error('ETIMEDOUT: connection timed out');
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      walletAddress: submitter,
      fetch,
    });

    const taskCheck = report.checks.find((c) => c.label === 'task-visibility');
    expect(taskCheck?.ok).toBe(false);
    // error message is classified and may be redacted, but should exist
    expect(taskCheck?.detail).toBeTypeOf('string');
  });

  it('reports per-task readiness for an actionable task', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({
        task: {
          taskId: 'task_actionable',
          orderId: 'order_1',
          title: 'Confirm customs release',
          status: 'open',
          assigneeWallet: submitter,
          stageName: 'Customs release',
          deadline: '2099-01-01T00:00:00.000Z',
          requiredEvidence: ['customs-docs'],
          canSubmit: true,
          primaryActionLabel: 'Confirm stage',
        },
      });
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      walletAddress: submitter,
      taskId: 'task_actionable',
      fetch,
    });

    const taskCheck = report.checks.find((c) => c.label === 'task-readiness');
    expect(taskCheck?.ok).toBe(true);
    expect(report.taskReadiness).toMatchObject({
      taskId: 'task_actionable',
      orderId: 'order_1',
      status: 'open',
      canSubmit: true,
      assigneeMatch: true,
      nextAction: 'prepare',
      requiredEvidence: ['customs-docs'],
    });
    expect(report.taskReadiness?.nextActionLabel).toContain('Ready to prepare');
    expect(report.tasks).toBeUndefined();
    expect(report.ok).toBe(true);
    // normal output strips raw fields
    expect(report.rawTaskReadiness).toBeUndefined();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('sourceId');
    expect(serialized).not.toContain('signalId');
  });

  it('reports per-task readiness for a blocked task', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({
        task: {
          taskId: 'task_blocked',
          orderId: 'order_2',
          title: 'Verify shipping docs',
          status: 'open',
          assigneeWallet: submitter,
          deadline: '2099-01-01T00:00:00.000Z',
          requiredEvidence: ['shipping-docs'],
          canSubmit: false,
          blockedReason: 'Required evidence not yet uploaded',
        },
      });
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      walletAddress: submitter,
      taskId: 'task_blocked',
      fetch,
    });

    expect(report.taskReadiness).toMatchObject({
      taskId: 'task_blocked',
      canSubmit: false,
      blockedReason: 'Required evidence not yet uploaded',
      assigneeMatch: true,
      nextAction: 'wait',
    });
    expect(report.taskReadiness?.nextActionLabel).toContain('Required evidence not yet uploaded');
    expect(report.ok).toBe(false);
  });

  it('reports next action as proof for a confirmed task', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({
        task: {
          taskId: 'task_confirmed',
          orderId: 'order_3',
          title: 'Completed inspection',
          status: 'confirmed',
          assigneeWallet: submitter,
          canSubmit: false,
        },
      });
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      walletAddress: submitter,
      taskId: 'task_confirmed',
      fetch,
    });

    expect(report.taskReadiness).toMatchObject({
      taskId: 'task_confirmed',
      status: 'confirmed',
      nextAction: 'proof',
    });
    expect(report.taskReadiness?.nextActionLabel).toContain('Run product proof');
    expect(report.ok).toBe(true);
  });

  it('reports per-task readiness without wallet address', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({
        task: {
          taskId: 'task_nowallet',
          orderId: 'order_4',
          title: 'Any task',
          status: 'open',
          assigneeWallet: submitter,
          canSubmit: true,
          requiredEvidence: [],
        },
      });
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      taskId: 'task_nowallet',
      fetch,
    });

    expect(report.taskReadiness).toMatchObject({
      taskId: 'task_nowallet',
      status: 'open',
      canSubmit: true,
      assigneeMatch: true,
      configuredWallet: '',
    });
    // no tasks list when task-id is provided
    expect(report.tasks).toBeUndefined();
    expect(report.walletAddress).toBeUndefined();
  });

  it('reports assignee mismatch when wallet differs from task assignee', async () => {
    const fetch: ProductApiFetch = async (url) => {
      if (!url.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({
        task: {
          taskId: 'task_mismatch',
          orderId: 'order_5',
          title: 'Wrong assignee task',
          status: 'open',
          assigneeWallet: '0x9999999999999999999999999999999999999999',
          canSubmit: true,
          requiredEvidence: [],
        },
      });
    };

    const report = await runProductDoctor({
      chainServicesUrl: 'http://chain.local/api',
      walletAddress: submitter,
      taskId: 'task_mismatch',
      fetch,
    });

    expect(report.taskReadiness).toMatchObject({
      taskId: 'task_mismatch',
      canSubmit: false,
      assigneeMatch: false,
      nextAction: 'blocked',
    });
    expect(report.taskReadiness?.nextActionLabel).toContain('not the task assignee');
    expect(report.ok).toBe(false);
  });
});

describe('doctor CLI', () => {
  it('passes Product API auth token env headers and reports only redacted auth status', async () => {
    const logs: string[] = [];
    const envName = 'UVP_DOCTOR_PRODUCT_API_TOKEN';
    const token = 'doctor-secret-token';
    const previousEnv = process.env[envName];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    const authorizationHeaders: string[] = [];
    process.env[envName] = token;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      if (init?.headers?.Authorization) {
        authorizationHeaders.push(init.headers.Authorization);
      }
      return jsonResponse({
        tasks: [
          {
            taskId: 'task_auth_doctor',
            orderId: 'order_auth',
            title: 'Auth doctor task',
            status: 'open',
          },
        ],
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      await main([
        'node',
        'uvp-executor',
        'doctor',
        '--chain-services-url',
        'http://chain.local/api',
        '--wallet-address',
        submitter,
        '--auth-token-env',
        envName,
      ]);
      const output = JSON.parse(logs[0] ?? '{}') as {
        auth?: { bearerTokenEnv?: string; bearerTokenConfigured?: boolean; redacted?: boolean };
      };
      expect(authorizationHeaders).toContain(`Bearer ${token}`);
      expect(output.auth).toEqual({
        bearerTokenEnv: envName,
        bearerTokenConfigured: true,
        redacted: true,
      });
      expect(logs[0]).not.toContain(token);
    } finally {
      console.log = originalLog;
      if (originalFetch) {
        globalThis.fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
      if (previousEnv === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previousEnv;
      }
    }
  });

  it('prints per-task readiness from the CLI with --task-id', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    globalThis.fetch = (async (url: unknown) => {
      const urlStr = String(url);
      if (!urlStr.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({
        task: {
          taskId: 'task_cli_ready',
          orderId: 'order_cli',
          title: 'CLI task',
          status: 'open',
          assigneeWallet: submitter,
          stageName: 'Customs release',
          deadline: '2099-01-01T00:00:00.000Z',
          requiredEvidence: ['customs-docs'],
          canSubmit: true,
          primaryActionLabel: 'Confirm stage',
        },
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      await main([
        'node',
        'uvp-executor',
        'doctor',
        '--chain-services-url',
        'http://chain.local/api',
        '--wallet-address',
        submitter,
        '--task-id',
        'task_cli_ready',
      ]);
      const output = JSON.parse(logs[0] ?? '{}') as {
        ok?: boolean;
        checks?: Array<{ label?: string; ok?: boolean }>;
        taskReadiness?: { taskId?: string; nextAction?: string; canSubmit?: boolean; assigneeMatch?: boolean };
        tasks?: unknown;
      };
      expect(output.ok).toBe(true);
      expect(output.checks).toHaveLength(2);
      expect(output.taskReadiness).toMatchObject({
        taskId: 'task_cli_ready',
        nextAction: 'prepare',
        canSubmit: true,
        assigneeMatch: true,
      });
      expect(output.tasks).toBeUndefined();
      expect(logs[0]).not.toContain(privateKey);
      expect(logs[0]).not.toContain('sourceId');
      expect(logs[0]).not.toContain('signalId');
    } finally {
      console.log = originalLog;
      if (originalFetch) {
        globalThis.fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  });

  it('includes raw task readiness data in CLI verbose mode', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    const sourceIdHex = bytes32('02');
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    globalThis.fetch = (async (url: unknown) => {
      const urlStr = String(url);
      if (!urlStr.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({
        task: {
          taskId: 'task_verbose',
          orderId: 'order_verb',
          title: 'Verbose task',
          status: 'open',
          assigneeWallet: submitter,
          canSubmit: true,
          sourceId: sourceIdHex,
          signalId: bytes32('03'),
          requiredEvidence: [],
        },
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      await main([
        'node',
        'uvp-executor',
        'doctor',
        '--chain-services-url',
        'http://chain.local/api',
        '--wallet-address',
        submitter,
        '--task-id',
        'task_verbose',
        '--verbose',
      ]);
      const output = JSON.parse(logs[0] ?? '{}') as {
        taskReadiness?: { taskId?: string };
        rawTaskReadiness?: { sourceId?: string };
      };
      expect(output.taskReadiness?.taskId).toBe('task_verbose');
      expect(output.rawTaskReadiness?.sourceId).toBe(sourceIdHex);
    } finally {
      console.log = originalLog;
      if (originalFetch) {
        globalThis.fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  });

  it('prints a doctor report from the CLI without secrets', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    globalThis.fetch = (async (url: unknown) => {
      const urlStr = String(url);
      if (!urlStr.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      return jsonResponse({
        tasks: [
          {
            taskId: 'task_1',
            orderId: 'order_1',
            title: 'Confirm customs release',
            status: 'open',
            sourceId: bytes32('02'),
            signalId: bytes32('03'),
          },
        ],
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      await main([
        'node',
        'uvp-executor',
        'doctor',
        '--chain-services-url',
        'http://chain.local/api',
        '--wallet-address',
        submitter,
      ]);
      const output = JSON.parse(logs[0] ?? '{}') as {
        ok?: boolean;
        checks?: Array<{ ok?: boolean; label?: string }>;
        tasks?: Array<{ taskId?: string }>;
        chainServicesUrl?: string;
        timestamp?: string;
      };
      expect(output.chainServicesUrl).toBe('http://chain.local/api');
      expect(output.ok).toBe(true);
      expect(output.checks).toHaveLength(2);
      expect(output.tasks?.[0]?.taskId).toBe('task_1');
      expect(output.timestamp).toBeTypeOf('string');
      // no secrets in output
      expect(logs[0]).not.toContain(privateKey);
      expect(logs[0]).not.toContain('sourceId');
      expect(logs[0]).not.toContain('signalId');
    } finally {
      console.log = originalLog;
      if (originalFetch) {
        globalThis.fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  });

  it('includes raw fields in CLI verbose mode', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    const sourceIdHex = bytes32('02');
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    globalThis.fetch = (async (url: unknown) => {
      const urlStr = String(url);
      if (!urlStr.includes('/product/')) {
        return jsonResponse({ service: 'chain-services' });
      }
      if (urlStr.includes('/product/tasks')) {
        return jsonResponse({
          tasks: [
            {
              taskId: 'task_1',
              orderId: 'order_1',
              title: 'Confirm customs release',
              status: 'open',
              sourceId: sourceIdHex,
              signalId: bytes32('03'),
            },
          ],
        });
      }
      return jsonResponse({
        submissionId: 'sub_1',
        prepareId: 'prep_1',
        taskId: 'task_1',
        orderId: 'order_1',
        status: 'confirmed',
        txHash: bytes32('44'),
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      await main([
        'node',
        'uvp-executor',
        'doctor',
        '--chain-services-url',
        'http://chain.local/api',
        '--wallet-address',
        submitter,
        '--submission-id',
        'sub_1',
        '--verbose',
      ]);
      const output = JSON.parse(logs[0] ?? '{}') as {
        rawTasks?: Array<{ sourceId?: string }>;
        rawProof?: { sourceId?: string };
        tasks?: Array<unknown>;
        proof?: unknown;
      };
      expect(output.rawTasks).toBeDefined();
      expect(output.rawTasks?.[0]?.sourceId).toBe(sourceIdHex);
      expect(output.rawProof).toBeDefined();
      // non-verbose fields still present
      expect(output.tasks).toBeDefined();
      expect(output.proof).toBeDefined();
    } finally {
      console.log = originalLog;
      if (originalFetch) {
        globalThis.fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  });

  it('prints reachability-only report when no wallet or submission id is given', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    globalThis.fetch = (async () => jsonResponse({ service: 'chain-services' })) as unknown as typeof globalThis.fetch;

    try {
      await main([
        'node',
        'uvp-executor',
        'doctor',
        '--chain-services-url',
        'http://chain.local/api',
      ]);
      const output = JSON.parse(logs[0] ?? '{}') as {
        ok?: boolean;
        checks?: Array<{ ok?: boolean; label?: string }>;
        tasks?: unknown;
        proof?: unknown;
      };
      expect(output.checks).toHaveLength(1);
      expect(output.checks?.[0]?.label).toBe('reachability');
      expect(output.tasks).toBeUndefined();
      expect(output.proof).toBeUndefined();
      expect(logs[0]).not.toContain('privateKey');
    } finally {
      console.log = originalLog;
      if (originalFetch) {
        globalThis.fetch = originalFetch;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    }
  });
});
