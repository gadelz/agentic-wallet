/**
 * KeyStore abstraction
 *
 * DECOUPLES secret-key custody from wallet logic.
 *
 * The WalletManager never encrypts/decrypts key material itself: it hands a
 * freshly generated private key to a KeyStore (wrap), asks it back only for
 * the moment of signing (unwrap), and forgets it (delete).
 *
 * This is the seam that lets a deployment move from local AES-256-GCM files
 * (developer/devnet) to a hardened custody backend (HashiCorp Vault Transit,
 * AWS KMS, an HSM) WITHOUT touching wallet, agent, or route code.
 */

/**
 * A backend that persists and retrieves Solana secret keys.
 *
 * Implementations MUST:
 * - Never persist plaintext key material on disk.
 * - Return an opaque `keyRef` from `wrap` that is safe to store in a plain
 *   database alongside public wallet metadata (it is backend-specific).
 * - Never log or expose the secret key bytes.
 */
export interface KeyStore {
  /** Backend identifier, used for audit/metadata (e.g. `local`, `vault-transit`). */
  readonly backend: string;

  /**
   * Persist a freshly generated secret key.
   * @param walletId  The wallet this key belongs to.
   * @param secretKey Raw 64-byte Ed25519 secret key.
   * @returns An opaque reference that may be persisted with the wallet.
   */
  wrap(walletId: string, secretKey: Uint8Array): Promise<string>;

  /**
   * Retrieve the secret key for signing.
   * @param walletId  The wallet this key belongs to.
   * @param keyRef    The opaque reference returned by `wrap`.
   */
  unwrap(walletId: string, keyRef: string): Promise<Uint8Array>;

  /**
   * Forget the key material for a wallet.
   * Backends with remote copies (Vault/KMS) should delete/revoke where
   * supported; backends without remote state may be a no-op.
   */
  delete(walletId: string, keyRef: string): Promise<void>;
}
