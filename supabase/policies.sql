-- Row Level Security policies for bills and warranties
-- Ensure users only access their own records

alter table public.bills enable row level security;
alter table public.warranties enable row level security;
alter table public.entitlements enable row level security;

-- Bills policies
create policy "select own bills" on public.bills
for select using (auth.uid() = user_id);

create policy "insert own bills" on public.bills
for insert with check (auth.uid() = user_id);

create policy "update own bills" on public.bills
for update using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "delete own bills" on public.bills
for delete using (auth.uid() = user_id);

-- Warranties policies
create policy "select own warranties" on public.warranties
for select using (auth.uid() = user_id);

create policy "insert own warranties" on public.warranties
for insert with check (auth.uid() = user_id);

create policy "update own warranties" on public.warranties
for update using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "delete own warranties" on public.warranties
for delete using (auth.uid() = user_id);

-- Entitlements policies: users can read their own subscription state
create policy "select own entitlements" on public.entitlements
for select using (auth.uid() = user_id);
