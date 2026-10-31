/**
 * KeyStore Tests
 *
 * Validates the key-custody abstraction:
 * - LocalEncryptedKeyStore round-trips secret keys without exposing them.
 * - VaultTransitKeyStore enforces https and round-trips via the transit API.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub persistence so tests don't write to disk
vi.mock('../src/utils/store.js', () => ({
  saveState: vi.fn(),
  loadState: vi.fn().mockReturnValue(null),
}));

import { LocalEncryptedKeyStore } from '../src/wallet/keystore/local-keystore.js';
import { VaultTransitKeyStore } from '../src/wallet/keystore/vault-transit-keystore.js';
import { Keypair } from '@solana/web3.js';

const SECRET = 'test-encryption-secret-32-characters-long!!';

describe('LocalEncryptedKeyStore', () => {
  it('wraps and unwraps a secret key without data loss', async () => {
    const ks = new LocalEncryptedKeyStore(SECRET);
    const kp = Keypair.generate();

    const keyRef = await ks.wrap('w1', kp.secretKey);
    expect(keyRef).toMatch(/^local:w1$/);

    const unwrapped = await ks.unwrap('w1', keyRef);
    expect(Buffer.from(unwrapped).toString('hex')).toBe(
      Buffer.from(kp.secretKey).toString('hex')
    );
  });

  it('throws for an unknown wallet', async () => {
    const ks = new LocalEncryptedKeyStore(SECRET);
    await expect(ks.unwrap('missing', 'local:missing')).rejects.toThrow(/No key material/);
  });

  it('deletes key material', async () => {
    const ks = new LocalEncryptedKeyStore(SECRET);
    const kp = Keypair.generate();
    const keyRef = await ks.wrap('w2', kp.secretKey);
    await ks.delete('w2', keyRef);
    await expect(ks.unwrap('w2', keyRef)).rejects.toThrow(/No key material/);
  });

  it('never returns the key material in the keyRef', async () => {
    const ks = new LocalEncryptedKeyStore(SECRET);
    const kp = Keypair.generate();
    const keyRef = await ks.wrap('w3', kp.secretKey);
    expect(keyRef).not.toContain(Buffer.from(kp.secretKey).toString('hex'));
    expect(keyRef).not.toContain(Buffer.from(kp.secretKey).toString('base64'));
  });
});

describe('VaultTransitKeyStore', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (String(url).includes('/encrypt/')) {
          return new Response(
            JSON.stringify({ data: { ciphertext: `vault:v1:${body.plaintext}` } }),
            { status: 200 }
          );
        }
        if (String(url).includes('/decrypt/')) {
          const ct = String(body.ciphertext);
          return new Response(
            JSON.stringify({ data: { plaintext: ct.replace('vault:v1:', '') } }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 404 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('refuses a non-https vault address (fail-closed)', () => {
    expect(
      () =>
        new VaultTransitKeyStore({
          vaultAddr: 'http://vault.internal:8200',
          vaultToken: 'some-long-token-12345',
          transitMount: 'transit',
          transitKeyName: 'agentic-wallet',
        })
    ).toThrow(/https/);
  });

  it('wraps and unwraps through the transit API', async () => {
    const ks = new VaultTransitKeyStore({
      vaultAddr: 'https://vault.example.com',
      vaultToken: 'some-long-token-12345',
      transitMount: 'transit',
      transitKeyName: 'agentic-wallet',
      disableCache: true,
    });
    const kp = Keypair.generate();

    const keyRef = await ks.wrap('wv1', kp.secretKey);
    expect(keyRef).toMatch(/^vault:v1:/);

    const unwrapped = await ks.unwrap('wv1', keyRef);
    expect(Buffer.from(unwrapped).toString('hex')).toBe(
      Buffer.from(kp.secretKey).toString('hex')
    );
  });

  it('throws a clear error when Vault returns an error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 }))
    );
    const ks = new VaultTransitKeyStore({
      vaultAddr: 'https://vault.example.com',
      vaultToken: 'some-long-token-12345',
      transitMount: 'transit',
      transitKeyName: 'agentic-wallet',
    });
    await expect(ks.wrap('wv2', Keypair.generate().secretKey)).rejects.toThrow(
      /Vault encrypt failed \(403\)/
    );
  });
});
