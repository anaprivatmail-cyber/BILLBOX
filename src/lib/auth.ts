import { supabase } from './supabase'

type ImportMetaEnv = ImportMeta & { env?: Record<string, unknown> }

export function getAppUrl(): string {
  const env = (import.meta as ImportMetaEnv).env
  const base = typeof env?.VITE_APP_URL === 'string' ? env.VITE_APP_URL : window.location.origin
  return String(base).replace(/\/$/, '')
}

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

export async function getSession() {
  const { data, error } = await supabase.auth.getSession()
  return { data, error }
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
  type ResendArgs = {
    type: 'signup'
    email: string
    options?: { emailRedirectTo?: string }
  }
  type ResendSupport = typeof supabase.auth & {
    resend?: (options: ResendArgs) => Promise<{ data: unknown; error: unknown }>
  }

  const auth = supabase.auth as ResendSupport
  if (typeof auth.resend !== 'function') {
    return { data: null, error: new Error('Supabase resend is not available') }
  }

  try {
    const { data, error } = await auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: redirectTo || `${getAppUrl()}/login` },
    })
    const normalizedError = error instanceof Error ? error : error ? new Error(String(error)) : null
    return { data, error: normalizedError }
  } catch (err: unknown) {
    const normalizedError = err instanceof Error ? err : new Error('Failed to resend confirmation email')
    return { data: null, error: normalizedError }
  }
}
