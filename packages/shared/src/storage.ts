import { supabase } from './supabase'

export type AttachmentItem = {
  name: string
  path: string
  created_at?: string
  updated_at?: string
  last_accessed_at?: string
  metadata?: Record<string, unknown> | null
}

async function getCurrentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  const id = data?.user?.id
  if (!id) throw new Error('No authenticated user')
  return id
}

function basePath(userId: string, kind: 'bills' | 'warranties', id: string): string {
  return `${userId}/${kind}/${id}`
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

function safeFileName(name: string): string {
  const base = name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '')
  return base.toLowerCase()
}

export async function listAttachments(kind: 'bills' | 'warranties', id: string): Promise<{ items: AttachmentItem[]; error: Error | null }>{
  try {
    const userId = await getCurrentUserId()
    const dir = basePath(userId, kind, id)
    const { data, error } = await supabase.storage.from('attachments').list(dir, {
      limit: 100,
      sortBy: { column: 'name', order: 'desc' },
    })
    if (error) return { items: [], error: toError(error) }
    type StorageEntry = { name: string; created_at?: string; updated_at?: string; last_accessed_at?: string; metadata?: Record<string, unknown> | null }
    const raw = Array.isArray(data) ? (data as unknown as StorageEntry[]) : []
    const items: AttachmentItem[] = raw.map((f) => ({
      name: f.name,
      path: `${dir}/${f.name}`,
      created_at: f.created_at,
      updated_at: f.updated_at,
      last_accessed_at: f.last_accessed_at,
      metadata: f.metadata ?? null,
    }))
    return { items, error: null }
  } catch (err: unknown) {
    return { items: [], error: toError(err) }
  }
}

export async function uploadAttachments(kind: 'bills' | 'warranties', id: string, files: File[]): Promise<{ error: Error | null }>{
  try {
    const userId = await getCurrentUserId()
    const dir = basePath(userId, kind, id)
    for (const file of files) {
      const ts = Date.now()
      const path = `${dir}/${ts}-${safeFileName(file.name)}`
      const { error } = await supabase.storage.from('attachments').upload(path, file, {
        upsert: true,
        contentType: file.type || undefined,
      })
      if (error) return { error: toError(error) }
    }
    return { error: null }
  } catch (err: unknown) {
    return { error: toError(err) }
  }
}

export async function deleteAttachment(path: string): Promise<{ error: Error | null }>{
  const { error } = await supabase.storage.from('attachments').remove([path])
  return { error: error ? toError(error) : null }
}

export async function getDownloadUrl(path: string): Promise<{ url: string | null; error: Error | null }>{
  const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, 60)
  return { url: data?.signedUrl || null, error: error ? toError(error) : null }
}
