# Supabase Backend Setup

This repository includes the Supabase client configuration and SQL for schema, RLS policies, and storage.

## Environment
Create a `.env` file based on `.env.example` and provide:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Client
The client is initialized in `src/lib/supabase.ts` and expects the environment variables above. Import it where needed in your app (no UI changes included here).

## Database Schema
Apply `supabase/schema.sql` in the Supabase SQL editor (or via CLI).

Then apply `supabase/payments.sql` to add optional payment fields (IBAN/reference/purpose and international bank details).

Tables:
- `public.bills`: user-specific bills
- `public.warranties`: user-specific warranties

## RLS Policies
Apply `supabase/policies.sql` to enable RLS and ensure users only access their own records.

## Storage
Apply `supabase/storage.sql` to create the private `attachments` bucket and per-user access policies. Store files under a folder named by the user's UUID, e.g. `user_id/filename.pdf`.

## Deployment Notes
- Run SQL files in order: `schema.sql`, `payments.sql`, `policies.sql`, `storage.sql`.
- Ensure authentication is enabled for your project and that `auth.uid()` resolves to the signed-in user's UUID.
