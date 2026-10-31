/**
 * Tenant Registry
 *
 * Manages SaaS tenants: creation, API-key auth (keys stored only as HMAC-SHA256
 * hashes, raw key returned exactly once), plan-based usage limits, and metering.
 *
 * SECURITY:
 * - API keys are NEVER stored in plaintext. Only HMAC(apiKey, serverSecret) is
 *   persisted, and it is matched by re-hashing the presented key.
 * - The raw API key is returned once at creation/rotation, mirroring the BYOA
 *   control-token pattern already used for agents.
 */

import { createHmac, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import { Result, success, failure } from '../utils/types.js';
import { saveState, loadState } from '../utils/store.js';
import { getLimits } from './plans.js';
import {
  TenantPlan,
  TenantRecord,
  TenantInfo,
  TenantUsage,
  TenantStatus,
  CreateTenantResult,
  UsageMeter,
} from './types.js';

const logger = createLogger('TENANT');

const STORE_KEY = 'tenants';

function hmac(apiKey: string, secret: string): string {
  return createHmac('sha256', secret).update(apiKey).digest('hex');
}

function generateApiKey(tenantId: string): string {
  return `tenant_${tenantId.slice(0, 8)}_${randomBytes(24).toString('hex')}`;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function freshUsage(): TenantUsage {
  return {
    agents: 0,
    intentDay: { date: dayKey(new Date()), count: 0 },
    requestMonth: { key: monthKey(new Date()), count: 0 },
    lifetime: { agentCreated: 0, intentSubmitted: 0, apiRequest: 0 },
    reported: { agentCreated: 0, intentSubmitted: 0, apiRequest: 0 },
  };
}

/** Revive a persisted usage object, resetting stale windows on rollover. */
function reviveUsage(raw: TenantUsage | undefined): TenantUsage {
  const base = freshUsage();
  if (!raw) return base;
  const now = new Date();
  return {
    agents: raw.agents ?? 0,
    // Reset the daily counter if the day rolled over.
    intentDay:
      raw.intentDay?.date === dayKey(now)
        ? { date: raw.intentDay.date, count: raw.intentDay.count }
        : { date: dayKey(now), count: 0 },
    // Reset the monthly counter if the month rolled over.
    requestMonth:
      raw.requestMonth?.key === monthKey(now)
        ? { key: raw.requestMonth.key, count: raw.requestMonth.count }
        : { key: monthKey(now), count: 0 },
    lifetime: {
      agentCreated: raw.lifetime?.agentCreated ?? 0,
      intentSubmitted: raw.lifetime?.intentSubmitted ?? 0,
      apiRequest: raw.lifetime?.apiRequest ?? 0,
    },
    reported: {
      agentCreated: raw.reported?.agentCreated ?? 0,
      intentSubmitted: raw.reported?.intentSubmitted ?? 0,
      apiRequest: raw.reported?.apiRequest ?? 0,
    },
  };
}

export interface StripeLinkage {
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  readonly stripeSubscriptionItemId?: string;
}

export class TenantRegistry {
  private tenants: Map<string, TenantRecord> = new Map();
  private keyIndex: Map<string, string> = new Map(); // apiKeyHash -> tenantId
  private secret: string;

  constructor(secret: string) {
    if (!secret || secret.length < 16) {
      throw new Error('TenantRegistry requires a secret of at least 16 characters');
    }
    this.secret = secret;
    this.loadFromStore();
  }

  // ── Persistence ──────────────────────────

  private saveToStore(): void {
    saveState(STORE_KEY, { tenants: Array.from(this.tenants.values()) });
  }

  private loadFromStore(): void {
    interface Saved {
      tenants: TenantRecord[];
    }
    const saved = loadState<Saved>(STORE_KEY);
    if (!saved?.tenants?.length) return;

    let restored = 0;
    for (const raw of saved.tenants) {
      const record: TenantRecord = {
        ...raw,
        createdAt: new Date(raw.createdAt),
        usage: reviveUsage(raw.usage),
      };
      this.tenants.set(record.id, record);
      this.keyIndex.set(record.apiKeyHash, record.id);
      restored++;
    }
    logger.info('Tenants restored from disk', { count: restored });
  }

  // ── Creation ─────────────────────────────

  createTenant(
    name: string,
    plan: TenantPlan = 'free',
    stripe?: StripeLinkage
  ): Result<CreateTenantResult, Error> {
    if (!name || name.trim().length === 0) {
      return failure(new Error('Tenant name is required'));
    }
    if (name.length > 100) {
      return failure(new Error('Tenant name must be 100 characters or fewer'));
    }
    if (this.tenants.size >= 1_000) {
      return failure(new Error('Tenant limit reached (1000)'));
    }

    const id = uuidv4();
    const apiKey = generateApiKey(id);
    const apiKeyHash = hmac(apiKey, this.secret);

    const record: TenantRecord = {
      id,
      name: name.trim(),
      plan,
      status: 'active',
      apiKeyHash,
      stripeCustomerId: stripe?.stripeCustomerId,
      stripeSubscriptionId: stripe?.stripeSubscriptionId,
      stripeSubscriptionItemId: stripe?.stripeSubscriptionItemId,
      createdAt: new Date(),
      usage: freshUsage(),
    };

    this.tenants.set(id, record);
    this.keyIndex.set(apiKeyHash, id);
    this.saveToStore();

    logger.info('Tenant created', { tenantId: id, name: record.name, plan });

    return success({ tenantId: id, apiKey });
  }

  // ── Auth ─────────────────────────────────

  authenticate(apiKey: string): Result<TenantRecord, Error> {
    if (!apiKey) {
      return failure(new Error('Missing tenant API key'));
    }
    const hash = hmac(apiKey, this.secret);
    const tenantId = this.keyIndex.get(hash);
    if (!tenantId) {
      return failure(new Error('Invalid tenant API key'));
    }
    const tenant = this.tenants.get(tenantId)!;
    if (tenant.status === 'suspended') {
      return failure(new Error('Tenant is suspended'));
    }
    return success(tenant);
  }

  rotateApiKey(tenantId: string): Result<string, Error> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return failure(new Error(`Tenant not found: ${tenantId}`));
    }
    const newKey = generateApiKey(tenantId);
    const newHash = hmac(newKey, this.secret);

    this.keyIndex.delete(tenant.apiKeyHash);
    this.tenants.set(tenantId, { ...tenant, apiKeyHash: newHash });
    this.keyIndex.set(newHash, tenantId);
    this.saveToStore();

    logger.info('Tenant API key rotated', { tenantId, name: tenant.name });
    return success(newKey);
  }

  setStatus(tenantId: string, status: TenantStatus): Result<true, Error> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return failure(new Error(`Tenant not found: ${tenantId}`));
    }
    this.tenants.set(tenantId, { ...tenant, status });
    this.saveToStore();
    logger.info('Tenant status changed', { tenantId, status });
    return success(true);
  }

  // ── Queries ──────────────────────────────

  getTenant(tenantId: string): Result<TenantRecord, Error> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return failure(new Error(`Tenant not found: ${tenantId}`));
    }
    return success(tenant);
  }

  listTenants(): TenantInfo[] {
    return Array.from(this.tenants.values()).map((t) => this.toPublicInfo(t));
  }

  // ── Metering ─────────────────────────────

  /**
   * Whether the tenant is allowed to perform `meter` right now, based on its
   * plan limits. Does NOT mutate state.
   */
  canUse(tenantId: string, meter: UsageMeter): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant || tenant.status === 'suspended') return false;
    const limits = getLimits(tenant.plan);
    const u = reviveUsage(tenant.usage);

    switch (meter) {
      case 'agent_created':
        return u.agents < limits.maxAgents;
      case 'intent_submitted':
        return u.intentDay.count < limits.maxIntentsPerDay;
      case 'api_request':
        return u.requestMonth.count < limits.maxApiRequestsPerMonth;
      default:
        return false;
    }
  }

  /**
   * Record one unit of `meter` for the tenant. Idempotent-safe on window
   * rollover (daily/monthly counters reset automatically).
   */
  recordUsage(tenantId: string, meter: UsageMeter): void {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return;

    const u = reviveUsage(tenant.usage);
    const now = new Date();

    switch (meter) {
      case 'agent_created':
        u.agents += 1;
        u.lifetime.agentCreated += 1;
        break;
      case 'intent_submitted':
        u.intentDay = {
          date: dayKey(now),
          count: u.intentDay.count + 1,
        };
        u.lifetime.intentSubmitted += 1;
        break;
      case 'api_request':
        u.requestMonth = {
          key: monthKey(now),
          count: u.requestMonth.count + 1,
        };
        u.lifetime.apiRequest += 1;
        break;
    }

    this.tenants.set(tenantId, { ...tenant, usage: u });
    this.saveToStore();
  }

  /**
   * Release one agent slot (used when an agent is revoked/deactivated).
   * Prevents the active-agent count from drifting below zero.
   */
  releaseAgent(tenantId: string): void {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return;
    const u = reviveUsage(tenant.usage);
    if (u.agents > 0) {
      this.tenants.set(tenantId, { ...tenant, usage: { ...u, agents: u.agents - 1 } });
      this.saveToStore();
    }
  }

  /**
   * Advance the billing watermark for a meter. Used by BillingService after a
   * successful usage push, so only deltas are ever billed.
   */
  markReported(tenantId: string, meter: UsageMeter, value: number): void {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return;
    const u = reviveUsage(tenant.usage);
    this.tenants.set(tenantId, {
      ...tenant,
      usage: {
        ...u,
        reported: {
          agentCreated:
            meter === 'agent_created' ? value : u.reported.agentCreated,
          intentSubmitted:
            meter === 'intent_submitted' ? value : u.reported.intentSubmitted,
          apiRequest:
            meter === 'api_request' ? value : u.reported.apiRequest,
        },
      },
    });
    this.saveToStore();
  }

  getUsage(tenantId: string): { usage: TenantUsage; limits: ReturnType<typeof getLimits> } | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;
    return { usage: reviveUsage(tenant.usage), limits: getLimits(tenant.plan) };
  }

  // ── Internal ─────────────────────────────

  private toPublicInfo(record: TenantRecord): TenantInfo {
    return {
      id: record.id,
      name: record.name,
      plan: record.plan,
      status: record.status,
      stripeCustomerId: record.stripeCustomerId,
      stripeSubscriptionId: record.stripeSubscriptionId,
      createdAt: record.createdAt,
      usage: reviveUsage(record.usage),
      limits: getLimits(record.plan),
    };
  }
}

// ── Singleton ──────────────────────────────

let tenantRegistryInstance: TenantRegistry | null = null;

/** Get the tenant registry, bootstrapped with the configured secret. */
export function getTenantRegistry(secret?: string): TenantRegistry {
  if (!tenantRegistryInstance) {
    // Caller should pass the server secret; fall back to the encryption secret
    // if not provided (e.g. in tests that construct directly).
    tenantRegistryInstance = new TenantRegistry(
      secret ?? process.env['TENANT_SECRET'] ?? 'dev-tenant-secret-change-me-1234'
    );
  }
  return tenantRegistryInstance;
}
