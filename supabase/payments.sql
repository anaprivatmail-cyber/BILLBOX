-- Add payment-related optional columns to public.bills
-- Paste this snippet into Supabase SQL Editor (SQL > New query)
-- RLS policies remain unchanged.

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS creditor_name text NULL,
  ADD COLUMN IF NOT EXISTS iban text NULL,
  ADD COLUMN IF NOT EXISTS reference text NULL,
  ADD COLUMN IF NOT EXISTS purpose text NULL,
  ADD COLUMN IF NOT EXISTS payment_details text NULL,
  ADD COLUMN IF NOT EXISTS invoice_number text NULL;
