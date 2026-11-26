# Access portal (AppKit)

Request, approve and track time-bound access. Deployed by the bundle at the repo root; see the main README.

| Path | Purpose |
|---|---|
| `server/server.ts` | Routes: config, requests, approve, decline, demo approver settings |
| `server/lifecycle.ts` | Access rules, with two stores: `uc` (catalogue via SQL warehouse) and `store` (Lakebase) |
| `server/demoApprover.ts` | Demo auto-approver (`demo` target only) |
| `config/queries/*.obo.sql` | Reads that run as the signed-in user, through secure views |
| `client/src` | React UI (tabs: Request access, My access, Review queue, Access review) |

```bash
cp .env.example .env     # profile, warehouse, schema names
npm ci
npm run dev              # local, as your CLI profile user
npm test                 # unit tests
databricks apps validate --profile <profile>   # typegen, lint, typecheck, build, tests
```

The analytics result cache is disabled on purpose: access state changes by the second.
