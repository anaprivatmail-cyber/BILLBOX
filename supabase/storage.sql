-- Storage bucket for attachments and per-user access policies

-- Create private bucket 'attachments' if it doesn't exist
insert into storage.buckets (id, name, public)
select 'attachments', 'attachments', false
where not exists (select 1 from storage.buckets where id = 'attachments');

-- Policies on storage.objects for bucket 'attachments'
-- Access is limited to objects within a folder named by the user's UUID
-- e.g., path: <user_id>/filename.pdf

create policy "select own attachments" on storage.objects
for select using (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "insert own attachments" on storage.objects
for insert with check (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "update own attachments" on storage.objects
for update using (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "delete own attachments" on storage.objects
for delete using (
  bucket_id = 'attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);
