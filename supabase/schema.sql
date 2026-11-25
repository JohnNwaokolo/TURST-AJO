-- Trust Ajo stores the prototype's complete application state in one row.
-- The Node server accesses this table with a Supabase secret key; never put
-- that key in browser code or expose this table to anon/authenticated roles.
create table if not exists public.app_state (
  id text primary key check (id = 'main'),
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

revoke all on table public.app_state from anon, authenticated;
grant usage on schema public to service_role;
grant all on table public.app_state to service_role;
