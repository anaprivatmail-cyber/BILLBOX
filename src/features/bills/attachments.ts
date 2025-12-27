import { supabase } from '../../lib/supabase'

export type AttachmentItem = {
  name: string
  path: string
  created_at?: string
  updated_at?: string
  last_accessed_at?: string
  metadata?: unknown
}

async function getCurrentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  const id = data?.user?.id
  if (!id) throw new Error('No authenticated user')
  return id
}

function basePath(userId: string, billId: string): string {
  return `${userId}/bills/${billId}`
}

export async function listAttachments(billId: string): Promise<{ items: AttachmentItem[]; error: Error | null }>{
  try {
    const userId = await getCurrentUserId()
    const dir = basePath(userId, billId)
    const { data, error } = await supabase.storage.from('attachments').list(dir, { limit: 100 })
    if (error) return { items: [], error }
    const items: AttachmentItem[] = (data || []).map((f: any) => ({
      name: f.name,
      path: `${dir}/${f.name}`,
      created_at: f.created_at,
      updated_at: f.updated_at,
      last_accessed_at: f.last_accessed_at,
      metadata: f.metadata,
    }))
    return { items, error: null }
  } catch (err: any) {
    return { items: [], error: err }
  }
}

export async function uploadAttachments(billId: string, files: File[]): Promise<{ error: Error | null }>{
  try {
    const userId = await getCurrentUserId()
    const dir = basePath(userId, billId)
    // Upload sequentially to keep simple error handling
    for (const file of files) {
      const path = `${dir}/${file.name}`
      const { error } = await supabase.storage.from('attachments').upload(path, file, {
        upsert: true,
        contentType: file.type || undefined,
      })
      if (error) return { error }
    }
    return { error: null }
  } catch (err: any) {
    return { error: err }
  }
}

export async function deleteAttachment(path: string): Promise<{ error: Error | null }>{
  const { error } = await supabase.storage.from('attachments').remove([path])
  return { error }
}

export async function getDownloadUrl(path: string): Promise<{ url: string | null; error: Error | null }>{
  const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, 60 * 15)
  return { url: data?.signedUrl || null, error }
}
