import { readFile } from 'node:fs/promises';
import { keccak256, toHex } from 'viem';
import type { Hex } from 'viem';

export {
  canonicalJson,
  hashEvidenceBytes,
  hashEvidenceJson,
  hashEvidenceText,
} from '@uvp-eth/protocol-bindings';

export interface EvidenceHashResult {
  algorithm: 'keccak256';
  evidenceHash: Hex;
  byteLength: number;
  source: 'bytes' | 'file' | 'json' | 'text';
  path?: string;
}

export async function hashEvidenceFile(path: string): Promise<EvidenceHashResult> {
  const bytes = await readFile(path);
  return {
    algorithm: 'keccak256',
    evidenceHash: keccak256(toHex(bytes)),
    byteLength: bytes.byteLength,
    source: 'file',
    path,
  };
}
