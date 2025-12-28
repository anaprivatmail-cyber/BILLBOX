import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Button, FlatList, SafeAreaView, StyleSheet, Text, TextInput, TouchableOpacity, View, ScrollView, Platform, Linking, Image, Switch } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { NavigationContainer, useFocusEffect, useNavigation, useRoute } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { CameraView, useCameraPermissions } from 'expo-camera'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system'
import * as Print from 'expo-print'
import * as Sharing from 'expo-sharing'
import { createClient, SupabaseClient, PostgrestError } from '@supabase/supabase-js'

// --- Minimal shared utilities (EPC/UPN parser + Supabase client) ---
type EPCResult = { iban?: string; creditor_name?: string; amount?: number; purpose?: string; reference?: string; currency?: string }
function parseEPC(text: string): EPCResult | null {
  try {
    const lines = text.split(/\r?\n/).map((l) => l.trim())
    if (lines.length < 7) return null
    if (lines[0] !== 'BCD') return null
    const serviceTag = lines[3]
    if (serviceTag !== 'SCT') return null
    const name = lines[5] || ''
    const iban = (lines[6] || '').replace(/\s+/g, '')
    const amountLine = lines[7] || ''
    let amount: number | undefined
    if (amountLine.startsWith('EUR')) {
      const num = amountLine.slice(3)
      const parsed = Number(num.replace(',', '.'))
      if (!Number.isNaN(parsed)) amount = parsed
    }
    const purpose = lines[8] || ''
    const reference = lines[9] || ''
    const result: EPCResult = {
      iban: iban || undefined,
      creditor_name: name || undefined,
      amount,
      purpose: purpose || undefined,
      reference: reference || undefined,
      currency: amountLine.startsWith('EUR') ? 'EUR' : undefined,
    }
    return result
  } catch {
    return null
  }
}
function parseUPN(text: string): EPCResult | null {
  try {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const joined = lines.join('\n')
    if (!/UPNQR|UPN/i.test(joined) && !/SI\d{2}[A-Z0-9]{15,}/.test(joined)) return null
    const ibanMatch = joined.match(/[A-Z]{2}\d{2}[A-Z0-9]{11,34}/)
    const iban = ibanMatch ? ibanMatch[0].replace(/\s+/g, '') : undefined
    let amount: number | undefined
    let currency: string | undefined
    for (const l of lines) {
      const eurMatch = l.match(/EUR\s*([0-9]+(?:[\.,][0-9]{1,2})?)/i)
      if (eurMatch) { const val = Number(eurMatch[1].replace(',', '.')); if (!Number.isNaN(val)) { amount = val; currency = 'EUR'; break } }
      const amtMatch = l.match(/([0-9]+(?:[\.,][0-9]{1,2})?)/)
      if (!amount && amtMatch) { const val = Number(amtMatch[1].replace(',', '.')); if (!Number.isNaN(val) && val > 0) amount = val }
    }
    let reference: string | undefined
    for (const l of lines) { const m = l.match(/(SI\d{2}[0-9]{4,}|sklic:?\s*([A-Z0-9\-\/]+))/i); if (m) { reference = (m[1] || m[2] || '').replace(/\s+/g, ''); if (reference) break } }
    let purpose: string | undefined
    for (const l of lines) { const m = l.match(/namen:?\s*(.+)|purpose:?\s*(.+)/i); if (m) { purpose = (m[1] || m[2] || '').trim(); if (purpose) break } }
    let creditor_name: string | undefined
    for (const l of lines) { const m = l.match(/prejemnik|recipient|name:?\s*(.+)/i); if (m) { const n = (m[1] || '').trim(); if (n) { creditor_name = n; break } } }
    const result: EPCResult = { iban, amount, purpose, reference, creditor_name, currency }
    if (result.iban || typeof result.amount === 'number') return result
    return null
  } catch { return null }
}
function parsePaymentQR(text: string): EPCResult | null { return parseEPC(text) || parseUPN(text) }

// Safely coerce potentially stringy booleans to real booleans
function coerceBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1'
  if (typeof val === 'number') return val === 1
  return Boolean(val)
}

function getSupabase(): SupabaseClient | null {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL
  const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return null
  return createClient(url, anon)
}

function getFunctionsBase(): string | null {
  const base = process.env.EXPO_PUBLIC_FUNCTIONS_BASE
  return base && typeof base === 'string' && base.trim() ? base.trim().replace(/\/$/, '') : null
}

// --- Types & APIs ---
type BillStatus = 'unpaid' | 'paid'
type Bill = { id: string; user_id: string; supplier: string; amount: number; currency: string; due_date: string; status: BillStatus; created_at: string; creditor_name?: string | null; iban?: string | null; reference?: string | null; purpose?: string | null }
type CreateBillInput = { supplier: string; amount: number; currency: string; due_date: string; status?: BillStatus; creditor_name?: string | null; iban?: string | null; reference?: string | null; purpose?: string | null }

// Warranties
type Warranty = { id: string; user_id: string; item_name: string; supplier?: string | null; purchase_date?: string | null; bill_id?: string | null; expires_at?: string | null; created_at: string }
type CreateWarrantyInput = { item_name: string; supplier?: string | null; purchase_date?: string | null; bill_id?: string | null; expires_at?: string | null }

async function getCurrentUserId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  const id = data?.user?.id
  if (!id) throw new Error('No authenticated user')
  return id
}
async function listBills(supabase: SupabaseClient): Promise<{ data: Bill[]; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const { data, error } = await supabase.from('bills').select('*').eq('user_id', userId).order('due_date', { ascending: true })
  return { data: (data as Bill[]) || [], error }
}
async function createBill(supabase: SupabaseClient, input: CreateBillInput): Promise<{ data: Bill | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const payload = { ...input, user_id: userId, status: input.status || 'unpaid' }
  const { data, error } = await supabase.from('bills').insert(payload).select().single()
  return { data: (data as Bill) || null, error }
}
async function deleteBill(supabase: SupabaseClient, id: string): Promise<{ error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const { error } = await supabase.from('bills').delete().eq('user_id', userId).eq('id', id)
  return { error }
}
async function setBillStatus(supabase: SupabaseClient, id: string, status: BillStatus): Promise<{ data: Bill | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const { data, error } = await supabase.from('bills').update({ status }).eq('user_id', userId).eq('id', id).select().single()
  return { data: (data as Bill) || null, error }
}

async function listWarranties(supabase: SupabaseClient): Promise<{ data: Warranty[]; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const { data, error } = await supabase.from('warranties').select('*').eq('user_id', userId).order('created_at', { ascending: false })
  return { data: (data as Warranty[]) || [], error }
}
async function createWarranty(supabase: SupabaseClient, input: CreateWarrantyInput): Promise<{ data: Warranty | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const payload = { ...input, user_id: userId }
  const { data, error } = await supabase.from('warranties').insert(payload).select().single()
  return { data: (data as Warranty) || null, error }
}
async function deleteWarranty(supabase: SupabaseClient, id: string): Promise<{ error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const { error } = await supabase.from('warranties').delete().eq('user_id', userId).eq('id', id)
  return { error }
}

