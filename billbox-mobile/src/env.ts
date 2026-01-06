import Constants from 'expo-constants'

function readExtra(key: string): string | undefined {
  const extra = (Constants as any)?.expoConfig?.extra || (Constants as any)?.manifest?.extra
  const v = extra?.[key]
  return typeof v === 'string' ? v : undefined
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = readExtra(key) ?? (process.env as any)?.[`EXPO_PUBLIC_${key}`] ?? (process.env as any)?.[key]
  if (raw == null) return fallback
  if (typeof raw === 'boolean') return raw
  return String(raw).toLowerCase() === 'true' || String(raw) === '1'
}

export const ENABLE_PUSH_NOTIFICATIONS = readBool('ENABLE_PUSH_NOTIFICATIONS', false)
export const ENABLE_IAP = readBool('ENABLE_IAP', false)
export const PUBLIC_SITE_URL: string | undefined =
  readExtra('PUBLIC_SITE_URL')
  ?? (process.env as any)?.EXPO_PUBLIC_PUBLIC_SITE_URL
  ?? (process.env as any)?.EXPO_PUBLIC_SITE_URL
