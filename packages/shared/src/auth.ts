import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password })
  return { data, error }
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  return { data, error }
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  return { error }
}

export async function getSession(): Promise<{ data: { session: Session | null } | null; error: unknown }>{
  const { data, error } = await supabase.auth.getSession()
  return { data, error }
}

export async function sendPasswordResetEmail(email: string, redirectTo: string) {
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  return { data, error }
}

export async function updatePassword(newPassword: string) {
  const { data, error } = await supabase.auth.updateUser({ password: newPassword })
  return { data, error }
}
