import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addressFromPrivateKey,
  createWalletEnv,
  getFaucetInfo,
  writeWalletEnvFile,
} from '../src/wallet.js';
import { ValidationError } from '../src/validation.js';

describe('wallet helpers', () => {
  it('generates an env file without returning the private key in the public write result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uvp-wallet-'));
    try {
      const envFile = join(dir, '.env.local');
      const result = await writeWalletEnvFile(envFile);
      const text = await readFile(envFile, 'utf8');
      const generatedPrivateKey = text.match(/UVP_ETH_DEPLOYER_PRIVATE_KEY=(0x[a-fA-F0-9]{64})/)?.[1];

      expect(result.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(generatedPrivateKey).toBeDefined();
      expect(JSON.stringify(result)).not.toContain(generatedPrivateKey);
      expect(text).toContain('UVP_ETH_DEPLOYER_PRIVATE_KEY=0x');
      expect(text).toContain(`UVP_ETH_DEPLOYER_ADDRESS=${result.address}`);
      await expect(writeWalletEnvFile(envFile)).rejects.toThrow(ValidationError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('derives addresses from private keys', () => {
    const wallet = createWalletEnv();

    expect(addressFromPrivateKey(wallet.privateKey)).toBe(wallet.address);
    expect(() => addressFromPrivateKey('bad-key')).toThrow(ValidationError);
  });

  it('prints supported faucet metadata', () => {
    const info = getFaucetInfo('base-sepolia', '0x0000000000000000000000000000000000000001');

    expect(info.chainId).toBe(84532);
    expect(info.address).toBe('0x0000000000000000000000000000000000000001');
    expect(info.links.some((link) => link.includes('docs.base.org'))).toBe(true);
    expect(() => getFaucetInfo('mainnet')).toThrow(ValidationError);
  });
});
