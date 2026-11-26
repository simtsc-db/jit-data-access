/**
 * Lifecycle rules for Time-bound access (single source of truth, used by the HTTP routes).
 *
 * Enforcement is layered:
 *   1. here (clear errors, owner check, tier caps, two-person rule),
 *   2. Delta CHECK constraints on control.access_lifecycle (no self-approval, valid states),
 *   3. the ABAC guard UDF, which decides at query time whether data is returned.
 * Writes run as the app service principal; identity and owner checks run as the signed-in user.
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@databricks/appkit';

/** Runs a parameterised statement and returns rows as objects. */
export type RunSql = (
  statement: string,
  params?: Record<string, ReturnType<typeof sql.string> | ReturnType<typeof sql.int>>
) => Promise<Record<string, unknown>[]>;

export class AccessError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface Names {
  catalog: string;
  controlSchema: string;
  dataSchema: string;
}

export const names: Names = {
  catalog: process.env.TBA_CATALOG ?? 'jit_access',
  controlSchema: process.env.TBA_CONTROL_SCHEMA ?? 'control',
  dataSchema: process.env.TBA_DATA_SCHEMA ?? 'gated_data',
};

const ident = (s: string) => `\`${s.replace(/`/g, '')}\``;
const ctl = () => `${ident(names.catalog)}.${ident(names.controlSchema)}`;

interface Product {
  product_id: string;
  owner_group: string;
  sensitivity_tier: string;
  max_duration_days: number;
  second_approver_required: boolean;
}

interface RequestRow {
  request_id: string;
  principal: string;
  requested_by: string;
  product_id: string;
  status: string;
  approver_1: string | null;
}

const asBool = (v: unknown) => v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
/** Coerces a SQL cell (string | number | boolean | null) to string; anything else is a schema error. */
export const str = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  throw new Error('Unexpected non-scalar SQL value');
};

async function product(run: RunSql, productId: string): Promise<Product> {
  const rows = await run(`SELECT * FROM ${ctl()}.data_products WHERE product_id = :p`, { p: sql.string(productId) });
  if (rows.length === 0) throw new AccessError(`Unknown data product '${productId}'`, 404);
  const r = rows[0];
  return {
    product_id: str(r.product_id),
    owner_group: str(r.owner_group),
    sensitivity_tier: str(r.sensitivity_tier),
    max_duration_days: Number(r.max_duration_days),
    second_approver_required: asBool(r.second_approver_required),
  };
}

async function getRequest(run: RunSql, requestId: string): Promise<RequestRow> {
  const rows = await run(`SELECT * FROM ${ctl()}.access_lifecycle WHERE request_id = :r`, { r: sql.string(requestId) });
  if (rows.length === 0) throw new AccessError(`Unknown request ${requestId}`, 404);
  const r = rows[0];
  return {
    request_id: str(r.request_id),
    principal: str(r.principal),
    requested_by: str(r.requested_by),
    product_id: str(r.product_id),
    status: str(r.status),
    approver_1: r.approver_1 == null ? null : str(r.approver_1),
  };
}

const affected = (rows: Record<string, unknown>[]) => Number(rows[0]?.num_affected_rows ?? 0);

/** Owner group of a product, for the user-scoped membership check done by the route. */
export async function ownerGroupFor(appRun: RunSql, requestId: string): Promise<string> {
  const r = await getRequest(appRun, requestId);
  return (await product(appRun, r.product_id)).owner_group;
}

