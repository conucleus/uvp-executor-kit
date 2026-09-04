import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeExecutorHandler } from '../src/runtime.js';
import {
  assertCallbackUrlAllowed,
  createHandlersFromExecutorConfig,
  DEFAULT_CALLBACK_MAX_ATTEMPTS,
  DEFAULT_CALLBACK_RETRY_BASE_DELAY_MS,
  loadExecutorConfig,
  parseCallbackHostAllowlist,
  startExecutorServer,
  verifyWebhookSignature,
  type ExecutorJob,
} from '../src/server.js';

const executorToken = 'executor-token';
const callbackToken = 'callback-token';
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
  it('provides fail-closed constant-time webhook HMAC verification for receivers', () => {
    const body = '{"signal":{"orderId":"order-1"}}';
    const signature = `sha256=${createHmac('sha256', callbackToken).update(body).digest('hex')}`;
    expect(verifyWebhookSignature(body, signature, callbackToken)).toBe(true);
    expect(verifyWebhookSignature(body, signature.replace(/.$/, '0'), callbackToken)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, callbackToken)).toBe(false);
    expect(verifyWebhookSignature(`${body} `, signature, callbackToken)).toBe(false);
  });

  it('accepts dispatches and posts callback signals to a webhook endpoint', async () => {
    const callbackBodies: unknown[] = [];
    const callbackEndpoint = createServer((request, response) => {
      void (async () => {
        if (request.headers.authorization !== `Bearer ${callbackToken}`) {
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
    await new Promise<void>((resolve) => callbackEndpoint.listen(0, '127.0.0.1', resolve));
    const callbackAddress = callbackEndpoint.address();
    if (!callbackAddress || typeof callbackAddress === 'string') {
      throw new Error('callback test server did not bind to a TCP address');
    }
    const callbackUrl = `http://127.0.0.1:${callbackAddress.port}/v0/signals`;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
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
      await new Promise<void>((resolve) => callbackEndpoint.close(() => resolve()));
    }
  });

  it('rejects missing auth and unknown handlers', async () => {
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
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
      callbackToken,
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
      callbackToken,
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
      fetchImpl: async () => new Response('callback rejected', { status: 500 }),
      callbackRetry: { maxAttempts: DEFAULT_CALLBACK_MAX_ATTEMPTS, baseDelayMs: 0 },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
        // Bounded retries were exhausted before the terminal failure was recorded.
        expect(jobs[0]?.callbacks?.[0]).toMatchObject({
          signalIndex: 0,
          delivered: false,
          attempts: DEFAULT_CALLBACK_MAX_ATTEMPTS,
        });
        expect(jobs[0]?.lastError).toContain('callback endpoint failed with 500');
      });
      // The exhausted delivery is reported through an error log.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('callback delivery failed for signal 0 after 3 attempt(s)'));
    } finally {
      errorSpy.mockRestore();
      await callbackFailure.close();
    }
  });

  it('retries a failing callback POST with backoff before reporting success', async () => {
    let attempt = 0;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
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
      // Default retry policy: bounded attempts with a real base delay.
      fetchImpl: async () => {
        attempt += 1;
        return attempt < DEFAULT_CALLBACK_MAX_ATTEMPTS
          ? new Response('flaky endpoint', { status: 503 })
          : new Response('ok', { status: 200 });
      },
    });
    try {
      const startedAt = Date.now();
      const response = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-callback-retry', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(executor.url);
        expect(jobs[0]?.status).toBe('callback_succeeded');
        expect(jobs[0]?.callbacks?.[0]).toEqual({
          signalIndex: 0,
          delivered: true,
          attempts: DEFAULT_CALLBACK_MAX_ATTEMPTS,
        });
      });
      expect(attempt).toBe(DEFAULT_CALLBACK_MAX_ATTEMPTS);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(DEFAULT_CALLBACK_RETRY_BASE_DELAY_MS);
    } finally {
      await executor.close();
    }
  });

  it('records per-signal delivery truthfully when only some signals are delivered', async () => {
    const twoSignalHandler: RuntimeExecutorHandler = (dispatchEffect) => ({
      status: 'succeeded',
      signals: [
        {
          zhixuId: dispatchEffect.zhixuId,
          orderId: dispatchEffect.orderId,
          source: 'buyer',
          stageIdentifier: dispatchEffect.stageIdentifier,
          signalName: `${dispatchEffect.stageIdentifier}.cmp`,
          senderId: 'exec-executor',
        },
        {
          zhixuId: dispatchEffect.zhixuId,
          orderId: dispatchEffect.orderId,
          source: 'buyer',
          stageIdentifier: dispatchEffect.stageIdentifier,
          signalName: `${dispatchEffect.stageIdentifier}.done`,
          senderId: 'exec-executor',
        },
      ],
    });
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      handlers: { 'exec.main#START': twoSignalHandler },
      port: 0,
      // The first signal (.cmp) is accepted; every delivery of the second one
      // (.done) fails so the job must end callback_failed while truthfully
      // recording that signal 0 was delivered.
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { signal?: { signalName?: string } };
        if (body.signal?.signalName === 'exec.main.cmp') {
          return new Response('ok', { status: 200 });
        }
        return new Response('callback rejected', { status: 500 });
      },
      callbackRetry: { baseDelayMs: 0 },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-partial-callback', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(executor.url);
        expect(jobs[0]?.status).toBe('callback_failed');
        expect(jobs[0]?.callbacks).toHaveLength(2);
      });
      const jobs = await getJobs(executor.url);
      const job = jobs[0];
      // The delivered signal stays recorded as delivered; the failure must not
      // mask the fact that the first signal went out.
      expect(job?.callbacks?.[0]).toMatchObject({ signalIndex: 0, delivered: true, attempts: 1 });
      expect(job?.callbacks?.[1]?.delivered).toBe(false);
      expect(job?.callbacks?.[1]?.error).toContain('callback endpoint failed with 500');
      expect(job?.lastError).toContain('1/2 signal(s)');
      expect(job?.lastError).toContain('were delivered');
    } finally {
      errorSpy.mockRestore();
      await executor.close();
    }
  });

  it('rejects a duplicate dispatch job id instead of overwriting the existing job', async () => {
    let outboundCalls = 0;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
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
      fetchImpl: async () => {
        outboundCalls += 1;
        return new Response('ok', { status: 200 });
      },
    });
    try {
      const first = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-conflict', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(first.status).toBe(202);

      const second = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ dispatchId: 'dispatch-conflict', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' }),
      });
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({
        error: 'job_already_exists',
        jobId: 'dispatch-conflict',
      });

      const jobs = await getJobs(executor.url);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe('dispatch-conflict');
    } finally {
      await executor.close();
    }
  });

  it('rejects dispatches without a dispatchId instead of synthesizing a timestamped job id', async () => {
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
      handlers: {},
      port: 0,
    });
    try {
      for (const body of [
        { effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' },
        { dispatchId: '', effect, callbackUrl: 'http://127.0.0.1:1/v0/signals' },
      ]) {
        const response = await fetch(`${executor.url}/v0/dispatches`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${executorToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: 'bad_request',
          message: expect.stringContaining('dispatchId'),
        });
      }
      expect(await getJobs(executor.url)).toHaveLength(0);
    } finally {
      await executor.close();
    }
  });

  it('rejects non-loopback callback URLs before enqueuing and never sends the callback token', async () => {
    let outboundCalls = 0;
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
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
      fetchImpl: async () => {
        outboundCalls += 1;
        return new Response('ok', { status: 200 });
      },
    });
    try {
      for (const callbackUrl of [
        'http://169.254.169.254/latest/meta-data/',
        'https://example.invalid/v0/signals',
        'file:///etc/passwd',
      ]) {
        const response = await fetch(`${executor.url}/v0/dispatches`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${executorToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ dispatchId: `dispatch-ssrf-${outboundCalls}`, effect, callbackUrl }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'bad_request' });
      }

      expect(outboundCalls).toBe(0);
      expect(await getJobs(executor.url)).toHaveLength(0);
    } finally {
      await executor.close();
    }
  });

  it('sends the callback bearer token to non-loopback hosts only when allowlisted', async () => {
    const outbound: { url: string; authorization?: string }[] = [];
    const executor = await startExecutorServer({
      executorId: 'exec-executor',
      executorToken,
      callbackToken,
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
      fetchImpl: async (input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        outbound.push({
          url: String(input),
          ...(typeof headers.authorization === 'string' ? { authorization: headers.authorization } : {}),
        });
        return new Response('ok', { status: 200 });
      },
      callbackHostAllowlist: ['callbacks.internal'],
    });

    try {
      const response = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          dispatchId: 'dispatch-allowlisted',
          effect,
          callbackUrl: 'http://callbacks.internal/v0/signals',
        }),
      });
      expect(response.status).toBe(202);
      await eventually(async () => {
        const jobs = await getJobs(executor.url);
        expect(jobs[0]?.status).toBe('callback_succeeded');
      });
      expect(outbound).toEqual([
        {
          url: 'http://callbacks.internal/v0/signals',
          authorization: `Bearer ${callbackToken}`,
        },
      ]);

      const blocked = await fetch(`${executor.url}/v0/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${executorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          dispatchId: 'dispatch-not-allowlisted',
          effect,
          callbackUrl: 'http://other.internal/v0/signals',
        }),
      });
      expect(blocked.status).toBe(400);
      expect(outbound).toHaveLength(1);
    } finally {
      await executor.close();
    }
  });

  it('parses the callback host allowlist env format and validates scheme/host', () => {
    expect(parseCallbackHostAllowlist(undefined)).toEqual([]);
    expect(parseCallbackHostAllowlist('')).toEqual([]);
    expect(parseCallbackHostAllowlist('callbacks.internal:8443, 10.0.0.7 , [::2]')).toEqual([
      'callbacks.internal:8443',
      '10.0.0.7',
      '::2',
    ]);

    expect(() => assertCallbackUrlAllowed('http://127.0.0.1:9/v0/signals', [])).not.toThrow();
    expect(() => assertCallbackUrlAllowed('http://localhost/v0/signals', [])).not.toThrow();
    expect(() => assertCallbackUrlAllowed('http://[::1]/v0/signals', [])).not.toThrow();
    expect(() => assertCallbackUrlAllowed('http://internal.example/v0/signals', ['internal.example'])).not.toThrow();

    expect(() => assertCallbackUrlAllowed('ftp://127.0.0.1/v0/signals', [])).toThrow(/scheme/);
    expect(() => assertCallbackUrlAllowed('http://169.254.169.254/', [])).toThrow(/not allowed/);
    expect(() => assertCallbackUrlAllowed('not a url', [])).toThrow(/valid URL/);
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
