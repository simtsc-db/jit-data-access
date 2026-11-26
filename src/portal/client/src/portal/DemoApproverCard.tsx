import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Slider,
} from '@databricks/appkit-ui/react';
import { Bot } from 'lucide-react';
import { fetchDemoApprover, formatTs, postJson, type DemoApproverState } from '../lib/portal';
import { ErrorNote, LoadingRows } from './common';

/** Demo mode only: lets a data owner set how often the demo approver service principal approves. */
export function DemoApproverCard() {
  const [state, setState] = useState<DemoApproverState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pct, setPct] = useState(100);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = () =>
    fetchDemoApprover()
      .then((s) => {
        setState(s);
        setPct(s.pct);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
  }, []);

  if (error) return <ErrorNote title="Demo auto-approver unavailable" message={error} />;
  if (!state) return <LoadingRows rows={2} />;
  if (!state.enabled) return null;

  const save = async () => {
    setSaving(true);
    setSaved(null);
    try {
      await postJson('/api/portal/demo/approver', { pct });
      setSaved(`Saved: new requests are approved ${pct}% of the time.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const meaning =
    pct === 100 ? 'always approves' : pct === 0 ? 'always declines' : `approves about ${pct}% and declines the rest`;

  return (
    <Card className="border-dashed">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Demo auto-approver</CardTitle>
          <Badge variant="outline">demo mode</Badge>
        </div>
        <CardDescription>
          A separate service principal decides each new request {Math.round(state.delayMs / 1000)} s after it is
          submitted. It is checked like any approver: owner group membership, no self-approval. Its draw and the rate
          are recorded in the decision reason; the record is marked DEMO_AUTO.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Approval rate</span>
          <span className="font-semibold text-foreground">
            {pct}% <span className="font-normal text-muted-foreground">({meaning})</span>
          </span>
        </div>
        <Slider
          value={[pct]}
          min={0}
          max={100}
          step={5}
          disabled={!state.canEdit || saving}
          onValueChange={(v) => setPct(v[0] ?? 0)}
          aria-label="Demo auto-approver approval rate"
        />
        <div className="grid gap-1 text-sm text-muted-foreground">
          <span>
            Approver identity: <span className="break-all text-foreground">{state.identity ?? 'not resolved'}</span>
          </span>
          {state.updatedBy && (
            <span>
              Last changed by {state.updatedBy} at {formatTs(state.updatedAt)}
            </span>
          )}
          {state.lastDecision && (
            <span>
              Last decision: {state.lastDecision.outcome} for request {state.lastDecision.requestId}
            </span>
          )}
          {!state.canEdit && <span>Only members of a data owner group can change the rate.</span>}
        </div>
        {state.lastError && <ErrorNote title="Last auto-decision failed" message={state.lastError} />}
        {saved && <p className="text-sm text-success">{saved}</p>}
      </CardContent>
      {state.canEdit && (
        <CardFooter>
          <Button onClick={() => void save()} disabled={saving || pct === state.pct}>
            {saving ? 'Saving...' : 'Save rate'}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
