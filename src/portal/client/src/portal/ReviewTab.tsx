import { useMemo, useState } from 'react';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { formatDuration, formatTs, postJson } from '../lib/portal';
import { EmptyNote, ErrorNote, LoadingRows, StatusBadge } from './common';

interface Props {
  ctl: string;
  onChanged: () => void;
}

export function ReviewTab({ ctl, onChanged }: Props) {
  const params = useMemo(() => ({ ctl: sql.string(ctl) }), [ctl]);
  const { data, loading, error } = useAnalyticsQuery('review_queue', params);

  if (loading) return <LoadingRows rows={3} />;
  if (error) return <ErrorNote title="Could not load the review queue" message={error} />;
  if (!data || data.length === 0) {
    return (
      <EmptyNote
        title="Nothing to review"
        description="There are no pending requests for data products whose owner group includes you."
      />
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {data.map((r) => (
        <ReviewCard key={r.request_id} row={r} onChanged={onChanged} />
      ))}
    </div>
  );
}

interface QueueRow {
  request_id: string;
  principal: string;
  display_name: string;
  sensitivity_tier: string;
  owner_group: string;
  second_approver_required: boolean;
  duration_minutes: number;
  justification: string;
  status: string;
  approver_1: string;
  requested_at: string;
}

function ReviewCard({ row, onChanged }: { row: QueueRow; onChanged: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const act = async (action: 'approve' | 'decline') => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await postJson(
        `/api/portal/requests/${encodeURIComponent(row.request_id)}/${action}`,
        action === 'decline' ? { reason } : {}
      );
      setMessage({ ok: true, text: `Now ${String(res.status)}.` });
      onChanged();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base break-all">{row.principal}</CardTitle>
          <StatusBadge status={row.status} />
        </div>
        <CardDescription>
          {row.display_name} · {row.sensitivity_tier} · {formatDuration(row.duration_minutes)} · requested{' '}
          {formatTs(row.requested_at)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          <span className="text-muted-foreground">Justification: </span>
          {row.justification}
        </p>
        {row.status === 'PENDING_SECOND' && (
          <p className="text-muted-foreground">
            First approval by {row.approver_1}. A different member of {row.owner_group} must give the second.
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor={`reason-${row.request_id}`}>Reason (required to decline)</Label>
          <Input id={`reason-${row.request_id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {message && (
          <Alert variant={message.ok ? 'default' : 'destructive'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        <Button onClick={() => void act('approve')} disabled={busy}>
          Approve
        </Button>
        <Button variant="outline" onClick={() => void act('decline')} disabled={busy || reason.trim().length === 0}>
          Decline
        </Button>
      </CardFooter>
    </Card>
  );
}
