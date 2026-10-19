-- Runs once when a stand database is made (the image runs its init-scripts): the service roles get the
-- stand's password, as in Supabase's self-hosted setup.
\set pgpass `echo "$POSTGRES_PASSWORD"`
alter user authenticator with password :'pgpass';
alter user supabase_auth_admin with password :'pgpass';
alter user postgres with password :'pgpass';
