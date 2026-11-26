import { describe, expect, it } from 'vitest';
import { decide, demoApproverConfig } from './demoApprover';
import { approve, decline, type RunSql, type Stores } from './lifecycle';

describe('decide', () => {
  it('always approves at 100%, whatever the draw', () => {
    for (const d of [0, 0.5, 0.999999, 1]) expect(decide(100, d).approve).toBe(true);
  });
  it('always declines at 0%, whatever the draw', () => {
    for (const d of [0, 0.5, 0.999999]) expect(decide(0, d).approve).toBe(false);
  });
  it('approves below the threshold and declines at or above it', () => {
    expect(decide(50, 0.49).approve).toBe(true);
    expect(decide(50, 0.5).approve).toBe(false);
  });
  it('clamps out-of-range rates and records the draw in the reason', () => {
    expect(decide(150, 0.99).approve).toBe(true);
    expect(decide(-5, 0).approve).toBe(false);
    expect(decide(70, 0.123).reason).toBe('Demo auto-approver: drew 12.3 against a 70% approval rate -> approved');
  });
});

describe('demoApproverConfig', () => {
  const env = {
    TBA_DEMO_APPROVER_CLIENT_ID: 'id',
    TBA_DEMO_APPROVER_SECRET: 's',
    DATABRICKS_HOST: 'example.cloud.databricks.com',
    DATABRICKS_WAREHOUSE_ID: 'w',
  };
  it('is off outside demo mode', () => expect(demoApproverConfig(env, false)).toBeNull());
  it('is off without credentials', () =>
    expect(demoApproverConfig({ ...env, TBA_DEMO_APPROVER_SECRET: '' }, true)).toBeNull());
  it('adds https:// to a bare host', () =>
    expect(demoApproverConfig(env, true)?.host).toBe('https://example.cloud.databricks.com'));
});

/** Captures write statements and their parameters. */
function recorder(request: Record<string, unknown>) {
  const writes: { statement: string; params: Record<string, unknown> }[] = [];
  const run: RunSql = (statement, params) => {
    if (statement.includes('data_products')) {
      return Promise.resolve([
        {
          product_id: 'p',
          owner_group: 'owners',
          sensitivity_tier: 'Sensitive-High',
          max_duration_days: 7,
          second_approver_required: false,
        },
      ]);
    }
    if (statement.startsWith('SELECT *')) return Promise.resolve([request]);
    writes.push({ statement, params: params ?? {} });
    return Promise.resolve([{ request_id: 'r1' }]); // RETURNING request_id
  };
  const db: Stores = { uc: run, store: run };
  return { run: db, writes };
}

const pending = { request_id: 'r1', principal: 'alice', requested_by: 'alice', product_id: 'p', status: 'PENDING' };
const value = (p: unknown) => (p && typeof p === 'object' && 'value' in p ? (p as { value: unknown }).value : p);

describe('decision source', () => {
  it('records DEMO_AUTO and the reason on an auto-approval', async () => {
    const { run, writes } = recorder(pending);
    await approve(run, { requestId: 'r1', approver: 'bot', approverIsOwner: true, source: 'DEMO_AUTO', reason: 'x' });
    expect(writes).toHaveLength(1);
    expect(value(writes[0].params.src)).toBe('DEMO_AUTO');
    expect(value(writes[0].params.why)).toBe('x');
  });
  it('defaults to HUMAN', async () => {
    const { run, writes } = recorder(pending);
    await approve(run, { requestId: 'r1', approver: 'bob', approverIsOwner: true });
    expect(value(writes[0].params.src)).toBe('HUMAN');
  });
  it('the auto-approver is still bound by the self-approval rule', async () => {
    const { run } = recorder({ ...pending, principal: 'bot', requested_by: 'bot' });
    await expect(
      approve(run, { requestId: 'r1', approver: 'bot', approverIsOwner: true, source: 'DEMO_AUTO' })
    ).rejects.toThrow(/Self-approval/);
  });
  it('the auto-approver must be in the owner group', async () => {
    const { run } = recorder(pending);
    await expect(
      decline(run, { requestId: 'r1', approver: 'bot', approverIsOwner: false, reason: 'r', source: 'DEMO_AUTO' })
    ).rejects.toThrow(/owner group/);
  });
});
