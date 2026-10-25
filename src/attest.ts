// Attestations: a signed statement by the system that executed an action for the agent (an email sent, a payment made),
// verified with a pinned Ed25519 public key. The only evidence for an action that leaves no local trace. Signatures
// authenticate the issuer, not the world; a pinned key never comes from the report or the request body.
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { Attestation } from './types.ts';

/** Deterministic JSON: sorted keys, no whitespace, so that signer and verifier hash the same bytes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function loadPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('attestation public key must be Ed25519');
  return key;
}

/** For an issuer: signs the body with its Ed25519 private key (PEM). The verifier never holds this key. */
export function signAttestation(body: Omit<Attestation, 'signature'>, privateKeyPem: string): Attestation {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('attestation private key must be Ed25519');
  return { ...body, signature: cryptoSign(null, Buffer.from(canonical(body), 'utf8'), key).toString('base64') };
}

export interface AttestationCheck { ok: boolean; reason: string }

const MAX_AGE_SECONDS = 7 * 24 * 3600;

/** Shape, scope (execution id), freshness and signature. `now` is injectable for a replay. */
export function verifyAttestation(a: unknown, key: KeyObject, executionId: string, now = Math.floor(Date.now() / 1000)): AttestationCheck {
  if (!a || typeof a !== 'object') return { ok: false, reason: 'not an object' };
  const o = a as Record<string, unknown>;
  if (o.schema !== 'truthgate.attestation.v1') return { ok: false, reason: 'unknown schema' };
  for (const k of ['issuer', 'executionId', 'operation', 'signature']) if (typeof o[k] !== 'string' || !(o[k] as string)) return { ok: false, reason: `missing ${k}` };
  if (o.state !== 'completed' && o.state !== 'failed') return { ok: false, reason: 'state must be completed or failed' };
  if (!o.params || typeof o.params !== 'object' || Array.isArray(o.params) || Object.values(o.params as object).some((v) => typeof v !== 'string')) return { ok: false, reason: 'params must be a string map' };
  if (typeof o.issuedAt !== 'number' || !Number.isInteger(o.issuedAt)) return { ok: false, reason: 'issuedAt must be an integer timestamp' };
  if (o.executionId !== executionId) return { ok: false, reason: 'execution id does not match this run' };
  if (o.issuedAt > now + 60 || now - o.issuedAt > MAX_AGE_SECONDS) return { ok: false, reason: 'issued in the future or older than seven days' };
  const { signature, ...body } = o;
  let sig: Buffer;
  try { sig = Buffer.from(signature as string, 'base64'); } catch { return { ok: false, reason: 'signature is not base64' }; }
  const valid = cryptoVerify(null, Buffer.from(canonical(body), 'utf8'), key, sig);
  return valid ? { ok: true, reason: 'valid signature by the pinned key' } : { ok: false, reason: 'bad signature' };
}

const IDENTIFIERS = /[\w.+-]+@[\w-]+\.[\w.-]+|https?:\/\/\S+|\b\d[\d,.]{2,}\b/g;

/** The attestation identifies the claimed action: every word of its operation appears in the claim, at least one of
 *  its parameter values (when it has any) appears too, and every identifier the claim names (an address, a URL, a
 *  number) is one of those values; a send to another recipient or of another amount is not this attestation. */
export function attestationMatches(a: Attestation, claimText: string): boolean {
  const text = claimText.toLowerCase();
  const words = a.operation.toLowerCase().split(/[_\-\s.]+/).filter((w) => w.length >= 3);
  if (!words.length) return false;
  const values = Object.values(a.params).map((v) => v.toLowerCase()).filter((v) => v.length >= 4);
  // With parameters, a value identifies the action and one operation word suffices ("sent the email to X");
  // without, every operation word must be there.
  const wordsNeeded = values.length ? 1 : words.length;
  if (words.filter((w) => text.includes(w)).length < wordsNeeded) return false;
  if (values.length && !values.some((v) => text.includes(v))) return false;
  const named = text.match(IDENTIFIERS) ?? [];
  const norm = (x: string) => x.replace(/[.,]+$/, '').replace(/^\$/, '').replace(/[,\s_]/g, '').replace(/\.0+$/, '');
  return named.every((id) => values.some((v) => v.includes(id.replace(/[.,]+$/, '')) || id.includes(v) || (norm(id) !== '' && norm(id) === norm(v))));
}
