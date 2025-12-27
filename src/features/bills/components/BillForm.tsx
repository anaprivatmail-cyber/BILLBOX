import { useEffect, useState } from 'react'
import type { Bill, CreateBillInput } from '../types'

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
  const [creditorName, setCreditorName] = useState<string>('')
  const [iban, setIban] = useState<string>('')
  const [reference, setReference] = useState<string>('')
  const [purpose, setPurpose] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (initial) {
      setSupplier(initial.supplier)
      setAmount(initial.amount)
      setCurrency(initial.currency)
      setDueDate(initial.due_date)
      setCreditorName(initial.creditor_name || '')
      setIban(initial.iban || '')
      setReference(initial.reference || '')
      setPurpose(initial.purpose || '')
    } else {
      setSupplier('')
      setAmount(0)
      setCurrency('EUR')
      setDueDate('')
      setCreditorName('')
      setIban('')
      setReference('')
      setPurpose('')
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
      await onSave({
        supplier,
        amount: Number(amount),
        currency,
        due_date: dueDate,
        creditor_name: creditorName || null,
        iban: iban || null,
        reference: reference || null,
        purpose: purpose || null,
      }, initial?.id)
    } catch (err: any) {
      setError(err?.message || 'Could not save bill')
    }
    setLoading(false)
  }

  return (
    <div className="p-4">
      <h3 className="text-lg font-semibold">{initial ? 'Edit Bill' : 'Add Bill'}</h3>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <form onSubmit={handleSubmit} className="mt-2 space-y-3">
        <div>
          <label className="label">Supplier</label>
          <input
            type="text"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            required
            className="input"
          />
        </div>
        <div>
          <label className="label">Amount</label>
          <input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            required
            className="input"
          />
        </div>
        <div>
          <label className="label">Currency</label>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="input">
            {currencies.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Due date</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            required
            className="input"
          />
        </div>
        <div>
          <label className="label">Creditor name (optional)</label>
          <input
            type="text"
            value={creditorName}
            onChange={(e) => setCreditorName(e.target.value)}
            className="input"
          />
        </div>
        <div>
          <label className="label">IBAN (optional)</label>
          <input
            type="text"
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            className="input"
          />
        </div>
        <div>
          <label className="label">Reference (optional)</label>
          <input
            type="text"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="input"
          />
        </div>
        <div>
          <label className="label">Purpose (optional)</label>
          <input
            type="text"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            className="input"
          />
        </div>
        <div className="mt-2 flex gap-2">
          <button type="submit" disabled={loading} className="btn btn-primary">{loading ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        </div>
      </form>
    </div>
  )
}
