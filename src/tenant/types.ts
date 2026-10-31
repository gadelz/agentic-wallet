/**
 * Multi-tenant SaaS types
 *
 * A Tenant is a customer of the hosted API. Each tenant:
 * - authenticates with a scoped API key (stored only as an HMAC hash)
 * - is assigned a plan that caps usage
 * - is metered on a set of usage meters
 * - may be linked to a Stripe customer/subscription for usage-based billing
 *
 * Tenant isolation: agents/wallets belong to exactly one tenant and are only
 * visible/operable through that tenant's API key.
 */

export type TenantPlan = 'free' | 'starter' | 'pro' | 'enterprise';
export type TenantStatus = 'active' | 'suspended';

/** The discrete billable/limitable units a tenant is metered on. */
export type UsageMeter = 'agent_created' | 'intent_submitted' | 'api_request';

/** Plan-defined hard limits. */
export interface PlanLimits {
  readonly maxAgents: number;
  readonly maxIntentsPerDay: number;
  readonly maxApiRequestsPerMonth: number;
}

/**
 * Per-tenant usage state (internal, mutable).
 *
 * - `agents`: current number of active (non-revoked) agents for this tenant.
 * - `intentDay` / `requestMonth`: windowed counters used for LIMIT enforcement
 *   (they reset on day/month rollover).
 * - `lifetime`: monotonically-increasing totals, used for METERED BILLING.
 * - `reported`: the last lifetime totals already pushed to the billing provider
 *   (watermark). `delta = lifetime - reported` is what gets billed.
 */
export interface TenantUsage {
  agents: number;
  intentDay: { date: string; count: number };
  requestMonth: { key: string; count: number };
  lifetime: {
    agentCreated: number;
    intentSubmitted: number;
    apiRequest: number;
  };
  reported: {
    agentCreated: number;
    intentSubmitted: number;
    apiRequest: number;
  };
}

/** Internal tenant record. `apiKeyHash` is HMAC-SHA256(rawKey, serverSecret). */
export interface TenantRecord {
  readonly id: string;
  readonly name: string;
  readonly plan: TenantPlan;
  readonly status: TenantStatus;
  readonly apiKeyHash: string;
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  readonly stripeSubscriptionItemId?: string;
  readonly createdAt: Date;
  readonly usage: TenantUsage;
}

/** Public-safe view (no apiKeyHash). */
export interface TenantInfo {
  readonly id: string;
  readonly name: string;
  readonly plan: TenantPlan;
  readonly status: TenantStatus;
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  readonly createdAt: Date;
  readonly usage: TenantUsage;
  readonly limits: PlanLimits;
}

export interface CreateTenantResult {
  readonly tenantId: string;
  readonly apiKey: string; // returned ONCE
}
