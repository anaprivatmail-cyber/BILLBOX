-- SQL snippet to extend public.bills with payment-related columns
-- Do NOT run automatically; apply manually in Supabase SQL editor

alter table public.bills add column if not exists creditor_name text;
alter table public.bills add column if not exists iban text;
alter table public.bills add column if not exists reference text;
alter table public.bills add column if not exists purpose text;
