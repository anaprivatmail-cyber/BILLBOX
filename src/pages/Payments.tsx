import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Card from '../components/ui/Card'
import Button from '../components/ui/Button'
import Badge from '../components/ui/Badge'
import type { Bill } from '../features/bills/types'
import { listBills, setBillStatus, isOverdue } from '../features/bills/api'

// Lazy-load qrcode to avoid bundle bloat on initial load
let QRCodePromise: Promise<typeof import('qrcode')> | null = null
function getQRCode() {
  if (!QRCodePromise) QRCodePromise = import('qrcode')
  return QRCodePromise
}

function buildEpcPayload(b: Bill): string | null {
  // Minimal structured fallback when EPC data incomplete
  const amount = Number(b.amount).toFixed(2)
  const hasEpc = Boolean(b.iban && b.creditor_name)
  if (!hasEpc) return null
  const serviceTag = 'BCD'
  const version = '002'
  const characterSet = '1' // UTF-8
  const identification = 'SCT'
  const bic = '' // optional in newer specs
  const name = (b.creditor_name || '').slice(0, 70)
  const iban = (b.iban || '').replace(/\s+/g, '')
  const amountLine = `EUR${amount}`
  const purpose = (b.purpose || '').slice(0, 4) // optional, 4 chars code
  const remittance = (b.reference || '').slice(0, 140)
  return [serviceTag, version, characterSet, identification, bic, name, iban, amountLine, '', purpose, remittance].join('\n')
}

function fallbackPayload(b: Bill): string {
  return [
    'SEPA Payment',
    `Supplier: ${b.supplier}`,
    b.creditor_name ? `Creditor: ${b.creditor_name}` : '',
    b.iban ? `IBAN: ${b.iban}` : '',
    `Amount: ${b.amount} ${b.currency}`,
    b.reference ? `Reference: ${b.reference}` : '',
    b.purpose ? `Purpose: ${b.purpose}` : '',
    `Due: ${b.due_date}`,
  ].filter(Boolean).join('\n')
}

function copyAll(b: Bill) {
  const text = [
    b.iban ? `IBAN: ${b.iban}` : '',
    b.reference ? `Reference: ${b.reference}` : '',
    `Amount: ${b.amount} ${b.currency}`,
    b.purpose ? `Purpose: ${b.purpose}` : '',
    `Supplier: ${b.supplier}`,
  ].filter(Boolean).join('\n')
  navigator.clipboard.writeText(text)
}

export default function PaymentsPage() {
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [qrBill, setQrBill] = useState<Bill | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string>('')

  useEffect(() => {
    ;(async () => {
      const { data, error } = await listBills()
      if (error) setError(error.message)
      else setBills(data)
      setLoading(false)
    })()
  }, [])

  const toPay = useMemo(() => {
    return bills
      .filter((b) => b.status === 'unpaid' || isOverdue(b))
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())
  }, [bills])

  const totals = useMemo(() => {
    const sum = (arr: Bill[]) => arr.reduce((acc, b) => acc + (Number(b.amount) || 0), 0)
    const unpaid = bills.filter((b) => b.status === 'unpaid')
    const overdue = bills.filter((b) => isOverdue(b))
    return { unpaidTotal: sum(unpaid), overdueTotal: sum(overdue) }
  }, [bills])

  async function showQr(b: Bill) {
    const payload = buildEpcPayload(b) || fallbackPayload(b)
    const QR = await getQRCode()
    const dataUrl = await QR.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 300 })
    setQrBill(b)
    setQrDataUrl(dataUrl)
  }

  async function markPaid(id: string) {
    const { error } = await setBillStatus(id, 'paid')
    if (error) setError(error.message)
    else {
      const { data } = await listBills()
      setBills(data)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="sticky top-16 z-10 bg-neutral-950/80 backdrop-blur border-b border-neutral-800">
        <div className="px-3 sm:px-4 py-3 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Payments</h2>
          <div className="flex items-center gap-6 text-sm">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-neutral-400">Unpaid</span>
              <span className="text-lg font-semibold">{totals.unpaidTotal.toFixed(2)}</span>
              <span className="text-xs text-neutral-400">EUR</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-neutral-400">Overdue</span>
              <span className="text-lg font-semibold text-red-300">{totals.overdueTotal.toFixed(2)}</span>
              <span className="text-xs text-neutral-400">EUR</span>
            </div>
            <Button onClick={() => navigator.clipboard.writeText(toPay.map(fallbackPayload).join('\n\n'))}>Copy all</Button>
          </div>
        </div>
      </div>
      <div className="px-3 sm:px-4 py-4">
        {error && <p className="text-sm text-red-400">{error}</p>}
        {loading ? (
          <p className="text-sm">Loading…</p>
        ) : toPay.length === 0 ? (
          <Card className="p-6 text-center">
            <div className="mx-auto mb-2 h-10 w-10 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-400">💳</div>
            <p className="text-sm text-neutral-300">No unpaid or overdue bills.</p>
            <div className="mt-3">
              <Link to="/app/bills" className="btn btn-primary">Add bill</Link>
            </div>
          </Card>
        ) : (
          <ul className="grid gap-3">
            {toPay.map((b) => (
              <li key={b.id} className="card p-4">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-sm text-neutral-400">{b.creditor_name || 'Supplier'}</div>
                    <div className="truncate font-semibold">{b.supplier}</div>
                    <div className="mt-1 text-xs text-neutral-400">Due {b.due_date}</div>
                    <div className="mt-1">
                      {isOverdue(b) ? <Badge variant="danger">Overdue</Badge> : <Badge>Unpaid</Badge>}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold">{Number(b.amount).toFixed(2)}</div>
                    <div className="text-xs text-neutral-400">{b.currency}</div>
                  </div>
                </div>
                {(b.creditor_name || b.iban || b.reference || b.purpose) && (
                  <div className="mt-2 text-xs text-neutral-300">
                    <div className="flex flex-wrap gap-3">
                      {b.creditor_name && <span>Creditor: {b.creditor_name}</span>}
                      {b.iban && <span>IBAN: {b.iban}</span>}
                      {b.reference && <span>Ref: {b.reference}</span>}
                      {b.purpose && <span>Purpose: {b.purpose}</span>}
                    </div>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button className="px-2 py-1 text-xs" onClick={() => copyAll(b)}>Copy All</Button>
                  <Button className="px-2 py-1 text-xs" onClick={() => showQr(b)}>Show QR</Button>
                  <Button className="px-2 py-1 text-xs" variant="primary" onClick={() => markPaid(b.id)}>Mark Paid</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {qrBill && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-3">
          <div className="card w-full max-w-sm p-4">
            <h3 className="text-lg font-semibold">Payment QR</h3>
            <img src={qrDataUrl} alt="Payment QR" className="mt-2 w-full rounded" />
            <div className="mt-3 flex gap-2">
              <Button onClick={() => setQrBill(null)}>Close</Button>
              <a href={qrDataUrl} download={`payment-${qrBill?.id}.png`} className="btn btn-secondary">Download QR</a>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
