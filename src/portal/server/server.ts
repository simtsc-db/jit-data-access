import { createApp, analytics, server, sql } from '@databricks/appkit';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AccessError, approve, decline, names, ownerGroupFor, requestAccess, str, type RunSql } from './lifecycle';

const DEMO_MODE = (process.env.TBA_DEMO_MODE ?? 'false').toLowerCase() === 'true';
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
          return { requestId, status: 'PENDING' };
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
