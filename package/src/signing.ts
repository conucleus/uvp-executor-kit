import type { Hex } from 'viem';
import { ValidationError } from './validation.js';

export const DEFAULT_SIGNING_KEY_ENV = 'UVP_EXECUTOR_PRIVATE_KEY';

export function loadPrivateKeyFromEnv(envName = DEFAULT_SIGNING_KEY_ENV): Hex | undefined {
  const value = process.env[envName];
  if (!value) {
    return undefined;
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new ValidationError(`${envName} must contain a 32-byte private key hex string`);
  }

  return value as Hex;
}
