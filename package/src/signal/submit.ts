import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadPrivateKeyFromEnv } from '../signing.js';
import { ValidationError } from '../validation.js';
import {
  buildSubmitStateMachineSignalCall,
  normalizeSubmitConfig,
  type NormalizedSubmitConfig,
  type StateMachinePublicClient,
  type StateMachineSignal,
  type SubmitStateMachineSignalCall,
  type SubmitStateMachineSignalConfig,
} from './build.js';

export type SubmitStateMachineSignalResult =
  | {
    readonly dryRun: true;
    readonly request: SubmitStateMachineSignalCall;
  }
  | {
    readonly dryRun: false;
    readonly request: SubmitStateMachineSignalCall;
    readonly txHash: Hex;
    readonly confirmed?: boolean;
  };

/**
 * Thrown after a submitSignal transaction was already broadcast but its receipt
 * could not be confirmed: either the receipt came back with status 'reverted'
 * or waiting for the receipt itself failed (timeout, RPC fault). The broadcast
 * txHash rides on the error so callers can keep the already-broadcast
 * transaction in the job audit trail instead of losing it to a retry.
 * `reverted` separates the two cases: only a receipt actually observed as
 * 'reverted' is a known outcome; a receipt that could not be obtained (or
 * carries a status string the kit does not recognize) leaves the broadcast's
 * outcome unknown and must never terminalize the job.
 */
export class SubmitSignalReceiptError extends Error {
  readonly txHash: Hex;
  readonly reverted: boolean;

  constructor(txHash: Hex, message: string, options?: { readonly cause?: unknown; readonly reverted?: boolean }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SubmitSignalReceiptError';
    this.txHash = txHash;
    this.reverted = options?.reverted ?? false;
  }
}

export async function submitStateMachineSignal(
  config: SubmitStateMachineSignalConfig,
  signal: StateMachineSignal,
): Promise<SubmitStateMachineSignalResult> {
  const normalizedConfig = normalizeSubmitConfig(config);

  if (normalizedConfig.dryRun) {
    const from = resolveConfiguredWalletAddress(normalizedConfig);
    if (!from) {
      throw new ValidationError(
        `dry-run requires walletAddress or a private key env var in ${normalizedConfig.privateKeyEnv} so the from address can be shown`,
      );
    }
    const request = buildSubmitStateMachineSignalCall(normalizedConfig, signal, from);
    return {
      dryRun: true,
      request,
    };
  }

  const privateKey = loadPrivateKeyFromEnv(normalizedConfig.privateKeyEnv);
  if (!privateKey) {
    throw new ValidationError(`missing private key env var ${normalizedConfig.privateKeyEnv}`);
  }

  const client = getPublicClient(normalizedConfig);
  await ensureChainId(client, normalizedConfig.chainId);

  const account = privateKeyToAccount(privateKey);
  if (normalizedConfig.walletAddress && normalizedConfig.walletAddress !== account.address) {
    throw new ValidationError(`walletAddress ${normalizedConfig.walletAddress} does not match ${normalizedConfig.privateKeyEnv} address ${account.address}`);
  }
  const requestWithFrom = buildSubmitStateMachineSignalCall(normalizedConfig, signal, account.address);
  const wallet = createWalletClient({
    account,
    chain: buildChain(normalizedConfig.chainId, normalizedConfig.rpcUrl),
    transport: http(normalizedConfig.rpcUrl),
  });
  const txHash = await wallet.writeContract({
    address: requestWithFrom.address,
    abi: requestWithFrom.abi,
    functionName: requestWithFrom.functionName,
    args: requestWithFrom.args,
  });
  let confirmed: boolean | undefined;
  if (normalizedConfig.waitForReceipt && client.waitForTransactionReceipt) {
    let receipt: { readonly status?: 'success' | 'reverted' | string };
    try {
      receipt = await client.waitForTransactionReceipt({ hash: txHash });
    } catch (error) {
      // The tx is already on chain; never let a receipt-wait fault drop the
      // hash of what was broadcast.
      const detail = error instanceof Error ? error.message : String(error);
      throw new SubmitSignalReceiptError(txHash, `submitSignal transaction receipt wait failed for ${txHash}: ${detail}`, { cause: error });
    }
    if (receipt.status === 'reverted') {
      throw new SubmitSignalReceiptError(txHash, `submitSignal transaction receipt status ${receipt.status}`, { reverted: true });
    }
    confirmed = receipt.status === 'success';
  }

  return {
    dryRun: false,
    request: requestWithFrom,
    txHash,
    ...(confirmed !== undefined ? { confirmed } : {}),
  };
}

export function getPublicClient(config: Pick<NormalizedSubmitConfig, 'chainId' | 'rpcUrl' | 'publicClient'>): StateMachinePublicClient {
  if (config.publicClient) {
    return config.publicClient;
  }
  return createPublicClient({
    chain: buildChain(config.chainId, config.rpcUrl),
    transport: http(config.rpcUrl),
  }) as unknown as StateMachinePublicClient;
}

function resolveConfiguredWalletAddress(config: Pick<NormalizedSubmitConfig, 'walletAddress' | 'privateKeyEnv'>): Address | undefined {
  if (config.walletAddress) {
    return config.walletAddress;
  }
  const privateKey = loadPrivateKeyFromEnv(config.privateKeyEnv);
  return privateKey ? privateKeyToAccount(privateKey).address : undefined;
}

export async function ensureChainId(client: StateMachinePublicClient, expectedChainId: number): Promise<void> {
  const actualChainId = await client.getChainId();
  if (actualChainId !== expectedChainId) {
    throw new ValidationError(`wrong chain id: got ${actualChainId}, expected ${expectedChainId}`);
  }
}

function buildChain(chainId: number, rpcUrl: string) {
  return {
    id: chainId,
    name: `uvp-${chainId}`,
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: [rpcUrl],
      },
    },
  } as const;
}
