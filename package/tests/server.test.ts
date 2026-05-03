import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHandlersFromExecutorConfig,
  loadExecutorConfig,
  startExecutorServer,
  type ExecutorJob,
} from '../src/server.js';

const executorToken = 'executor-token';
const runtimeToken = 'runtime-token';
const effect = {
  type: 'HookReady',
  eventId: 'event-1',
  zhixuId: 'zhixu-1',
  orderId: 'order-1',
  hookId: 'exec.main#START',
  stageIdentifier: 'exec.main',
  hookName: 'START',
} as const;

describe('executor HTTP server', () => {
  it('accepts dispatches and posts callback signals to runtime-host', async () => {
    const callbackBodies: unknown[] = [];
    const runtime = createServer((request, response) => {
      void (async () => {
        if (request.headers.authorization !== `Bearer ${runtimeToken}`) {
          response.statusCode = 401;
          response.end('unauthorized');
          return;
        }
        callbackBodies.push(JSON.parse(await readBody(request)) as unknown);
        response.statusCode = 202;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true }));
      })();
    });
    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve));
    const runtimeAddress = runtime.address();
    if (!runtimeAddress || typeof runtimeAddress === 'string') {
      throw new Error('runtime test server did not bind to a TCP address');
    }
    const callbackUrl = `http://127.0.0.1:${runtimeAddress.port}/v0/signals`;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      runtimeToken,
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'buyer',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
            receivedAt: '2026-04-27T00:00:03.000Z',
          },
        },
      }),
      port: 0,
    });

    try {
      const accepted = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-1', effect, callbackUrl }),
      });
      expect(accepted.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(executor.url);
        expect(jobs[0]?.status).toBe('callback_succeeded');
      });

      expect(callbackBodies).toEqual([
        {
          signal: {
            zhixuId: 'zhixu-1',
            orderId: 'order-1',
            source: 'buyer',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
            senderId: 'exec-executor',
            idempotencyKey: 'order-1:exec.main#START:exec.main.cmp',
            receivedAt: '2026-04-27T00:00:03.000Z',
          },
        },
      ]);
    } finally {
      await executor.close();
      await new Promise<void>((resolve) => runtime.close(() => resolve()));
    }
  });

  it('rejects missing auth and unknown handlers', async () => {
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      runtimeToken,
      handlers: {},
      port: 0,
    });
    try {
      const unauthorized = await fetch(`${executor.url}/v0/jobs`);
      expect(unauthorized.status).toBe(401);

      const unknown = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          dispatchId: 'dispatch-unknown',
          effect,
          callbackUrl: 'http://127.0.0.1:1/v0/signals',
        }),
      });
      expect(unknown.status).toBe(404);
    } finally {
      await executor.close();
    }
  });

  it('records handler and callback failures on jobs', async () => {
    const handlerFailure = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      runtimeToken,
      handlers: {
        'exec.main#START': () => ({ status: 'failed', error: 'local executor failed' }),
      },
      port: 0,
    });
    try {
      const response = await fetch(`${handlerFailure.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-handler-failed', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(handlerFailure.url);
        expect(jobs[0]?.status).toBe('handler_failed');
        expect(jobs[0]?.lastError).toBe('local executor failed');
      });
    } finally {
      await handlerFailure.close();
    }

    const callbackFailure = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      runtimeToken,
      handlers: createHandlersFromExecutorConfig({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'buyer',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }),
      port: 0,
      fetchImpl: async () => new Response('runtime rejected callback', { status: 500 }),
    });
    try {
      const response = await fetch(`${callbackFailure.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-callback-failed', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(callbackFailure.url);
        expect(jobs[0]?.status).toBe('callback_failed');
        expect(jobs[0]?.lastError).toContain('runtime callback failed with 500');
      });
    } finally {
      await callbackFailure.close();
    }
  });

  it('loads static handler config from JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-executor-config-'));
    const configPath = join(dir, 'executor.json');
    try {
      await writeFile(configPath, JSON.stringify({
        executorId: 'exec-executor',
        handlers: {
          'exec.main#START': {
            source: 'buyer',
            stageIdentifier: 'exec.main',
            signalName: 'exec.main.cmp',
          },
        },
      }));

      const config = await loadExecutorConfig(configPath);
      const handlers = createHandlersFromExecutorConfig(config);
      expect(Object.keys(handlers)).toEqual(['exec.main#START']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function getJobs(baseUrl: string): Promise<readonly ExecutorJob[]> {
  const response = await fetch(`${baseUrl}/v0/jobs`, {
    headers: { authorization: `Bearer ${executorToken}` },
  });
  const json = await response.json() as { jobs: ExecutorJob[] };
  return json.jobs;
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function readBody(request: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
