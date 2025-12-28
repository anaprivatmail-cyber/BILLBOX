import type { PostgrestError } from '@supabase/supabase-js'
import { supabase } from '../supabase'
import type { Bill, BillStatus, CreateBillInput, UpdateBillInput } from '../types/bills'

async function getCurrentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  const id = data?.user?.id
  if (!id) throw new Error('No authenticated user')
  return id
}

export async function listBills(): Promise<{ data: Bill[]; error: PostgrestError | null }> {
  const userId = await getCurrentUserId()
  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .eq('user_id', userId)
    .order('due_date', { ascending: true })
  return { data: (data as Bill[]) || [], error }
}

export async function getBill(id: string): Promise<{ data: Bill | null; error: PostgrestError | null }> {
  const userId = await getCurrentUserId()
  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .single()
  return { data: (data as Bill) || null, error }
}

export async function createBill(input: CreateBillInput): Promise<{ data: Bill | null; error: PostgrestError | null }> {
  const userId = await getCurrentUserId()
  const payload = { ...input, user_id: userId, status: (input.status || 'unpaid') as BillStatus }
  const { data, error } = await supabase
    .from('bills')
    .insert(payload)
    .select()
    .single()
  return { data: (data as Bill) || null, error }
}

export async function updateBill(id: string, input: UpdateBillInput): Promise<{ data: Bill | null; error: PostgrestError | null }> {
  const userId = await getCurrentUserId()
  const { data, error } = await supabase
    .from('bills')
    .update(input)
    .eq('user_id', userId)
    .eq('id', id)
    .select()
    .single()
  return { data: (data as Bill) || null, error }
}

export async function deleteBill(id: string): Promise<{ error: PostgrestError | null }> {
  const userId = await getCurrentUserId()
  const { error } = await supabase
    .from('bills')
    .delete()
    .eq('user_id', userId)
    .eq('id', id)
  return { error }
}

export async function setBillStatus(id: string, status: BillStatus): Promise<{ data: Bill | null; error: PostgrestError | null }> {
  return updateBill(id, { status })
}

export function isOverdue(bill: Bill): boolean {
  if (bill.status === 'paid') return false
  const today = new Date()
  const due = new Date(bill.due_date)
  return due.getTime() < new Date(today.toDateString()).getTime()
}
