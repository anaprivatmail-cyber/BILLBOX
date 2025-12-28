import { useEffect, useMemo, useRef, useState } from 'react'
import type { Warranty, CreateWarrantyInput } from '../types'
import { Tabs } from '../../../components/ui/Tabs'
import QRScanner from '../../../components/QRScanner'
import { parseEPC } from '../../../lib/epc'
import { uploadAttachments as uploadWarrantyAttachments } from '../attachments'
import { BrowserQRCodeReader } from '@zxing/browser'

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
  const [inputMethod, setInputMethod] = useState<'manual' | 'upload' | 'qr'>('manual')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const [decodedText, setDecodedText] = useState<string | null>(null)
  const [uploadDecoding, setUploadDecoding] = useState(false)
  const [uploadDecodeError, setUploadDecodeError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

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

  const inputTabs = useMemo(() => ([
    { key: 'manual', label: 'Manual' },
    { key: 'upload', label: 'Photo-PDF' },
    { key: 'qr', label: 'Scan QR' },
  ]), [])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null
    setSelectedFile(file)
  }

  async function decodeUploadQR() {
    if (!selectedFile) return
    setUploadDecodeError(null)
    setDecodedText(null)
    if (!selectedFile.type.startsWith('image/')) {
      setUploadDecodeError('Only images supported for QR decode. PDFs are not yet supported.')
      return
    }
    const url = URL.createObjectURL(selectedFile)
    setUploadDecoding(true)
    try {
      const reader = new BrowserQRCodeReader()
      const img = new Image()
      img.src = url
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Failed to load image'))
      })
      const decodePromise = reader.decodeFromImageUrl(url)
      const timeoutPromise = new Promise((_resolve, reject) => {
        const id = setTimeout(() => {
          clearTimeout(id)
          reject(new Error('Timeout: QR not found in 6s'))
        }, 6000)
      })
      const result = await Promise.race([decodePromise, timeoutPromise]) as any
      const text = typeof result?.getText === 'function' ? result.getText() : String(result)
      if (!text) throw new Error('No QR text decoded')
      setDecodedText(text)
      const epc = parseEPC(text)
      if (epc) {
        if (epc.creditor_name) setSupplier(epc.creditor_name)
      }
    } catch (err: any) {
      const name = err?.name || 'Error'
      const msg = err instanceof Error ? err.message : 'QR decode failed'
      console.error('[QR] Upload decode error:', { name, message: msg })
      setUploadDecodeError('Could not detect a QR in the photo. Try a sharper, well-lit image.')
    } finally {
      setUploadDecoding(false)
      URL.revokeObjectURL(url)
    }
  }

  async function handleUploadAttachment() {
    if (!selectedFile) return
    setUploadMsg(null)
    if (!initial?.id) {
      setUploadMsg('Save the warranty first, then upload attachments.')
      return
    }
    const { error } = await uploadWarrantyAttachments(initial.id, [selectedFile])
    if (error) setUploadMsg(error.message)
    else setUploadMsg('Attachment uploaded.')
  }

  function onQrDecode(text: string) {
    setDecodedText(text)
    const epc = parseEPC(text)
    if (epc) {
      if (epc.creditor_name) setSupplier(epc.creditor_name)
      if (typeof epc.amount === 'number' && !expiresAt) {
        // No direct mapping for amount here; keep text available to user.
      }
    }
  }

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

  // Ensure the form container is scrolled to top when opened
  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [])

  return (
    <div ref={containerRef} className="p-4 max-h-[80vh] overflow-y-auto scroll-smooth touch-pan-y">
      <h3 className="text-lg font-semibold">{initial ? 'Edit Warranty' : 'Add Warranty'}</h3>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <form onSubmit={handleSubmit} className="mt-2 space-y-3">
        {/* Sticky input method bar */}
        <div className="mt-3 sticky top-[72px] z-20 -mx-4 px-4 py-3 bg-white shadow-sm ring-1 ring-neutral-200">
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
                <button type="button" className="btn btn-secondary" onClick={handleUploadAttachment} disabled={!selectedFile}>Store attachment</button>
                <button type="button" className="btn btn-secondary" onClick={decodeUploadQR} disabled={!selectedFile || uploadDecoding}>
                  {uploadDecoding ? 'Scanning…' : 'Scan QR from photo'}
                </button>
              </div>
              {uploadMsg && <div className="text-xs text-neutral-600">{uploadMsg}</div>}
              {uploadDecodeError && <div className="text-xs text-red-600">{uploadDecodeError}</div>}
              <div className="text-xs text-neutral-500">OCR for warranties coming later. Image QR detection is available.</div>
            </div>
          )}
          {inputMethod === 'qr' && (
            <div className="mt-3 space-y-2">
              <QRScanner onDecode={onQrDecode} />
              {decodedText && (
                <div className="mt-2">
                  <div className="text-xs text-neutral-500 mb-1">Decoded text</div>
                  <textarea className="input w-full h-24" value={decodedText} readOnly />
                </div>
              )}
            </div>
          )}
        </div>
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
