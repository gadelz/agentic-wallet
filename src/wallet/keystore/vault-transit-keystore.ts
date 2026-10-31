/**
 * VaultTransitKeyStore
 *
 * PRODUCTION custody backend. Secret keys are encrypted by HashiCorp Vault's
 * `transit` engine (an asymmetric-encryption key managed inside Vault), so:
 *
 * - The raw private key NEVER touches disk. It exists only in Vault (encrypted
 *   by the transit key) and in this process for the moment of signing.
 * - Vault holds the encryption key; a compromised wallet database yields only
 *   ciphertext blobs (the `keyRef`), which are useless without Vault access.
 * - Signing still happens locally with the decrypted key (Vault transit does
 *   not sign Ed25519 on Solana's behalf), so the custody guarantee is "keys
 *   are stored encrypted by Vault", not "Vault signs".
 *
 * Env wiring (see the factory): VAULT_ADDR (https only), VAULT_TOKEN,
 * VAULT_TRANSIT_MOUNT, VAULT_TRANSIT_KEY_NAME. The transit key must be created
 * in Vault beforehand:
 *
 *   vault secrets enable transit
 *   vault write -f transit/keys/agentic-wallet type=ed25519
 */

import type { KeyStore } from './types.js';

export interface VaultOptions {
  vaultAddr: string;
  vaultToken: string;
  transitMount: string;
  transitKeyName: string;
  /** Disable the in-process plaintext cache (default false). */
  disableCache?: boolean;
}

export class VaultTransitKeyStore implements KeyStore {
  readonly backend = 'vault-transit';

  private readonly opts: VaultOptions;
  // Small in-process cache: keyRef -> secretKey, so repeated signs within a
  // process don't re-issue a network round-trip. Plaintext only lives in RAM;
  // nothing is ever written to disk. Disable with disableCache for the strictest
  // "never hold plaintext" posture.
  private readonly cache = new Map<string, Uint8Array>();

  constructor(opts: VaultOptions) {
    if (!/^https:\/\//i.test(opts.vaultAddr)) {
      throw new Error(
        'VAULT_ADDR must be an https:// URL — refusing plaintext transport for key custody'
      );
    }
    if (opts.vaultToken.length < 10) {
      console.warn('⚠ WARNING: VAULT_TOKEN looks short. Rotate before production.');
    }
    this.opts = opts;
  }

  async wrap(walletId: string, secretKey: Uint8Array): Promise<string> {
    const plaintext = Buffer.from(secretKey).toString('base64');
    const res = await fetch(
      `${this.opts.vaultAddr}/v1/${this.opts.transitMount}/encrypt/${this.opts.transitKeyName}`,
      {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.opts.vaultToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ plaintext }),
      }
    );
    if (!res.ok) {
      throw new Error(`Vault encrypt failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: { ciphertext?: string } };
    const ciphertext = json.data?.ciphertext;
    if (!ciphertext) {
      throw new Error('Vault encrypt response missing ciphertext');
    }
    this.cache.delete(walletId);
    // The ciphertext blob doubles as the keyRef; it is safe to persist anywhere.
    return ciphertext;
  }

  async unwrap(walletId: string, keyRef: string): Promise<Uint8Array> {
    if (!this.opts.disableCache) {
      const cached = this.cache.get(keyRef);
      if (cached) return cached;
    }
    const res = await fetch(
      `${this.opts.vaultAddr}/v1/${this.opts.transitMount}/decrypt/${this.opts.transitKeyName}`,
      {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.opts.vaultToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ciphertext: keyRef }),
      }
    );
    if (!res.ok) {
      throw new Error(`Vault decrypt failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: { plaintext?: string } };
    const plaintext = json.data?.plaintext;
    if (!plaintext) {
      throw new Error('Vault decrypt response missing plaintext');
    }
    const secretKey = new Uint8Array(Buffer.from(plaintext, 'base64'));
    if (!this.opts.disableCache) {
      this.cache.set(keyRef, secretKey);
    }
    return secretKey;
  }

  async delete(walletId: string, keyRef: string): Promise<void> {
    this.cache.delete(keyRef);
    // Transit keys are versioned; Vault has no per-ciphertext delete. Key
    // revocation/rotation is an operational concern (see docs/keystore.md).
    void walletId;
  }
}