// --- Local storage helpers (offline/read-only mode) ---
type LocalBill = Bill & { unsynced?: boolean }
const LS_KEY = 'billbox.local.bills'
async function loadLocalBills(): Promise<LocalBill[]> {
  try { const raw = await AsyncStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : [] } catch { return [] }
}
async function saveLocalBills(items: LocalBill[]): Promise<void> { try { await AsyncStorage.setItem(LS_KEY, JSON.stringify(items)) } catch {} }
async function addLocalBill(input: Omit<LocalBill, 'id' | 'created_at' | 'user_id' | 'status'> & { status?: BillStatus }): Promise<LocalBill> {
  const items = await loadLocalBills()
  const now = new Date().toISOString()
  const bill: LocalBill = { id: 'local_'+Math.random().toString(36).slice(2), user_id: 'local', created_at: now, status: input.status || 'unpaid', unsynced: true, ...input }
  items.unshift(bill)
  await saveLocalBills(items)
  return bill
}
async function deleteLocalBill(id: string): Promise<void> {
  const items = await loadLocalBills()
  await saveLocalBills(items.filter(b => b.id !== id))
}
async function setLocalBillStatus(id: string, status: BillStatus): Promise<void> {
  const items = await loadLocalBills()
  await saveLocalBills(items.map(b => b.id===id ? { ...b, status } : b))
}

// Local warranties
type LocalWarranty = Warranty & { unsynced?: boolean }
const LS_WARRANTIES_KEY = 'billbox.local.warranties'
async function loadLocalWarranties(): Promise<LocalWarranty[]> { try { const raw = await AsyncStorage.getItem(LS_WARRANTIES_KEY); return raw ? JSON.parse(raw) : [] } catch { return [] } }
async function saveLocalWarranties(items: LocalWarranty[]): Promise<void> { try { await AsyncStorage.setItem(LS_WARRANTIES_KEY, JSON.stringify(items)) } catch {} }
async function addLocalWarranty(input: Omit<LocalWarranty, 'id'|'created_at'|'user_id'|'unsynced'>): Promise<LocalWarranty> {
  const items = await loadLocalWarranties()
  const now = new Date().toISOString()
  const w: LocalWarranty = { id: 'local_'+Math.random().toString(36).slice(2), created_at: now, user_id: 'local', unsynced: true, ...input }
  items.unshift(w)
  await saveLocalWarranties(items)
  return w
}
async function deleteLocalWarranty(id: string): Promise<void> { const items = await loadLocalWarranties(); await saveLocalWarranties(items.filter(w=>w.id!==id)) }

// --- Attachments helpers ---
type AttachmentItem = { name: string; path: string; created_at?: string; uri?: string }
const LS_ATTACH_PREFIX = 'billbox.local.attachments.'
function getLocalAttachKey(kind: 'bills'|'warranties', id: string): string { return `${LS_ATTACH_PREFIX}${kind}.${id}` }
async function listLocalAttachments(kind: 'bills'|'warranties', id: string): Promise<AttachmentItem[]> {
  try { const raw = await AsyncStorage.getItem(getLocalAttachKey(kind, id)); return raw ? JSON.parse(raw) : [] } catch { return [] }
}
async function addLocalAttachment(kind: 'bills'|'warranties', id: string, item: AttachmentItem): Promise<void> {
  const items = await listLocalAttachments(kind, id)
  items.unshift(item)
  await AsyncStorage.setItem(getLocalAttachKey(kind, id), JSON.stringify(items))
}
async function removeLocalAttachment(kind: 'bills'|'warranties', id: string, path: string): Promise<void> {
  const items = await listLocalAttachments(kind, id)
  const next = items.filter((i)=>i.path!==path)
  await AsyncStorage.setItem(getLocalAttachKey(kind, id), JSON.stringify(next))
}

async function listRemoteAttachments(supabase: SupabaseClient, kind: 'bills'|'warranties', recId: string): Promise<AttachmentItem[]> {
  const userId = await getCurrentUserId(supabase)
  const dir = `${userId}/${kind}/${recId}`
  const { data, error } = await supabase.storage.from('attachments').list(dir, { limit: 100, sortBy: { column: 'name', order: 'desc' } })
  if (error) return []
  const items = Array.isArray(data) ? (data as any[]).map((f)=>({ name: f.name, path: `${dir}/${f.name}`, created_at: f.created_at })) : []
  return items
}

async function getSignedUrl(supabase: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, 300)
  return error ? null : (data?.signedUrl || null)
}

async function uploadAttachmentFromUri(kind: 'bills'|'warranties', recId: string, uri: string, filename: string, contentType?: string): Promise<{ path: string | null; error: string | null }>{
  try {
    const s = getSupabase()
    if (!s) {
      const path = `${recId}/${filename}`
      await addLocalAttachment(kind, recId, { name: filename, path, created_at: new Date().toISOString(), uri })
      return { path, error: null }
    }
    const userId = await getCurrentUserId(s)
    const dir = `${userId}/${kind}/${recId}`
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase()
    const path = `${dir}/${Date.now()}-${safeName}`
    const fileLike: any = { uri, name: safeName, type: contentType || 'application/octet-stream' }
    const { error } = await s.storage.from('attachments').upload(path, fileLike, { upsert: true, contentType: fileLike.type })
    if (error) return { path: null, error: error.message }
    return { path, error: null }
  } catch (e: any) {
    return { path: null, error: e?.message || 'upload_failed' }
  }
}

async function deleteAttachment(kind: 'bills'|'warranties', recId: string, path: string): Promise<{ error: string | null }>{
  const s = getSupabase()
  if (!s) { await removeLocalAttachment(kind, recId, path); return { error: null } }
  const { error } = await s.storage.from('attachments').remove([path])
  return { error: error ? error.message : null }
}

async function deleteAllAttachmentsForRecord(kind: 'bills'|'warranties', recId: string): Promise<void> {
  const s = getSupabase()
  if (!s) {
    const items = await listLocalAttachments(kind, recId)
    for (const it of items) await removeLocalAttachment(kind, recId, it.path)
    return
  }
  const items = await listRemoteAttachments(s, kind, recId)
  if (!items.length) return
  await s.storage.from('attachments').remove(items.map(i=> i.path))
}

