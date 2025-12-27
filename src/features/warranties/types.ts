export type WarrantyStatus = 'active' | 'expiring' | 'expired'

export interface Warranty {
  id: string
  user_id: string
  item_name: string
  supplier?: string | null
  purchase_date?: string | null // YYYY-MM-DD
  expires_at?: string | null // YYYY-MM-DD
  created_at: string
}

export interface CreateWarrantyInput {
  item_name: string
  supplier?: string | null
  purchase_date?: string | null
  expires_at?: string | null
}

export interface UpdateWarrantyInput {
  item_name?: string
  supplier?: string | null
  purchase_date?: string | null
  expires_at?: string | null
}
