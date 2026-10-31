/**
 * LocalEncryptedKeyStore
 *
 * DEFAULT backend. Preserves the original behaviour: AES-256-GCM with scrypt
 * KDF, encrypted blobs persisted to `data/keystore_local.json`. The secret is
 * only ever decrypted for the duration of a `unwrap` call (signing) and is
 * zeroed by the caller afterwards.
 *
 * Suitable for devnet/development. NOT for production custody — production
 * deployments should select the `vault-transit` backend (see the factory).
 */

import { encrypt, decrypt } from '../../utils/encryption.js';
import { saveState, loadState } from '../../utils/store.js';
import type { KeyStore } from './types.js';

const LOCAL_STORE_KEY = 'keystore_local';

interface LocalStoreShape {
  /** walletId -> encrypted blob (AES-256-GCM, base64 "salt:iv:tag:ct") */
  blobs: Record<string, string>;
}

export class LocalEncryptedKeyStore implements KeyStore {
  readonly backend = 'local';

  private blobs = new Map<string, string>();
  private readonly encryptionSecret: string;

  constructor(encryptionSecret: string) {
    this.encryptionSecret = encryptionSecret;
    this.loadFromStore();
  }

  async wrap(walletId: string, secretKey: Uint8Array): Promise<string> {
    const blob = encrypt(secretKey, this.encryptionSecret);
    this.blobs.set(walletId, blob);
    this.saveToStore();
    return `local:${walletId}`;
  }

  async unwrap(walletId: string, _keyRef: string): Promise<Uint8Array> {
    const blob = this.blobs.get(walletId);
    if (!blob) {
      throw new Error(`No key material available for wallet ${walletId}`);
    }
    // Decrypt on demand; caller zeroes the returned buffer after signing.
    return decrypt(blob, this.encryptionSecret);
  }

  async delete(walletId: string, _keyRef: string): Promise<void> {
    if (this.blobs.delete(walletId)) {
      this.saveToStore();
    }
  }

  // ── Persistence ──────────────────────────────────────────────

  private saveToStore(): void {
    const blobs: Record<string, string> = {};
    for (const [id, blob] of this.blobs.entries()) {
      blobs[id] = blob;
    }
    saveState<LocalStoreShape>(LOCAL_STORE_KEY, { blobs });
  }

  private loadFromStore(): void {
    const saved = loadState<LocalStoreShape>(LOCAL_STORE_KEY);
    if (!saved?.blobs) return;
    for (const [id, blob] of Object.entries(saved.blobs)) {
      this.blobs.set(id, blob);
    }
  }
}
