import { useEffect, useMemo, useRef, useState } from 'react'
import type { Bill, CreateBillInput } from '../types'
import { Tabs } from '../../../components/ui/Tabs'
import QRScanner from '../../../components/QRScanner'
import { parseEPC } from '../../../lib/epc'

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
  const [inputMethod, setInputMethod] = useState<'manual' | 'upload' | 'qr'>('manual')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  // OCR placeholder: no state needed while feature is pending
  const [decodedText, setDecodedText] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

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

  const inputTabs = useMemo(() => ([
    { key: 'manual', label: 'Manual' },
    { key: 'upload', label: 'Photo-PDF' },
    { key: 'qr', label: 'Scan QR' },
  ]), [])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null
    setSelectedFile(file)
  }


  function onQrDecode(text: string) {
    setDecodedText(text)
    const epc = parseEPC(text)
    if (epc) {
      if (epc.creditor_name) setCreditorName(epc.creditor_name)
      if (epc.iban) setIban(epc.iban)
      if (typeof epc.amount === 'number') setAmount(epc.amount)
      if (epc.purpose) setPurpose(epc.purpose)
      if (epc.reference) setReference(epc.reference)
    }
  }

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

  // Ensure the form container is scrolled to top when opened
  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [])

  return (
    <div ref={containerRef} className="p-5 max-h-[80vh] overflow-y-auto scroll-smooth touch-pan-y">
      <h3 className="text-xl font-semibold tracking-tight">{initial ? 'Edit Bill' : 'Add Bill'}</h3>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <form onSubmit={handleSubmit} className="mt-3 space-y-5">
        {/* Sticky input method bar */}
        <div className="sticky top-0 z-10 -mx-5 px-5 py-2 bg-white/90 backdrop-blur border-b border-neutral-200">
          <div className="text-xs text-neutral-500 mb-2">Input method</div>
          <Tabs items={inputTabs} value={inputMethod} onChange={(k) => setInputMethod(k as typeof inputMethod)} />
          {inputMethod === 'upload' && (
            <div className="mt-3 space-y-2">
              <input type="file" accept="application/pdf,image/*" onChange={handleFileChange} className="input" />
              {selectedFile && (
                <div className="flex items-center gap-3 text-sm">
                  <div className="font-medium">{selectedFile.name}</div>
                  {selectedFile.type.startsWith('image/') ? (
                    <img src={URL.createObjectURL(selectedFile)} alt="preview" className="h-16 w-16 object-cover rounded border" />
                  ) : (
                    <div className="h-16 w-16 flex items-center justify-center rounded border bg-neutral-100">PDF</div>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <button type="button" className="btn btn-secondary" disabled>Extract data</button>
              </div>
              <div className="text-xs text-neutral-600">OCR coming</div>
              <div className="text-xs text-neutral-500">Manual editing is always available below.</div>
            </div>
          )}
          {inputMethod === 'qr' && (
            <div className="mt-3 space-y-2">
              <QRScanner onDecode={onQrDecode} />
              {decodedText && (
                <div className="mt-2">
                  <div className="text-xs text-neutral-500 mb-1">Decoded text</div>
                  <textarea className="input w-full h-24" value={decodedText} readOnly />
                  <div className="text-xs text-neutral-500 mt-1">If not EPC/SEPA, copy details and fill manually.</div>
                </div>
              )}
            </div>
          )}
        </div>
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
