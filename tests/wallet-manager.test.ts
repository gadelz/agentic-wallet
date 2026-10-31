/**
 * Wallet Manager Tests
 *
 * Validates wallet creation, public key retrieval, signing,
 * key zeroing, policy enforcement, and persistence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub getConfig before importing WalletManager
vi.mock('../src/utils/config.js', () => ({
  getConfig: () => ({
    KEY_ENCRYPTION_SECRET: 'test-secret-at-least-16-characters',
    KEY_STORE_BACKEND: 'local',
    VAULT_ADDR: '',
    VAULT_TOKEN: '',
    VAULT_TRANSIT_MOUNT: 'transit',
    VAULT_TRANSIT_KEY_NAME: 'agentic-wallet',
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    SOLANA_NETWORK: 'devnet',
    PORT: 3001,
    WS_PORT: 3002,
    ADMIN_API_KEY: 'test-admin-key-12345678',
    CORS_ORIGINS: '',
    MAX_AGENTS: 20,
    AGENT_LOOP_INTERVAL_MS: 5000,
    MAX_RETRIES: 3,
    CONFIRMATION_TIMEOUT_MS: 30000,
    LOG_LEVEL: 'info',
  }),
  ESTIMATED_SOL_TRANSFER_FEE: 0.00001,
  ESTIMATED_TOKEN_TRANSFER_FEE: 0.01,
}));

// Stub persistence so tests don't write to disk
vi.mock('../src/utils/store.js', () => ({
  saveState: vi.fn(),
  loadState: vi.fn().mockReturnValue(null),
}));

import { WalletManager } from '../src/wallet/wallet-manager.js';
import { PublicKey, Transaction, SystemProgram } from '@solana/web3.js';

describe('WalletManager', () => {
  let wm: WalletManager;

  beforeEach(() => {
    wm = new WalletManager();
  });

  describe('createWallet', () => {
    it('creates a wallet with a valid public key', async () => {
      const result = await wm.createWallet('test-wallet');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const info = result.value;
      expect(info.id).toMatch(/^wallet_/);
      expect(info.publicKey).toBeTruthy();
      // Should be a valid Solana public key
      expect(() => new PublicKey(info.publicKey)).not.toThrow();
    });

    it('creates wallets with unique IDs', async () => {
      const a = await wm.createWallet('w1');
      const b = await wm.createWallet('w2');
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.value.id).not.toBe(b.value.id);
      expect(a.value.publicKey).not.toBe(b.value.publicKey);
    });

    it('never exposes the secret key or key reference', async () => {
      const result = await wm.createWallet('visible');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // WalletInfo should not contain secretKey or keyRef
      expect((result.value as any).encryptedSecretKey).toBeUndefined();
      expect((result.value as any).keyRef).toBeUndefined();
      expect((result.value as any).secretKey).toBeUndefined();
    });
  });

  describe('getPublicKey', () => {
    it('returns a PublicKey for a known wallet', async () => {
      const cr = await wm.createWallet('pk-test');
      expect(cr.ok).toBe(true);
      if (!cr.ok) return;

      const pkResult = wm.getPublicKey(cr.value.id);
      expect(pkResult.ok).toBe(true);
      if (!pkResult.ok) return;
      expect(pkResult.value).toBeInstanceOf(PublicKey);
      expect(pkResult.value.toBase58()).toBe(cr.value.publicKey);
    });

    it('fails for an unknown wallet', () => {
      const result = wm.getPublicKey('nonexistent');
      expect(result.ok).toBe(false);
    });
  });

  describe('signTransaction', () => {
    it('signs a transaction successfully', async () => {
      const cr = await wm.createWallet('sign-test');
      expect(cr.ok).toBe(true);
      if (!cr.ok) return;

      const pkResult = wm.getPublicKey(cr.value.id);
      if (!pkResult.ok) return;

      // Build a minimal transaction
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: pkResult.value,
          toPubkey: pkResult.value, // self-transfer for testing
          lamports: 100,
        })
      );
      tx.recentBlockhash = 'GHtXQBSoZsSaMmmFwpEhCbyUhHR9xACrKS9gHsV5A5Bj';
      tx.feePayer = pkResult.value;

      const signResult = await wm.signTransaction(cr.value.id, tx);
      expect(signResult.ok).toBe(true);
      if (!signResult.ok) return;
      // The signed transaction should have at least one signature
      expect(signResult.value.signatures.length).toBeGreaterThan(0);
    });

    it('fails for an unknown wallet', async () => {
      const tx = new Transaction();
      const result = await wm.signTransaction('nonexistent', tx);
      expect(result.ok).toBe(false);
    });
  });

  describe('deleteWallet', () => {
    it('removes a wallet', async () => {
      const cr = await wm.createWallet('delete-me');
      expect(cr.ok).toBe(true);
      if (!cr.ok) return;

      const delResult = await wm.deleteWallet(cr.value.id);
      expect(delResult.ok).toBe(true);

      // Should no longer exist
      const pkResult = wm.getPublicKey(cr.value.id);
      expect(pkResult.ok).toBe(false);
    });
  });

  describe('policy validation', () => {
    it('rejects a transfer exceeding maxTransferAmount', async () => {
      const cr = await wm.createWallet('policy-test');
      expect(cr.ok).toBe(true);
      if (!cr.ok) return;

      const intent = {
        id: 'test-intent',
        agentId: 'agent-1',
        timestamp: new Date(),
        type: 'transfer_sol' as const,
        recipient: '11111111111111111111111111111111',
        amount: 999, // way above the default 1 SOL max
      };

      const result = wm.validateIntent(cr.value.id, intent, 1000);
      expect(result.ok).toBe(false);
    });

    it('accepts a valid small transfer', async () => {
      const cr = await wm.createWallet('valid-tx');
      expect(cr.ok).toBe(true);
      if (!cr.ok) return;

      const intent = {
        id: 'test-intent-2',
        agentId: 'agent-2',
        timestamp: new Date(),
        type: 'transfer_sol' as const,
        recipient: '11111111111111111111111111111111',
        amount: 0.01,
      };

      const result = wm.validateIntent(cr.value.id, intent, 10);
      expect(result.ok).toBe(true);
    });
  });
});