// --- Screens ---
function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const supabase = useMemo(() => getSupabase(), [])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <View style={styles.container}>
      <Text style={styles.title}>BillBox</Text>
      {!supabase && (
        <View style={{ padding: 8, backgroundColor: '#FFF8E1', borderColor: '#F6D365', borderWidth: 1, borderRadius: 6, marginBottom: 8 }}>
          <Text style={{ color: '#6B4F00' }}>Cloud sync disabled. You can still scan, OCR, and attach files locally.</Text>
        </View>
      )}
      <TextInput style={styles.input} placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" />
      <TextInput style={styles.input} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
      <TouchableOpacity disabled={coerceBool(busy)} style={styles.primaryBtn} onPress={async () => {
        if (!supabase) {
          Alert.alert('Unavailable', 'Login requires Supabase config. Continuing in read-only mode.')
          onLoggedIn()
          return
        }
        try {
          setBusy(true)
          const { error } = await supabase.auth.signInWithPassword({ email, password })
          setBusy(false)
          if (error) Alert.alert('Login failed', error.message)
          else onLoggedIn()
        } catch (err) {
          setBusy(false)
          Alert.alert('Login error', err instanceof Error ? err.message : String(err))
        }
      }}>
        <Text style={styles.primaryBtnText}>{busy ? 'Signing in…' : 'Sign In'}</Text>
      </TouchableOpacity>
      {!supabase && (
        <TouchableOpacity style={[styles.primaryBtn, { marginTop: 12, backgroundColor: '#4A5568' }]} onPress={onLoggedIn}>
          <Text style={styles.primaryBtnText}>Continue without login</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

function ScanBillScreen() {
  const navigation = useNavigation<any>()
  const [permission, requestPermission] = useCameraPermissions()
  const [torch, setTorch] = useState<'on' | 'off'>('on')
  const [lastQR, setLastQR] = useState('')
  const [manual, setManual] = useState('')
  const [rawText, setRawText] = useState<string>('')
  const [format, setFormat] = useState<'UPN' | 'EPC/SEPA SCT' | 'Unknown' | ''>('')
  const [parsed, setParsed] = useState<EPCResult | null>(null)
  const [useDataActive, setUseDataActive] = useState(false)
  const [supplier, setSupplier] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [currency, setCurrency] = useState('EUR')
  const [dueDate, setDueDate] = useState('')
  const [creditorName, setCreditorName] = useState('')
  const [iban, setIban] = useState('')
  const [reference, setReference] = useState('')
  const [purpose, setPurpose] = useState('')
  const [saving, setSaving] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrError, setOcrError] = useState<string | null>(null)
  const [pendingAttachment, setPendingAttachment] = useState<{ uri: string; name: string; type?: string } | null>(null)
  useEffect(() => { (async ()=>{ if (!permission?.granted) await requestPermission() })() }, [permission])
  async function pickImage() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
    if (res.canceled) return
    const asset = res.assets?.[0]
    if (!asset?.uri) return
    setPendingAttachment({ uri: asset.uri, name: (asset.fileName || 'photo.jpg'), type: asset.type || 'image/jpeg' })
    // Try QR decode first (web via ZXing), with up to 3 retries; fallback to OCR
    const decoded = await decodeImageQR(asset.uri, 3)
    if (decoded) {
      handleDecodedText(decoded)
    } else {
      await extractWithOCR(asset.uri)
    }
  }

  async function decodeImageQR(uri: string, retries: number): Promise<string | null> {
    if (Platform.OS !== 'web') return null
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser') as any
      const reader = new BrowserQRCodeReader()
      let lastErr: any
      for (let i=0; i<retries; i++) {
        try {
          const res = await reader.decodeFromImageUrl(uri)
          if (res?.text) return res.text as string
        } catch (e) { lastErr = e }
      }
      if (lastErr) console.warn('ZXing decode failed:', lastErr)
      return null
    } catch (e) {
      console.warn('ZXing not available or failed:', e)
      return null
    }
  }

  function handleDecodedText(text: string) {
    const t = (text ?? '').toString()
    setRawText(t || '')
    if (!t) { setFormat('Unknown'); setParsed(null); Alert.alert('QR detected but no text decoded'); return }
    const epc = parseEPC(t)
    const upn = !epc ? parseUPN(t) : null
    const p = epc || upn
    if (!p) { setFormat('Unknown'); setParsed(null); Alert.alert('Unsupported QR format'); return }
    setFormat(epc ? 'EPC/SEPA SCT' : 'UPN')
    setParsed(p)
    setSupplier(p.creditor_name || supplier)
    setCreditorName(p.creditor_name || '')
    setIban(p.iban || '')
    setReference(p.reference || '')
    setPurpose(p.purpose || '')
    if (typeof p.amount === 'number') setAmountStr(String(p.amount))
    if (p.currency) setCurrency(p.currency)
    setUseDataActive(true)
  }

  async function extractWithOCR(uri: string) {
    try {
      setOcrError(null)
      setOcrBusy(true)
      const base = getFunctionsBase()
      if (!base) {
        throw new Error('OCR unavailable: missing EXPO_PUBLIC_FUNCTIONS_BASE')
      }
      // fetch the file and send as binary to Netlify function
      const fileResp = await fetch(uri)
      const blob = await fileResp.blob()
      const resp = await fetch(`${base}/.netlify/functions/ocr`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob })
      const data = await resp.json().catch(() => null)
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error || `OCR failed (${resp.status})`)
      }
      const f = data.fields || {}
      const parts: string[] = []
      if (f.creditor_name || f.supplier) parts.push(`Creditor: ${f.creditor_name || f.supplier}`)
      if (typeof f.amount === 'number' && f.currency) parts.push(`Amount: ${f.currency} ${f.amount}`)
      if (f.due_date) parts.push(`Due: ${f.due_date}`)
      if (f.iban) parts.push(`IBAN: ${f.iban}`)
      if (f.reference) parts.push(`Ref: ${f.reference}`)
      if (f.purpose) parts.push(`Purpose: ${f.purpose}`)
      // Prefill fields
      setSupplier(f.creditor_name || f.supplier || supplier)
      setCreditorName(f.creditor_name || '')
      setIban(f.iban || '')
      setReference(f.reference || '')
      setPurpose(f.purpose || '')
      if (typeof f.amount === 'number') setAmountStr(String(f.amount))
      if (f.currency) setCurrency(f.currency)
      if (f.due_date) setDueDate(f.due_date)
      setUseDataActive(true)
      Alert.alert('OCR extracted', (parts.join('\n') || 'No fields found') + '\n\nThe selected image will be attached on save.')
    } catch (e: any) {
      setOcrError(e?.message || 'OCR failed')
    } finally {
      setOcrBusy(false)
    }
  }
  return (
    <View style={{ flex: 1 }}>
      <CameraView style={{ flex: 1 }} facing={'back'} enableTorch={coerceBool(torch==='on')} onBarcodeScanned={(evt)=>{
        const text = (evt?.data ?? '').toString()
        if (!text || text===lastQR) return
        setLastQR(text)
        setRawText(text)
        const epc = parseEPC(text)
        const upn = !epc ? parseUPN(text) : null
        const p = epc || upn
        if (!p) { setFormat('Unknown'); setParsed(null); Alert.alert('Scan', 'QR read, but format unknown.'); return }
        setFormat(epc ? 'EPC/SEPA SCT' : 'UPN')
        setParsed(p)
        setSupplier(p.creditor_name || supplier)
        setCreditorName(p.creditor_name || '')
        setIban(p.iban || '')
        setReference(p.reference || '')
        setPurpose(p.purpose || '')
        if (typeof p.amount === 'number') setAmountStr(String(p.amount))
        if (p.currency) setCurrency(p.currency)
        setUseDataActive(true)
      }} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} />
      <View style={styles.scanControls}>
        <TouchableOpacity style={styles.secondaryBtn} onPress={()=> setTorch(t => t==='on'? 'off':'on')}><Text style={styles.secondaryBtnText}>{torch==='on' ? 'Torch Off' : 'Torch On'}</Text></TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={pickImage}><Text style={styles.secondaryBtnText}>{ocrBusy ? 'Extracting…' : 'OCR from Photo'}</Text></TouchableOpacity>
      </View>
      {ocrError && (
        <View style={{ padding: 8, backgroundColor: '#FEE2E2' }}><Text style={{ color: '#991B1B', textAlign: 'center' }}>{ocrError}</Text></View>
      )}
      <View style={{ padding: 12, backgroundColor: '#fff' }}>
        <Text style={{ fontWeight: '600', marginBottom: 4 }}>Raw QR text</Text>
        <View style={{ maxHeight: 140 }}>
          <ScrollView>
            <Text style={{ fontSize: 12, color: '#555', marginBottom: 8 }}>{rawText ? rawText : '—'}</Text>
          </ScrollView>
        </View>
        <Text style={{ marginBottom: 8 }}>Manual paste:</Text>
        <TextInput style={styles.input} value={manual} onChangeText={setManual} placeholder="Paste QR text here" multiline />
        <Button title="Parse" onPress={()=>{ if (!manual) { Alert.alert('QR detected but no text decoded'); return } handleDecodedText(manual) }} />
      </View>
      <View style={{ padding: 12, backgroundColor: '#fff' }}>
        <Text style={{ marginBottom: 6 }}>Detected: {format || '—'}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity style={styles.primaryBtn} onPress={()=>{ if (parsed) { setUseDataActive(true) } }}><Text style={styles.primaryBtnText}>Use data</Text></TouchableOpacity>
        </View>
      </View>
      {useDataActive && (
        <View style={{ padding: 12, backgroundColor: '#fff' }}>
          <Text style={{ fontWeight: '600', marginBottom: 8 }}>Prefill Bill</Text>
          <TextInput style={styles.input} placeholder="Supplier" value={supplier} onChangeText={setSupplier} />
          <TextInput style={styles.input} placeholder="Amount" keyboardType="decimal-pad" value={amountStr} onChangeText={setAmountStr} />
          <TextInput style={styles.input} placeholder="Currency" value={currency} onChangeText={setCurrency} />
          <TextInput style={styles.input} placeholder="Due date (YYYY-MM-DD)" value={dueDate} onChangeText={setDueDate} />
          <TextInput style={styles.input} placeholder="Creditor name" value={creditorName} onChangeText={setCreditorName} />
          <TextInput style={styles.input} placeholder="IBAN" value={iban} onChangeText={setIban} />
          <TextInput style={styles.input} placeholder="Reference" value={reference} onChangeText={setReference} />
          <TextInput style={styles.input} placeholder="Purpose" value={purpose} onChangeText={setPurpose} />
          <TouchableOpacity style={[styles.primaryBtn, { marginTop: 8 }]} disabled={saving} onPress={async ()=>{
            if (!supplier) { Alert.alert('Missing', 'Supplier is required'); return }
            if (!dueDate) { Alert.alert('Missing', 'Please enter due date (YYYY-MM-DD)'); return }
            const amt = Number(String(amountStr).replace(',', '.'))
            if (Number.isNaN(amt)) { Alert.alert('Invalid', 'Amount is not a number'); return }
            // If data came from OCR but no attachment available, enforce attachment
            if (ocrBusy === false && pendingAttachment && !pendingAttachment.uri) {
              Alert.alert('Attachment required', 'OCR prefills require attaching the source image/PDF.')
              return
            }
            const s = getSupabase()
            try {
              setSaving(true)
              let savedId: string | null = null
              if (s) {
                const { data, error } = await createBill(s, {
                  supplier,
                  amount: amt,
                  currency: currency || 'EUR',
                  due_date: dueDate,
                  creditor_name: creditorName || null,
                  iban: iban || null,
                  reference: reference || null,
                  purpose: purpose || null,
                })
                if (error) { Alert.alert('Save failed', error.message); setSaving(false); return }
                savedId = data?.id || null
              } else {
                const local = await addLocalBill({ supplier, amount: amt, currency: currency || 'EUR', due_date: dueDate, creditor_name: creditorName || null, iban: iban || null, reference: reference || null, purpose: purpose || null })
                savedId = local.id
              }
              // Auto-attach pendingAttachment if exists
              if (savedId && pendingAttachment?.uri) {
                const up = await uploadAttachmentFromUri('bills', savedId, pendingAttachment.uri, pendingAttachment.name || 'attachment', pendingAttachment.type)
                if (up.error) {
                  Alert.alert('Attachment upload failed', up.error)
                }
              }
              setSaving(false)
              Alert.alert('Saved', s ? 'Bill created successfully' : 'Saved locally (Not synced)')
              if (!pendingAttachment) {
                Alert.alert('Tip', 'You can attach a photo or PDF of the bill (recommended).')
              }
              try { (navigation as any)?.navigate?.('My Bills', { highlightBillId: savedId }) } catch {}
            } catch (e: any) {
              setSaving(false)
              Alert.alert('Save error', e?.message || 'Unknown error')
            }
          }}>
            <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : 'Save bill'}</Text>
          </TouchableOpacity>
          {!!parsed && !pendingAttachment && (
            <View style={{ paddingTop: 8 }}>
              <Text style={{ color: '#B45309' }}>QR contains limited data. You can attach the full bill/receipt.</Text>
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={async ()=>{
              const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
              if (res.canceled) return
              const asset = res.assets?.[0]
              if (!asset?.uri) return
              setPendingAttachment({ uri: asset.uri, name: (asset.fileName || 'photo.jpg'), type: asset.type || 'image/jpeg' })
              Alert.alert('Attachment selected', 'The image will be uploaded on save.')
            }}>
              <Text style={styles.secondaryBtnText}>Attach Image</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={async ()=>{
              const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
              if (res.canceled) return
              const file = res.assets?.[0]
              if (!file?.uri) return
              setPendingAttachment({ uri: file.uri, name: file.name || 'document.pdf', type: 'application/pdf' })
              Alert.alert('Attachment selected', 'The PDF will be uploaded on save.')
            }}>
              <Text style={styles.secondaryBtnText}>Attach PDF</Text>
            </TouchableOpacity>
          </View>
          {!!pendingAttachment && (
            <View style={{ marginTop: 8 }}>
              <Text style={{ marginBottom: 4 }}>Attachment preview:</Text>
              {pendingAttachment.type?.startsWith('image/') ? (
                <Image source={{ uri: pendingAttachment.uri }} style={{ width: 160, height: 120, borderRadius: 6 }} />
              ) : (
                <Text>{pendingAttachment.name}</Text>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  )
}

function BillsListScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const route = useRoute<any>()
  const [items, setItems] = useState<Bill[]>([])
  const [supplier, setSupplier] = useState('')
  const [amount, setAmount] = useState('')
  const [dueDate, setDueDate] = useState(new Date().toISOString().slice(0,10))
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showUnpaidOnly, setShowUnpaidOnly] = useState(true)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  useEffect(() => { (async ()=>{ 
    if (!supabase) { const locals = await loadLocalBills(); setItems(locals as any); return }
    const { data } = await listBills(supabase); setItems(data) 
  })() }, [supabase])
  useEffect(() => {
    const id = (route as any)?.params?.highlightBillId
    if (typeof id === 'string') setHighlightId(id)
  }, [route])
  async function add() {
    const amt = Number(amount)
    if (!supplier || Number.isNaN(amt)) { Alert.alert('Validation', 'Enter supplier and amount'); return }
    if (supabase) {
      const s = supabase!
      const { data, error } = await createBill(s, { supplier, amount: amt, currency: 'EUR', due_date: dueDate })
      if (error) { Alert.alert('Error', String(error.message)); return }
      if (data) setItems((prev) => [data, ...prev])
    } else {
      const local = await addLocalBill({ supplier, amount: amt, currency: 'EUR', due_date: dueDate })
      setItems((prev:any) => [local, ...prev])
    }
    setSupplier(''); setAmount('')
  }
  async function del(id: string) {
    Alert.alert('Are you sure? This will also delete attached files.', 'Confirm deletion of this bill and all attachments.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { 
        await deleteAllAttachmentsForRecord('bills', id)
        if (supabase) { const s = supabase!; const { error } = await deleteBill(s, id); if (error) Alert.alert('Error', String(error.message)) }
        else { await deleteLocalBill(id) }
        setItems((prev)=>prev.filter(b=>b.id!==id)) 
      } }
    ])
  }
  const navigation = useNavigation<any>()
  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>My Bills</Text>
      {!supabase && (
        <View style={{ padding: 8, backgroundColor: '#FFF8E1', borderColor: '#F6D365', borderWidth: 1, borderRadius: 6, marginBottom: 8 }}>
          <Text style={{ color: '#6B4F00' }}>Offline / Read-only mode. Saved bills are local and marked Not synced.</Text>
        </View>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <TextInput style={[styles.input, { flex: 1 }]} placeholder="Search supplier" value={query} onChangeText={setQuery} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text>Unpaid only</Text>
          <Switch value={showUnpaidOnly} onValueChange={setShowUnpaidOnly} />
        </View>
        <TextInput style={[styles.input,{ width: 120 }]} placeholder="Start YYYY-MM-DD" value={start} onChangeText={setStart} />
        <TextInput style={[styles.input,{ width: 120 }]} placeholder="End YYYY-MM-DD" value={end} onChangeText={setEnd} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={[styles.input, { flex: 1 }]} placeholder="Supplier" value={supplier} onChangeText={setSupplier} />
        <TextInput style={[styles.input, { width: 100 }]} placeholder="Amount" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
        <TextInput style={[styles.input, { width: 140 }]} placeholder="Due YYYY-MM-DD" value={dueDate} onChangeText={setDueDate} />
        <Button title="Add" onPress={add} />
      </View>
      <FlatList data={items.filter(b=>{
        if (showUnpaidOnly && b.status!=='unpaid') return false
        if (query && !b.supplier.toLowerCase().includes(query.toLowerCase())) return false
        if (start && b.due_date < start) return false
        if (end && b.due_date > end) return false
        return true
      })} keyExtractor={(b)=>b.id} renderItem={({ item }) => (
        <View style={[styles.card, highlightId===item.id ? { borderColor: '#2fb344', borderWidth: 2 } : null]}>
          <Text style={styles.cardTitle}>{item.supplier}{(item as any).unsynced ? ' • Not synced' : ''}</Text>
          <Text>{item.currency} {item.amount} due {item.due_date} {item.status==='paid' ? ' • Paid' : ''}</Text>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 8, alignItems: 'center' }}>
            <Button title={item.status==='paid' ? 'Mark Unpaid' : 'Mark Paid'} onPress={async ()=>{ 
              if (supabase) { const s = supabase!; const { data } = await setBillStatus(s, item.id, item.status==='paid' ? 'unpaid' : 'paid'); if (data) setItems(prev=>prev.map(b=>b.id===item.id?data:b)) } 
              else { await setLocalBillStatus(item.id, item.status==='paid' ? 'unpaid' : 'paid'); setItems(prev=>prev.map((b:any)=>b.id===item.id? { ...b, status: b.status==='paid'?'unpaid':'paid' }:b)) }
            }} />
            <Button title="Details" onPress={()=> navigation.navigate('Bill Details', { bill: item })} />
            <TouchableOpacity onPress={()=>del(item.id)}><Text style={{ fontSize: 18 }}>🗑️</Text></TouchableOpacity>
          </View>
        </View>
      )} />
    </View>
  )
}

