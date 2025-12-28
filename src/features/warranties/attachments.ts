import { supabase } from '../../lib/supabase'

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

function basePath(userId: string, warrantyId: string): string {
  return `${userId}/warranties/${warrantyId}`
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

function safeFileName(name: string): string {
  const base = name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '')
  return base.toLowerCase()
}

export async function uploadAttachments(warrantyId: string, files: File[]): Promise<{ error: Error | null }>{
  try {
    const userId = await getCurrentUserId()
    const dir = basePath(userId, warrantyId)
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
