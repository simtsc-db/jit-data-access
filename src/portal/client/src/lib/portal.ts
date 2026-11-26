/** Small client helpers for the Data Access Portal (formatting, status semantics, mutations). */

export interface PortalConfig {
  ctl: string;
  demoMode: boolean;
  /** Demo auto-approver bound and active (demo mode only). */
  demoApprover: boolean;
  title: string;
}

export async function fetchConfig(): Promise<PortalConfig> {
  const res = await fetch('/api/portal/config');
  if (!res.ok) throw new Error(`Config failed (${res.status})`);
  const body: unknown = await res.json();
  if (body && typeof body === 'object' && 'ctl' in body && 'demoMode' in body) {
    const title = 'title' in body && typeof body.title === 'string' && body.title ? body.title : 'Data Access Portal';
    const demoApprover = 'demoApprover' in body && body.demoApprover === true;
    return { ctl: String(body.ctl), demoMode: body.demoMode === true, demoApprover, title };
  }
  throw new Error('Unexpected config payload');
}

/** POSTs JSON to a portal route; throws the server's rule message on failure. */
export async function postJson(path: string, payload: object): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await res.json().catch(() => ({}));
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (!res.ok) throw new Error(typeof record.error === 'string' ? record.error : `Request failed (${res.status})`);
  return record;
}

/** SQL booleans can arrive as the strings 'true' / 'false' at runtime, despite the generated type. */
export function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

export function formatDuration(minutes: number): string {
  const m = Number(minutes);
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}

export function formatRemaining(seconds: number): string {
  const s = Number(seconds);
  if (s <= 0) return 'ended';
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h left`;
  return `${(s / 86400).toFixed(1)} days left`;
}

export function formatTs(value: string | null | undefined): string {
  if (!value) return '--';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export type Tone = 'success' | 'warning' | 'destructive' | 'muted';

/** Status semantics: ACTIVE = access open (good), PENDING = waiting (caution), DENIED = refused, closed = neutral. */
export function statusTone(status: string): Tone {
  if (status === 'ACTIVE') return 'success';
  if (status.startsWith('PENDING')) return 'warning';
  if (status === 'DENIED') return 'destructive';
  return 'muted';
}

export const toneClass: Record<Tone, string> = {
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  destructive: 'border-destructive text-destructive',
  muted: 'border-border text-muted-foreground',
};

export interface DemoApproverState {
  enabled: boolean;
  pct: number;
  identity: string | null;
  canEdit: boolean;
  delayMs: number;
  updatedBy: string;
  updatedAt: string;
  lastDecision: { requestId: string; outcome: string; at: string } | null;
  lastError: string | null;
}

export async function fetchDemoApprover(): Promise<DemoApproverState> {
  const res = await fetch('/api/portal/demo/approver');
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok || !body || typeof body !== 'object') throw new Error(`Demo approver status failed (${res.status})`);
  const b = body as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    enabled: b.enabled === true,
    pct: typeof b.pct === 'number' ? b.pct : 100,
    identity: typeof b.identity === 'string' ? b.identity : null,
    canEdit: b.canEdit === true,
    delayMs: typeof b.delayMs === 'number' ? b.delayMs : 3000,
    updatedBy: text(b.updatedBy),
    updatedAt: text(b.updatedAt),
    lastDecision:
      b.lastDecision && typeof b.lastDecision === 'object'
        ? (b.lastDecision as DemoApproverState['lastDecision'])
        : null,
    lastError: typeof b.lastError === 'string' ? b.lastError : null,
  };
}
