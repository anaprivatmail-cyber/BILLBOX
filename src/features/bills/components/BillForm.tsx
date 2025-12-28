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
    <div className="p-5">
      <h3 className="text-xl font-semibold tracking-tight">{initial ? 'Edit Bill' : 'Add Bill'}</h3>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <form onSubmit={handleSubmit} className="mt-3 space-y-5">
        {/* Basics */}
        <div>
          <div className="text-xs text-neutral-400 mb-2">Basics</div>
          <div className="grid gap-3 sm:grid-cols-2">
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
              <label className="label">Due date</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required
                className="input"
              />
            </div>
          </div>
        </div>

        {/* Payment details */}
        <div>
          <div className="text-xs text-neutral-400 mb-2">Payment details</div>
          <div className="grid gap-3 sm:grid-cols-3">
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
              <label className="label">Creditor name</label>
              <input
                type="text"
                value={creditorName}
                onChange={(e) => setCreditorName(e.target.value)}
                className="input"
              />
              <div className="helper mt-1">Name of the account holder receiving the payment.</div>
            </div>
          </div>
        </div>

        {/* Optional */}
        <div>
          <div className="text-xs text-neutral-400 mb-2">Optional</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">IBAN</label>
              <input
                type="text"
                value={iban}
                onChange={(e) => setIban(e.target.value)}
                className="input"
              />
              <div className="helper mt-1">International Bank Account Number, no spaces.</div>
            </div>
            <div>
              <label className="label">Reference</label>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="input"
              />
              <div className="helper mt-1">Invoice or payment reference to identify the transfer.</div>
            </div>
            <div>
              <label className="label">Purpose</label>
              <input
                type="text"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                className="input"
              />
              <div className="helper mt-1">Short description of the payment (optional).</div>
            </div>
          </div>
        </div>

        <div className="mt-2 flex gap-2 justify-end">
          <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={loading} className="btn btn-primary">{loading ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  )
}
