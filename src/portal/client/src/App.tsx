import { useEffect, useMemo, useState } from 'react';
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger, useAnalyticsQuery } from '@databricks/appkit-ui/react';
import { ShieldCheck } from 'lucide-react';
import { fetchConfig, type PortalConfig } from './lib/portal';
import { ErrorNote, LoadingRows } from './portal/common';
import { RequestTab } from './portal/RequestTab';
import { MyAccessTab } from './portal/MyAccessTab';
import { ReviewTab } from './portal/ReviewTab';
import { AuditTab } from './portal/AuditTab';

const NO_PARAMS = {};

function Identity() {
  // Runs on-behalf-of the user: this is exactly the identity Unity Catalog evaluates.
  const { data, loading } = useAnalyticsQuery('whoami', NO_PARAMS);
  if (loading) return <span className="text-sm text-muted-foreground">Signing in...</span>;
  return (
    <Badge variant="secondary" title="Queries on this page run as this identity (on-behalf-of user)">
      {data?.[0]?.me ?? 'unknown user'}
    </Badge>
  );
}

export default function App() {
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  // Bumped after every mutation so the affected views remount and re-query.
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);

  const preselect = useMemo(() => new URLSearchParams(window.location.search).get('securable'), []);
  const [tab, setTab] = useState('request');

  useEffect(() => {
    if (config?.title) document.title = config.title;
  }, [config?.title]);

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch((e: unknown) => setConfigError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-4 md:px-6 py-3 flex flex-wrap items-center gap-3">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold text-foreground">{config?.title ?? 'Data Access Portal'}</h1>
        <span className="hidden md:inline text-sm text-muted-foreground">
          Approval-gated, time-bound access. Enforced by Unity Catalog ABAC at query time.
        </span>
        <div className="ml-auto">
          <Identity />
        </div>
      </header>
      <main className="p-4 md:p-6 max-w-6xl mx-auto">
        {configError && <ErrorNote title="Portal configuration unavailable" message={configError} />}
        {!config && !configError && <LoadingRows rows={4} />}
        {config && (
          <Tabs value={tab} onValueChange={setTab} className="space-y-4">
            <TabsList>
              <TabsTrigger value="request">Request access</TabsTrigger>
              <TabsTrigger value="mine">My access</TabsTrigger>
              <TabsTrigger value="review">Review queue</TabsTrigger>
              <TabsTrigger value="audit">Access review</TabsTrigger>
            </TabsList>
            <TabsContent value="request">
              <RequestTab
                ctl={config.ctl}
                demoMode={config.demoMode}
                preselectSecurable={preselect}
                onSubmitted={() => {
                  refresh();
                  setTab('mine');
                }}
              />
            </TabsContent>
            <TabsContent value="mine">
              <MyAccessTab key={`mine-${refreshKey}`} ctl={config.ctl} onRefresh={refresh} />
            </TabsContent>
            <TabsContent value="review">
              <ReviewTab key={`review-${refreshKey}`} ctl={config.ctl} onChanged={refresh} />
            </TabsContent>
            <TabsContent value="audit">
              <AuditTab key={`audit-${refreshKey}`} ctl={config.ctl} />
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  );
}
