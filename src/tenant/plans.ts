/**
 * SaaS plan definitions
 *
 * Each plan caps how much a tenant can do. These are the LIMITS; metering and
 * Stripe billing track the actual consumption against them.
 */

import { PlanLimits, TenantPlan } from './types.js';

export const PLANS: Record<TenantPlan, PlanLimits> = {
  free: {
    maxAgents: 2,
    maxIntentsPerDay: 50,
    maxApiRequestsPerMonth: 1_000,
  },
  starter: {
    maxAgents: 10,
    maxIntentsPerDay: 1_000,
    maxApiRequestsPerMonth: 20_000,
  },
  pro: {
    maxAgents: 50,
    maxIntentsPerDay: 10_000,
    maxApiRequestsPerMonth: 200_000,
  },
  enterprise: {
    maxAgents: 500,
    maxIntentsPerDay: 1_000_000,
    maxApiRequestsPerMonth: 10_000_000,
  },
};

export const TENANT_PLANS: readonly TenantPlan[] = [
  'free',
  'starter',
  'pro',
  'enterprise',
] as const;

export function getLimits(plan: TenantPlan): PlanLimits {
  return PLANS[plan];
}

export function isPlan(value: string): value is TenantPlan {
  return (TENANT_PLANS as readonly string[]).includes(value);
}
