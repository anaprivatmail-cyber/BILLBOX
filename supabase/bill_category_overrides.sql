-- Vendor/category overrides (per user)
-- Run in Supabase SQL Editor or via CLI/migrations

create table if not exists public.bill_category_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  supplier_key text not null,
  category text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bill_category_overrides_user_supplier_uq
  on public.bill_category_overrides(user_id, supplier_key);
create index if not exists bill_category_overrides_user_id_idx
  on public.bill_category_overrides(user_id);

-- updated_at trigger (reuse set_updated_at if it already exists)
create or replace function public.set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_bill_category_overrides_updated_at on public.bill_category_overrides;
create trigger trg_bill_category_overrides_updated_at
before update on public.bill_category_overrides
for each row execute function public.set_updated_at();

-- RLS
alter table public.bill_category_overrides enable row level security;

drop policy if exists "select own category overrides" on public.bill_category_overrides;
create policy "select own category overrides" on public.bill_category_overrides
for select using (auth.uid() = user_id);

drop policy if exists "insert own category overrides" on public.bill_category_overrides;
create policy "insert own category overrides" on public.bill_category_overrides
for insert with check (auth.uid() = user_id);

drop policy if exists "update own category overrides" on public.bill_category_overrides;
create policy "update own category overrides" on public.bill_category_overrides
for update using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "delete own category overrides" on public.bill_category_overrides;
create policy "delete own category overrides" on public.bill_category_overrides
for delete using (auth.uid() = user_id);