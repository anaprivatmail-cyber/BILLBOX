import { createClient, SupabaseClient } from '@supabase/supabase-js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function getViteEnv(key: string): string | undefined {
  try {
    const meta = (typeof import.meta !== 'undefined' ? import.meta : undefined) as { env?: Record<string, unknown> } | undefined
    const val = meta?.env?.[key]
    return typeof val === 'string' ? val : undefined
  } catch {
    return undefined
  }
}

function getExpoEnv(key: string): string | undefined {
  const env = (typeof process !== 'undefined' && isRecord(process) && isRecord((process as Record<string, unknown>).env))
    ? ((process as Record<string, unknown>).env as Record<string, unknown>)
    : undefined
  const val = env?.[key]
  return typeof val === 'string' ? val : undefined
}

function getEnv(key: string): string | undefined {
  return getViteEnv(key) || getExpoEnv(key)
}

export function getSupabaseClient(): SupabaseClient {
  const url = getEnv('VITE_SUPABASE_URL') || getEnv('EXPO_PUBLIC_SUPABASE_URL')
  const anon = getEnv('VITE_SUPABASE_ANON_KEY') || getEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY')
  if (!url || !anon) {
    throw new Error('Missing Supabase env vars (VITE_* or EXPO_PUBLIC_*).')
  }
  return createClient(url, anon)
}

export const supabase: SupabaseClient = getSupabaseClient()
