import type { Command } from 'commander';
import { stringifyForTransport } from '../../transport.js';
import { ValidationError } from '../../validation.js';
import {
  addressFromPrivateKey,
  DEFAULT_WALLET_ADDRESS_ENV,
  DEFAULT_WALLET_PRIVATE_KEY_ENV,
  getFaucetInfo,
  writeWalletEnvFile,
} from '../../wallet.js';
import type {
  FaucetInfoOptions,
  WalletAddressOptions,
  WalletNewOptions,
} from '../options.js';

/** wallet + faucet 命令分发。 */
export function registerWalletCommands(program: Command): void {
  const wallet = program.command('wallet').description('manage local executor/deployer wallet material');
  wallet
    .command('new')
    .description('create a new wallet and write it to a gitignored env file')
    .option('--env-file <path>', 'env file to write', '.env.local')
    .option('--overwrite', 'replace an existing env file')
    .option('--private-key-env <name>', 'private key env var name', DEFAULT_WALLET_PRIVATE_KEY_ENV)
    .option('--address-env <name>', 'address env var name', DEFAULT_WALLET_ADDRESS_ENV)
    .action(async (options: WalletNewOptions) => {
      const result = await writeWalletEnvFile(options.envFile, {
        privateKeyEnv: options.privateKeyEnv,
        addressEnv: options.addressEnv,
        ...(options.overwrite ? { overwrite: true } : {}),
      });
      console.log(stringifyForTransport({
        wallet: {
          address: result.address,
          envFile: result.envFile,
          privateKeyEnv: result.privateKeyEnv,
          addressEnv: result.addressEnv,
          overwritten: result.overwritten,
        },
      }));
    });

  wallet
    .command('address')
    .description('derive the wallet address from a private key env var')
    .option('--private-key-env <name>', 'private key env var name', DEFAULT_WALLET_PRIVATE_KEY_ENV)
    .action((options: WalletAddressOptions) => {
      const privateKey = process.env[options.privateKeyEnv];
      if (!privateKey) {
        throw new ValidationError(`missing private key env var ${options.privateKeyEnv}`);
      }
      console.log(stringifyForTransport({
        wallet: {
          address: addressFromPrivateKey(privateKey, options.privateKeyEnv),
          privateKeyEnv: options.privateKeyEnv,
        },
      }));
    });

  const faucet = program.command('faucet').description('show testnet faucet guidance');
  faucet
    .command('info')
    .description('print faucet links for a supported testnet')
    .option('--network <name>', 'testnet name', 'base-sepolia')
    .option('--address <address>', 'optional address to fund')
    .action((options: FaucetInfoOptions) => {
      console.log(stringifyForTransport({ faucet: getFaucetInfo(options.network, options.address) }));
    });
}
