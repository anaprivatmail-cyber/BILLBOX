-- Email import (Brevo inbound) support
-- Adds:
-- - public.inbound_email_aliases: per-user/per-space forwarding alias token
-- - public.inbox_items: server-delivered Inbox items (attachments stored in Storage bucket 'attachments')
--
-- Run in Supabase SQL Editor or via Supabase CLI.

create extension if not exists "pgcrypto";

-- Per-space forwarding address token.
create table if not exists public.inbound_email_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  space_id text not null,
  alias_token text not null default gen_random_uuid()::text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists inbound_email_aliases_alias_token_uq on public.inbound_email_aliases(alias_token);
create unique index if not exists inbound_email_aliases_user_space_uq on public.inbound_email_aliases(user_id, space_id);
create index if not exists inbound_email_aliases_user_id_idx on public.inbound_email_aliases(user_id);

-- Server-delivered inbox items.
create table if not exists public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  space_id text not null,
  source text not null default 'email',
  status text not null default 'new', -- new|pending|processed|archived
  sender text null,
  subject text null,
  received_at timestamptz not null default now(),
  attachment_bucket text not null default 'attachments',
  attachment_path text null,
  attachment_name text null,
  mime_type text null,
  size_bytes bigint null,
  meta jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz null
);

create index if not exists inbox_items_user_space_idx on public.inbox_items(user_id, space_id);
create index if not exists inbox_items_user_status_idx on public.inbox_items(user_id, status);
create index if not exists inbox_items_received_at_idx on public.inbox_items(received_at);

-- updated_at triggers
create or replace function public.set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_inbound_email_aliases_updated_at'
  ) then
    create trigger trg_inbound_email_aliases_updated_at
    before update on public.inbound_email_aliases
    for each row execute function public.set_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_inbox_items_updated_at'
  ) then
    create trigger trg_inbox_items_updated_at
    before update on public.inbox_items
    for each row execute function public.set_updated_at();
  end if;
end $$;

-- NOTE: If your Supabase SQL Editor rejects DDL inside DO blocks in your setup,
-- you can use the safer re-runnable statements below instead:
-- drop trigger if exists trg_inbound_email_aliases_updated_at on public.inbound_email_aliases;
-- create trigger trg_inbound_email_aliases_updated_at before update on public.inbound_email_aliases for each row execute function public.set_updated_at();
-- drop trigger if exists trg_inbox_items_updated_at on public.inbox_items;
-- create trigger trg_inbox_items_updated_at before update on public.inbox_items for each row execute function public.set_updated_at();

-- RLS
alter table public.inbound_email_aliases enable row level security;
alter table public.inbox_items enable row level security;

-- Policies (created conditionally so the script is re-runnable)

-- Policies (re-runnable)
drop policy if exists "select own inbound email aliases" on public.inbound_email_aliases;
create policy "select own inbound email aliases" on public.inbound_email_aliases
for select using (auth.uid() = user_id);

drop policy if exists "insert own inbound email aliases" on public.inbound_email_aliases;
create policy "insert own inbound email aliases" on public.inbound_email_aliases
for insert with check (auth.uid() = user_id);

drop policy if exists "update own inbound email aliases" on public.inbound_email_aliases;
create policy "update own inbound email aliases" on public.inbound_email_aliases
for update using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "delete own inbound email aliases" on public.inbound_email_aliases;
create policy "delete own inbound email aliases" on public.inbound_email_aliases
for delete using (auth.uid() = user_id);

drop policy if exists "select own inbox items" on public.inbox_items;
create policy "select own inbox items" on public.inbox_items
for select using (auth.uid() = user_id);

drop policy if exists "insert own inbox items" on public.inbox_items;
create policy "insert own inbox items" on public.inbox_items
for insert with check (auth.uid() = user_id);

drop policy if exists "update own inbox items" on public.inbox_items;
create policy "update own inbox items" on public.inbox_items
for update using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "delete own inbox items" on public.inbox_items;
create policy "delete own inbox items" on public.inbox_items
for delete using (auth.uid() = user_id);
