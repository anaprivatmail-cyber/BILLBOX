import { supabase } from './supabase';

export function getAppUrl(): string {
  const base = (import.meta as any).env?.VITE_APP_URL || window.location.origin
  return String(base).replace(/\/$/, '')
}

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  return { data, error };
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { data, error };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  return { error };
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  return { data, error };
}

export async function sendPasswordResetEmail(email: string, redirectTo?: string) {
  const url = redirectTo || `${getAppUrl()}/reset`
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: url })
  return { data, error }
}

export async function updatePassword(newPassword: string) {
  const { data, error } = await supabase.auth.updateUser({ password: newPassword })
  return { data, error }
}

export async function resendConfirmation(email: string, redirectTo?: string) {
  try {
    const { data, error } = await (supabase.auth as any).resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: redirectTo || `${getAppUrl()}/login` },
    })
    return { data, error }
  } catch (err: any) {
    return { data: null, error: err }
  }
}
