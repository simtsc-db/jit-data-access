import { createApp, analytics, server, sql } from '@databricks/appkit';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  AccessError,
  approve,
  decline,
  getAutoApprovePct,
  names,
  ownerGroupFor,
  ownerGroups,
  requestAccess,
  setAutoApprovePct,
  str,
  type RunSql,
} from './lifecycle';
import { DemoApproverSql, decide, demoApproverConfig } from './demoApprover';

const DEMO_MODE = (process.env.TBA_DEMO_MODE ?? 'false').toLowerCase() === 'true';
// Demo auto-approver: only when demo mode is on AND its credentials are bound (bundle target `demo`).
const demoApproverCfg = demoApproverConfig(process.env, DEMO_MODE);
const demoApprover = demoApproverCfg ? new DemoApproverSql(demoApproverCfg) : null;
const AUTO_DECISION_DELAY_MS = 3000;
const PORTAL_TITLE = process.env.TBA_PORTAL_TITLE?.trim() || 'Data Access Portal';

const toRows = (res: unknown): Record<string, unknown>[] => {
  if (res && typeof res === 'object' && 'data' in res && Array.isArray(res.data)) {
    return res.data as Record<string, unknown>[];
  }
  return [];
};

const requestBody = z.object({
  productId: z.string().min(1),
  durationMinutes: z.number().int().positive(),
  justification: z.string().min(10).max(2000),
});
const declineBody = z.object({ reason: z.string().min(1).max(1000) });
const demoSettingsBody = z.object({ pct: z.number().int().min(0).max(100) });

