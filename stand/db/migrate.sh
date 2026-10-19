#!/bin/sh
# Applies one version's migrations (supabase/migrations/*.sql, in name order), each file in one transaction,
# as the postgres role, the way `supabase db reset` does; then supabase/seed.sql if there is one.
# (stand/db/before-migrations.sql, if there is one, goes first: see below.)
# Waits for the auth service to make its schema first. Stops at the first file that fails.
set -e
export PGUSER=postgres PGDATABASE=postgres

until psql -tAc "select to_regclass('auth.users') is not null" 2>/dev/null | grep -q t; do sleep 1; done

if psql -tAc "select to_regclass('stand.migrations') is not null" | grep -q t; then
  echo "$VERSION: migrations already applied"
  exit 0
fi

# objects that a Supabase service the stand does not run would make (Storage, Realtime), if a project's
# migrations need them: stand/db/before-migrations.sql, as the image's superuser
if [ -f /stand-db/before-migrations.sql ]; then
  PGUSER=supabase_admin psql -q -v ON_ERROR_STOP=1 --single-transaction -f /stand-db/before-migrations.sql
fi

n=0
for f in /supabase/migrations/*.sql; do
  [ -e "$f" ] || continue
  if ! psql -q -v ON_ERROR_STOP=1 --single-transaction -f "$f"; then
    echo "$VERSION: migration failed: $(basename "$f")"
    exit 1
  fi
  n=$((n + 1))
done
if [ -f /supabase/seed.sql ]; then psql -q -v ON_ERROR_STOP=1 --single-transaction -f /supabase/seed.sql; fi

psql -q -c "create schema stand; create table stand.migrations (applied int not null); insert into stand.migrations values ($n);"
psql -q -c "notify pgrst, 'reload schema'"
echo "$VERSION: applied $n migrations"
