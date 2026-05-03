import { describe, expect, it } from 'vitest';
import { canonicalJson, hashEvidenceJson, hashEvidenceText } from '../src/evidence.js';

describe('evidence hashing', () => {
  it('canonicalizes object keys recursively', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it('hashes equivalent JSON objects to the same evidence hash', () => {
    const left = hashEvidenceJson({ b: 2, a: 1 });
    const right = hashEvidenceJson({ a: 1, b: 2 });

    expect(left.evidenceHash).toBe(right.evidenceHash);
    expect(left.algorithm).toBe('keccak256');
  });

  it('keeps text hashing distinct from JSON string hashing', () => {
    expect(hashEvidenceText('paid').evidenceHash).not.toBe(hashEvidenceJson('paid').evidenceHash);
  });
});
