import { useMemo } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { formatTs, isTrue } from '../lib/portal';
import { EmptyNote, ErrorNote, LoadingRows } from './common';

export function AuditTab({ ctl }: { ctl: string }) {
  const params = useMemo(() => ({ ctl: sql.string(ctl) }), [ctl]);
  const { data, loading, error } = useAnalyticsQuery('owner_access_review', params);

  const kpis = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      pending: rows.filter((r) => r.effective_status.startsWith('PENDING')).length,
      active: rows.filter((r) => r.effective_status === 'ACTIVE').length,
      expiringSoon: rows.filter((r) => isTrue(r.expires_within_7d)).length,
      awaitingClose: rows.filter((r) => r.effective_status.startsWith('EXPIRED (')).length,
      asOf: rows[0]?.as_of ?? null,
    };
  }, [data]);

  if (loading) return <LoadingRows rows={5} />;
  if (error) return <ErrorNote title="Could not load the access review" message={error} />;
  if (!data || data.length === 0) {
    return (
      <EmptyNote
        title="No records for products you own"
        description="The access review shows every request for data products whose owner group includes you."
      />
    );
  }
  const asOf = formatTs(kpis.asOf);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Active windows" value={kpis.active} note={`of ${kpis.total} requests, as of ${asOf}`} />
        <Kpi
          label="Pending decisions"
          value={kpis.pending}
          note="awaiting an owner"
          tone={kpis.pending > 0 ? 'warning' : undefined}
        />
        <Kpi label="Expiring within 7 days" value={kpis.expiringSoon} note="renewal needs a new approval" />
        <Kpi
          label="Ended, record not yet closed"
          value={kpis.awaitingClose}
          note="no access (guard); expiry job closes within 15 min"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Access review</CardTitle>
          <CardDescription>
            Every request for products you own, from control.access_lifecycle (change data feed on). Source of truth for
            periodic access reviews.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            queryKey="owner_access_review"
            parameters={params}
            transform={forDisplay}
            filterColumn="principal"
            filterPlaceholder="Filter by principal..."
            pageSize={10}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/** Audit rows: show NULL as "--" (never as 0) and drop helper columns used only for the KPIs. */
const HELPER_COLUMNS = new Set(['expires_within_7d', 'as_of']);
function forDisplay(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => !HELPER_COLUMNS.has(key))
        .map(([key, value]) => [key, value ?? '--'])
    )
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: number; note: string; tone?: 'warning' }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={`text-3xl ${tone === 'warning' ? 'text-warning' : ''}`}>{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{note}</CardContent>
    </Card>
  );
}