function BillDetailsScreen() {
  const route = useRoute<any>()
  const navigation = useNavigation<any>()
  const supabase = useMemo(() => getSupabase(), [])
  const bill = (route.params?.bill || null) as Bill | null
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  useEffect(() => { (async ()=>{
    if (!bill) return
    if (supabase) setAttachments(await listRemoteAttachments(supabase!, 'bills', bill.id))
    else setAttachments(await listLocalAttachments('bills', bill.id))
  })() }, [bill, supabase])

  async function refresh() {
    if (!bill) return
    if (supabase) setAttachments(await listRemoteAttachments(supabase!, 'bills', bill.id))
    else setAttachments(await listLocalAttachments('bills', bill.id))
  }

  async function addImage() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
    if (res.canceled) return
    const asset = res.assets?.[0]
    if (!asset?.uri) return
    const name = asset.fileName || 'photo.jpg'
    const type = asset.type || 'image/jpeg'
    const up = await uploadAttachmentFromUri('bills', bill!.id, asset.uri, name, type)
    if (up.error) Alert.alert('Upload failed', up.error)
    else Alert.alert('Attachment uploaded', 'Image attached to bill')
    await refresh()
  }

  async function addPdf() {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
    if (res.canceled) return
    const file = res.assets?.[0]
    if (!file?.uri) return
    const name = file.name || 'document.pdf'
    const up = await uploadAttachmentFromUri('bills', bill!.id, file.uri, name, 'application/pdf')
    if (up.error) Alert.alert('Upload failed', up.error)
    else Alert.alert('Attachment uploaded', 'PDF attached to bill')
    await refresh()
  }

  async function openAttachment(path: string, uri?: string) {
    if (supabase) {
      const url = await getSignedUrl(supabase!, path)
      if (url) Linking.openURL(url)
      else Alert.alert('Open failed', 'Could not get URL')
    } else {
      if (uri) Linking.openURL(uri)
      else Alert.alert('Offline', 'Attachment stored locally. Preview is unavailable.')
    }
  }

  async function remove(path: string) {
    Alert.alert('Delete attachment?', 'This file will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { const { error } = await deleteAttachment('bills', bill!.id, path); if (error) Alert.alert('Delete failed', error); else await refresh() } }
    ])
  }

  if (!bill) return (
    <View style={styles.centered}><Text>No bill selected.</Text></View>
  )

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Bill Details</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{bill.supplier}</Text>
        <Text>{bill.currency} {bill.amount} due {bill.due_date}</Text>
        {!!bill.reference && <Text>Ref: {bill.reference}</Text>}
        {!!bill.iban && <Text>IBAN: {bill.iban}</Text>}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <Button title="Create Warranty from this Bill" onPress={async ()=>{
          try {
            const s = getSupabase()
            let createdId: string | null = null
            if (s) {
              const { data, error } = await createWarranty(s, { item_name: bill.supplier, supplier: bill.supplier, purchase_date: bill.due_date, bill_id: bill.id })
              if (error) { Alert.alert('Warranty error', error.message); return }
              createdId = data?.id || null
            } else {
              const local = await addLocalWarranty({ item_name: bill.supplier, supplier: bill.supplier, purchase_date: bill.due_date, bill_id: bill.id })
              createdId = local.id
            }
            if (createdId) {
              Alert.alert('Warranty created', 'Linked to this bill.')
              navigation.navigate('Warranty Details', { warrantyId: createdId })
            }
          } catch (e: any) {
            Alert.alert('Create warranty failed', e?.message || 'Unknown error')
          }
        }} />
      </View>
      <Text style={styles.sectionTitle}>Attachments</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <Button title="Add Image" onPress={addImage} />
        <Button title="Add PDF" onPress={addPdf} />
      </View>
      <FlatList data={attachments} keyExtractor={(a)=>a.path} renderItem={({ item })=> (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{item.name}</Text>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
            <Button title="Open" onPress={()=>openAttachment(item.path, item.uri)} />
            <Button title="Delete" color="#c53030" onPress={()=>remove(item.path)} />
          </View>
        </View>
      )} />
    </View>
  )
}

