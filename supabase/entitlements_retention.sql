-- Entitlements retention fields for downgrade/export/delete workflows
-- Run in Supabase SQL Editor or via CLI migrations

alter table public.entitlements
  add column if not exists export_until timestamptz,
  add column if not exists delete_at timestamptz,
  add column if not exists downgrade_cleanup_at timestamptz;

create index if not exists entitlements_export_until_idx on public.entitlements(export_until);
create index if not exists entitlements_delete_at_idx on public.entitlements(delete_at);
create index if not exists entitlements_downgrade_cleanup_idx on public.entitlements(downgrade_cleanup_at);
