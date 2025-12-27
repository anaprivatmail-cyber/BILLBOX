import { useEffect, useState } from 'react'
import type { Warranty, CreateWarrantyInput } from '../types'

interface Props {
  initial?: Warranty | null
  onCancel: () => void
  onSave: (input: CreateWarrantyInput, id?: string) => Promise<void>
}

export default function WarrantyForm({ initial, onCancel, onSave }: Props) {
  const [itemName, setItemName] = useState('')
  const [supplier, setSupplier] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (initial) {
      setItemName(initial.item_name)
      setSupplier(initial.supplier || '')
      setPurchaseDate(initial.purchase_date || '')
      setExpiresAt(initial.expires_at || '')
    } else {
      setItemName('')
      setSupplier('')
      setPurchaseDate('')
      setExpiresAt('')
    }
  }, [initial])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!itemName) {
      setError('Item name is required.')
      return
    }
    if (!expiresAt) {
      setError('Expiry date is required.')
      return
    }
    setLoading(true)
    try {
      await onSave({ item_name: itemName, supplier: supplier || null, purchase_date: purchaseDate || null, expires_at: expiresAt }, initial?.id)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not save warranty'
      setError(msg)
    }
    setLoading(false)
  }

  return (
    <div style={{ padding: 16 }}>
      <h3>{initial ? 'Edit Warranty' : 'Add Warranty'}</h3>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <form onSubmit={handleSubmit}>
        <div style={{ marginTop: 8 }}>
          <label>
            Item name
            <input type="text" value={itemName} onChange={(e) => setItemName(e.target.value)} required style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>
            Supplier (optional)
            <input type="text" value={supplier} onChange={(e) => setSupplier(e.target.value)} style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>
            Purchase date (optional)
            <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>
            Expires at
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} required style={{ display: 'block', width: '100%', marginTop: 4 }} />
          </label>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button type="submit" disabled={loading}>{loading ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  )
}
