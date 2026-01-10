function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1' || v === 'yes' || v === 'y') return true
    if (v === 'false' || v === '0' || v === 'no' || v === 'n') return false
  }
  return fallback
}

// Public site used for legal pages.
export const PUBLIC_SITE_URL: string =
  (process.env.EXPO_PUBLIC_PUBLIC_SITE_URL as string | undefined) ||
  (process.env.EXPO_PUBLIC_SITE_URL as string | undefined) ||
  'https://billbox.app'

export const ENABLE_PUSH_NOTIFICATIONS: boolean = parseBool(process.env.EXPO_PUBLIC_ENABLE_PUSH_NOTIFICATIONS, false)
export const ENABLE_IAP: boolean = parseBool(process.env.EXPO_PUBLIC_ENABLE_IAP, true)
