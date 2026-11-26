import { describe, expect, it } from 'vitest';
import { AccessError, approve, requestAccess, type RunSql } from './lifecycle';

const product = {
  product_id: 'citizen_cases',
  owner_group: 'owners',
  sensitivity_tier: 'Sensitive-High',
  max_duration_days: 7,
  second_approver_required: false,
};

/** Minimal fake warehouse: answers the rule module's lookups and records writes. */
function fakeSql(opts: { request?: Record<string, unknown>; twoPerson?: boolean; open?: boolean }) {
  const writes: string[] = [];
  const run: RunSql = (statement) => {
    if (statement.includes('FROM') && statement.includes('data_products')) {
      return Promise.resolve([{ ...product, second_approver_required: opts.twoPerson ?? false }]);
    }
    if (statement.startsWith('SELECT request_id')) return Promise.resolve(opts.open ? [{ request_id: 'r0' }] : []);
    if (statement.startsWith('SELECT *') && statement.includes('access_lifecycle')) {
      return Promise.resolve(opts.request ? [opts.request] : []);
    }
    writes.push(statement.trim().split(/\s+/)[0]);
    return Promise.resolve([{ num_affected_rows: 1 }]);
  };
  return { run, writes };
}

const pending = {
  request_id: 'r1',
  principal: 'alice',
  requested_by: 'alice',
  product_id: 'citizen_cases',
  status: 'PENDING',
  approver_1: null,
};

describe('requestAccess', () => {
  it('rejects windows above the tier maximum', async () => {
    const { run } = fakeSql({});
    await expect(
      requestAccess(run, {
        principal: 'a',
        requestedBy: 'a',
        productId: 'citizen_cases',
        durationMinutes: 8 * 1440,
        justification: 'long enough text',
      })
    ).rejects.toThrow(/between 1 minute and 7 days/);
  });
  it('rejects a second open request for the same product', async () => {
    const { run } = fakeSql({ open: true });
    await expect(
      requestAccess(run, {
        principal: 'a',
        requestedBy: 'a',
        productId: 'citizen_cases',
        durationMinutes: 60,
        justification: 'long enough text',
      })
    ).rejects.toBeInstanceOf(AccessError);
  });
  it('inserts a PENDING request', async () => {
    const { run, writes } = fakeSql({});
    const id = await requestAccess(run, {
      principal: 'a',
      requestedBy: 'a',
      productId: 'citizen_cases',
      durationMinutes: 60,
      justification: 'long enough text',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(writes).toEqual(['INSERT']);
  });
});

describe('approve', () => {
  it('blocks self-approval', async () => {
    const { run, writes } = fakeSql({ request: pending });
    await expect(approve(run, { requestId: 'r1', approver: 'alice', approverIsOwner: true })).rejects.toThrow(
      /Self-approval/
    );
    expect(writes).toEqual([]);
  });
  it('blocks non-owners', async () => {
    const { run } = fakeSql({ request: pending });
    await expect(approve(run, { requestId: 'r1', approver: 'bob', approverIsOwner: false })).rejects.toThrow(
      /owner group/
    );
  });
  it('activates on a single approval', async () => {
    const { run } = fakeSql({ request: pending });
    await expect(approve(run, { requestId: 'r1', approver: 'bob', approverIsOwner: true })).resolves.toBe('ACTIVE');
  });
  it('requires two different approvers when configured', async () => {
    const first = fakeSql({ request: pending, twoPerson: true });
    await expect(approve(first.run, { requestId: 'r1', approver: 'bob', approverIsOwner: true })).resolves.toBe(
      'PENDING_SECOND'
    );
    const second = fakeSql({ request: { ...pending, status: 'PENDING_SECOND', approver_1: 'bob' }, twoPerson: true });
    await expect(approve(second.run, { requestId: 'r1', approver: 'bob', approverIsOwner: true })).rejects.toThrow(
      /different approver/
    );
    await expect(approve(second.run, { requestId: 'r1', approver: 'carol', approverIsOwner: true })).resolves.toBe(
      'ACTIVE'
    );
  });
});
