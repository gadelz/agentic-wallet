/**
 * KeyStore factory — selects the custody backend from configuration.
 *
 * Backends:
 *  - `local`          (default) AES-256-GCM on-disk; devnet/development only.
 *  - `vault-transit`  HashiCorp Vault transit engine; production custody.
 *
 * Selecting `vault-transit` without a usable VAULT_ADDR/VAULT_TOKEN throws at
 * startup — fail-closed, never silently fall back to local.
 */

import type { KeyStore } from './types.js';
import { LocalEncryptedKeyStore } from './local-keystore.js';
import { VaultTransitKeyStore } from './vault-transit-keystore.js';
import { getConfig } from '../../utils/config.js';

let instance: KeyStore | null = null;

export function createKeyStore(): KeyStore {
  const config = getConfig();

  if (config.KEY_STORE_BACKEND === 'vault-transit') {
    return new VaultTransitKeyStore({
      vaultAddr: config.VAULT_ADDR,
      vaultToken: config.VAULT_TOKEN,
      transitMount: config.VAULT_TRANSIT_MOUNT,
      transitKeyName: config.VAULT_TRANSIT_KEY_NAME,
    });
  }

  // Default: local AES-256-GCM
  return new LocalEncryptedKeyStore(config.KEY_ENCRYPTION_SECRET);
}

export function getKeyStore(): KeyStore {
  if (!instance) {
    instance = createKeyStore();
  }
  return instance;
}
