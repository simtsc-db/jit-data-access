import { useMemo, useState } from 'react';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { CheckCircle2 } from 'lucide-react';
import { isTrue, postJson } from '../lib/portal';
import { EmptyNote, ErrorNote, LoadingRows } from './common';

interface Props {
  ctl: string;
  demoMode: boolean;
  demoApprover: boolean;
  preselectSecurable: string | null;
  onSubmitted: () => void;
}

export function RequestTab({ ctl, demoMode, demoApprover, preselectSecurable, onSubmitted }: Props) {
  const params = useMemo(() => ({ ctl: sql.string(ctl) }), [ctl]);
  const { data, loading, error } = useAnalyticsQuery('products', params);

  const preselected = useMemo(() => {
    if (!data || !preselectSecurable) return null;
    const hit = data.find((p) => p.securable.toLowerCase() === preselectSecurable.toLowerCase());
    return hit ? hit.product_id : null;
  }, [data, preselectSecurable]);

  const [productId, setProductId] = useState<string | null>(null);
  const [unit, setUnit] = useState<'days' | 'minutes'>('days');
  const [amount, setAmount] = useState('1');
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (loading) return <LoadingRows rows={4} />;
  if (error) return <ErrorNote title="Could not load data products" message={error} />;
  if (!data || data.length === 0) {
    return <EmptyNote title="No data products" description="No time-bound data products are configured yet." />;
  }

  const selectedId = productId ?? preselected ?? data[0].product_id;
  const product = data.find((p) => p.product_id === selectedId) ?? data[0];
  const unknownSecurable = preselectSecurable !== null && preselected === null;
  const minutes = Number(amount) * (unit === 'days' ? 1440 : 1);
  const maxMinutes = Number(product.max_duration_days) * 1440;
  const durationValid = Number.isInteger(Number(amount)) && minutes > 0 && minutes <= maxMinutes;
  const justificationValid = justification.trim().length >= 10;

  const submit = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await postJson('/api/portal/requests', {
        productId: product.product_id,
        durationMinutes: minutes,
        justification,
      });
      const auto = typeof res.autoDecisionInMs === 'number' ? ' The demo auto-approver decides in a few seconds.' : '';
      setResult({ ok: true, message: `Request ${String(res.requestId)} sent to ${product.owner_group}.${auto}` });
      setJustification('');
      onSubmitted();
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Request time-bound access</CardTitle>
          <CardDescription>
            Access starts when an owner approves and ends automatically at the expiry time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {unknownSecurable && (
            <Alert>
              <AlertDescription>
                {preselectSecurable} is not a time-bound data product. Use the standard Unity Catalog request flow.
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="product">Data product</Label>
            <Select value={product.product_id} onValueChange={setProductId}>
              <SelectTrigger id="product" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {data.map((p) => (
                  <SelectItem key={p.product_id} value={p.product_id}>
                    {p.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="amount">Duration</Label>
              <Input
                id="amount"
                type="number"
                min={1}
                step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={!durationValid}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="unit">Unit</Label>
              <Select value={unit} onValueChange={(v) => setUnit(v === 'minutes' ? 'minutes' : 'days')}>
                <SelectTrigger id="unit" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="days">days</SelectItem>
                  {demoMode && <SelectItem value="minutes">minutes (demo mode)</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          </div>
          {!durationValid && (
            <p className="text-sm text-destructive">
              Choose a whole number up to {product.max_duration_days} days for this tier.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="justification">Business justification</Label>
            <Textarea
              id="justification"
              placeholder="Purpose, deliverable, ticket reference (at least 10 characters)"
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={4}
            />
          </div>
          {result && (
            <Alert variant={result.ok ? 'default' : 'destructive'}>
              {result.ok && <CheckCircle2 className="h-4 w-4 text-success" />}
              <AlertDescription>{result.message}</AlertDescription>
            </Alert>
          )}
          {demoApprover && (
            <p className="text-sm text-muted-foreground">
              Demo mode: an automated approver (a separate service principal) decides new requests a few seconds after
              submission, at the rate set in the Review queue tab.
            </p>
          )}
          <Button onClick={() => void submit()} disabled={submitting || !durationValid || !justificationValid}>
            {submitting ? 'Submitting...' : 'Submit request'}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Rules for this product</CardTitle>
          <CardDescription>Set by the data owner; enforced by Unity Catalog.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Rule label="Sensitivity tier" value={product.sensitivity_tier} />
          <Rule label="Maximum window" value={`${product.max_duration_days} days`} />
          <Rule
            label="Approvals required"
            value={isTrue(product.second_approver_required) ? '2 (different people)' : '1'}
          />
          <Rule label="Approver group" value={product.owner_group} />
          <Rule label="Table" value={product.securable} />
        </CardContent>
      </Card>
    </div>
  );
}

function Rule({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right break-all">{value}</span>
    </div>
  );
}
