/**
 * Demo auto-approver: a separate service principal that approves or declines new requests at a
 * configurable rate, so a single presenter can run the full flow. Demo mode only.
 *
 * It is a real second identity: its own OAuth credentials (from a secret scope, via app resources), its own
 * current_user(), and its own owner-group membership check. The write still goes through the app service
 * principal and the same lifecycle rules, so self-approval, owner and constraint checks all still apply.
 */
import { WorkspaceClient } from '@databricks/sdk-experimental';

export interface DemoApproverConfig {
  host: string;
  clientId: string;
  clientSecret: string;
  warehouseId: string;
}

/** Returns a config only when demo mode is on and the approver credentials are present. */
export function demoApproverConfig(env: NodeJS.ProcessEnv, demoMode: boolean): DemoApproverConfig | null {
  const clientId = env.TBA_DEMO_APPROVER_CLIENT_ID?.trim();
  const clientSecret = env.TBA_DEMO_APPROVER_SECRET?.trim();
  const rawHost = env.DATABRICKS_HOST?.trim();
  const warehouseId = env.DATABRICKS_WAREHOUSE_ID?.trim();
  if (!demoMode || !clientId || !clientSecret || !rawHost || !warehouseId) return null;
  const host = rawHost.startsWith('http') ? rawHost : `https://${rawHost}`;
  return { host, clientId, clientSecret, warehouseId };
}

export interface Decision {
  approve: boolean;
  reason: string;
}

/**
 * Approve when draw * 100 < pct. pct is clamped to 0..100, so 100 always approves and 0 always declines
 * (draw is in [0, 1)). The draw and threshold go into the recorded reason for transparency.
 */
export function decide(pct: number, draw: number): Decision {
  const threshold = Math.min(100, Math.max(0, Math.round(pct)));
  const drawn = Math.min(Math.max(draw, 0), 0.999999) * 100;
  const approve = drawn < threshold;
  return {
    approve,
    reason:
      `Demo auto-approver: drew ${drawn.toFixed(1)} against a ${threshold}% approval rate ` +
      `-> ${approve ? 'approved' : 'declined'}`,
  };
}

/** Runs SQL as the demo approver service principal (OAuth M2M), for identity and membership checks only. */
export class DemoApproverSql {
  private readonly client: WorkspaceClient;

  constructor(private readonly cfg: DemoApproverConfig) {
    this.client = new WorkspaceClient({
      host: cfg.host,
      authType: 'oauth-m2m',
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
    });
  }

  async query(statement: string, params: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const res = await this.client.statementExecution.executeStatement({
      warehouse_id: this.cfg.warehouseId,
      statement,
      parameters: Object.entries(params).map(([name, value]) => ({ name, value, type: 'STRING' })),
      wait_timeout: '30s',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
    });
    const state = res.status?.state;
    if (state !== 'SUCCEEDED') {
      throw new Error(`demo approver query ${state ?? 'UNKNOWN'}: ${res.status?.error?.message ?? 'no detail'}`);
    }
    const cols = res.manifest?.schema?.columns?.map((c) => c.name ?? '') ?? [];
    return (res.result?.data_array ?? []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
  }
}
