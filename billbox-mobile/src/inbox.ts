import AsyncStorage from '@react-native-async-storage/async-storage'
import * as FileSystem from 'expo-file-system'

export type InboxStatus = 'new' | 'pending' | 'processed' | 'archived'

export type InboxItem = {
  id: string
  created_at: string
  spaceId: string
  name: string
  uri: string
  localPath?: string
  mimeType?: string
  status: InboxStatus
  extractedFields?: any
  notes?: string
  meta?: any
}

const LS_INBOX_PREFIX = 'billbox.inbox.'

function key(spaceId: string | null | undefined): string {
  return `${LS_INBOX_PREFIX}${spaceId || 'default'}`
}

async function load(spaceId: string | null | undefined): Promise<InboxItem[]> {
  try {
    const raw = await AsyncStorage.getItem(key(spaceId))
    const parsed = raw ? (JSON.parse(raw) as InboxItem[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function save(spaceId: string | null | undefined, items: InboxItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key(spaceId), JSON.stringify(items))
  } catch {}
}

export async function listInbox(spaceId: string | null | undefined): Promise<InboxItem[]> {
  return load(spaceId)
}

export async function addToInbox(input: {
  spaceId: string | null | undefined
  uri: string
  name: string
  mimeType?: string
  id?: string
  createdAt?: string
  status?: InboxStatus
  extractedFields?: any
  notes?: string
  meta?: any
}): Promise<InboxItem> {
  const items = await load(input.spaceId)
  const now = new Date().toISOString()
  const createdAt = input.createdAt && typeof input.createdAt === 'string' ? input.createdAt : now
  const safeSpace = String(input.spaceId || 'default')
  const id = (input.id && String(input.id)) || `inbox_${Math.random().toString(36).slice(2, 10)}`
  const safeName = String(input.name || 'document').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'document'
  let localPath: string | undefined
  try {
    const base = (FileSystem as any).documentDirectory || (FileSystem as any).cacheDirectory
    if (base) {
      const dir = `${base}inbox/${safeSpace}`
      try { await FileSystem.makeDirectoryAsync(dir, { intermediates: true }) } catch {}
      const dest = `${dir}/${id}_${safeName}`
      const from = String(input.uri || '')
      if (/^https?:\/\//i.test(from)) {
        const dl = await FileSystem.downloadAsync(from, dest)
        localPath = dl?.uri || dest
      } else {
        await FileSystem.copyAsync({ from, to: dest })
        localPath = dest
      }
    }
  } catch {
    localPath = undefined
  }
  const next: InboxItem = {
    id,
    created_at: createdAt,
    spaceId: safeSpace,
    name: input.name || 'document',
    uri: input.uri,
    localPath: localPath || input.uri,
    mimeType: input.mimeType,
    status: input.status || 'new',
    extractedFields: input.extractedFields,
    notes: input.notes,
    meta: input.meta,
  }
  items.unshift(next)
  await save(input.spaceId, items)
  return next
}

export async function updateInboxItem(spaceId: string | null | undefined, id: string, patch: Partial<InboxItem>): Promise<void> {
  const items = await load(spaceId)
  const next = items.map((it) => (it.id === id ? { ...it, ...patch } : it))
  await save(spaceId, next)
}

export async function removeInboxItem(spaceId: string | null | undefined, id: string): Promise<void> {
  const items = await load(spaceId)
  await save(spaceId, items.filter((it) => it.id !== id))
}

export async function clearInbox(spaceId: string | null | undefined): Promise<void> {
  try {
    await AsyncStorage.removeItem(key(spaceId))
  } catch {}
}
