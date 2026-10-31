/**
 * Network Safety Tests
 *
 * Validates the fail-closed mainnet gate in config: mainnet must have BOTH
 * ALLOW_MAINNET=true AND a private RPC URL, or the config is rejected.
 */

import { describe, it, expect } from 'vitest';

import { validateNetworkSafety } from '../src/utils/config.js';

const DEVNET_RPC = 'https://api.devnet.solana.com';
const PRIVATE_RPC = 'https://mainnet.helius-rpc.com';

describe('validateNetworkSafety', () => {
  it('allows devnet with the default RPC', () => {
    expect(
      validateNetworkSafety({ SOLANA_NETWORK: 'devnet', SOLANA_RPC_URL: DEVNET_RPC, ALLOW_MAINNET: false })
    ).toBeNull();
  });

  it('allows testnet', () => {
    expect(
      validateNetworkSafety({ SOLANA_NETWORK: 'testnet', SOLANA_RPC_URL: DEVNET_RPC, ALLOW_MAINNET: false })
    ).toBeNull();
  });

  it('rejects mainnet without the opt-in (fail-closed)', () => {
    expect(
      validateNetworkSafety({ SOLANA_NETWORK: 'mainnet-beta', SOLANA_RPC_URL: PRIVATE_RPC, ALLOW_MAINNET: false })
    ).toMatch(/ALLOW_MAINNET=true/);
  });

  it('rejects mainnet with the default devnet RPC even when allowed', () => {
    expect(
      validateNetworkSafety({ SOLANA_NETWORK: 'mainnet-beta', SOLANA_RPC_URL: DEVNET_RPC, ALLOW_MAINNET: true })
    ).toMatch(/private SOLANA_RPC_URL/);
  });

  it('rejects mainnet with an empty RPC even when allowed', () => {
    expect(
      validateNetworkSafety({ SOLANA_NETWORK: 'mainnet-beta', SOLANA_RPC_URL: '', ALLOW_MAINNET: true })
    ).toMatch(/private SOLANA_RPC_URL/);
  });

  it('allows mainnet only with the opt-in AND a private RPC', () => {
    expect(
      validateNetworkSafety({ SOLANA_NETWORK: 'mainnet-beta', SOLANA_RPC_URL: PRIVATE_RPC, ALLOW_MAINNET: true })
    ).toBeNull();
  });
});
