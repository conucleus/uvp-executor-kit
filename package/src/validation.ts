import type { Address, Hex } from 'viem';
import {
  normalizeAddress as normalizeAddressKey,
  normalizeAddressChecksummed as normalizeAddressChecksummedKey,
  normalizeBytes32 as normalizeBytes32Key,
} from '@uvp-eth/protocol-bindings';

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

// 地址/字节规范化双形态的判定单源在 protocol-bindings（宽松 40-hex → 小写
// 比较键 + 严格 EIP-55 → checksummed 展示/签名形态）。本仓不再自带判定
// 副本，只保留错误形态包装：kit 的错误分类学与调用方捕获的是
// ValidationError，而上游抛的是普通 Error。
function rethrowAsValidationError<T>(normalize: () => T): T {
  try {
    return normalize();
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 比较键/存储键权威形态：宽松 40-hex 校验，统一小写输出。
 * 地址等价判定、去重键、集合成员判定必须用本形态——绝不能一侧
 * checksummed 一侧小写地直接比较。
 */
export function normalizeAddress(value: Address | string, fieldName = 'address'): Address {
  return rethrowAsValidationError(() => normalizeAddressKey(value, fieldName));
}

/**
 * 展示/签名形态：严格 EIP-55 checksum 校验（混合大小写且错拼即拒），
 * 输出 checksummed。用于入口校验与对外展示/上链载荷字段。
 */
export function normalizeAddressChecksummed(value: Address | string, fieldName = 'address'): Address {
  return rethrowAsValidationError(() => normalizeAddressChecksummedKey(value, fieldName));
}

export function normalizeBytes32(value: Hex | string, fieldName = 'bytes32'): Hex {
  return rethrowAsValidationError(() => normalizeBytes32Key(value, fieldName));
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
