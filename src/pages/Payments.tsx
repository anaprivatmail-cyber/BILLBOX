import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
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
    <div style={{ padding: 12, maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Payments</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/app" style={{ textDecoration: 'none' }}>Bills</Link>
          <span style={{ color: '#999' }}>|</span>
          <Link to="/app/warranties" style={{ textDecoration: 'none' }}>Warranties</Link>
          <span style={{ color: '#999' }}>|</span>
          <Link to="/app/reports" style={{ textDecoration: 'none' }}>Reports</Link>
        </div>
      </div>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : toPay.length === 0 ? (
        <p>No unpaid or overdue bills.</p>
      ) : (
        <div style={{ marginTop: 12 }}>
          <button onClick={() => navigator.clipboard.writeText(toPay.map(fallbackPayload).join('\n\n'))}>Copy All Bills</button>
          <ul style={{ listStyle: 'none', padding: 0, marginTop: 8 }}>
            {toPay.map((b) => (
              <li key={b.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{b.supplier}</div>
                    <div style={{ fontSize: 12, color: '#555' }}>{b.amount} {b.currency} • due {b.due_date}</div>
                    <div style={{ fontSize: 12, color: isOverdue(b) ? 'red' : '#555' }}>{isOverdue(b) ? 'overdue' : 'unpaid'}</div>
                    <div style={{ fontSize: 12, color: '#333', marginTop: 4 }}>
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        {b.creditor_name && <span>Creditor: {b.creditor_name}</span>}
                        {b.iban && <span>IBAN: {b.iban}</span>}
                        {b.reference && <span>Ref: {b.reference}</span>}
                        {b.purpose && <span>Purpose: {b.purpose}</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => copyAll(b)}>Copy All</button>
                    <button onClick={() => showQr(b)}>Show QR</button>
                    <button onClick={() => markPaid(b.id)}>Mark Paid</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {qrBill && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', padding: 16, borderRadius: 8, width: '100%', maxWidth: 360 }}>
            <h3 style={{ marginTop: 0 }}>Payment QR</h3>
            <img src={qrDataUrl} alt="Payment QR" style={{ width: '100%' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={() => setQrBill(null)}>Close</button>
              <a href={qrDataUrl} download={`payment-${qrBill?.id}.png`}><button type="button">Download QR</button></a>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