export async function requestAccess(
  appRun: RunSql,
  input: { principal: string; requestedBy: string; productId: string; durationMinutes: number; justification: string }
): Promise<string> {
  const p = await product(appRun, input.productId);
  const maxMinutes = p.max_duration_days * 24 * 60;
  if (input.durationMinutes <= 0 || input.durationMinutes > maxMinutes) {
    throw new AccessError(
      `Duration must be between 1 minute and ${p.max_duration_days} days for tier ${p.sensitivity_tier}`
    );
  }
  if (input.justification.trim().length < 10) {
    throw new AccessError('A business justification of at least 10 characters is required');
  }
  const open = await appRun(
    `SELECT request_id FROM ${ctl()}.access_lifecycle WHERE principal = :pr AND product_id = :p
     AND (status IN ('PENDING','PENDING_SECOND') OR (status = 'ACTIVE' AND expires_at > current_timestamp()))`,
    { pr: sql.string(input.principal), p: sql.string(input.productId) }
  );
  if (open.length > 0) {
    throw new AccessError(`An open request or active window already exists (${str(open[0].request_id)})`, 409);
  }
  const requestId = randomUUID();
  await appRun(
    `INSERT INTO ${ctl()}.access_lifecycle
       (request_id, principal, product_id, privilege, justification, duration_minutes, status, requested_by, requested_at)
     VALUES (:rid, :pr, :p, 'SELECT', :j, :d, 'PENDING', :rb, current_timestamp())`,
    {
      rid: sql.string(requestId),
      pr: sql.string(input.principal),
      p: sql.string(input.productId),
      j: sql.string(input.justification.trim()),
      d: sql.int(input.durationMinutes),
      rb: sql.string(input.requestedBy),
    }
  );
  return requestId;
}

export async function approve(
  appRun: RunSql,
  input: { requestId: string; approver: string; approverIsOwner: boolean }
): Promise<'ACTIVE' | 'PENDING_SECOND'> {
  const r = await getRequest(appRun, input.requestId);
  const p = await product(appRun, r.product_id);
  if (!input.approverIsOwner) throw new AccessError(`You are not in owner group ${p.owner_group}`, 403);
  if (input.approver === r.principal || input.approver === r.requested_by) {
    throw new AccessError('Self-approval is not allowed', 403);
  }
  const activate = (approverCol: 'approver_1' | 'approver_2', fromStatus: string) =>
    appRun(
      `UPDATE ${ctl()}.access_lifecycle
       SET status = 'ACTIVE', ${approverCol} = :a, decided_at = current_timestamp(), starts_at = current_timestamp(),
           expires_at = current_timestamp() + make_interval(0, 0, 0, 0, 0, duration_minutes, 0)
       WHERE request_id = :r AND status = '${fromStatus}'`,
      { a: sql.string(input.approver), r: sql.string(input.requestId) }
    );

  let rows: Record<string, unknown>[];
  let next: 'ACTIVE' | 'PENDING_SECOND';
  if (r.status === 'PENDING' && p.second_approver_required) {
    rows = await appRun(
      `UPDATE ${ctl()}.access_lifecycle SET status = 'PENDING_SECOND', approver_1 = :a
       WHERE request_id = :r AND status = 'PENDING'`,
      { a: sql.string(input.approver), r: sql.string(input.requestId) }
    );
    next = 'PENDING_SECOND';
  } else if (r.status === 'PENDING') {
    rows = await activate('approver_1', 'PENDING');
    next = 'ACTIVE';
  } else if (r.status === 'PENDING_SECOND') {
    if (input.approver === r.approver_1)
      throw new AccessError('Second approval must come from a different approver', 403);
    rows = await activate('approver_2', 'PENDING_SECOND');
    next = 'ACTIVE';
  } else {
    throw new AccessError(`Request is ${r.status}, nothing to approve`, 409);
  }
  if (affected(rows) !== 1) throw new AccessError('Request changed concurrently; reload and retry', 409);
  return next;
}

export async function decline(
  appRun: RunSql,
  input: { requestId: string; approver: string; approverIsOwner: boolean; reason: string }
): Promise<void> {
  const r = await getRequest(appRun, input.requestId);
  if (!input.approverIsOwner) throw new AccessError('Only the data owner group can decline', 403);
  if (r.status !== 'PENDING' && r.status !== 'PENDING_SECOND') throw new AccessError(`Request is ${r.status}`, 409);
  if (input.reason.trim().length === 0) throw new AccessError('A reason is required');
  await appRun(
    `UPDATE ${ctl()}.access_lifecycle SET status = 'DENIED', decided_at = current_timestamp(), decision_reason = :why,
       closed_at = current_timestamp(), closed_by = :a
     WHERE request_id = :r AND status IN ('PENDING','PENDING_SECOND')`,
    { why: sql.string(input.reason.trim()), a: sql.string(input.approver), r: sql.string(input.requestId) }
  );
}