function HomeScreen({ navigation }: { navigation: any }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Dashboard</Text>
      {!getSupabase() && (
        <View style={{ padding: 8, backgroundColor: '#FFF8E1', borderColor: '#F6D365', borderWidth: 1, borderRadius: 6, marginBottom: 8 }}>
          <Text style={{ color: '#6B4F00' }}>Cloud sync disabled. You can still scan, OCR, and attach files locally.</Text>
        </View>
      )}
      <DashboardPanel />
    </View>
  )
}

function DashboardPanel() {
  const supabase = useMemo(() => getSupabase(), [])
  const [bills, setBills] = useState<Bill[]>([])
  const [warranties, setWarranties] = useState<Warranty[]>([])
  useEffect(() => { (async ()=>{
    if (supabase) { const { data } = await listBills(supabase); setBills(data) }
    else { const locals = await loadLocalBills(); setBills(locals as any) }
    if (supabase) { const { data } = await listWarranties(supabase); setWarranties(data) } else { const localsW = await loadLocalWarranties(); setWarranties(localsW as any) }
  })() }, [supabase])
  const today = new Date().toISOString().slice(0,10)
  const unpaid = bills.filter(b=>b.status==='unpaid')
  const totalUnpaid = unpaid.reduce((sum,b)=> sum + (b.currency==='EUR'? b.amount : 0), 0)
  const overdue = unpaid.filter(b=> b.due_date < today)
  const totalOverdue = overdue.reduce((sum,b)=> sum + (b.currency==='EUR'? b.amount : 0), 0)
  const nextDue = unpaid.sort((a,b)=> a.due_date.localeCompare(b.due_date))[0] || null
  const upcomingExp = warranties.filter(w=> w.expires_at && w.expires_at >= today && w.expires_at <= new Date(Date.now()+30*24*3600*1000).toISOString().slice(0,10)).length
  const expiredCount = warranties.filter(w=> w.expires_at && w.expires_at < today).length
  return (
    <View>
      <View style={styles.card}><Text style={styles.cardTitle}>Total unpaid</Text><Text>EUR {totalUnpaid.toFixed(2)}</Text></View>
      <View style={styles.card}><Text style={styles.cardTitle}>Total overdue</Text><Text>EUR {totalOverdue.toFixed(2)}</Text></View>
      <View style={styles.card}><Text style={styles.cardTitle}>Next due bill</Text><Text>{nextDue ? `${nextDue.supplier} • ${nextDue.due_date} • EUR ${nextDue.amount}` : '—'}</Text></View>
      <View style={styles.card}><Text style={styles.cardTitle}>Warranties</Text><Text>{`Upcoming expiry (30d): ${upcomingExp} • Expired: ${expiredCount}`}</Text></View>
    </View>
  )
}

function WarrantiesScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const navigation = useNavigation<any>()
  const [items, setItems] = useState<Warranty[]>([])
  const [itemName, setItemName] = useState('')
  const [supplier, setSupplier] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [durationMonths, setDurationMonths] = useState('')
  const [pendingAttachment, setPendingAttachment] = useState<{ uri: string; name: string; type?: string } | null>(null)
  useEffect(() => { (async ()=>{
    if (supabase) { const { data } = await listWarranties(supabase); setItems(data) }
    else { const locals = await loadLocalWarranties(); setItems(locals as any) }
  })() }, [supabase])

  async function addManual() {
    if (!itemName) { Alert.alert('Validation', 'Enter item name'); return }
    if (!pendingAttachment) { Alert.alert('Attachment required', 'Warranties must include an image or PDF attachment.'); return }
    // Calculate expiry if duration and purchase date provided
    let computedExpires = expiresAt
    if (!computedExpires && durationMonths && purchaseDate) {
      try {
        const d = new Date(purchaseDate)
        const months = parseInt(durationMonths, 10)
        if (!Number.isNaN(months) && months > 0) {
          const y = d.getFullYear()
          const m = d.getMonth() + months
          const nd = new Date(y, m, d.getDate())
          computedExpires = nd.toISOString().slice(0,10)
        }
      } catch {}
    }
    if (supabase) {
      const { data, error } = await createWarranty(supabase!, { item_name: itemName, supplier: supplier || null, purchase_date: purchaseDate || null, expires_at: computedExpires || null })
      if (error) { Alert.alert('Error', error.message); return }
      if (data) {
        const up = await uploadAttachmentFromUri('warranties', data.id, pendingAttachment.uri, pendingAttachment.name, pendingAttachment.type)
        if (up.error) Alert.alert('Attachment upload failed', up.error)
        setItems(prev=>[data, ...prev])
      }
    } else {
      const local = await addLocalWarranty({ item_name: itemName, supplier: supplier || null, purchase_date: purchaseDate || null, expires_at: computedExpires || null })
      await addLocalAttachment('warranties', local.id, { name: pendingAttachment.name, path: `${local.id}/${pendingAttachment.name}`, created_at: new Date().toISOString() })
      setItems((prev:any)=>[local, ...prev])
    }
    setItemName(''); setSupplier(''); setPurchaseDate(''); setExpiresAt(''); setDurationMonths('')
    setPendingAttachment(null)
    Alert.alert('Saved', supabase ? 'Warranty saved' : 'Saved locally (Not synced)')
  }

  async function del(id: string) {
    Alert.alert('Are you sure? This will also delete attached files.', 'Confirm deletion of this warranty and attachments.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deleteAllAttachmentsForRecord('warranties', id); if (supabase) { const { error } = await deleteWarranty(supabase!, id); if (error) Alert.alert('Error', error.message) } else { await deleteLocalWarranty(id) } setItems(prev=>prev.filter(w=>w.id!==id)) } }
    ])
  }

  async function ocrPhoto() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
    if (res.canceled) return
    const asset = res.assets?.[0]
    if (!asset?.uri) return
    const base = getFunctionsBase()
    if (!base) { Alert.alert('OCR unavailable', 'Missing EXPO_PUBLIC_FUNCTIONS_BASE'); return }
    try {
      const fileResp = await fetch(asset.uri)
      const blob = await fileResp.blob()
      const resp = await fetch(`${base}/.netlify/functions/ocr`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob })
      const data = await resp.json()
      if (!resp.ok || !data?.ok) throw new Error(data?.error || `OCR failed (${resp.status})`)
      const f = data.fields || {}
      setItemName(f.supplier || itemName)
      setSupplier(f.supplier || supplier)
      setPurchaseDate(f.due_date || purchaseDate)
      Alert.alert('OCR extracted', 'Fields prefilling from photo. The image will be attached on save.')
      // Auto-create warranty record and attach file
      let savedId: string | null = null
      if (supabase) {
        const { data: created, error } = await createWarranty(supabase!, { item_name: f.supplier || 'Item', supplier: f.supplier || null, purchase_date: f.due_date || null })
        if (error) throw new Error(error.message)
        savedId = created?.id || null
      } else {
        const local = await addLocalWarranty({ item_name: f.supplier || 'Item', supplier: f.supplier || null, purchase_date: f.due_date || null })
        savedId = local.id
      }
      if (savedId) {
        const up = await uploadAttachmentFromUri('warranties', savedId, asset.uri, asset.fileName || 'photo.jpg', asset.type || 'image/jpeg')
        if (up.error) Alert.alert('Attachment upload failed', up.error)
        else Alert.alert('Warranty saved', 'Photo attached')
        navigation.navigate('Warranty Details', { warrantyId: savedId })
      }
    } catch (e: any) {
      Alert.alert('OCR error', e?.message || 'Failed')
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Warranties</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={[styles.input, { flex: 1 }]} placeholder="Item name" value={itemName} onChangeText={setItemName} />
        <TextInput style={[styles.input, { width: 140 }]} placeholder="Supplier" value={supplier} onChangeText={setSupplier} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={[styles.input, { width: 140 }]} placeholder="Purchase YYYY-MM-DD" value={purchaseDate} onChangeText={setPurchaseDate} />
        <TextInput style={[styles.input, { width: 140 }]} placeholder="Expires YYYY-MM-DD" value={expiresAt} onChangeText={setExpiresAt} />
        <TextInput style={[styles.input, { width: 160 }]} placeholder="Duration (months)" value={durationMonths} onChangeText={setDurationMonths} keyboardType="numeric" />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Button title="Attach Image" onPress={async ()=>{
          const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
          if (res.canceled) return
          const asset = res.assets?.[0]
          if (!asset?.uri) return
          setPendingAttachment({ uri: asset.uri, name: asset.fileName || 'photo.jpg', type: asset.type || 'image/jpeg' })
          Alert.alert('Attachment selected', 'Image will be attached on save.')
        }} />
        <Button title="Attach PDF" onPress={async ()=>{
          const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
          if (res.canceled) return
          const file = res.assets?.[0]
          if (!file?.uri) return
          setPendingAttachment({ uri: file.uri, name: file.name || 'document.pdf', type: 'application/pdf' })
          Alert.alert('Attachment selected', 'PDF will be attached on save.')
        }} />
      </View>
      {!!pendingAttachment && (
        <View style={{ marginTop: 8 }}>
          <Text style={{ marginBottom: 4 }}>Attachment preview:</Text>
          {pendingAttachment.type?.startsWith('image/') ? (
            <Image source={{ uri: pendingAttachment.uri }} style={{ width: 160, height: 120, borderRadius: 6 }} />
          ) : (
            <Text>{pendingAttachment.name}</Text>
          )}
        </View>
      )}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <Button title="Save" onPress={addManual} />
        <Button title="OCR from Photo" onPress={ocrPhoto} />
      </View>
      <FlatList data={items} keyExtractor={(w)=>w.id} renderItem={({ item }) => (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{item.item_name}{(item as any)?.unsynced ? ' • Not synced' : ''}</Text>
          <Text>{item.supplier || '—'} • purchased {item.purchase_date || '—'} • expires {item.expires_at || '—'}</Text>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
            <Button title="Details" onPress={()=> navigation.navigate('Warranty Details', { warrantyId: item.id })} />
            <TouchableOpacity onPress={()=>del(item.id)}><Text style={{ fontSize: 18 }}>🗑️</Text></TouchableOpacity>
          </View>
        </View>
      )} />
    </View>
  )
}

