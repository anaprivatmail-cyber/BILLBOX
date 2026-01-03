-- Supabase schema: bills and warranties tables
-- Run in Supabase SQL Editor or via CLI/migrations

create extension if not exists "pgcrypto";

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  supplier text not null,
  amount numeric(12,2) not null,
  currency text not null,
  due_date date,
  status text not null,
  created_at timestamptz not null default now()
);

create index if not exists bills_user_id_idx on public.bills(user_id);

create table if not exists public.warranties (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  item_name text not null,
  supplier text,
  purchase_date date,
  bill_id uuid,
  expires_at date,
  created_at timestamptz not null default now()
);

create index if not exists warranties_user_id_idx on public.warranties(user_id);
create index if not exists warranties_bill_id_idx on public.warranties(bill_id);

-- Ensure optional columns exist if table was created previously
alter table public.warranties add column if not exists supplier text;
alter table public.warranties add column if not exists purchase_date date;
alter table public.warranties add column if not exists bill_id uuid;
