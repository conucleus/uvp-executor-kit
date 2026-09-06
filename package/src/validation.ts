import { getAddress, isAddress, isHex } from 'viem';
import type { Address, Hex } from 'viem';

export class ExecutorKitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorKitError';
  }
}

export class ValidationError extends ExecutorKitError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotImplementedExecutorKitError extends ExecutorKitError {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedExecutorKitError';
  }
}

const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;

export function normalizeAddress(value: Address | string, fieldName = 'address'): Address {
  if (!isAddress(value)) {
    throw new ValidationError(`${fieldName} must be a valid EVM address`);
  }

  return getAddress(value);
}

export function normalizeBytes32(value: Hex | string, fieldName = 'bytes32'): Hex {
  if (!isHex(value) || !BYTES32_RE.test(value)) {
    throw new ValidationError(`${fieldName} must be a 32-byte hex value`);
  }

  return value.toLowerCase() as Hex;
}

export function parseBigNumberish(value: bigint | number | string, fieldName: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${fieldName} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }

  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(`${fieldName} must be a non-negative integer string`);
  }

  return BigInt(value);
}

export function parsePositiveInteger(value: number | string, fieldName: string): number {
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(`${fieldName} must be a positive integer string`);
  }

  const numberValue = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new ValidationError(`${fieldName} must be a positive safe integer`);
  }

  return numberValue;
}
