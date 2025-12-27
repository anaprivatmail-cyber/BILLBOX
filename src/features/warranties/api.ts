import { PostgrestError } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { Warranty, CreateWarrantyInput, UpdateWarrantyInput, WarrantyStatus } from './types'

async function getCurrentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  const id = data?.user?.id
  if (!id) throw new Error('No authenticated user')
  return id
}

export function getWarrantyStatus(w: Warranty): WarrantyStatus {
  const today = new Date()
  const expires = w.expires_at ? new Date(w.expires_at) : null
  if (!expires) return 'active'
  const days = Math.floor((expires.getTime() - new Date(today.toDateString()).getTime()) / (1000 * 60 * 60 * 24))
  if (days < 0) return 'expired'
  if (days <= 30) return 'expiring'
  return 'active'
}

export async function listWarranties(): Promise<{ data: Warranty[]; error: PostgrestError | null }>{
  const userId = await getCurrentUserId()
  const { data, error } = await supabase
    .from('warranties')
    .select('*')
    .eq('user_id', userId)
    .order('expires_at', { ascending: true, nullsFirst: true })
  return { data: (data as Warranty[]) || [], error }
}

export async function createWarranty(input: CreateWarrantyInput): Promise<{ data: Warranty | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId()
  const payload = { ...input, user_id: userId }
  const { data, error } = await supabase.from('warranties').insert(payload).select().single()
  return { data: (data as Warranty) || null, error }
}

export async function updateWarranty(id: string, input: UpdateWarrantyInput): Promise<{ data: Warranty | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId()
  const { data, error } = await supabase
    .from('warranties')
    .update(input)
    .eq('user_id', userId)
    .eq('id', id)
    .select()
    .single()
  return { data: (data as Warranty) || null, error }
}

export async function deleteWarranty(id: string): Promise<{ error: PostgrestError | null }>{
  const userId = await getCurrentUserId()
  const { error } = await supabase
    .from('warranties')
    .delete()
    .eq('user_id', userId)
    .eq('id', id)
  return { error }
}
