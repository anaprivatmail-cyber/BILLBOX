import { useEffect, useState } from 'react'
import { Bill, CreateBillInput } from '../types'

interface Props {
  initial?: Bill | null
  onCancel: () => void
  onSave: (input: CreateBillInput, id?: string) => Promise<void>
}

const currencies = ['EUR', 'USD', 'GBP']

export default function BillForm({ initial, onCancel, onSave }: Props) {
  const [supplier, setSupplier] = useState('')
  const [amount, setAmount] = useState<number>(0)
  const [currency, setCurrency] = useState('EUR')
  const [dueDate, setDueDate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (initial) {
      setSupplier(initial.supplier)
      setAmount(initial.amount)
      setCurrency(initial.currency)
      setDueDate(initial.due_date)
    } else {
      setSupplier('')
      setAmount(0)
      setCurrency('EUR')
      setDueDate('')
    }
  }, [initial])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!supplier || !dueDate) {
      setError('Supplier and due date are required.')
      return
    }
    setLoading(true)
    try {
      await onSave({ supplier, amount: Number(amount), currency, due_date: dueDate }, initial?.id)
    } catch (err: any) {
      setError(err?.message || 'Could not save bill')
    }
    setLoading(false)
  }

  return (
    <div style={{ padding: 16 }}>
      <h3>{initial ? 'Edit Bill' : 'Add Bill'}</h3>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <form onSubmit={handleSubmit}>
        <div style={{ marginTop: 8 }}>
          <label>
            Supplier
            <input
              type="text"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              required
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
          </label>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>
            Amount
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              required
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
          </label>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>
            Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ display: 'block', width: '100%', marginTop: 4 }}>
              {currencies.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>
            Due date
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              required
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
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
