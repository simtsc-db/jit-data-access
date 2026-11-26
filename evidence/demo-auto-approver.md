# Demo auto-approver: end-to-end run

Run on 2026-11-26 (06:13 to 06:15 UTC), `demo` target, through the deployed portal's HTTP API as the operator
(a member of `jit-access-owners`). The approver is a separate service principal (`<approver-sp>`) whose
credentials come from a secret scope via app resources. Identities and URLs are redacted.

| Step | Result |
|---|---|
| `GET /api/portal/config` | `demoMode: true`, `demoApprover: true` |
| `GET /api/portal/demo/approver` | enabled, rate 100, identity `<approver-sp>`, `canEdit: true` (operator is an owner) |
| Rate **100%**, operator rows before | 0 |
| Submit 1-minute request | HTTP 200, `PENDING`, `autoDecisionInMs: 3000` |
| Record 8 s later | `ACTIVE`, approver_1 `<approver-sp>`, `DEMO_AUTO`, reason "drew 56.5 against a 100% approval rate -> approved" |
| Operator rows | **5000** |
| Rows after the 1-minute window | **0** (no job involved) |
| Rate **0%**, submit again | HTTP 200, `PENDING` |
| Record 8 s later | `DENIED`, `DEMO_AUTO`, reason "drew 82.6 against a 0% approval rate -> declined" |
| Operator rows | 0 |
| Last decision reported by the card endpoint | `DENIED`, no error |

Unit tests (`server/demoApprover.test.ts`): rate 100 always approves and 0 always declines for any draw,
threshold boundary, clamping, config off outside demo mode or without credentials, `DEMO_AUTO` recorded,
the approver still bound by the self-approval and owner-group rules. 18/18 tests pass.

Not covered here: the UI slider was not clicked through in a browser (workspace SSO); the same endpoints back it.
