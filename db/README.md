# Database

Supabase Postgres, project `afdhnjohvsoxwzlmpddj`, region `ap-southeast-1`.

Migrations are plain SQL applied with `psql`. The Supabase CLI is not used — there
is no local Postgres in this setup and the migration set is small enough that a
linear, idempotent apply is simpler to reason about.

Every file here is written to be **idempotent**: re-running the full set against an
existing database is a no-op rather than an error.

## Applying

Credentials come from Secrets Manager, never from a file on disk:

```bash
DB=$(aws secretsmanager get-secret-value --region ap-southeast-1 --secret-id hilom/supabase --query SecretString --output text | python -c "import json,sys;print(json.load(sys.stdin)['dbUrl'])")
psql "$DB" -v ON_ERROR_STOP=1 -f db/migrations/0001_initial_schema.sql
psql "$DB" -v ON_ERROR_STOP=1 -f db/migrations/0002_rls.sql
psql "$DB" -v ON_ERROR_STOP=1 -f db/seed/0001_seed_products.sql
```

Connections must use the pooler host (`aws-0-ap-southeast-1.pooler.supabase.com`).
The direct `db.<ref>.supabase.co` host is IPv6-only and does not resolve here.

## Access model

| Role | Key | Access |
|---|---|---|
| `anon` | publishable key (ships in the React bundle, public) | `select` on active products, their course mappings, and cached courses |
| `service_role` | secret key (backend only, Secrets Manager) | full access; bypasses RLS |

`orders` is readable only by `service_role`. RLS is enabled on it with **no**
policy, and privileges are revoked from `anon`/`authenticated`, so both layers
have to fail before buyer emails and payment IDs could leak.

Note that bypassing RLS is not the same as holding table privileges —
`service_role` needs explicit `grant`s (see `0002_rls.sql`), or every backend
read and write fails with `42501 permission denied`.

## Seed data caveat

**Prices in `db/seed/0001_seed_products.sql` are placeholders** and have not been
confirmed against real Hilom pricing. Set the real values before Phase 6 test
purchases carry any meaning.

Course mapping reflects the confirmed catalog: only Moodle courses 10, 15, 16, 17
and 18 are real, and the Breakthrough Bundle (course 17) sells access to courses
10, 15 and 16 rather than to course 17 itself.

## A scratch database, for the concurrency scripts

`scripts/test-seat-concurrency.sh` and `scripts/test-class-seat-concurrency.sh`
create and drop rows, so they must never be pointed at production. Build a
local throwaway instead — the full migration set applies cleanly from empty,
which is itself worth knowing:

```bash
psql -h localhost -U postgres -d postgres -c "create database hilom_scratch;"
psql -h localhost -U postgres -d hilom_scratch \
  -c "create role anon; create role authenticated; create role service_role;"
for f in db/migrations/*.sql; do
  psql -h localhost -U postgres -d hilom_scratch -v ON_ERROR_STOP=1 -q -f "$f" || break
done
```

The three roles come first because the migrations `grant` to them by name and
Supabase provides them; a local Postgres does not.

```bash
scripts/test-seat-concurrency.sh       "postgresql://postgres:postgres@localhost/hilom_scratch" 20 3
scripts/test-class-seat-concurrency.sh "postgresql://postgres:postgres@localhost/hilom_scratch" 20 3
```