createApp({
  plugins: [analytics(), server()],
  // Access state changes by the second (approvals, expiry). Never serve it from a cache:
  // AppKit's default would cache analytics results for 1 hour.
  cache: { enabled: false },
  onPluginsReady(appkit) {
    // Writes to the control plane run as the app service principal (users never get MODIFY).
    const appRun: RunSql = async (statement, params) => toRows(await appkit.analytics.query(statement, params));

    // Identity and approver checks run as the signed-in user, so they cannot be spoofed via headers.
    const whoAmI = async (req: Request) =>
      str(toRows(await appkit.asUser(req).analytics.query('SELECT current_user() AS me'))[0]?.me);
    const isMemberOf = async (req: Request, group: string) => {
      const rows = toRows(
        await appkit
          .asUser(req)
          .analytics.query('SELECT is_account_group_member(:g) OR is_member(:g) AS ok', { g: sql.string(group) })
      );
      return rows[0]?.ok === true || str(rows[0]?.ok).toLowerCase() === 'true';
    };

    const ownsAnyProduct = async (req: Request) => {
      for (const g of await ownerGroups(appRun)) if (await isMemberOf(req, g)) return true;
      return false;
    };

    // Demo auto-approver state (identity resolved once, as the approver SP itself).
    let approverIdentity: string | null = null;
    let lastAutoDecision: { requestId: string; outcome: string; at: string } | null = null;
    let lastAutoError: string | null = null;
    const approverWhoAmI = async () => {
      if (!demoApprover) throw new Error('demo approver not configured');
      approverIdentity ??= str((await demoApprover.query('SELECT current_user() AS me'))[0]?.me);
      return approverIdentity;
    };
    const approverIsOwner = async (group: string) => {
      if (!demoApprover) return false;
      const rows = await demoApprover.query('SELECT is_account_group_member(:g) OR is_member(:g) AS ok', { g: group });
      return rows[0]?.ok === true || str(rows[0]?.ok).toLowerCase() === 'true';
    };
    const autoDecide = async (requestId: string) => {
      try {
        const { pct } = await getAutoApprovePct(appRun);
        const decision = decide(pct, Math.random());
        const approver = await approverWhoAmI();
        const owner = await approverIsOwner(await ownerGroupFor(appRun, requestId));
        if (decision.approve) {
          const status = await approve(appRun, {
            requestId,
            approver,
            approverIsOwner: owner,
            source: 'DEMO_AUTO',
            reason: decision.reason,
          });
          lastAutoDecision = { requestId, outcome: status, at: new Date().toISOString() };
        } else {
          await decline(appRun, {
            requestId,
            approver,
            approverIsOwner: owner,
            reason: decision.reason,
            source: 'DEMO_AUTO',
          });
          lastAutoDecision = { requestId, outcome: 'DENIED', at: new Date().toISOString() };
        }
        lastAutoError = null;
      } catch (e) {
        lastAutoError = e instanceof Error ? e.message.split('\n')[0].slice(0, 300) : String(e);
        console.error('demo auto-approver failed:', lastAutoError);
      }
    };

    const handle = (fn: (req: Request) => unknown) => async (req: Request, res: Response) => {
      try {
        res.json(await fn(req));
      } catch (e) {
        if (e instanceof AccessError) {
          res.status(e.status).json({ error: e.message });
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        console.error('portal route failed:', message);
        // Surface constraint violations (e.g. CHECK no_self_approval) as rule errors, not 500s.
        const status = /CONSTRAINT|INSUFFICIENT_PERMISSIONS|PERMISSION_DENIED/.test(message) ? 403 : 500;
        res.status(status).json({ error: message.split('\n')[0].slice(0, 300) });
      }
    };

    appkit.server.extend((app) => {
      app.get(
        '/api/portal/config',
        handle(() => ({
          ctl: `${names.catalog}.${names.controlSchema}`,
          demoMode: DEMO_MODE,
          demoApprover: demoApprover !== null,
          title: PORTAL_TITLE,
        }))
      );

      app.post(
        '/api/portal/requests',
        handle(async (req) => {
          const body = requestBody.safeParse(req.body);
          if (!body.success) throw new AccessError('Invalid request: product, duration and justification are required');
          const me = await whoAmI(req);
          if (!DEMO_MODE && body.data.durationMinutes % 1440 !== 0) {
            throw new AccessError('Durations are whole days outside demo mode');
          }
          const requestId = await requestAccess(appRun, {
            principal: me,
            requestedBy: me,
            productId: body.data.productId,
            durationMinutes: body.data.durationMinutes,
            justification: body.data.justification,
          });
          if (demoApprover) {
            setTimeout(() => void autoDecide(requestId), AUTO_DECISION_DELAY_MS);
          }
          return { requestId, status: 'PENDING', autoDecisionInMs: demoApprover ? AUTO_DECISION_DELAY_MS : null };
        })
      );

      app.get(
        '/api/portal/demo/approver',
        handle(async (req) => {
          if (!demoApprover) return { enabled: false };
          const settings = await getAutoApprovePct(appRun);
          const identity = await approverWhoAmI().catch((e: unknown) => {
            lastAutoError = e instanceof Error ? e.message.split('\n')[0].slice(0, 300) : String(e);
            return null;
          });
          return {
            enabled: true,
            ...settings,
            identity,
            canEdit: await ownsAnyProduct(req),
            delayMs: AUTO_DECISION_DELAY_MS,
            lastDecision: lastAutoDecision,
            lastError: lastAutoError,
          };
        })
      );

      app.post(
        '/api/portal/demo/approver',
        handle(async (req) => {
          if (!demoApprover) throw new AccessError('The demo auto-approver is not enabled', 404);
          const body = demoSettingsBody.safeParse(req.body);
          if (!body.success) throw new AccessError('Approval rate must be a whole number from 0 to 100');
          if (!(await ownsAnyProduct(req))) throw new AccessError('Only data owners can change the demo approver', 403);
          await setAutoApprovePct(appRun, body.data.pct, await whoAmI(req));
          return getAutoApprovePct(appRun);
        })
      );

      app.post(
        '/api/portal/requests/:id/approve',
        handle(async (req) => {
          const requestId = String(req.params.id);
          const me = await whoAmI(req);
          const owner = await isMemberOf(req, await ownerGroupFor(appRun, requestId));
          const status = await approve(appRun, { requestId, approver: me, approverIsOwner: owner });
          return { requestId, status };
        })
      );

      app.post(
        '/api/portal/requests/:id/decline',
        handle(async (req) => {
          const body = declineBody.safeParse(req.body);
          if (!body.success) throw new AccessError('A reason is required');
          const requestId = String(req.params.id);
          const me = await whoAmI(req);
          const owner = await isMemberOf(req, await ownerGroupFor(appRun, requestId));
          await decline(appRun, { requestId, approver: me, approverIsOwner: owner, reason: body.data.reason });
          return { requestId, status: 'DENIED' };
        })
      );
    });
  },
}).catch(console.error);
