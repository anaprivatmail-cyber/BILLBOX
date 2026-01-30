-- Admin/comp override for permanent access
-- Run in Supabase SQL Editor or via CLI migrations

alter table public.entitlements
  add column if not exists is_comp boolean not null default false;

create index if not exists entitlements_is_comp_idx on public.entitlements(is_comp);
