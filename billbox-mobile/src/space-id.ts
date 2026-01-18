export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuidString(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function resolveDbSpaceIdFromEntitlements(
  entitlements: { spaceId?: string | null; spaceId2?: string | null } | null | undefined,
  localSpaceId: string | null | undefined,
): string | null {
  const local = typeof localSpaceId === 'string' ? localSpaceId.trim() : ''
  if (!local) return null
  const candidate = local === 'personal2' ? entitlements?.spaceId2 : entitlements?.spaceId
  const raw = typeof candidate === 'string' ? candidate.trim() : ''
  return isUuidString(raw) ? raw : null
}

export function localPayerIdFromDbSpaceId(
  entitlements: { spaceId?: string | null; spaceId2?: string | null } | null | undefined,
  dbSpaceId: string | null | undefined,
): 'personal' | 'personal2' | null {
  const raw = typeof dbSpaceId === 'string' ? dbSpaceId.trim() : ''
  if (!isUuidString(raw)) return null
  if (entitlements?.spaceId && raw === entitlements.spaceId) return 'personal'
  if (entitlements?.spaceId2 && raw === entitlements.spaceId2) return 'personal2'
  return null
}