function WarrantyDetailsScreen() {
  const route = useRoute<any>()
  const supabase = useMemo(() => getSupabase(), [])
  const warrantyId: string | null = route.params?.warrantyId || null
  const [warranty, setWarranty] = useState<Warranty | null>(null)
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  useEffect(() => { (async ()=>{
    if (!warrantyId) return
    if (supabase) {
      const userId = await getCurrentUserId(supabase!)
      const { data } = await supabase!.from('warranties').select('*').eq('user_id', userId).eq('id', warrantyId).single()
      setWarranty((data as Warranty) || null)
      setAttachments(await listRemoteAttachments(supabase!, 'warranties', warrantyId))
    } else {
      const locals = await loadLocalWarranties()
      const w = locals.find(l=> l.id===warrantyId) || null
      setWarranty(w as any)
      setAttachments(await listLocalAttachments('warranties', warrantyId))
    }
  })() }, [warrantyId, supabase])

  async function refresh() {
    if (!warrantyId) return
    if (supabase) setAttachments(await listRemoteAttachments(supabase!, 'warranties', warrantyId))
    else setAttachments(await listLocalAttachments('warranties', warrantyId))
  }
  async function addImage() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
    if (res.canceled) return
    const asset = res.assets?.[0]
    if (!asset?.uri) return
    const up = await uploadAttachmentFromUri('warranties', warrantyId!, asset.uri, asset.fileName || 'photo.jpg', asset.type || 'image/jpeg')
    if (up.error) Alert.alert('Upload failed', up.error)
    else Alert.alert('Attachment uploaded', 'Image attached to warranty')
    await refresh()
  }
  async function addPdf() {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
    if (res.canceled) return
    const file = res.assets?.[0]
    if (!file?.uri) return
    const up = await uploadAttachmentFromUri('warranties', warrantyId!, file.uri, file.name || 'document.pdf', 'application/pdf')
    if (up.error) Alert.alert('Upload failed', up.error)
    else Alert.alert('Attachment uploaded', 'PDF attached to warranty')
    await refresh()
  }
  async function openAttachment(path: string, uri?: string) {
    if (supabase) { const url = await getSignedUrl(supabase!, path); if (url) Linking.openURL(url); else Alert.alert('Open failed', 'Could not get URL') }
    else if (uri) Linking.openURL(uri)
    else Alert.alert('Offline', 'Attachment stored locally. Preview is unavailable.')
  }
  async function remove(path: string) {
    Alert.alert('Delete attachment?', 'This file will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { const { error } = await deleteAttachment('warranties', warrantyId!, path); if (error) Alert.alert('Delete failed', error); else await refresh() } }
    ])
  }

  if (!warranty) return (<View style={styles.centered}><Text>Warranty not found.</Text></View>)
  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Warranty Details</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{warranty.item_name}</Text>
        <Text>{warranty.supplier || '—'} • purchased {warranty.purchase_date || '—'} • expires {warranty.expires_at || '—'}</Text>
      </View>
      <Text style={styles.sectionTitle}>Attachments</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <Button title="Add Image" onPress={addImage} />
        <Button title="Add PDF" onPress={addPdf} />
      </View>
      <FlatList data={attachments} keyExtractor={(a)=>a.path} renderItem={({ item })=> (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{item.name}</Text>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
            <Button title="Open" onPress={()=>openAttachment(item.path, item.uri)} />
            <Button title="Delete" color="#c53030" onPress={()=>remove(item.path)} />
          </View>
        </View>
      )} />
    </View>
  )
}

function ReportsScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const [bills, setBills] = useState<Bill[]>([])
  const [range, setRange] = useState<{ start: string; end: string }>({ start: new Date(new Date().getFullYear(),0,1).toISOString().slice(0,10), end: new Date().toISOString().slice(0,10) })
  useEffect(() => { (async ()=>{
    if (supabase) { const { data } = await listBills(supabase); setBills(data) }
    else { const locals = await loadLocalBills(); setBills(locals as any) }
  })() }, [supabase])

  const filtered = bills.filter(b=> b.due_date >= range.start && b.due_date <= range.end)
  const monthly: Record<string, number> = {}
  for (const b of filtered) {
    const ym = b.due_date.slice(0,7)
    monthly[ym] = (monthly[ym] || 0) + (b.currency==='EUR'? b.amount : 0)
  }
  const suppliers: Record<string, number> = {}
  for (const b of filtered) suppliers[b.supplier] = (suppliers[b.supplier] || 0) + (b.currency==='EUR'? b.amount : 0)

  async function exportCSV() {
    const rows = [['Supplier','Amount','Currency','Due','Status']].concat(filtered.map(b=>[b.supplier, String(b.amount), b.currency, b.due_date, b.status]))
    const csv = rows.map(r=> r.map(v=> String(v).replace(/"/g,'""')).map(v=>`"${v}"`).join(',')).join('\n')
    const file = `${FileSystem.cacheDirectory}billbox-report.csv`
    await FileSystem.writeAsStringAsync(file, csv)
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file)
    else Alert.alert('CSV saved', file)
  }

  async function exportPDF() {
    const itemsHtml = filtered.map(b=> `<tr><td>${b.supplier}</td><td>${b.currency} ${b.amount.toFixed(2)}</td><td>${b.due_date}</td><td>${b.status}</td></tr>`).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>BillBox Report</title><style>table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px}</style></head><body><h1>BillBox Report</h1><p>Range: ${range.start} → ${range.end}</p><table><thead><tr><th>Supplier</th><th>Amount</th><th>Due</th><th>Status</th></tr></thead><tbody>${itemsHtml}</tbody></table></body></html>`
    const { uri } = await Print.printToFileAsync({ html })
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri)
    else Alert.alert('PDF saved', uri)
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Reports</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={[styles.input,{ width: 140 }]} placeholder="YYYY-MM-DD" value={range.start} onChangeText={(v)=>setRange(r=>({ ...r, start: v }))} />
        <TextInput style={[styles.input,{ width: 140 }]} placeholder="YYYY-MM-DD" value={range.end} onChangeText={(v)=>setRange(r=>({ ...r, end: v }))} />
        <Button title="Export CSV" onPress={exportCSV} />
        <Button title="Export PDF" onPress={exportPDF} />
      </View>
      <Text style={styles.sectionTitle}>Monthly spend</Text>
      <View style={{ padding: 8 }}>
        {Object.keys(monthly).sort().map((k)=> (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text style={{ width: 80 }}>{k}</Text>
            <View style={{ height: 12, backgroundColor: '#2b6cb0', width: Math.min(300, Math.round(monthly[k])) }} />
            <Text style={{ marginLeft: 8 }}>EUR {monthly[k].toFixed(2)}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.sectionTitle}>Top suppliers</Text>
      <View style={{ padding: 8 }}>
        {Object.entries(suppliers).sort((a,b)=> b[1]-a[1]).slice(0,10).map(([s,amt])=> (
          <View key={s} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text style={{ flex: 1 }}>{s}</Text>
            <Text>EUR {amt.toFixed(2)}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

const Stack = createNativeStackNavigator()
const Tab = createBottomTabNavigator()

function MainTabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Dashboard" component={HomeScreen} />
      <Tab.Screen name="Scan Bill" component={ScanBillScreen} />
      <Tab.Screen name="My Bills" component={BillsListScreen} />
      <Tab.Screen name="Warranties" component={WarrantiesScreen} />
      <Tab.Screen name="Reports" component={ReportsScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  )
}

function SettingsScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
      <View style={styles.card}><Text>{supabase ? 'Cloud sync enabled' : 'Offline mode (cloud sync disabled)'}</Text></View>
      <View style={styles.card}><Text>Functions base: {getFunctionsBase() || 'Not set'}</Text></View>
      {supabase && (
        <Button title="Sign out" onPress={async ()=>{ try { await supabase!.auth.signOut(); Alert.alert('Signed out'); } catch(e:any) { Alert.alert('Error', e?.message||'Failed') } }} />
      )}
    </View>
  )
}

export default function App() {
  const supabase = useMemo(() => getSupabase(), [])
  const [loggedIn, setLoggedIn] = useState(false)
  useEffect(() => { (async ()=>{ if (!supabase) { setLoggedIn(true); return } const { data } = await supabase.auth.getSession(); setLoggedIn(!!data?.session) })() }, [supabase])
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <StatusBar style="dark" />
      <NavigationContainer>
        <Stack.Navigator>
          {!loggedIn ? (
            <Stack.Screen name="Login" options={{ headerShown: coerceBool(false) }}>
              {() => <LoginScreen onLoggedIn={()=>setLoggedIn(true)} />}
            </Stack.Screen>
          ) : (
            <>
              <Stack.Screen name="BillBox" component={MainTabs} options={{ headerShown: coerceBool(false) }} />
              <Stack.Screen name="Bill Details" component={BillDetailsScreen} />
              <Stack.Screen name="Warranty Details" component={WarrantyDetailsScreen} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 16 },
  sectionTitle: { fontSize: 20, fontWeight: '600', marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  primaryBtn: { backgroundColor: '#2b6cb0', paddingVertical: 10, borderRadius: 6, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontWeight: '600' },
  secondaryBtn: { backgroundColor: '#00000088', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20 },
  secondaryBtnText: { color: '#fff' },
  scanControls: { position: 'absolute', bottom: 24, left: 0, right: 0, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 12 },
  card: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, marginBottom: 8 },
  cardTitle: { fontSize: 16, fontWeight: '600' }
})
