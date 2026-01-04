import AsyncStorage from '@react-native-async-storage/async-storage'
import * as FileSystem from 'expo-file-system'

export type InboxItemStatus = 'pending' | 'archived' | 'processed'

export type InboxItem = {
  id: string
  spaceId: string
  name: string
  mimeType?: string
  localPath: string
  createdAt: number
  status: InboxItemStatus
  extractedFields?: any
  notes?: string
}

const STORAGE_KEY_PREFIX = 'billbox.mobile.inbox:'

function key(spaceId: string) {
  return `${STORAGE_KEY_PREFIX}${spaceId}`
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function read(spaceId: string): Promise<InboxItem[]> {
  const raw = await AsyncStorage.getItem(key(spaceId))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as InboxItem[]) : []
  } catch {
    return []
  }
}

async function write(spaceId: string, items: InboxItem[]): Promise<void> {
  await AsyncStorage.setItem(key(spaceId), JSON.stringify(items))
}

async function ensureDir(path: string) {
  try {
    const info = await FileSystem.getInfoAsync(path)
    if (!info.exists) await FileSystem.makeDirectoryAsync(path, { intermediates: true })
  } catch {
    // ignore
  }
}

async function tryCopyToDocuments(spaceId: string, uri: string, name: string): Promise<string> {
  const base = (FileSystem as any).documentDirectory as string | null | undefined
  if (!base) return uri

  const dir = `${base}inbox/${spaceId}`
  await ensureDir(dir)

  const ext = (() => {
    const m = name.match(/\.[a-zA-Z0-9]+$/)
    return m ? m[0] : ''
  })()

  const dest = `${dir}/${newId()}${ext}`
  try {
    await FileSystem.copyAsync({ from: uri, to: dest })
    return dest
  } catch {
    return uri
  }
}

export async function listInbox(spaceId: string): Promise<InboxItem[]> {
  const items = await read(spaceId)
  return [...items].sort((a, b) => b.createdAt - a.createdAt)
}

export async function addToInbox({
  spaceId,
  uri,
  name,
  mimeType,
}: {
  spaceId: string
  uri: string
  name: string
  mimeType?: string
}): Promise<InboxItem> {
  const items = await read(spaceId)
  const localPath = await tryCopyToDocuments(spaceId, uri, name)

  const item: InboxItem = {
    id: newId(),
    spaceId,
    name,
    mimeType,
    localPath,
    createdAt: Date.now(),
    status: 'pending',
  }

  items.unshift(item)
  await write(spaceId, items)
  return item
}

export async function updateInboxItem(spaceId: string, id: string, patch: Partial<InboxItem>): Promise<void> {
  const items = await read(spaceId)
  const next = items.map((it) => (it.id === id ? { ...it, ...patch } : it))
  await write(spaceId, next)
}

export async function removeInboxItem(spaceId: string, id: string): Promise<void> {
  const items = await read(spaceId)
  const target = items.find((it) => it.id === id)
  const next = items.filter((it) => it.id !== id)
  await write(spaceId, next)

  const base = (FileSystem as any).documentDirectory as string | null | undefined
  if (base && target?.localPath?.startsWith(base)) {
    try {
      await FileSystem.deleteAsync(target.localPath, { idempotent: true })
    } catch {
      // ignore
    }
  }
}

export async function clearInbox(spaceId: string): Promise<void> {
  const items = await read(spaceId)
  await write(spaceId, [])

  const base = (FileSystem as any).documentDirectory as string | null | undefined
  for (const it of items) {
    if (base && it.localPath?.startsWith(base)) {
      try {
        await FileSystem.deleteAsync(it.localPath, { idempotent: true })
      } catch {}
    }
  }
}
