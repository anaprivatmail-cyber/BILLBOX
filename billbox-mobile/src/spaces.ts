import AsyncStorage from '@react-native-async-storage/async-storage'

export type SpacePlan = 'free' | 'basic' | 'pro'

export type Space = {
  id: string
  name: string
  kind: 'personal' | 'business'
  plan: SpacePlan
  seats: number
  created_at: string
}

const LS_SPACES = 'billbox.spaces'
const LS_CURRENT_SPACE = 'billbox.currentSpace'

export async function loadSpaces(): Promise<Space[]> {
  try {
    const raw = await AsyncStorage.getItem(LS_SPACES)
    const parsed = raw ? (JSON.parse(raw) as Space[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function saveSpaces(spaces: Space[]): Promise<void> {
  try {
    await AsyncStorage.setItem(LS_SPACES, JSON.stringify(spaces))
  } catch {}
}

export async function loadCurrentSpaceId(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(LS_CURRENT_SPACE)
    return raw ? String(raw) : null
  } catch {
    return null
  }
}

export async function saveCurrentSpaceId(id: string): Promise<void> {
  try {
    await AsyncStorage.setItem(LS_CURRENT_SPACE, id)
  } catch {}
}

export async function ensureDefaults(): Promise<{ spaces: Space[]; currentId: string }>{
  const now = new Date().toISOString()
  let spaces = await loadSpaces()

  if (!spaces.length) {
    spaces = [
      {
        id: 'personal',
        name: 'Payer 1',
        kind: 'personal',
        plan: 'free',
        seats: 1,
        created_at: now,
      },
    ]
    await saveSpaces(spaces)
  }

  let currentId = (await loadCurrentSpaceId()) || spaces[0]?.id || 'personal'
  if (!spaces.some((s) => s.id === currentId)) {
    currentId = spaces[0]?.id || 'personal'
    await saveCurrentSpaceId(currentId)
  }

  return { spaces, currentId }
}

export async function upsertSpace(space: Space): Promise<void> {
  const spaces = await loadSpaces()
  const idx = spaces.findIndex((s) => s.id === space.id)
  const next = idx >= 0 ? spaces.map((s, i) => (i === idx ? space : s)) : [space, ...spaces]
  await saveSpaces(next)
}

export async function removeSpace(id: string): Promise<void> {
  const spaces = await loadSpaces()
  const next = spaces.filter((s) => s.id !== id)
  await saveSpaces(next)
  const current = await loadCurrentSpaceId()
  if (current === id) {
    const fallback = next[0]?.id || 'personal'
    await saveCurrentSpaceId(fallback)
  }
}
