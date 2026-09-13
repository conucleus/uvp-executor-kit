import type { Command } from 'commander';
import {
  createHandlersFromExecutorConfig,
  DEFAULT_CALLBACK_HMAC_SECRET_ENV,
  DEFAULT_CALLBACK_TOKEN_ENV,
  DEFAULT_EXECUTOR_TOKEN_ENV,
  loadExecutorConfig,
  startExecutorServer,
} from '../../server.js';
import { stringifyForTransport } from '../../transport.js';
import {
  parsePort,
  readSecretFromEnv,
  waitForShutdown,
  type ServeOptions,
} from '../options.js';

/** serve 命令分发（本地 executor HTTP 服务）。 */
export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('start a local executor HTTP server')
    .requiredOption('--config <path>', 'executor config JSON path')
    .option('--host <host>', 'host to bind', '127.0.0.1')
    .option('--port <port>', 'port to bind', '0')
    .option('--executor-token-env <name>', 'env var containing executor dispatch bearer token', DEFAULT_EXECUTOR_TOKEN_ENV)
    .option('--callback-token-env <name>', 'env var containing executor callback bearer token', DEFAULT_CALLBACK_TOKEN_ENV)
    .option('--callback-hmac-secret-env <name>', 'env var containing callback HMAC secret', DEFAULT_CALLBACK_HMAC_SECRET_ENV)
    .option('--ready-json', 'print a ready JSON line after the server starts')
    .action(async (options: ServeOptions) => {
      const config = await loadExecutorConfig(options.config);
      // Secrets come only from named env vars: a value passed as a flag is
      // visible to every process listing command lines (ps).
      const handle = await startExecutorServer({
        executorId: config.executorId,
        handlers: createHandlersFromExecutorConfig(config),
        executorToken: readSecretFromEnv(options.executorTokenEnv, 'executor token'),
        callbackToken: readSecretFromEnv(options.callbackTokenEnv, 'callback token'),
        ...(process.env[options.callbackHmacSecretEnv]?.trim()
          ? { callbackHmacSecret: process.env[options.callbackHmacSecretEnv]!.trim() }
          : {}),
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
}
