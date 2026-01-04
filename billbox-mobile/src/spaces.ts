import AsyncStorage from '@react-native-async-storage/async-storage'

export type SpacePlan = 'free' | 'basic' | 'pro'

export type Space = {
  id: string
  name: string
  plan?: SpacePlan
}

const KEY_SPACES = 'billbox.mobile.spaces'
const KEY_CURRENT_SPACE = 'billbox.mobile.currentSpace'

const DEFAULT_SPACES: Space[] = [
  { id: 'personal', name: 'Personal (Payer 1)', plan: 'free' },
  { id: 'personal2', name: 'Personal (Payer 2)', plan: 'free' },
]

async function readSpaces(): Promise<Space[]> {
  const raw = await AsyncStorage.getItem(KEY_SPACES)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Space[]) : []
  } catch {
    return []
  }
}

async function writeSpaces(spaces: Space[]): Promise<void> {
  await AsyncStorage.setItem(KEY_SPACES, JSON.stringify(spaces))
}

export async function ensureDefaults(): Promise<void> {
  const spaces = await readSpaces()
  if (spaces.length) return
  await writeSpaces(DEFAULT_SPACES)
  await AsyncStorage.setItem(KEY_CURRENT_SPACE, DEFAULT_SPACES[0].id)
}

export async function loadSpaces(): Promise<Space[]> {
  const spaces = await readSpaces()
  return spaces.length ? spaces : DEFAULT_SPACES
}

export async function upsertSpace(space: Space): Promise<void> {
  const spaces = await loadSpaces()
  const next = spaces.some((s) => s.id === space.id) ? spaces.map((s) => (s.id === space.id ? space : s)) : [space, ...spaces]
  await writeSpaces(next)
}

export async function removeSpace(spaceId: string): Promise<void> {
  const spaces = await loadSpaces()
  const next = spaces.filter((s) => s.id !== spaceId)
  await writeSpaces(next)

  const current = await loadCurrentSpaceId()
  if (current === spaceId) {
    await saveCurrentSpaceId(next[0]?.id || DEFAULT_SPACES[0].id)
  }
}

export async function loadCurrentSpaceId(): Promise<string> {
  return (await AsyncStorage.getItem(KEY_CURRENT_SPACE)) || DEFAULT_SPACES[0].id
}

export async function saveCurrentSpaceId(spaceId: string): Promise<void> {
  await AsyncStorage.setItem(KEY_CURRENT_SPACE, spaceId)
}
