import type { Command } from 'commander';
import { loadExecutorConfig } from '../../server.js';
import { stringifyForTransport } from '../../transport.js';
import { loadStateMachineHandlerConfig } from '../../watcher/index.js';
import { ValidationError } from '../../validation.js';
import {
  stateMachineHandlerConfigToExecutorConfigDTO,
  summarizeSupplierOps,
} from '../output.js';
import type { ConfigValidateOptions } from '../options.js';

/** config validate 命令分发。 */
export function registerConfigValidateCommand(program: Command): void {
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
