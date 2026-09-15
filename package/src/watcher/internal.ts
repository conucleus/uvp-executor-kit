/**
 * Watcher-internal leaf helpers shared across the scan/jobs/storage/execution
 * modules (process liveness, error shaping, small parse/coerce utilities).
 * Module-level exports only — none of these are part of the SDK surface.
 */
/** Signal 0 探测存活；EPERM 表示进程存在但属主不同，仍算存活。 */
import { ValidationError } from '../validation.js';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === 'EPERM';
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function parseNonNegativeSafeInteger(value: number | string, fieldName: string): number {
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError(`${fieldName} must be a non-negative integer string`);
  }

  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new ValidationError(`${fieldName} must be a non-negative safe integer`);
  }
  return numberValue;
}

export function asString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  return value;
}

export function asNumberOrString(value: unknown, fieldName: string): number | string {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a number or string`);
  }
  return value;
}

export function asNonEmptyString(value: unknown, fieldName: string): string {
  const text = asString(value, fieldName).trim();
  if (text.length === 0) {
    throw new ValidationError(`${fieldName} must be a non-empty string`);
  }
  return text;
}

export function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
