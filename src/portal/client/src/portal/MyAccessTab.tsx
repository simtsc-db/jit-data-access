import { useMemo } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { RefreshCw } from 'lucide-react';
import { formatDuration, formatRemaining, formatTs } from '../lib/portal';
import { EmptyNote, ErrorNote, LoadingRows, StatusBadge } from './common';

interface Props {
  ctl: string;
  onRefresh: () => void;
}

export function MyAccessTab({ ctl, onRefresh }: Props) {
  const params = useMemo(() => ({ ctl: sql.string(ctl) }), [ctl]);
  const products = useAnalyticsQuery('products', params);
  const mine = useAnalyticsQuery('my_access', params);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>What Unity Catalog returns to you right now</CardTitle>
            <CardDescription>
              Queried as you. The ABAC guard returns rows only inside an approved, unexpired window.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" />
            Re-check
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.loading && <LoadingRows rows={1} />}
          {products.error && <ErrorNote title="Could not load data products" message={products.error} />}
          {products.data?.map((p) => (
            <LiveVisibility key={p.product_id} name={p.display_name} securable={p.securable} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>My requests and windows</CardTitle>
          <CardDescription>Your own requests only (filtered by Unity Catalog on current_user()).</CardDescription>
        </CardHeader>
        <CardContent>
          {mine.loading && <LoadingRows />}
          {mine.error && <ErrorNote title="Could not load your requests" message={mine.error} />}
          {mine.data && mine.data.length === 0 && (
            <EmptyNote title="No requests yet" description="Use the Request tab to ask for time-bound access." />
          )}
          {mine.data && mine.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data product</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Approved by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mine.data.map((r) => (
                  <TableRow key={r.request_id}>
                    <TableCell>{r.display_name}</TableCell>
                    <TableCell>
                      <StatusBadge status={r.effective_status} />
                    </TableCell>
                    <TableCell>{formatDuration(r.duration_minutes)}</TableCell>
                    <TableCell>
                      {r.effective_status === 'ACTIVE'
                        ? `${formatTs(r.expires_at)} (${formatRemaining(r.seconds_left)})`
                        : formatTs(r.expires_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {[r.approver_1, r.approver_2].filter(Boolean).join(', ') || '--'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LiveVisibility({ name, securable }: { name: string; securable: string }) {
  const params = useMemo(() => ({ securable: sql.string(securable) }), [securable]);
  const { data, loading, error } = useAnalyticsQuery('live_visibility', params);
  if (loading) return <LoadingRows rows={1} />;
  if (error) return <ErrorNote title={name} message={error} />;
  const row = data?.[0];
  const rows = Number(row?.visible_rows ?? 0);
  return (
    <div className="rounded-lg border p-4 space-y-1">
      <p className="text-sm text-muted-foreground">{name}</p>
      <p className={`text-3xl font-semibold ${rows > 0 ? 'text-success' : 'text-foreground'}`}>
        {rows.toLocaleString()} <span className="text-base font-normal text-muted-foreground">rows visible</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {securable} · checked {formatTs(row?.checked_at)}
      </p>
    </div>
  );
}
