export type BillStatus = 'unpaid' | 'paid'
export type BillFilter = 'all' | 'unpaid' | 'paid' | 'overdue'

export interface Bill {
  id: string
  user_id: string
  supplier: string
  amount: number
  currency: string
  due_date: string // YYYY-MM-DD
  status: BillStatus
  created_at: string
  creditor_name?: string | null
  iban?: string | null
  reference?: string | null
  reference_model?: string | null
  purpose?: string | null
  invoice_number?: string | null
  category?: string | null
}

export interface CreateBillInput {
  supplier: string
  amount: number
  currency: string
  due_date: string
  status?: BillStatus
  creditor_name?: string | null
  iban?: string | null
  reference?: string | null
  reference_model?: string | null
  purpose?: string | null
  invoice_number?: string | null
  category?: string | null
}

export interface UpdateBillInput {
  supplier?: string
  amount?: number
  currency?: string
  due_date?: string
  status?: BillStatus
  creditor_name?: string | null
  iban?: string | null
  reference?: string | null
  reference_model?: string | null
  purpose?: string | null
  invoice_number?: string | null
  category?: string | null
}
