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
    <div className="p-4">
      <h3 className="text-lg font-semibold">{initial ? 'Edit Warranty' : 'Add Warranty'}</h3>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <form onSubmit={handleSubmit} className="mt-2 space-y-3">
        <div>
          <label className="label">Item name</label>
          <input type="text" value={itemName} onChange={(e) => setItemName(e.target.value)} required className="input" />
        </div>
        <div>
          <label className="label">Supplier (optional)</label>
          <input type="text" value={supplier} onChange={(e) => setSupplier(e.target.value)} className="input" />
        </div>
        <div>
          <label className="label">Purchase date (optional)</label>
          <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} className="input" />
        </div>
        <div>
          <label className="label">Expires at</label>
          <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} required className="input" />
        </div>
        <div className="mt-2 flex gap-2">
          <button type="submit" disabled={loading} className="btn btn-primary">{loading ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        </div>
      </form>
    </div>
  )
}
