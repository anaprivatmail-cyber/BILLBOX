/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, RefreshControl, StyleSheet, Text, Button, View, Platform, Linking, Image, Switch, ActivityIndicator, Pressable, KeyboardAvoidingView, TextInput, ScrollView, TouchableOpacity, Modal } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { NavigationContainer, useFocusEffect, useNavigation, useRoute, NavigationContainerRef } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { CameraView, useCameraPermissions } from 'expo-camera'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system'
import * as Print from 'expo-print'
import * as Sharing from 'expo-sharing'
import Constants from 'expo-constants'
// @ts-ignore JSZip is provided by dependency
import JSZip from 'jszip'
import * as Notifications from 'expo-notifications'
import { createClient, SupabaseClient, PostgrestError } from '@supabase/supabase-js'
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker'
import { Screen, Surface, SectionHeader, AppButton, AppInput, SegmentedControl, Badge, EmptyState, InlineInfo, Disclosure, Divider } from './src/ui/components'
import { colors as themeColors, layout as themeLayout, spacing as themeSpacing } from './src/ui/theme'
import type { Lang } from './src/i18n'
import { t, loadLang, saveLang } from './src/i18n'
import type { InboxItem } from './src/inbox'
import { listInbox, addToInbox, updateInboxItem, removeInboxItem, clearInbox } from './src/inbox'
import { ensureNotificationConfig, requestPermissionIfNeeded, scheduleBillReminders, cancelBillReminders, snoozeBillReminder, scheduleGroupedPaymentReminder, scheduleWarrantyReminders, cancelWarrantyReminders } from './src/reminders'
import { ENABLE_PUSH_NOTIFICATIONS, PUBLIC_SITE_URL, ENABLE_IAP } from './src/env'
import type { Space, SpacePlan } from './src/spaces'
import { ensureDefaults as ensureSpacesDefaults, upsertSpace, removeSpace, loadCurrentSpaceId, saveCurrentSpaceId, loadSpaces } from './src/spaces'
import { setUpgradeHandler, showUpgradeAlert, type EntitlementsSnapshot, type PlanId, useEntitlements, EntitlementsProvider } from './src/entitlements'

const BRAND_WORDMARK = require('./assets/logo/logo-wordmark.png')
const BRAND_ICON = require('./assets/logo/logo-icon.png')

type LangContextValue = { lang: Lang; setLang: (value: Lang) => void }
const LangContext = React.createContext<LangContextValue>({ lang: 'en', setLang: () => {} })
function useLang() {
  return useContext(LangContext)
}

function formatTemplate(template: string, vars: Record<string, any>): string {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key) => {
    const v = vars?.[key]
    return v == null ? '' : String(v)
  })
}

function tf(lang: Lang, key: string, vars: Record<string, any>): string {
  return formatTemplate(t(lang, key), vars)
}

function payerLabelFromSpaceId(spaceId: string | null | undefined): 'Payer 1' | 'Payer 2' {
  // Uses currentLang inside i18n.ts via t(key) overload.
  return (spaceId === 'personal2' ? t('payer_2_label') : t('payer_1_label')) as any
}

function isPayerSpaceId(spaceId: string | null | undefined): boolean {
  return spaceId === 'personal' || spaceId === 'personal2'
}

async function removeAllLocalKeysWithPrefix(prefix: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys()
    const toRemove = keys.filter((k) => k.startsWith(prefix))
    if (toRemove.length) await AsyncStorage.multiRemove(toRemove)
  } catch {}
}

function planLabel(plan: PlanId): string {
  if (plan === 'pro') return 'Pro'
  if (plan === 'basic') return 'Basic'
  return 'Free'
}

function planPrice(plan: PlanId): string {
  if (plan === 'pro') return '€4 / month or €38 / year'
  if (plan === 'basic') return '€2.20 / month or €20 / year'
  return '€0'
}

const isIOS = Platform.OS === 'ios'
const IS_EXPO_GO = (Constants as any)?.appOwnership === 'expo' || (Constants as any)?.executionEnvironment === 'storeClient'
const AUTH_STORAGE_KEY = 'billbox.mobile.auth'
const LS_LAST_EMAIL = 'billbox.mobile.lastEmail'

// --- EPC / UPN parsing (copied from shared epc utilities) ---
type EPCResult = {
  iban?: string
  creditor_name?: string
  amount?: number
  purpose?: string
  reference?: string
  currency?: string
}

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
      const eurMatch = l.match(/EUR\s*([0-9]+(?:[.,][0-9]{1,2})?)/i)
      if (eurMatch) {
        const val = Number(eurMatch[1].replace(',', '.'))
        if (!Number.isNaN(val)) { amount = val; currency = 'EUR'; break }
      }
      const amtMatch = l.match(/([0-9]+(?:[.,][0-9]{1,2})?)/)
      if (!amount && amtMatch) {
        const val = Number(amtMatch[1].replace(',', '.'))
        if (!Number.isNaN(val) && val > 0) amount = val
      }
    }
    let reference: string | undefined
    for (const l of lines) {
      const m = l.match(/(SI\d{2}[0-9]{4,}|sklic:?\s*([A-Z0-9-/]+))/i)
      if (m) { reference = (m[1] || m[2] || '').replace(/\s+/g, ''); if (reference) break }
    }
    let purpose: string | undefined
    for (const l of lines) {
      const m = l.match(/namen:?\s*(.+)|purpose:?\s*(.+)/i)
      if (m) { purpose = (m[1] || m[2] || '').trim(); if (purpose) break }
    }
    let creditor_name: string | undefined
    for (const l of lines) {
      const m = l.match(/prejemnik|recipient|name:?\s*(.+)/i)
      if (m) { const n = (m[1] || '').trim(); if (n) { creditor_name = n; break } }
    }
    const result: EPCResult = { iban, amount, purpose, reference, creditor_name, currency }
    if (result.iban || typeof result.amount === 'number') return result
    return null
  } catch {
    return null
  }
}

function parsePaymentQR(text: string): EPCResult | null {
  return parseEPC(text) || parseUPN(text)
}

// Safely coerce potentially stringy booleans to real booleans
function coerceBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1'
  if (typeof val === 'number') return val === 1
  return Boolean(val)
}

// --- Supabase helpers (mobile) ---
function getSupabase(): SupabaseClient | null {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL
  const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return null
  return createClient(url, anon, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: AsyncStorage,
      storageKey: AUTH_STORAGE_KEY,
    },
  })
}

function getFunctionsBase(): string | null {
  const base = process.env.EXPO_PUBLIC_FUNCTIONS_BASE
  return base && typeof base === 'string' && base.trim() ? base.trim().replace(/\/$/, '') : null
}

type Interval = 'monthly' | 'yearly'

function resolveProductId(plan: PlanId, interval: Interval): string | null {
  const prefix = Platform.OS === 'ios' ? 'EXPO_PUBLIC_IAP_APPLE_' : 'EXPO_PUBLIC_IAP_GOOGLE_'
  const keyBase = `${prefix}${String(plan).toUpperCase()}_${String(interval).toUpperCase()}`
  const envKey = process.env[keyBase as keyof NodeJS.ProcessEnv] as string | undefined
  const val = envKey && typeof envKey === 'string' ? envKey.trim() : ''
  return val || null
}

async function verifyIapOnBackend(productId: string): Promise<boolean> {
  try {
    const base = getFunctionsBase()
    const supabase = getSupabase()
    if (!base || !supabase) {
      return false
    }
    const { data, error } = await supabase.auth.getUser()
    if (error || !data?.user?.id) return false
    const userId = data.user.id
    const resp = await fetch(`${base}/.netlify/functions/verify-iap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: Platform.OS, productId, userId }),
    })
    if (!resp.ok) return false
    const json = await resp.json().catch(() => ({}))
    return !!json?.ok
  } catch {
    return false
  }
}

// --- Bills & warranties types ---
type BillStatus = 'unpaid' | 'paid' | 'archived'

type Bill = {
  id: string
  user_id: string
  supplier: string
  amount: number
  currency: string
  due_date: string
  status: BillStatus
  created_at: string
  creditor_name?: string | null
  iban?: string | null
  reference?: string | null
  purpose?: string | null
  space_id?: string | null
}

type CreateBillInput = {
  supplier: string
  amount: number
  currency: string
  due_date: string
  status?: BillStatus
  creditor_name?: string | null
  iban?: string | null
  reference?: string | null
  purpose?: string | null
  space_id?: string | null
}

type Warranty = {
  id: string
  user_id: string
  item_name: string
  supplier?: string | null
  purchase_date?: string | null
  bill_id?: string | null
  expires_at?: string | null
  created_at: string
  space_id?: string | null
}

type CreateWarrantyInput = {
  item_name: string
  supplier?: string | null
  purchase_date?: string | null
  bill_id?: string | null
  expires_at?: string | null
  space_id?: string | null
}

async function getCurrentUserId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  const id = data?.user?.id
  if (!id) throw new Error('No authenticated user')
  return id
}

async function listBills(supabase: SupabaseClient, _spaceId?: string | null): Promise<{ data: Bill[]; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase
    .from('bills')
    .select('*')
    .eq('user_id', userId)
  if (_spaceId) q = q.eq('space_id', _spaceId)
  const { data, error } = await q.order('due_date', { ascending: true })
  return { data: (data as Bill[]) || [], error }
}

async function createBill(supabase: SupabaseClient, input: CreateBillInput): Promise<{ data: Bill | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const payload: any = { ...input, user_id: userId, status: input.status || 'unpaid' }
  const { data, error } = await supabase.from('bills').insert(payload).select().single()
  return { data: (data as Bill) || null, error }
}

async function deleteBill(supabase: SupabaseClient, id: string, _spaceId?: string | null): Promise<{ error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase.from('bills').delete().eq('user_id', userId).eq('id', id)
  if (_spaceId) q = q.eq('space_id', _spaceId)
  const { error } = await q
  return { error }
}

async function setBillStatus(supabase: SupabaseClient, id: string, status: BillStatus, _spaceId?: string | null): Promise<{ data: Bill | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase
    .from('bills')
    .update({ status })
    .eq('user_id', userId)
    .eq('id', id)
  if (_spaceId) q = q.eq('space_id', _spaceId)
  const { data, error } = await q.select().single()
  return { data: (data as Bill) || null, error }
}

async function listWarranties(supabase: SupabaseClient, _spaceId?: string | null): Promise<{ data: Warranty[]; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase
    .from('warranties')
    .select('*')
    .eq('user_id', userId)
  if (_spaceId) q = q.eq('space_id', _spaceId)
  const { data, error } = await q.order('created_at', { ascending: false })
  return { data: (data as Warranty[]) || [], error }
}

async function createWarranty(supabase: SupabaseClient, input: CreateWarrantyInput): Promise<{ data: Warranty | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const payload: any = { ...input, user_id: userId }
  const { data, error } = await supabase.from('warranties').insert(payload).select().single()
  return { data: (data as Warranty) || null, error }
}

async function deleteWarranty(supabase: SupabaseClient, id: string, _spaceId?: string | null): Promise<{ error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase.from('warranties').delete().eq('user_id', userId).eq('id', id)
  if (_spaceId) q = q.eq('space_id', _spaceId)
  const { error } = await q
  return { error }
}

// --- Local storage helpers (per-space offline mode) ---
type LocalBill = Bill & { unsynced?: boolean }

const LS_BILLS_PREFIX = 'billbox.local.bills.'

function normalizeSpaceId(id?: string | null): string {
  return id && id.trim().length > 0 ? id : 'default'
}

function billsKey(spaceId?: string | null) {
  return `${LS_BILLS_PREFIX}${normalizeSpaceId(spaceId)}`
}

async function loadLocalBills(spaceId?: string | null): Promise<LocalBill[]> {
  try {
    const raw = await AsyncStorage.getItem(billsKey(spaceId))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

async function saveLocalBills(spaceId: string | null | undefined, items: LocalBill[]): Promise<void> {
  try {
    await AsyncStorage.setItem(billsKey(spaceId), JSON.stringify(items))
  } catch {}
}

async function addLocalBill(spaceId: string | null | undefined, input: Omit<LocalBill, 'id' | 'created_at' | 'user_id' | 'status'> & { status?: BillStatus }): Promise<LocalBill> {
  const items = await loadLocalBills(spaceId)
  const now = new Date().toISOString()
  const bill: LocalBill = {
    id: `local_${Math.random().toString(36).slice(2)}`,
    user_id: 'local',
    created_at: now,
    status: input.status || 'unpaid',
    unsynced: true,
    space_id: normalizeSpaceId(spaceId),
    ...input,
  }
  items.unshift(bill)
  await saveLocalBills(spaceId, items)
  return bill
}

async function deleteLocalBill(spaceId: string | null | undefined, id: string): Promise<void> {
  const items = await loadLocalBills(spaceId)
  await saveLocalBills(spaceId, items.filter((b) => b.id !== id))
}

async function setLocalBillStatus(spaceId: string | null | undefined, id: string, status: BillStatus): Promise<void> {
  const items = await loadLocalBills(spaceId)
  await saveLocalBills(spaceId, items.map((b) => (b.id === id ? { ...b, status } : b)))
}

type LocalWarranty = Warranty & { unsynced?: boolean }

const LS_WARRANTIES_PREFIX = 'billbox.local.warranties.'

function warrantiesKey(spaceId?: string | null) {
  return `${LS_WARRANTIES_PREFIX}${normalizeSpaceId(spaceId)}`
}

async function loadLocalWarranties(spaceId?: string | null): Promise<LocalWarranty[]> {
  try {
    const raw = await AsyncStorage.getItem(warrantiesKey(spaceId))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

async function purgePayerData(spaceId: string): Promise<void> {
  // Best-effort cleanup of payer-scoped data to prevent "ghost" data.
  try { await clearInbox(spaceId) } catch {}

  const supabase = getSupabase()
  let bills: Bill[] = []
  let warranties: Warranty[] = []

  try {
    if (supabase) {
      const b = await listBills(supabase, spaceId)
      bills = b.data || []
      const w = await listWarranties(supabase, spaceId)
      warranties = w.data || []
    } else {
      bills = (await loadLocalBills(spaceId)) as any
      warranties = (await loadLocalWarranties(spaceId)) as any
    }
  } catch {}

  for (const bill of bills) {
    try { await cancelBillReminders(bill.id, spaceId) } catch {}
    try { await deleteAllAttachmentsForRecord(spaceId, 'bills', bill.id) } catch {}
    try {
      if (supabase) await deleteBill(supabase, bill.id, spaceId)
      else await deleteLocalBill(spaceId, bill.id)
    } catch {}
  }

  for (const w of warranties) {
    try { await cancelWarrantyReminders(w.id, spaceId) } catch {}
    try { await deleteAllAttachmentsForRecord(spaceId, 'warranties', w.id) } catch {}
    try {
      if (supabase) await deleteWarranty(supabase, w.id, spaceId)
      else await deleteLocalWarranty(spaceId, w.id)
    } catch {}
  }

  try { await AsyncStorage.removeItem(billsKey(spaceId)) } catch {}
  try { await AsyncStorage.removeItem(warrantiesKey(spaceId)) } catch {}
  await removeAllLocalKeysWithPrefix(`${LS_ATTACH_PREFIX}${normalizeSpaceId(spaceId)}.`)
}

async function saveLocalWarranties(spaceId: string | null | undefined, items: LocalWarranty[]): Promise<void> {
  try {
    await AsyncStorage.setItem(warrantiesKey(spaceId), JSON.stringify(items))
  } catch {}
}

async function addLocalWarranty(spaceId: string | null | undefined, input: Omit<LocalWarranty, 'id' | 'created_at' | 'user_id' | 'unsynced'>): Promise<LocalWarranty> {
  const items = await loadLocalWarranties(spaceId)
  const now = new Date().toISOString()
  const w: LocalWarranty = {
    id: `local_${Math.random().toString(36).slice(2)}`,
    created_at: now,
    user_id: 'local',
    unsynced: true,
    space_id: normalizeSpaceId(spaceId),
    ...input,
  }
  items.unshift(w)
  await saveLocalWarranties(spaceId, items)
  return w
}

async function deleteLocalWarranty(spaceId: string | null | undefined, id: string): Promise<void> {
  const items = await loadLocalWarranties(spaceId)
  await saveLocalWarranties(spaceId, items.filter((w) => w.id !== id))
}

// --- Attachments helpers (per-space offline + Supabase storage) ---
type AttachmentItem = { name: string; path: string; created_at?: string; uri?: string }

const LS_ATTACH_PREFIX = 'billbox.local.attachments.'

function localAttachKey(spaceId: string | null | undefined, kind: 'bills' | 'warranties', id: string): string {
  return `${LS_ATTACH_PREFIX}${normalizeSpaceId(spaceId)}.${kind}.${id}`
}

async function listLocalAttachments(spaceId: string | null | undefined, kind: 'bills' | 'warranties', id: string): Promise<AttachmentItem[]> {
  try {
    const raw = await AsyncStorage.getItem(localAttachKey(spaceId, kind, id))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

async function addLocalAttachment(spaceId: string | null | undefined, kind: 'bills' | 'warranties', id: string, item: AttachmentItem): Promise<void> {
  const items = await listLocalAttachments(spaceId, kind, id)
  items.unshift(item)
  await AsyncStorage.setItem(localAttachKey(spaceId, kind, id), JSON.stringify(items))
}

async function removeLocalAttachment(spaceId: string | null | undefined, kind: 'bills' | 'warranties', id: string, path: string): Promise<void> {
  const items = await listLocalAttachments(spaceId, kind, id)
  const next = items.filter((i) => i.path !== path)
  await AsyncStorage.setItem(localAttachKey(spaceId, kind, id), JSON.stringify(next))
}

async function listRemoteAttachments(supabase: SupabaseClient, kind: 'bills' | 'warranties', recId: string, _spaceId?: string | null): Promise<AttachmentItem[]> {
  const userId = await getCurrentUserId(supabase)
  const dir = `${userId}/${kind}/${recId}`
  const { data, error } = await supabase.storage.from('attachments').list(dir, {
    limit: 100,
    sortBy: { column: 'name', order: 'desc' },
  })
  if (error) return []
  const items = Array.isArray(data)
    ? (data as any[]).map((f) => ({ name: f.name, path: `${dir}/${f.name}`, created_at: f.created_at }))
    : []
  return items
}

async function getSignedUrl(supabase: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, 300)
  return error ? null : (data?.signedUrl || null)
}

async function uploadAttachmentFromUri(
  spaceId: string | null | undefined,
  kind: 'bills' | 'warranties',
  recId: string,
  uri: string,
  filename: string,
  contentType?: string,
): Promise<{ path: string | null; error: string | null }>{
  try {
    const s = getSupabase()
    if (!s) {
      const path = `${recId}/${filename}`
      await addLocalAttachment(spaceId, kind, recId, { name: filename, path, created_at: new Date().toISOString(), uri })
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

async function deleteAttachment(spaceId: string | null | undefined, kind: 'bills' | 'warranties', recId: string, path: string): Promise<{ error: string | null }>{
  const s = getSupabase()
  if (!s) {
    await removeLocalAttachment(spaceId, kind, recId, path)
    return { error: null }
  }
  const { error } = await s.storage.from('attachments').remove([path])
  return { error: error ? error.message : null }
}

async function deleteAllAttachmentsForRecord(spaceId: string | null | undefined, kind: 'bills' | 'warranties', recId: string): Promise<void> {
  const s = getSupabase()
  if (!s) {
    const items = await listLocalAttachments(spaceId, kind, recId)
    for (const it of items) await removeLocalAttachment(spaceId, kind, recId, it.path)
    return
  }
  const items = await listRemoteAttachments(s, kind, recId)
  if (!items.length) return
  await s.storage.from('attachments').remove(items.map((i) => i.path))
}

// --- OCR helper (Netlify function wrapper) ---
async function performOCR(uri: string): Promise<{ fields: any; summary: string }>{
  const base = getFunctionsBase()
  if (!base) {
    throw new Error('OCR unavailable: missing EXPO_PUBLIC_FUNCTIONS_BASE')
  }
  const fileResp = await fetch(uri)
  const blob = await fileResp.blob()
  const supabase = getSupabase()
  let authHeader: Record<string, string> = {}
  if (supabase) {
    try {
      const { data } = await supabase.auth.getSession()
      const token = data?.session?.access_token
      if (token) authHeader = { Authorization: `Bearer ${token}` }
    } catch {}
  }
  const resp = await fetch(`${base}/.netlify/functions/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', ...authHeader },
    body: blob,
  })
  const data = await resp.json().catch(() => null as any)
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
  const summary = parts.join('\n') || 'No fields found'
  return { fields: f, summary }
}

// --- Spaces context ---
type SpaceContextValue = {
  spaces: Space[]
  current: Space | null
  spaceId: string | null
  loading: boolean
  initError: string | null
  initTimedOut: boolean
  retryInit: () => void
  setCurrent: (id: string) => Promise<void>
  addSpace: (space: { name: string; kind: Space['kind']; plan: SpacePlan; seats?: number }) => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  updatePlan: (id: string, plan: SpacePlan) => Promise<void>
  remove: (id: string) => Promise<void>
}

const SpaceContext = React.createContext<SpaceContextValue | undefined>(undefined)

function useSpacesContext(): SpaceContextValue {
  const ctx = useContext(SpaceContext)
  if (!ctx) throw new Error('SpaceContext not available')
  return ctx
}

function useActiveSpace() {
  const ctx = useSpacesContext()
  return { space: ctx.current, spaceId: ctx.spaceId, loading: ctx.loading }
}

function SpaceProvider({ children, enabled, demoMode }: { children: React.ReactNode; enabled: boolean; demoMode: boolean }) {
  const [spaces, setSpaces] = useState<Space[]>([])
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [initError, setInitError] = useState<string | null>(null)
  const [initTimedOut, setInitTimedOut] = useState(false)
  const [initNonce, setInitNonce] = useState(0)
  const { snapshot: entitlements } = useEntitlements()
  const { lang } = useLang()

  const retryInit = useCallback(() => {
    setInitError(null)
    setInitTimedOut(false)
    setInitNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    let mounted = true

    // Before auth/demo is finalized, do not initialize payers/spaces at all.
    if (!enabled) {
      setSpaces([])
      setSpaceId(null)
      setInitError(null)
      setInitTimedOut(false)
      setLoading(false)
      return () => {
        mounted = false
      }
    }

    const start = Date.now()
    console.log('[startup] payer init start', { demoMode })
    setLoading(true)
    setInitError(null)
    setInitTimedOut(false)

    const timeoutMs = 10_000
    const timeout = setTimeout(() => {
      if (!mounted) return
      setInitTimedOut(true)
      setLoading(false)
      // Fallback to an in-memory payer list so the app stays usable.
      if (!spaces.length) {
        setSpaces([{ id: 'personal', name: t(lang, 'payer_1_label'), plan: 'free' } as any])
        setSpaceId('personal')
      }
      console.warn('[startup] payer init timeout')
    }, timeoutMs)

    ;(async () => {
      try {
        if (demoMode) {
          // Demo must work without network/auth; keep payers in-memory.
          if (!mounted) return
          setSpaces([{ id: 'personal', name: t(lang, 'payer_1_label'), plan: 'free' } as any])
          setSpaceId('personal')
          return
        }

        // Strict fallback: if no payer exists, ensure defaults.
        await ensureSpacesDefaults()
        const initial = await loadSpaces()
        let currentId: string | null = null
        try {
          currentId = await loadCurrentSpaceId()
        } catch {
          currentId = initial[0]?.id || null
        }
        if (currentId && !initial.some((s) => s.id === currentId)) {
          currentId = initial[0]?.id || null
        }
        if (!mounted) return
        setSpaces(initial)
        setSpaceId(currentId || initial[0]?.id || null)
      } catch (e: any) {
        if (!mounted) return
        setInitError(e?.message || 'Payer preparation failed')
        console.warn('[startup] payer init error', e)

        // Keep app usable: fall back to an in-memory payer.
        setSpaces([{ id: 'personal', name: t(lang, 'payer_1_label'), plan: 'free' } as any])
        setSpaceId('personal')
      } finally {
        clearTimeout(timeout)
        if (!mounted) return
        setLoading(false)
        console.log('[startup] payer init end', { ms: Date.now() - start, ok: true })
      }
    })()

    return () => {
      mounted = false
      clearTimeout(timeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, demoMode, initNonce])

  const setCurrent = useCallback(async (id: string) => {
    setSpaceId(id)
    await saveCurrentSpaceId(id)
  }, [])

  const addSpaceHandler = useCallback(async (input: { name: string; kind: Space['kind']; plan: SpacePlan; seats?: number }) => {
    if (spaces.length >= entitlements.payerLimit) {
      showUpgradeAlert('space_limit')
      return
    }
    if (input.kind === 'business' && entitlements.plan !== 'pro') {
      showUpgradeAlert('business_space')
      return
    }

    // Stabilize Payer 2 identity to prevent duplicates.
    if (input.kind === 'personal' && entitlements.plan === 'pro' && spaces.some((s) => s.id === 'personal')) {
      const existingPayer2 = spaces.find((s) => s.id === 'personal2')
      if (existingPayer2) {
        const trimmed = (input.name || '').trim() || existingPayer2.name
        await upsertSpace({ ...existingPayer2, name: trimmed })
        const updated = await loadSpaces()
        setSpaces(updated)
        setSpaceId(existingPayer2.id)
        return
      }
    }
    const now = new Date().toISOString()
    const id =
      input.kind === 'personal' && entitlements.plan === 'pro' && spaces.length === 1 && spaces[0]?.id === 'personal'
        ? 'personal2'
        : `${input.kind}-${Math.random().toString(36).slice(2, 8)}`
    const next: Space = {
      id,
      name: input.name,
      kind: input.kind,
      plan: input.plan,
      seats: input.seats ?? 1,
      created_at: now,
    }
    await upsertSpace(next)
    const updated = await loadSpaces()
    setSpaces(updated)
    setSpaceId(id)
  }, [entitlements.payerLimit, entitlements.plan, spaces])

  const renameHandler = useCallback(async (id: string, name: string) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return
    const all = await loadSpaces()
    const existing = all.find((s) => s.id === id)
    if (!existing) return
    await upsertSpace({ ...existing, name: trimmed })
    const updated = await loadSpaces()
    setSpaces(updated)
  }, [])

  const updatePlanHandler = useCallback(async (id: string, plan: SpacePlan) => {
    const all = await loadSpaces()
    const existing = all.find((s) => s.id === id)
    if (!existing) return
    await upsertSpace({ ...existing, plan })
    const updated = await loadSpaces()
    setSpaces(updated)
  }, [])

  const removeHandler = useCallback(async (id: string) => {
    const sp = spaces.find((s) => s.id === id) || null
    const slotLabel = payerLabelFromSpaceId(id)
    const displayName = sp?.name ? `"${sp.name}"` : slotLabel
    const isPayer1 = id === 'personal'
    const message = isPayer1
      ? tf(lang, 'spaces_remove_payer1_message', { displayName, slotLabel })
      : tf(lang, 'spaces_remove_payer2_message', { displayName, slotLabel })

    Alert.alert(tf(lang, 'spaces_remove_title', { slotLabel }), message, [
      { text: t(lang, 'common_cancel'), style: 'cancel' },
      {
        text: t(lang, 'remove_action'),
        style: 'destructive',
        onPress: async () => {
          if (isPayer1) {
            try { await AsyncStorage.removeItem('billbox.onboarding.payer1Named') } catch {}
          }
          await purgePayerData(id)
          await removeSpace(id)
          await ensureSpacesDefaults()
          const ensuredSpaces = await loadSpaces()
          const ensuredCurrentId = await loadCurrentSpaceId().catch(() => ensuredSpaces[0]?.id || null)
          setSpaces(ensuredSpaces)
          setSpaceId(ensuredCurrentId || ensuredSpaces[0]?.id || null)
        },
      },
    ])
  }, [lang, spaces])

  const current = spaces.find((s) => s.id === spaceId) || null

  const value: SpaceContextValue = {
    spaces,
    current,
    spaceId,
    loading,
    initError,
    initTimedOut,
    retryInit,
    setCurrent,
    addSpace: addSpaceHandler,
    rename: renameHandler,
    updatePlan: updatePlanHandler,
    remove: removeHandler,
  }

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>
}
function BillDetailsScreen() {
  const route = useRoute<any>()
  const navigation = useNavigation<any>()
  const supabase = useMemo(() => getSupabase(), [])
  const { lang } = useLang()
  const bill = (route.params?.bill || null) as Bill | null
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [linkedWarranty, setLinkedWarranty] = useState<Warranty | null>(null)
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()

  useEffect(() => { (async ()=>{
    if (!bill || spaceLoading || !space) return
    if (supabase) setAttachments(await listRemoteAttachments(supabase!, 'bills', bill.id, spaceId))
    else setAttachments(await listLocalAttachments(spaceId, 'bills', bill.id))

    try {
      if (supabase) {
        const { data } = await listWarranties(supabase!, spaceId)
        const match = (data || []).find((w: any) => w.bill_id === bill.id) || null
        setLinkedWarranty(match)
      } else {
        const locals = await loadLocalWarranties(spaceId)
        const match = (locals || []).find((w: any) => w.bill_id === bill.id) || null
        setLinkedWarranty(match as any)
      }
    } catch {
      setLinkedWarranty(null)
    }
  })() }, [bill, supabase, spaceLoading, space, spaceId])

  async function refresh() {
    if (!bill || spaceLoading || !space) return
    if (supabase) setAttachments(await listRemoteAttachments(supabase!, 'bills', bill.id, spaceId))
    else setAttachments(await listLocalAttachments(spaceId, 'bills', bill.id))
  }

  async function addImage() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
    if (res.canceled) return
    const asset = res.assets?.[0]
    if (!asset?.uri) return
    const name = asset.fileName || 'photo.jpg'
    const type = asset.type || 'image/jpeg'
    const up = await uploadAttachmentFromUri(spaceId, 'bills', bill!.id, asset.uri, name, type)
    if (up.error) Alert.alert(t(lang, 'upload_failed_title'), up.error || t(lang, 'upload_failed_message_generic'))
    else Alert.alert(t(lang, 'attachment_uploaded_title'), t(lang, 'image_attached_to_bill_message'))
  }

  async function addPdf() {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
    if (res.canceled) return
    const file = res.assets?.[0]
    if (!file?.uri) return
    const name = file.name || 'document.pdf'
    const up = await uploadAttachmentFromUri(spaceId, 'bills', bill!.id, file.uri, name, 'application/pdf')
    if (up.error) Alert.alert(t(lang, 'upload_failed_title'), up.error || t(lang, 'upload_failed_message_generic'))
    else Alert.alert(t(lang, 'attachment_uploaded_title'), t(lang, 'pdf_attached_to_bill_message'))
    await refresh()
  }

  async function openAttachment(path: string, uri?: string) {
    if (supabase) {
      const url = await getSignedUrl(supabase!, path)
      if (url) Linking.openURL(url)
      else Alert.alert(t(lang, 'open_failed_title'), t(lang, 'could_not_get_url_message'))
    } else {
      if (uri) Linking.openURL(uri)
      else Alert.alert(t(lang, 'offline_title'), t(lang, 'attachment_stored_locally_message'))
    }
  }

  async function remove(path: string) {
    Alert.alert(t(lang, 'delete_attachment_title'), t(lang, 'delete_attachment_message'), [
      { text: t(lang, 'cancel_action'), style: 'cancel' },
      {
        text: t(lang, 'delete_action'),
        style: 'destructive',
        onPress: async () => {
          const { error } = await deleteAttachment(spaceId, 'bills', bill!.id, path)
          if (error) Alert.alert(t(lang, 'delete_failed_title'), String(error))
          else await refresh()
        },
      },
    ])
  }

  if (!bill || spaceLoading || !space) {
    return (
      <Screen title={t(lang, 'bill_details_fallback_title')} scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{t(lang, 'loading_bill')}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen title={bill.supplier || t(lang, 'bill_details_fallback_title')}>
      <View style={styles.pageStack}>
        <Surface elevated>
          <SectionHeader title={t(lang, 'bill_summary_title')} />
          <Text style={styles.bodyText}>
            {bill.currency} {bill.amount.toFixed(2)} • {t(lang, 'due_label')} {bill.due_date}
          </Text>
          {!!bill.reference && <Text style={styles.bodyText}>{t(lang, 'ref_prefix')} {bill.reference}</Text>}
          {!!bill.iban && <Text style={styles.bodyText}>{t(lang, 'iban_prefix')} {bill.iban}</Text>}
          {!bill.due_date && (
            <InlineInfo
              tone="warning"
              iconName="alert-circle-outline"
              message={t(lang, 'no_due_date_reminders_message')}
            />
          )}
          {linkedWarranty ? (
            <AppButton
              label={t(lang, 'view_linked_warranty')}
              variant="secondary"
              iconName="shield-checkmark-outline"
              onPress={() => navigation.navigate('Warranty Details', { warrantyId: linkedWarranty.id })}
            />
          ) : (
            <AppButton
              label={t(lang, 'create_warranty_from_bill')}
              variant="secondary"
              iconName="shield-checkmark-outline"
              onPress={async () => {
                try {
                  // Enforce 1:1 rule (one bill -> max one warranty)
                  try {
                    const s0 = getSupabase()
                    if (s0) {
                      const { data } = await listWarranties(s0, spaceId)
                      const existing = (data || []).find((w: any) => w.bill_id === bill.id) || null
                      if (existing?.id) {
                        Alert.alert(t(lang, 'warranty_already_exists_title'), t(lang, 'opening_existing_warranty_for_bill_message'))
                        navigation.navigate('Warranty Details', { warrantyId: existing.id })
                        return
                      }
                    } else {
                      const locals = await loadLocalWarranties(spaceId)
                      const existing = (locals || []).find((w: any) => w.bill_id === bill.id) || null
                      if ((existing as any)?.id) {
                        Alert.alert(t(lang, 'warranty_already_exists_title'), t(lang, 'opening_existing_warranty_for_bill_message'))
                        navigation.navigate('Warranty Details', { warrantyId: (existing as any).id })
                        return
                      }
                    }
                  } catch {}

                  const s = getSupabase()
                  let createdId: string | null = null
                  if (s) {
                    const { data, error } = await createWarranty(s, { item_name: bill.supplier, supplier: bill.supplier, purchase_date: bill.due_date, bill_id: bill.id, space_id: spaceId })
                    if (error) {
                      Alert.alert(t(lang, 'warranty_error_title'), error.message)
                      return
                    }
                    createdId = data?.id || null
                  } else {
                    const local = await addLocalWarranty(spaceId, { item_name: bill.supplier, supplier: bill.supplier, purchase_date: bill.due_date, bill_id: bill.id })
                    createdId = local.id
                  }
                  if (createdId) {
                    Alert.alert(t(lang, 'warranty_created_title'), t(lang, 'linked_to_this_bill_message'))
                    navigation.navigate('Warranty Details', { warrantyId: createdId })
                  }
                } catch (e: any) {
                  Alert.alert(t(lang, 'create_warranty_failed_title'), e?.message || t(lang, 'unknown_error'))
                }
              }}
            />
          )}
        </Surface>

        <Surface elevated>
          <SectionHeader title={t(lang, 'reminders_title')} />
          <View style={styles.billActionsRow}>
            <AppButton
              label={t(lang, 'schedule_defaults')}
              variant="secondary"
              iconName="alarm-outline"
              onPress={async ()=>{
                if (!bill.due_date) {
                  Alert.alert(t(lang, 'missing_due_date_title'), t(lang, 'add_due_date_to_schedule_reminders_message'))
                  return
                }
                await ensureNotificationConfig()
                const ok = await requestPermissionIfNeeded()
                if (!ok) {
                  Alert.alert(t(lang, 'enable_reminders_title'), t(lang, 'enable_notifications_in_settings_message'))
                  return
                }
                await scheduleBillReminders({ ...bill, space_id: spaceId } as any, undefined, spaceId)
                Alert.alert(t(lang, 'reminders_scheduled_title'), t(lang, 'scheduled_default_bill_reminders_message'))
              }}
            />
            <AppButton
              label={t(lang, 'cancel_reminders')}
              variant="ghost"
              iconName="notifications-off-outline"
              onPress={async ()=>{
                await cancelBillReminders(bill.id, spaceId)
                Alert.alert(t(lang, 'reminders_title'), t(lang, 'canceled_for_this_bill_message'))
              }}
            />
          </View>
          <View style={styles.billActionsRow}>
            <AppButton
              label={t(lang, 'snooze_1_day')}
              variant="secondary"
              onPress={async ()=>{
                await snoozeBillReminder({ ...bill, space_id: spaceId } as any, 1, spaceId)
                Alert.alert(t(lang, 'snoozed_title'), t(lang, 'next_reminder_in_1_day_message'))
              }}
            />
            <AppButton
              label={t(lang, 'snooze_3_days')}
              variant="secondary"
              onPress={async ()=>{
                await snoozeBillReminder({ ...bill, space_id: spaceId } as any, 3, spaceId)
                Alert.alert(t(lang, 'snoozed_title'), t(lang, 'next_reminder_in_3_days_message'))
              }}
            />
            <AppButton
              label={t(lang, 'snooze_7_days')}
              variant="secondary"
              onPress={async ()=>{
                await snoozeBillReminder({ ...bill, space_id: spaceId } as any, 7, spaceId)
                Alert.alert(t(lang, 'snoozed_title'), t(lang, 'next_reminder_in_7_days_message'))
              }}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={t(lang, 'attachments_title')} />
          <View style={styles.attachmentRow}>
            <AppButton
              label={t(lang, 'add_image')}
              variant="secondary"
              iconName="image-outline"
              onPress={addImage}
            />
            <AppButton
              label={t(lang, 'add_pdf')}
              variant="secondary"
              iconName="document-attach-outline"
              onPress={addPdf}
            />
          </View>
          {attachments.length === 0 ? (
            <EmptyState
              title={t(lang, 'no_attachments_yet_title')}
              message={t(lang, 'attachments_help_message')}
              actionLabel={t(lang, 'attach_image_or_pdf_action')}
              onActionPress={addImage}
              iconName="document-text-outline"
            />
          ) : (
            <FlatList
              data={attachments}
              keyExtractor={(a)=>a.path}
              contentContainerStyle={styles.listContent}
              renderItem={({ item }) => (
                <Surface elevated style={styles.billRowCard}>
                  <Text style={styles.cardTitle}>{item.name}</Text>
                  <View style={styles.billActionsRow}>
                    <AppButton
                      label={t(lang, 'open_action')}
                      variant="secondary"
                      iconName="open-outline"
                      onPress={()=>openAttachment(item.path, item.uri)}
                    />
                    <AppButton
                      label={t(lang, 'delete_action')}
                      variant="ghost"
                      iconName="trash-outline"
                      onPress={()=>remove(item.path)}
                    />
                  </View>
                </Surface>
              )}
            />
          )}
        </Surface>

        <Surface elevated>
          <SectionHeader title={t(lang, 'danger_zone_title')} />
          <AppButton
            label={t(lang, 'delete_bill')}
            variant="ghost"
            iconName="trash-outline"
            onPress={() => {
              Alert.alert(t(lang, 'delete_bill_confirm_title'), t(lang, 'delete_bill_confirm_message'), [
                { text: t(lang, 'cancel_action'), style: 'cancel' },
                {
                  text: t(lang, 'delete_action'),
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await deleteAllAttachmentsForRecord(spaceId, 'bills', bill.id)
                      if (supabase) {
                        const { error } = await deleteBill(supabase, bill.id, spaceId)
                        if (error) throw error
                      } else {
                        await deleteLocalBill(spaceId, bill.id)
                      }
                      Alert.alert(t(lang, 'deleted_title'), t(lang, 'bill_removed_message'))
                      navigation.goBack()
                    } catch (e: any) {
                      Alert.alert(t(lang, 'delete_failed_title'), e?.message || t(lang, 'unable_to_delete_bill'))
                    }
                  },
                },
              ])
            }}
          />
        </Surface>
      </View>
    </Screen>
  )
}

const loginLanguageOptions: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'sl', label: 'Slovenščina' },
  { code: 'hr', label: 'Hrvatski' },
  { code: 'it', label: 'Italiano' },
  { code: 'de', label: 'Deutsch' },
]

type LoginMode = 'signIn' | 'signUp' | 'forgotPassword' | 'resendConfirmation'

type AuthFeedback = {
  tone: 'info' | 'warning' | 'danger' | 'success'
  message: string
}

type LoginScreenProps = {
  onLoggedIn: (mode?: 'auth' | 'demo') => void
  lang: Lang
  setLang: (value: Lang) => void
}

function LoginScreen({ onLoggedIn, lang, setLang }: LoginScreenProps) {
  const supabase = useMemo(() => getSupabase(), [])
  const [mode, setMode] = useState<LoginMode>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [socialBusy, setSocialBusy] = useState<'none' | 'google' | 'apple'>('none')
  const [feedback, setFeedback] = useState<AuthFeedback | null>(null)
  const [lastEmail, setLastEmail] = useState<string | null>(null)
  const supabaseRedirect = process.env.EXPO_PUBLIC_SUPABASE_REDIRECT_URL
  const googleEnabled = Boolean(supabase)
  const appleEnabled = Platform.OS === 'ios' && Boolean(supabase)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const stored = await AsyncStorage.getItem(LS_LAST_EMAIL)
        if (mounted && stored) {
          setEmail(stored)
          setLastEmail(stored)
        }
      } catch {}
    })()
    return () => {
      mounted = false
    }
  }, [])

  const rememberEmail = useCallback(async (value: string) => {
    const normalized = value.trim().toLowerCase()
    setLastEmail(normalized)
    try {
      await AsyncStorage.setItem(LS_LAST_EMAIL, normalized)
    } catch {}
  }, [])

  const setModeWithReset = useCallback((nextMode: LoginMode) => {
    setFeedback(null)
    setMode(nextMode)
    if (nextMode !== 'signUp') {
      setConfirmPassword('')
    }
    if (nextMode === 'signIn') {
      setPassword('')
    }
  }, [])

  const handleEmailSignIn = useCallback(async () => {
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !password) {
      setFeedback({ tone: 'danger', message: t(lang, 'error_email_password_required') })
      return
    }
    setBusy(true)
    setFeedback(null)
    try {
      if (!supabase) {
        await rememberEmail(trimmedEmail)
        onLoggedIn('auth')
        return
      }
      const { error } = await supabase.auth.signInWithPassword({ email: trimmedEmail, password })
      if (error) {
        setFeedback({ tone: 'danger', message: error.message })
        return
      }
      await rememberEmail(trimmedEmail)
      onLoggedIn('auth')
    } catch (e: any) {
      setFeedback({ tone: 'danger', message: e?.message || t(lang, 'error_generic') })
    } finally {
      setBusy(false)
    }
  }, [email, password, supabase, lang, rememberEmail, onLoggedIn])

  const handleSignUp = useCallback(async () => {
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !password || !confirmPassword) {
      setFeedback({ tone: 'danger', message: t(lang, 'error_fill_required') })
      return
    }
    if (password !== confirmPassword) {
      setFeedback({ tone: 'danger', message: t(lang, 'error_password_mismatch') })
      return
    }
    if (!supabase) {
      setFeedback({ tone: 'warning', message: t(lang, 'auth_requires_cloud') })
      return
    }
    setBusy(true)
    setFeedback(null)
    try {
      const { error } = await supabase.auth.signUp({ email: trimmedEmail, password })
      if (error) {
        setFeedback({ tone: 'danger', message: error.message })
        return
      }
      await rememberEmail(trimmedEmail)
      setFeedback({ tone: 'success', message: t(lang, 'sign_up_success_check_email') })
      setMode('resendConfirmation')
      setPassword('')
      setConfirmPassword('')
    } catch (e: any) {
      setFeedback({ tone: 'danger', message: e?.message || t(lang, 'error_generic') })
    } finally {
      setBusy(false)
    }
  }, [email, password, confirmPassword, supabase, lang, rememberEmail])

  const handleForgotPassword = useCallback(async () => {
    const trimmedEmail = email.trim()
    if (!trimmedEmail) {
      setFeedback({ tone: 'danger', message: t(lang, 'error_email_required') })
      return
    }
    if (!supabase) {
      setFeedback({ tone: 'warning', message: t(lang, 'auth_requires_cloud') })
      return
    }
    setBusy(true)
    setFeedback(null)
    try {
      const options = supabaseRedirect ? { redirectTo: supabaseRedirect } : undefined
      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, options)
      if (error) {
        setFeedback({ tone: 'danger', message: error.message })
        return
      }
      await rememberEmail(trimmedEmail)
      setFeedback({ tone: 'success', message: t(lang, 'reset_password_success') })
      setMode('signIn')
      setPassword('')
    } catch (e: any) {
      setFeedback({ tone: 'danger', message: e?.message || t(lang, 'error_generic') })
    } finally {
      setBusy(false)
    }
  }, [email, supabase, supabaseRedirect, lang, rememberEmail])

  const handleResendConfirmation = useCallback(async () => {
    const trimmedEmail = email.trim()
    if (!trimmedEmail) {
      setFeedback({ tone: 'danger', message: t(lang, 'error_email_required') })
      return
    }
    if (!supabase) {
      setFeedback({ tone: 'warning', message: t(lang, 'auth_requires_cloud') })
      return
    }
    setBusy(true)
    setFeedback(null)
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email: trimmedEmail })
      if (error) {
        setFeedback({ tone: 'danger', message: error.message })
        return
      }
      await rememberEmail(trimmedEmail)
      setFeedback({ tone: 'success', message: t(lang, 'confirmation_email_sent') })
    } catch (e: any) {
      setFeedback({ tone: 'danger', message: e?.message || t(lang, 'error_generic') })
    } finally {
      setBusy(false)
    }
  }, [email, supabase, lang, rememberEmail])

  const handleGoogleSignIn = useCallback(async () => {
    if (!supabase) {
      setFeedback({ tone: 'warning', message: t(lang, 'auth_requires_cloud') })
      return
    }
    setFeedback(null)
    setSocialBusy('google')
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: supabaseRedirect ? { redirectTo: supabaseRedirect } : undefined,
      })
      if (error) {
        setFeedback({ tone: 'danger', message: error.message })
        return
      }
      if (data?.url) {
        await Linking.openURL(data.url)
      } else {
        setFeedback({ tone: 'warning', message: t(lang, 'social_not_configured') })
      }
    } catch (e: any) {
      setFeedback({ tone: 'danger', message: e?.message || t(lang, 'error_generic') })
    } finally {
      setSocialBusy('none')
    }
  }, [supabase, supabaseRedirect, lang])

  const handleAppleSignIn = useCallback(async () => {
    if (!supabase) {
      setFeedback({ tone: 'warning', message: t(lang, 'auth_requires_cloud') })
      return
    }
    setFeedback(null)
    setSocialBusy('apple')
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'apple',
        options: supabaseRedirect ? { redirectTo: supabaseRedirect } : undefined,
      })
      if (error) {
        setFeedback({ tone: 'danger', message: error.message })
        return
      }
      if (data?.url) {
        await Linking.openURL(data.url)
      } else {
        setFeedback({ tone: 'warning', message: t(lang, 'social_not_configured') })
      }
    } catch (e: any) {
      setFeedback({ tone: 'danger', message: e?.message || t(lang, 'error_generic') })
    } finally {
      setSocialBusy('none')
    }
  }, [supabase, supabaseRedirect, lang])

  const modeTitleKey: Record<LoginMode, string> = {
    signIn: 'sign_in',
    signUp: 'sign_up',
    forgotPassword: 'reset_password_title',
    resendConfirmation: 'resend_confirmation_title',
  }

  const modeDescriptionKey: Record<LoginMode, string> = {
    signIn: 'login_intro',
    signUp: 'sign_up_intro',
    forgotPassword: 'forgot_password_intro',
    resendConfirmation: 'resend_confirmation_intro',
  }

  const primaryActionKey: Record<LoginMode, string> = {
    signIn: 'sign_in',
    signUp: 'create_account_action',
    forgotPassword: 'send_reset_link',
    resendConfirmation: 'send_confirmation_link',
  }

  const primaryActionHandler = mode === 'signIn'
    ? handleEmailSignIn
    : mode === 'signUp'
      ? handleSignUp
      : mode === 'forgotPassword'
        ? handleForgotPassword
        : handleResendConfirmation

  const primaryBusy = busy || socialBusy !== 'none'

  const continueAsLabel = lastEmail ? t(lang, 'continue_as_email').replace('{email}', lastEmail) : null

  return (
    <SafeAreaView style={styles.loginSafeArea}>
      <KeyboardAvoidingView behavior={isIOS ? 'padding' : undefined} style={styles.loginKeyboard}>
        <ScrollView contentContainerStyle={styles.loginScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.loginWrapper}>
            <View style={styles.loginHeader}>
              <View style={styles.loginLogo}>
                <Image source={BRAND_ICON} style={styles.loginLogoImage} resizeMode="contain" accessibilityLabel="BillBox" />
              </View>
              <Text style={styles.loginTitle}>{t(lang, 'app_title')}</Text>
              <Text style={styles.loginSubtitle}>{t(lang, 'login_tagline')}</Text>
            </View>

            {feedback && (
              <InlineInfo tone={feedback.tone} message={feedback.message} style={styles.feedbackBanner} />
            )}

            {!supabase && (
              <InlineInfo
                iconName="cloud-offline-outline"
                tone="warning"
                title={t(lang, 'offline_mode')}
                message={t(lang, 'auth_offline_hint')}
                style={styles.feedbackBanner}
              />
            )}

            <Surface elevated style={styles.authCard}>
              <Text style={styles.authCardTitle}>{t(lang, modeTitleKey[mode])}</Text>
              <Text style={styles.authCardSubtitle}>{t(lang, modeDescriptionKey[mode])}</Text>
              <View style={styles.authForm}>
                <AppInput
                  placeholder={t(lang, 'email_placeholder')}
                  value={email}
                  onChangeText={(value) => {
                    setEmail(value)
                  }}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
                {(mode === 'signIn' || mode === 'signUp') && (
                  <AppInput
                    placeholder={t(lang, 'password_placeholder')}
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                  />
                )}
                {mode === 'signUp' && (
                  <AppInput
                    placeholder={t(lang, 'confirm_password_placeholder')}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    secureTextEntry
                  />
                )}
              </View>

              {mode === 'signIn' && continueAsLabel && (
                <Pressable onPress={() => setEmail(lastEmail || '')} hitSlop={8} style={styles.authHintPressable}>
                  <Text style={styles.authHintText}>{continueAsLabel}</Text>
                </Pressable>
              )}

              <AppButton
                label={t(lang, primaryActionKey[mode])}
                onPress={primaryActionHandler}
                loading={busy}
                disabled={primaryBusy}
                style={styles.authPrimaryButton}
              />

              {mode === 'signIn' && (googleEnabled || appleEnabled) && (
                <>
                  <Divider style={styles.authDivider} />
                  <View style={styles.socialStack}>
                    {googleEnabled && (
                      <AppButton
                        label={t(lang, 'google_sign_in')}
                        variant="secondary"
                        iconName="logo-google"
                        onPress={handleGoogleSignIn}
                        loading={socialBusy === 'google'}
                        disabled={socialBusy !== 'none' || busy}
                      />
                    )}
                    {appleEnabled && (
                      <AppButton
                        label={t(lang, 'apple_sign_in')}
                        variant="secondary"
                        iconName="logo-apple"
                        onPress={handleAppleSignIn}
                        loading={socialBusy === 'apple'}
                        disabled={socialBusy !== 'none' || busy}
                      />
                    )}
                  </View>
                </>
              )}

              <View style={styles.authLinks}>
                {mode === 'signIn' ? (
                  <>
                    <Pressable onPress={() => setModeWithReset('forgotPassword')} hitSlop={8}>
                      <Text style={styles.authLink}>{t(lang, 'forgot_password')}</Text>
                    </Pressable>
                    <Pressable onPress={() => setModeWithReset('resendConfirmation')} hitSlop={8}>
                      <Text style={styles.authLink}>{t(lang, 'resend_confirmation')}</Text>
                    </Pressable>
                    <Pressable onPress={() => setModeWithReset('signUp')} hitSlop={8}>
                      <Text style={styles.authLink}>{t(lang, 'create_account_prompt')}</Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable onPress={() => setModeWithReset('signIn')} hitSlop={8}>
                    <Text style={styles.authLink}>{t(lang, 'back_to_sign_in')}</Text>
                  </Pressable>
                )}
              </View>
            </Surface>

            {!supabase && (
              <AppButton
                label={t(lang, 'continue_without_login')}
                variant="outline"
                iconName="play-outline"
                onPress={() => onLoggedIn('demo')}
              />
            )}

            <Surface elevated style={styles.languageCard}>
              <Text style={styles.languageTitle}>{t(lang, 'language')}</Text>
              <View style={styles.languageGrid}>
                {loginLanguageOptions.map((option) => {
                  const selected = lang === option.code
                  return (
                    <Pressable
                      key={option.code}
                      onPress={() => setLang(option.code)}
                      style={[styles.languageOption, selected && styles.languageOptionSelected]}
                      hitSlop={8}
                    >
                      <Text style={[styles.languageOptionLabel, selected && styles.languageOptionLabelSelected]}>{option.label}</Text>
                    </Pressable>
                  )
                })}
              </View>
            </Surface>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

function ScanBillScreen() {
  const navigation = useNavigation<any>()
  const route = useRoute<any>()
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const { lang } = useLang()
  const spacesCtx = useSpacesContext()
  const { snapshot: entitlements } = useEntitlements()
  const effectiveSpaceId = spaceId || space?.id || 'default'
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
  const [showDuePicker, setShowDuePicker] = useState(false)
  const [archiveOnly, setArchiveOnly] = useState(false)
  const [creditorName, setCreditorName] = useState('')
  const [iban, setIban] = useState('')
  const [reference, setReference] = useState('')
  const [purpose, setPurpose] = useState('')
  const [saving, setSaving] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrError, setOcrError] = useState<string | null>(null)
  const [pendingAttachment, setPendingAttachment] = useState<{ uri: string; name: string; type?: string } | null>(null)
  const [inboxSourceId, setInboxSourceId] = useState<string | null>(null)
  const [cameraVisible, setCameraVisible] = useState(true)

  const hasBillData = Boolean(
    useDataActive ||
    supplier ||
    amountStr ||
    dueDate ||
    creditorName ||
    iban ||
    reference ||
    purpose ||
    pendingAttachment
  )

  const clearExtraction = useCallback(() => {
    setManual('')
    setRawText('')
    setParsed(null)
    setFormat('')
    setUseDataActive(false)
    setOcrError(null)
    setPendingAttachment(null)
    setSupplier('')
    setAmountStr('')
    setCurrency('EUR')
    setDueDate('')
    setArchiveOnly(false)
    setCreditorName('')
    setIban('')
    setReference('')
    setPurpose('')
    setInboxSourceId(null)
    setLastQR('')
    setCameraVisible(true)
    setTorch('on')
  }, [])
  useEffect(() => {
    const payload = route.params?.inboxPrefill
    if (payload && payload.fields) {
      const f = payload.fields as ExtractedFields
      setSupplier(f.creditor_name || f.supplier || supplier)
      setCreditorName(f.creditor_name || '')
      setIban(f.iban || '')
      setReference(f.reference || '')
      setPurpose(f.purpose || '')
      if (typeof f.amount === 'number') setAmountStr(String(f.amount))
      if (f.currency) setCurrency(f.currency)
      if (f.due_date) setDueDate(f.due_date)
      if (payload.attachmentPath) {
        setPendingAttachment({ uri: payload.attachmentPath, name: payload.attachmentPath.split('/').pop() || 'document', type: payload.mimeType || 'application/octet-stream' })
      }
      setUseDataActive(true)
      setCameraVisible(false)
      setTorch('off')
      if (payload.id) setInboxSourceId(payload.id)
      if (navigation?.setParams) navigation.setParams({ inboxPrefill: null })
    }
  }, [route, navigation])
  useEffect(() => { (async ()=>{ if (!permission?.granted) await requestPermission() })() }, [permission])
  async function pickImage() {
    if (!entitlements.canUseOCR) {
      showUpgradeAlert('ocr')
      return
    }
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

  async function pickPdfForOCR() {
    if (!entitlements.canUseOCR) {
      showUpgradeAlert('ocr')
      return
    }
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
    if (res.canceled) return
    const file = res.assets?.[0]
    if (!file?.uri) return
    setPendingAttachment({ uri: file.uri, name: file.name || 'document.pdf', type: 'application/pdf' })
    await extractWithOCR(file.uri)
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
    if (!t) { setFormat('Unknown'); setParsed(null); Alert.alert(t(lang, 'qr_no_text_decoded_title')); return }
    const epc = parseEPC(t)
    const upn = !epc ? parseUPN(t) : null
    const p = epc || upn
    if (!p) { setFormat('Unknown'); setParsed(null); Alert.alert(t(lang, 'qr_unsupported_format_title')); return }
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
    setCameraVisible(false)
    setTorch('off')
  }

  async function extractWithOCR(uri: string) {
    if (!entitlements.canUseOCR) {
      showUpgradeAlert('ocr')
      return
    }
    try {
      setOcrError(null)
      setOcrBusy(true)
      const { fields: f, summary } = await performOCR(uri)
      setSupplier(f.creditor_name || f.supplier || supplier)
      setCreditorName(f.creditor_name || '')
      setIban(f.iban || '')
      setReference(f.reference || '')
      setPurpose(f.purpose || '')
      if (typeof f.amount === 'number') setAmountStr(String(f.amount))
      if (f.currency) setCurrency(f.currency)
      if (f.due_date) setDueDate(f.due_date)
      setUseDataActive(true)
      setCameraVisible(false)
      setTorch('off')
      Alert.alert(t(lang, 'ocr_extracted_title'), `${summary}\n\n${t(lang, 'ocr_selected_image_attached_on_save_message')}`)
    } catch (e: any) {
      const msg = e?.message || 'OCR failed'
      setOcrError(msg)
      if (/quota/i.test(msg) || /ocr_quota_exceeded/i.test(msg)) {
        showUpgradeAlert('ocr')
      }
    } finally {
      setOcrBusy(false)
    }
  }
  const handleManualExtract = () => {
    if (!manual.trim()) {
      Alert.alert(t(lang, 'missing_data_title'), t(lang, 'missing_data_paste_qr_text_message'))
      return
    }
    handleDecodedText(manual)
  }

  function getDueDateValue() {
    if (!dueDate) return new Date()
    const parts = String(dueDate).split('-')
    if (parts.length !== 3) return new Date()
    const [y, m, d] = parts.map((part) => Number(part))
    if ([y, m, d].some((part) => Number.isNaN(part))) return new Date()
    return new Date(y, m - 1, d)
  }

  function handleDuePickerChange(_event: any, selectedDate?: Date) {
    if (!selectedDate) {
      if (!isIOS) setShowDuePicker(false)
      return
    }
    const y = selectedDate.getFullYear()
    const m = String(selectedDate.getMonth() + 1).padStart(2, '0')
    const d = String(selectedDate.getDate()).padStart(2, '0')
    setDueDate(`${y}-${m}-${d}`)
    if (!isIOS) setShowDuePicker(false)
  }

  const handleSaveBill = async () => {
    if (!supplier.trim()) {
      Alert.alert(t(lang, 'supplier_required_title'), t(lang, 'supplier_required_message'))
      return
    }
    if (!currency.trim()) {
      Alert.alert(t(lang, 'currency_required_title'), t(lang, 'currency_required_message'))
      return
    }
    const amt = Number(String(amountStr).replace(',', '.'))
    if (Number.isNaN(amt) || amt <= 0) {
      Alert.alert(t(lang, 'invalid_amount_title'), t(lang, 'invalid_amount_message'))
      return
    }

    const trimmedDue = dueDate.trim()
    const effectiveDueDate = trimmedDue || new Date().toISOString().slice(0, 10)

    if (!archiveOnly) {
      if (!creditorName.trim()) {
        Alert.alert(t(lang, 'creditor_required_title'), t(lang, 'creditor_required_message'))
        return
      }
      if (!iban.trim()) {
        Alert.alert(t(lang, 'iban_required_title'), t(lang, 'iban_required_message'))
        return
      }
      if (iban.trim().length < 10) {
        Alert.alert(t(lang, 'invalid_iban_title'), t(lang, 'invalid_iban_message'))
        return
      }
      if (!reference.trim()) {
        Alert.alert(t(lang, 'reference_required_title'), t(lang, 'reference_required_message'))
        return
      }
      if (!purpose.trim()) {
        Alert.alert(t(lang, 'purpose_required_title'), t(lang, 'purpose_required_message'))
        return
      }
      if (!trimmedDue) {
        Alert.alert(t(lang, 'due_date_required_title'), t(lang, 'due_date_required_message'))
        return
      }
      if (!pendingAttachment?.uri) {
        Alert.alert(t(lang, 'attachment_required_title'), t(lang, 'attachment_required_message'))
        return
      }
    }
    try {
      setSaving(true)
      const s = getSupabase()
      if (entitlements.plan === 'free') {
        try {
          let currentCount = 0
          if (s) {
            const { data } = await s.from('bills').select('id')
            currentCount = Array.isArray(data) ? data.length : 0
          } else {
            const locals = await loadLocalBills(spaceId)
            currentCount = Array.isArray(locals) ? locals.length : 0
          }
          if (currentCount >= 15) {
            showUpgradeAlert('bills_limit')
            setSaving(false)
            return
          }
        } catch {}
      }
      let savedId: string | null = null
      if (s) {
        const { data, error } = await createBill(s, {
          supplier: supplier.trim(),
          amount: amt,
          currency: currency.trim() || 'EUR',
          due_date: effectiveDueDate,
          status: archiveOnly ? 'archived' : 'unpaid',
          creditor_name: (creditorName.trim() || supplier.trim()) || null,
          iban: iban.trim() || null,
          reference: reference.trim() || null,
          purpose: purpose.trim() || null,
          space_id: spaceId,
        })
        if (error) {
          Alert.alert(t(lang, 'save_failed_title'), error.message)
          setSaving(false)
          return
        }
        savedId = data?.id || null
      } else {
        const local = await addLocalBill(spaceId, {
          supplier: supplier.trim(),
          amount: amt,
          currency: currency.trim() || 'EUR',
          due_date: effectiveDueDate,
          status: archiveOnly ? 'archived' : 'unpaid',
          creditor_name: (creditorName.trim() || supplier.trim()) || null,
          iban: iban.trim() || null,
          reference: reference.trim() || null,
          purpose: purpose.trim() || null,
        })
        savedId = local.id
      }

      if (savedId && pendingAttachment?.uri) {
        const up = await uploadAttachmentFromUri(spaceId, 'bills', savedId, pendingAttachment.uri, pendingAttachment.name || 'attachment', pendingAttachment.type)
        if (up.error) Alert.alert(t(lang, 'attachment_upload_failed_title'), up.error)
      }

      if (inboxSourceId) {
        await updateInboxItem(spaceId, inboxSourceId, { status: 'processed' })
        setInboxSourceId(null)
      }

      Alert.alert(
        t(lang, 'bill_saved_title'),
        archiveOnly
          ? t(lang, 'bill_saved_archived_message')
          : (s ? t(lang, 'bill_created_successfully_message') : t(lang, 'bill_saved_locally_not_synced_message')),
      )
      clearExtraction()
      try { (navigation as any)?.navigate?.('Bills', { highlightBillId: savedId }) } catch {}
    } catch (e: any) {
      Alert.alert(t(lang, 'save_error_title'), e?.message || t(lang, 'unable_to_save_bill'))
    } finally {
      setSaving(false)
    }
  }

  if (spaceLoading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{t(lang, 'loading_spaces')}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen title={t(lang, 'scan_title')}>
      <View style={styles.pageStack}>
        {spacesCtx.spaces.length > 1 ? (
          <Surface elevated>
            <SectionHeader title={t(lang, 'payer_title')} />
            <SegmentedControl
              value={spacesCtx.current?.id || spaceId || ''}
              onChange={(id) => { spacesCtx.setCurrent(id) }}
              options={spacesCtx.spaces.map((s) => ({ value: s.id, label: s.name }))}
              style={{ marginTop: themeSpacing.xs }}
            />
            <Text style={[styles.mutedText, { marginTop: themeSpacing.xs }]}>{t(lang, 'scan_active_payer_hint')}</Text>
          </Surface>
        ) : null}

        <Text style={[styles.mutedText, { marginBottom: themeSpacing.xs }]}>{t(lang, 'scan_intro_message')}</Text>

        {!permission?.granted ? (
          <Surface elevated>
            <SectionHeader title={t(lang, 'capture_bill_title')} />
            <Text style={styles.bodyText}>{t(lang, 'capture_bill_help_message')}</Text>
            <View style={styles.actionRow}>
              <AppButton label={t(lang, 'enable_camera_action')} iconName="camera-outline" onPress={requestPermission} />
              <AppButton label={ocrBusy ? t(lang, 'extracting_ellipsis') : t(lang, 'import_photo_action')} variant="secondary" iconName="image-outline" onPress={pickImage} loading={ocrBusy} />
              <AppButton label={ocrBusy ? t(lang, 'extracting_ellipsis') : t(lang, 'import_pdf_action')} variant="secondary" iconName="document-text-outline" onPress={pickPdfForOCR} loading={ocrBusy} />
            </View>
          </Surface>
        ) : (
          <Surface elevated style={[styles.cameraCard, styles.captureCard]}>
            {cameraVisible ? (
              <>
                <View style={styles.cameraFrame}>
                  <CameraView
                    style={styles.cameraPreview}
                    facing="back"
                    enableTorch={coerceBool(torch === 'on')}
                    onBarcodeScanned={(evt) => {
                      const text = (evt?.data ?? '').toString()
                      if (!text || text === lastQR) return
                      setLastQR(text)
                      handleDecodedText(text)
                    }}
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  />
                  <View pointerEvents="none" style={styles.cameraOverlay}>
                    <View style={styles.cameraFocusBox} />
                  </View>
                </View>
                <View style={styles.cameraActions}>
                  <AppButton
                    label={torch === 'on' ? t(lang, 'torch_off_action') : t(lang, 'torch_on_action')}
                    variant="ghost"
                    iconName={torch === 'on' ? 'flash-off-outline' : 'flash-outline'}
                    onPress={() => setTorch((prev) => (prev === 'on' ? 'off' : 'on'))}
                  />
                  <AppButton
                    label={ocrBusy ? 'Extracting…' : 'Import photo'}
                    variant="secondary"
                    iconName="image-outline"
                    onPress={pickImage}
                    loading={ocrBusy}
                  />
                  <AppButton
                    label={ocrBusy ? 'Extracting…' : 'Import PDF'}
                    variant="secondary"
                    iconName="document-text-outline"
                    onPress={pickPdfForOCR}
                    loading={ocrBusy}
                  />
                </View>
                <Text style={styles.helperText}>{t(lang, 'camera_qr_helper_text')}</Text>
              </>
            ) : (
              <View style={styles.capturePlaceholder}>
                <Ionicons name="scan-outline" size={36} color={themeColors.primary} />
                <Text style={styles.captureMessage}>{t(lang, 'qr_details_captured_message')}</Text>
                <View style={styles.captureActions}>
                  <AppButton
                    label={t(lang, 'scan_again_action')}
                    variant="secondary"
                    iconName="scan-outline"
                    onPress={() => {
                      setCameraVisible(true)
                      setLastQR('')
                        setTorch('on')
                    }}
                  />
                  <AppButton
                    label={ocrBusy ? t(lang, 'extracting_ellipsis') : t(lang, 'import_photo_action')}
                    variant="secondary"
                    iconName="image-outline"
                    onPress={pickImage}
                    loading={ocrBusy}
                  />
                  <AppButton
                    label={ocrBusy ? t(lang, 'extracting_ellipsis') : t(lang, 'import_pdf_action')}
                    variant="secondary"
                    iconName="document-text-outline"
                    onPress={pickPdfForOCR}
                    loading={ocrBusy}
                  />
                </View>
              </View>
            )}
          </Surface>
        )}

        {ocrError && (
          <InlineInfo iconName="alert-circle-outline" tone="danger" message={ocrError} />
        )}

        <Surface elevated>
          <SectionHeader title={t(lang, 'bill_data_sources_title')} actionLabel={t(lang, 'clear_action')} onActionPress={clearExtraction} />
          <Text style={styles.bodyText}>{t(lang, 'bill_data_sources_help_message')}</Text>
          <Disclosure title={t(lang, 'paste_qr_text_advanced_title')}>
            <AppInput
              placeholder={t(lang, 'paste_qr_text_placeholder')}
              value={manual}
              onChangeText={setManual}
              multiline
              hint={t(lang, 'qr_formats_hint')}
            />
            <View style={styles.actionRow}>
              <AppButton label={t(lang, 'extract_fields_action')} iconName="sparkles-outline" onPress={handleManualExtract} />
              <Badge label={format ? tf(lang, 'detected_format_label', { format }) : t(lang, 'awaiting_data_label')} tone={format ? 'info' : 'neutral'} />
            </View>
          </Disclosure>
          <Disclosure title={t(lang, 'show_raw_details_title')}>
            <Text style={styles.codeBlock}>{rawText || t(lang, 'no_qr_data_captured_yet')}</Text>
          </Disclosure>
        </Surface>

        <Surface elevated style={styles.formCard}>
          <SectionHeader title={t(lang, 'bill_draft_title')} actionLabel={t(lang, 'clear_action')} onActionPress={clearExtraction} />
          <Text style={styles.formIntro}>{t(lang, 'bill_draft_intro')}</Text>
          {!hasBillData && (
            <InlineInfo
              tone="info"
              iconName="scan-outline"
              message={t(lang, 'bill_draft_empty_hint')}
              style={styles.formNotice}
            />
          )}

          <View style={styles.formSection}>
            <Text style={styles.formSectionTitle}>{t(lang, 'summary_section_title')}</Text>
            <View style={styles.formStack}>
              <AppInput placeholder={t(lang, 'supplier_placeholder')} value={supplier} onChangeText={setSupplier} />
              <View style={styles.formRow}>
                <AppInput placeholder={t(lang, 'amount_placeholder')} value={amountStr} onChangeText={setAmountStr} keyboardType="numeric" style={styles.flex1} />
                <AppInput placeholder={t(lang, 'currency_placeholder')} value={currency} onChangeText={setCurrency} style={styles.currencyInput} />
              </View>

              <View style={styles.filterToggle}>
                <Switch value={archiveOnly} onValueChange={setArchiveOnly} />
                <Text style={styles.toggleLabel}>{t(lang, 'archive_already_paid_label')}</Text>
              </View>
              {archiveOnly && (
                <InlineInfo
                  tone="info"
                  iconName="archive-outline"
                  message={t(lang, 'archive_info_message')}
                  style={styles.formNotice}
                />
              )}

              <View style={{ gap: themeSpacing.xs }}>
                <Text style={styles.formSectionTitle}>{t(lang, 'dates_section_title')}</Text>
                <View style={styles.formRow}>
                  <AppInput
                    placeholder={t(lang, 'due_date_placeholder')}
                    value={dueDate}
                    onChangeText={setDueDate}
                    hint={t(lang, 'due_date_hint')}
                    style={styles.flex1}
                  />
                  <AppButton
                    label={dueDate ? t(lang, 'change_date_action') : t(lang, 'pick_date_action')}
                    variant="secondary"
                    iconName="calendar-outline"
                    onPress={() => setShowDuePicker(true)}
                  />
                </View>
                {showDuePicker && (
                  <View style={styles.datePickerContainer}>
                    <DateTimePicker
                      value={getDueDateValue()}
                      mode="date"
                      display={isIOS ? 'spinner' : 'calendar'}
                      onChange={handleDuePickerChange}
                    />
                    {isIOS && (
                      <View style={styles.datePickerActions}>
                        <AppButton label={t(lang, 'done_action')} variant="primary" onPress={() => setShowDuePicker(false)} />
                      </View>
                    )}
                  </View>
                )}
              </View>
            </View>
          </View>

          <Divider style={styles.formDivider} />

          <View style={styles.formSection}>
            <Text style={styles.formSectionTitle}>{t(lang, 'payment_details_section_title')}</Text>
            <View style={styles.formStack}>
              <AppInput placeholder={t(lang, 'creditor_placeholder')} value={creditorName} onChangeText={setCreditorName} />
              <AppInput placeholder={t(lang, 'iban_placeholder')} value={iban} onChangeText={setIban} />
              <AppInput placeholder={t(lang, 'reference_placeholder')} value={reference} onChangeText={setReference} />
              <AppInput placeholder={t(lang, 'purpose_placeholder')} value={purpose} onChangeText={setPurpose} multiline />
            </View>
          </View>

          <Divider style={styles.formDivider} />

          <View style={styles.formSection}>
            <Text style={styles.formSectionTitle}>{t(lang, 'attachments_title')}</Text>
            {!pendingAttachment && (
              <InlineInfo tone="warning" iconName="alert-circle-outline" message={t(lang, 'attach_original_bill_warning')} style={styles.formNotice} />
            )}
            <View style={styles.attachmentButtons}>
              <AppButton
                label={pendingAttachment?.type?.startsWith('image/') ? t(lang, 'replace_image_action') : t(lang, 'attach_image_action')}
                variant="secondary"
                iconName="image-outline"
                onPress={async () => {
                  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
                  if (res.canceled) return
                  const asset = res.assets?.[0]
                  if (!asset?.uri) return
                  setPendingAttachment({ uri: asset.uri, name: asset.fileName || 'photo.jpg', type: asset.type || 'image/jpeg' })
                }}
              />
              <AppButton
                label={pendingAttachment?.type === 'application/pdf' ? t(lang, 'replace_pdf_action') : t(lang, 'attach_pdf_action')}
                variant="secondary"
                iconName="document-attach-outline"
                onPress={async () => {
                  const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
                  if (res.canceled) return
                  const file = res.assets?.[0]
                  if (!file?.uri) return
                  setPendingAttachment({ uri: file.uri, name: file.name || 'document.pdf', type: 'application/pdf' })
                }}
              />
            </View>
            {pendingAttachment && (
              <View style={styles.attachmentPreview}>
                <Text style={styles.bodyText}>{tf(lang, 'staged_attachment_label', { name: pendingAttachment.name })}</Text>
                {pendingAttachment.type?.startsWith('image/') && (
                  <Image source={{ uri: pendingAttachment.uri }} style={styles.attachmentImage} />
                )}
                <AppButton label={t(lang, 'remove_attachment_action')} variant="ghost" iconName="close-circle-outline" onPress={() => setPendingAttachment(null)} />
              </View>
            )}
          </View>

          <AppButton
            label={saving ? t(lang, 'saving_bill_ellipsis') : t(lang, 'save_bill_action')}
            iconName="save-outline"
            onPress={handleSaveBill}
            loading={saving}
            style={styles.saveButton}
          />
        </Surface>
      </View>
    </Screen>
  )
}

function InboxScreen() {
  const navigation = useNavigation<any>()
  const route = useRoute<any>()
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const { lang } = useLang()
  const { snapshot: entitlements } = useEntitlements()
  const [items, setItems] = useState<InboxItem[]>([])
  const [filter, setFilter] = useState<'pending' | 'archived' | 'all'>('pending')
  const [busy, setBusy] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (spaceLoading || !space) return
    const list = await listInbox(spaceId)
    setItems(list)
  }, [spaceLoading, space, spaceId])

  useFocusEffect(useCallback(() => {
    refresh()
  }, [refresh]))

  useEffect(() => {
    if (route.params?.highlight) {
      setHighlightId(route.params.highlight)
      navigation.setParams?.({ highlight: null })
    }
  }, [route, navigation])

  const filtered = useMemo(() => {
    if (filter === 'all') return items
    return items.filter((item) => item.status === (filter === 'pending' ? 'pending' : 'archived'))
  }, [items, filter])

  async function importFromDevice() {
    try {
      setImporting(true)
      const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true })
      if (res.canceled) return
      const file = res.assets?.[0]
      if (!file?.uri) return
      await addToInbox({ spaceId, uri: file.uri, name: file.name || 'document', mimeType: file.mimeType || undefined })
      await refresh()
      Alert.alert(t(lang, 'inbox_title'), t(lang, 'inbox_document_added_message'))
    } catch (e: any) {
      Alert.alert(t(lang, 'import_failed_title'), e?.message || t(lang, 'unable_to_import_document'))
    } finally {
      setImporting(false)
    }
  }

  async function runOcr(item: InboxItem) {
    if (!entitlements.canUseOCR) {
      showUpgradeAlert('ocr')
      return
    }
    try {
      setBusy(item.id)
      const { fields, summary } = await performOCR(item.localPath)
      await updateInboxItem(spaceId, item.id, { extractedFields: fields, notes: summary, status: 'pending' })
      await refresh()
      Alert.alert(t(lang, 'ocr_completed_title'), summary)
    } catch (e: any) {
      Alert.alert(t(lang, 'ocr_failed_title'), e?.message || t(lang, 'unable_to_process_document'))
    } finally {
      setBusy(null)
    }
  }

  async function openItem(item: InboxItem) {
    try {
      await Linking.openURL(item.localPath)
    } catch {
      Alert.alert(t(lang, 'open_failed_title'), t(lang, 'unable_to_open_file_export_hint'))
    }
  }

  async function attachToBill(item: InboxItem) {
    if (!item.extractedFields) {
      Alert.alert(t(lang, 'run_ocr_first_title'), t(lang, 'scan_document_to_prefill_bill_message'))
      return
    }
    navigation.navigate('Scan', {
      inboxPrefill: {
        id: item.id,
        fields: item.extractedFields,
        attachmentPath: item.localPath,
        mimeType: item.mimeType,
      },
    })
  }

  async function archiveItem(item: InboxItem) {
    await updateInboxItem(spaceId, item.id, { status: 'archived' })
    await refresh()
  }

  async function removeItem(item: InboxItem) {
    Alert.alert(t(lang, 'delete_inbox_item_title'), t(lang, 'delete_inbox_item_message'), [
      { text: t(lang, 'common_cancel'), style: 'cancel' },
      { text: t(lang, 'delete_action'), style: 'destructive', onPress: async () => { await removeInboxItem(spaceId, item.id); await refresh() } },
    ])
  }

  if (spaceLoading || !space) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2b6cb0" />
        <Text style={{ marginTop: 8 }}>{t(lang, 'loading_space')}</Text>
      </View>
    )
  }

  return (
    <Screen title={t(lang, 'inbox_title')} scroll={false}>
      <View style={styles.pageStack}>
        <Surface elevated>
          <SectionHeader title={t(lang, 'inbox_import_section_title')} />
          <Text style={styles.bodyText}>{t(lang, 'inbox_import_help_message')}</Text>
          <View style={styles.inboxControlsRow}>
            <AppButton
              label={importing ? t(lang, 'importing_ellipsis') : t(lang, 'import_from_device_action')}
              iconName="add-outline"
              onPress={importFromDevice}
              loading={importing}
              disabled={importing}
            />
            <SegmentedControl
              value={filter}
              onChange={(v) => setFilter(v as any)}
              options={[
                { value: 'pending', label: t(lang, 'filter_pending') },
                { value: 'archived', label: t(lang, 'filter_archived') },
                { value: 'all', label: t(lang, 'filter_all') },
              ]}
              style={{ flex: 1 }}
            />
          </View>
        </Surface>

        <View style={styles.listWrapper}>
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text>{t(lang, 'inbox_empty_message')}</Text>}
            renderItem={({ item }) => (
              <Surface elevated style={[styles.card, highlightId === item.id ? styles.inboxItemHighlighted : null]}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                <Text>{item.mimeType} • {new Date(item.created_at).toLocaleString()}</Text>
                <Text>{t(lang, 'status_label')} {item.status === 'archived' ? t(lang, 'status_archived') : t(lang, 'status_pending')}</Text>
                {item.extractedFields && (
                  <View style={{ marginTop: 6 }}>
                    <Text style={{ fontWeight: '600' }}>{t(lang, 'extracted_label')}</Text>
                    {item.notes ? <Text>{item.notes}</Text> : null}
                  </View>
                )}
                <View style={styles.inboxActionsRow}>
                  <AppButton label={t(lang, 'open_action')} variant="secondary" iconName="open-outline" onPress={()=>openItem(item)} />
                  <AppButton label={busy===item.id ? t(lang, 'processing_ellipsis') : t(lang, 'run_ocr_action')} variant="secondary" iconName="sparkles-outline" onPress={()=>runOcr(item)} loading={busy===item.id} disabled={busy===item.id} />
                  <AppButton label={t(lang, 'attach_to_bill_action')} variant="secondary" iconName="link-outline" onPress={()=>attachToBill(item)} />
                  <AppButton label={t(lang, 'archive_action')} variant="ghost" iconName="archive-outline" onPress={()=>archiveItem(item)} />
                  <AppButton label={t(lang, 'delete_action')} variant="danger" iconName="trash-outline" onPress={()=>removeItem(item)} />
                </View>
              </Surface>
            )}
          />
        </View>
      </View>
    </Screen>
  )
}

function BillsListScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const navigation = useNavigation<any>()
  const route = useRoute<any>()
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const { lang } = useLang()
  const insets = useSafeAreaInsets()
  const hasLoadedRef = useRef(false)

  const [bills, setBills] = useState<Bill[]>([])
  const [loadingBills, setLoadingBills] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [filtersExpanded, setFiltersExpanded] = useState(true)
  const [supplierQuery, setSupplierQuery] = useState('')
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')
  const [dateMode, setDateMode] = useState<'due' | 'invoice' | 'created'>('due')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'unpaid' | 'archived'>('all')
  const [unpaidOnly, setUnpaidOnly] = useState(false)
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [hasAttachmentsOnly, setHasAttachmentsOnly] = useState(false)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})

  const [iosPickerVisible, setIosPickerVisible] = useState(false)
  const [iosPickerField, setIosPickerField] = useState<'from' | 'to' | null>(null)
  const [iosPickerValue, setIosPickerValue] = useState(new Date())

  const dateFieldLabels: Record<typeof dateMode, string> = {
    due: t(lang, 'date_field_due'),
    invoice: t(lang, 'date_field_invoice'),
    created: t(lang, 'date_field_created'),
  }

  const formatDateInput = useCallback((value: Date) => {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }, [])

  const parseDateValue = useCallback((value?: string | null): Date | null => {
    if (!value) return null
    if (value.includes('T')) {
      const parsed = new Date(value)
      if (Number.isNaN(parsed.getTime())) return null
      return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
    }
    const parts = value.split('-')
    if (parts.length !== 3) return null
    const [y, m, d] = parts.map((part) => Number(part))
    if ([y, m, d].some((part) => Number.isNaN(part))) return null
    return new Date(y, m - 1, d)
  }, [])

  const getBillDate = useCallback((bill: Bill, mode: typeof dateMode): string => {
    if (mode === 'invoice') return (bill as any).invoice_date || bill.created_at
    if (mode === 'created') return bill.created_at
    return bill.due_date
  }, [])

  const formatDisplayDate = useCallback((value?: string | null) => {
    const parsed = parseDateValue(value)
    return parsed ? parsed.toLocaleDateString() : '—'
  }, [parseDateValue])

  const today = useMemo(() => {
    const base = new Date()
    return new Date(base.getFullYear(), base.getMonth(), base.getDate())
  }, [])

  const loadBills = useCallback(async (silent = false) => {
    if (spaceLoading || !space) return
    silent ? setRefreshing(true) : setLoadingBills(true)
    try {
      if (supabase) {
        const { data, error } = await listBills(supabase, spaceId)
        if (error) throw error
        setBills(data || [])
      } else {
        const locals = await loadLocalBills(spaceId)
        setBills((locals as any) || [])
      }
    } catch (e: any) {
      Alert.alert(t(lang, 'bills_title'), e?.message || t(lang, 'unable_to_load_bills'))
    } finally {
      hasLoadedRef.current = true
      silent ? setRefreshing(false) : setLoadingBills(false)
    }
  }, [lang, spaceLoading, space, supabase, spaceId])

  useFocusEffect(
    useCallback(() => {
      loadBills(hasLoadedRef.current)
      return () => {}
    }, [loadBills])
  )

  useEffect(() => {
    const id = (route as any)?.params?.highlightBillId
    if (typeof id === 'string') {
      setHighlightId(id)
      navigation.setParams?.({ highlightBillId: null })
    }
  }, [route, navigation])

  useEffect(() => {
    if (!highlightId) return
    const timeout = setTimeout(() => setHighlightId(null), 3000)
    return () => clearTimeout(timeout)
  }, [highlightId])

  useEffect(() => {
    if (!spaceId) {
      setAttachmentCounts({})
      return
    }
    let cancelled = false
    async function resolveCounts() {
      if (bills.length === 0) {
        if (!cancelled) setAttachmentCounts({})
        return
      }
      const entries = await Promise.all(
        bills.map(async (bill) => {
          try {
            const list = supabase
              ? await listRemoteAttachments(supabase, 'bills', bill.id, spaceId)
              : await listLocalAttachments(spaceId, 'bills', bill.id)
            return [bill.id, list.length] as const
          } catch {
            return [bill.id, 0] as const
          }
        })
      )
      if (!cancelled) {
        const next: Record<string, number> = {}
        for (const [id, count] of entries) next[id] = count
        setAttachmentCounts(next)
      }
    }
    resolveCounts()
    return () => {
      cancelled = true
    }
  }, [bills, supabase, spaceId])

  const resetFilters = useCallback(() => {
    setSupplierQuery('')
    setAmountMin('')
    setAmountMax('')
    setDateFrom('')
    setDateTo('')
    setStatusFilter('all')
    setUnpaidOnly(false)
    setOverdueOnly(false)
    setHasAttachmentsOnly(false)
    setIncludeArchived(false)
    setDateMode('due')
  }, [])

  const handleStatusChange = useCallback((value: string) => {
    const next = (value as 'all' | 'paid' | 'unpaid' | 'archived') || 'all'
    setStatusFilter(next)
    setUnpaidOnly(next === 'unpaid')
    if (next === 'archived') setIncludeArchived(true)
  }, [])

  const handleUnpaidToggle = useCallback((value: boolean) => {
    setUnpaidOnly(value)
    setStatusFilter(value ? 'unpaid' : 'all')
  }, [])

  const openDatePicker = useCallback((field: 'from' | 'to') => {
    const current = parseDateValue(field === 'from' ? dateFrom : dateTo) || new Date()
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        mode: 'date',
        value: current,
        onChange: (_event, selectedDate) => {
          if (!selectedDate) return
          const iso = formatDateInput(selectedDate)
          if (field === 'from') setDateFrom(iso)
          else setDateTo(iso)
        },
      })
    } else {
      setIosPickerField(field)
      setIosPickerValue(current)
      setIosPickerVisible(true)
    }
  }, [dateFrom, dateTo, formatDateInput, parseDateValue])

  const confirmIosPicker = useCallback(() => {
    if (!iosPickerField) {
      setIosPickerVisible(false)
      return
    }
    const iso = formatDateInput(iosPickerValue)
    if (iosPickerField === 'from') setDateFrom(iso)
    else setDateTo(iso)
    setIosPickerField(null)
    setIosPickerVisible(false)
  }, [formatDateInput, iosPickerField, iosPickerValue])

  const cancelIosPicker = useCallback(() => {
    setIosPickerField(null)
    setIosPickerVisible(false)
  }, [])

  const filteredBills = useMemo(() => {
    const supplierTerm = supplierQuery.trim().toLowerCase()
    const minVal = amountMin ? Number(String(amountMin).replace(',', '.')) : null
    const maxVal = amountMax ? Number(String(amountMax).replace(',', '.')) : null
    const fromDate = parseDateValue(dateFrom)
    const toDate = parseDateValue(dateTo)
    const msDay = 24 * 60 * 60 * 1000

    const list = bills.filter((bill) => {
      if (!includeArchived && bill.status === 'archived') return false
      if (supplierTerm && !bill.supplier.toLowerCase().includes(supplierTerm)) return false

      if (minVal !== null && !Number.isNaN(minVal) && bill.amount < minVal) return false
      if (maxVal !== null && !Number.isNaN(maxVal) && bill.amount > maxVal) return false

      if (statusFilter === 'paid' && bill.status !== 'paid') return false
      if (statusFilter === 'unpaid' && bill.status !== 'unpaid') return false
      if (statusFilter === 'archived' && bill.status !== 'archived') return false
      if (unpaidOnly && bill.status !== 'unpaid') return false

      const dueDate = parseDateValue(bill.due_date)
      const isOverdue = dueDate ? bill.status === 'unpaid' && dueDate.getTime() < today.getTime() : false
      if (overdueOnly && !isOverdue) return false

      if (hasAttachmentsOnly && (attachmentCounts[bill.id] || 0) === 0) return false

      const trackedDate = parseDateValue(getBillDate(bill, dateMode))
      if (fromDate && (!trackedDate || trackedDate.getTime() < fromDate.getTime())) return false
      if (toDate && (!trackedDate || trackedDate.getTime() > toDate.getTime())) return false

      return true
    })

    return list.sort((a, b) => {
      const aDate = parseDateValue(getBillDate(a, dateMode))
      const bDate = parseDateValue(getBillDate(b, dateMode))
      const aTime = aDate ? aDate.getTime() : 0
      const bTime = bDate ? bDate.getTime() : 0
      if (aTime === bTime) return a.supplier.localeCompare(b.supplier)
      return aTime - bTime
    })
  }, [amountMax, amountMin, attachmentCounts, bills, dateFrom, dateMode, dateTo, getBillDate, hasAttachmentsOnly, overdueOnly, parseDateValue, statusFilter, supplierQuery, today, unpaidOnly])

  const totalCount = bills.length
  const resultsLabel = filteredBills.length === totalCount
    ? (totalCount === 1
      ? tf(lang, 'bills_count_single', { count: totalCount })
      : tf(lang, 'bills_count_plural', { count: totalCount || 0 }))
    : tf(lang, 'bills_count_filtered', { filtered: filteredBills.length, total: totalCount })

  const renderEmpty = useCallback(() => {
    if (loadingBills) return null
    return (
      <View style={styles.brandEmptyWrap}>
        <Image source={BRAND_WORDMARK} style={styles.wordmarkEmpty} resizeMode="contain" accessibilityLabel="BILLBOX" />
        <EmptyState
          iconName="document-text-outline"
          title={t(lang, 'no_bills_found_title')}
          description={t(lang, 'no_bills_found_description')}
          actionLabel={t(lang, 'add_bill_action')}
          onActionPress={() => navigation.navigate('Scan')}
        />
      </View>
    )
  }, [lang, loadingBills, navigation])

  const formatAmount = useCallback((value: number, currency?: string | null) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(value)
    } catch {
      return `${value.toFixed(2)} ${currency || 'EUR'}`
    }
  }, [])

  const relativeDueText = useCallback((due: Date | null) => {
    if (!due) return t(lang, 'relative_due_none')
    const diffDays = Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
    if (diffDays === 0) return t(lang, 'relative_due_today')
    if (diffDays > 0) return diffDays === 1
      ? tf(lang, 'relative_due_in_day', { count: diffDays })
      : tf(lang, 'relative_due_in_days', { count: diffDays })
    const overdue = Math.abs(diffDays)
    return overdue === 1
      ? tf(lang, 'relative_due_overdue_by_day', { count: overdue })
      : tf(lang, 'relative_due_overdue_by_days', { count: overdue })
  }, [lang, today])

  const renderBillItem = useCallback(({ item }: { item: Bill }) => {
    const dueDate = parseDateValue(item.due_date)
    const trackedDate = getBillDate(item, dateMode)
    const isOverdue = dueDate ? item.status === 'unpaid' && dueDate.getTime() < today.getTime() : false
    const statusLabel = item.status === 'archived'
      ? t(lang, 'status_archived')
      : isOverdue
        ? t(lang, 'status_overdue')
        : item.status === 'paid'
          ? t(lang, 'status_paid')
          : t(lang, 'status_unpaid')
    const statusTone: 'danger' | 'success' | 'info' = item.status === 'archived' ? 'info' : isOverdue ? 'danger' : item.status === 'paid' ? 'success' : 'info'
    const attachments = attachmentCounts[item.id] || 0

    return (
      <Surface
        elevated
        style={[styles.billCard, highlightId === item.id && styles.billHighlighted]}
      >
        <Pressable
          onPress={() => navigation.navigate('Bill Details', { bill: item })}
          style={({ pressed }) => [styles.billCardPressable, pressed && styles.billCardPressed]}
          hitSlop={8}
        >
          <View style={styles.billHeader}>
            <Text style={styles.billSupplier} numberOfLines={1}>
              {item.supplier || 'Untitled bill'}
            </Text>
            <Text style={styles.billAmount}>{formatAmount(item.amount, item.currency)}</Text>
          </View>

          <View style={styles.billMetaRow}>
            <View style={styles.billMetaGroup}>
              <Ionicons name="calendar-outline" size={16} color="#4B5563" />
              <Text style={styles.billMetaText}>{formatDisplayDate(item.due_date)}</Text>
            </View>
            <Badge label={statusLabel} tone={statusTone} />
          </View>

          <View style={styles.billMetaRow}>
            <View style={styles.billMetaGroup}>
              <Ionicons name="time-outline" size={16} color="#6B7280" />
              <Text style={styles.billMetaSecondary}>{relativeDueText(dueDate)}</Text>
            </View>
            {attachments > 0 && (
              <View style={styles.attachmentPill}>
                <Ionicons name="document-attach-outline" size={14} color={themeColors.primary} />
                <Text style={styles.attachmentText}>
                  {attachments} {attachments === 1 ? 'attachment' : 'attachments'}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.billMetaRow}>
            <View style={styles.billMetaGroup}>
              <Ionicons name="person-circle-outline" size={16} color="#6B7280" />
              <Text style={styles.billMetaSecondary}>{space?.name || 'Default space'}</Text>
            </View>
          </View>

          {dateMode !== 'due' && (
            <View style={styles.billMetaGroup}>
              <Ionicons name="calendar-clear-outline" size={16} color="#6B7280" />
              <Text style={styles.billMetaSecondary}>
                {dateMode === 'invoice' ? t(lang, 'invoice_date_label') : t(lang, 'created_label')}: {formatDisplayDate(trackedDate)}
              </Text>
            </View>
          )}
        </Pressable>
      </Surface>
    )
  }, [attachmentCounts, dateMode, formatAmount, formatDisplayDate, getBillDate, highlightId, lang, navigation, parseDateValue, relativeDueText, space, today])

  if (spaceLoading || !space) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={themeColors.primary} />
        <Text style={styles.mutedText}>{t(lang, 'loading_space')}</Text>
      </View>
    )
  }

  const listBottomPadding = Math.max(insets.bottom, 12) + themeSpacing.xl + 56

  return (
    <Screen title={t(lang, 'bills_title')} scroll={false}>
      <View style={styles.pageStack}>
        {!supabase && (
          <InlineInfo
            tone="warning"
            iconName="cloud-offline-outline"
            message={t(lang, 'cloud_sync_disabled_message')}
          />
        )}

        <Surface elevated padded={false} style={styles.filtersCard}>
          <Pressable style={styles.filtersHeader} onPress={() => setFiltersExpanded((prev) => !prev)} hitSlop={8}>
            <Text style={styles.sectionTitle}>{t(lang, 'filters_title')}</Text>
            <View style={styles.filtersHeaderRight}>
              <Text style={styles.filtersHeaderLabel}>{tf(lang, 'filtering_by_label', { field: dateFieldLabels[dateMode] })}</Text>
              <Badge label={dateFieldLabels[dateMode]} tone="info" />
              <Ionicons name={filtersExpanded ? 'chevron-up' : 'chevron-down'} size={18} color={themeColors.textMuted} />
            </View>
          </Pressable>

          {filtersExpanded && (
            <View style={styles.filtersBody}>
              <SegmentedControl
                value={dateMode}
                onChange={(value) => setDateMode(value as typeof dateMode)}
                options={[
                  { value: 'due', label: t(lang, 'date_mode_due_short') },
                  { value: 'invoice', label: t(lang, 'date_mode_invoice_short') },
                  { value: 'created', label: t(lang, 'date_mode_created_short') },
                ]}
              />

              <AppInput
                placeholder={t(lang, 'supplier_placeholder')}
                value={supplierQuery}
                onChangeText={setSupplierQuery}
              />

              <View style={styles.filterRow}>
                <AppInput
                  placeholder={t(lang, 'min_amount_placeholder')}
                  keyboardType="numeric"
                  value={amountMin}
                  onChangeText={setAmountMin}
                  style={styles.flex1}
                />
                <AppInput
                  placeholder={t(lang, 'max_amount_placeholder')}
                  keyboardType="numeric"
                  value={amountMax}
                  onChangeText={setAmountMax}
                  style={styles.flex1}
                />
              </View>

              <View style={styles.dateFilterSection}>
                <Text style={styles.filterLabel}>{t(lang, 'date_range_label')}</Text>
                <View style={styles.dateRow}>
                  <Pressable style={styles.dateButton} onPress={() => openDatePicker('from')} hitSlop={8}>
                    <Ionicons name="calendar-outline" size={16} color={themeColors.primary} />
                    <Text style={styles.dateButtonText}>{dateFrom || t(lang, 'start_date_label')}</Text>
                  </Pressable>
                  <Pressable style={styles.dateButton} onPress={() => openDatePicker('to')} hitSlop={8}>
                    <Ionicons name="calendar-outline" size={16} color={themeColors.primary} />
                    <Text style={styles.dateButtonText}>{dateTo || t(lang, 'end_date_label')}</Text>
                  </Pressable>
                </View>
                <View style={styles.manualDateRow}>
                  <AppInput
                    placeholder={t(lang, 'date_iso_placeholder')}
                    value={dateFrom}
                    onChangeText={setDateFrom}
                    style={styles.flex1}
                    hint={t(lang, 'manual_entry_optional_hint')}
                  />
                  <AppInput
                    placeholder={t(lang, 'date_iso_placeholder')}
                    value={dateTo}
                    onChangeText={setDateTo}
                    style={styles.flex1}
                  />
                </View>
              </View>

              <View style={styles.filterToggleRow}>
                <View style={styles.filterToggle}>
                  <Switch value={unpaidOnly} onValueChange={handleUnpaidToggle} />
                  <Text style={styles.toggleLabel}>{t(lang, 'unpaid_only_toggle')}</Text>
                </View>
                <View style={styles.filterToggle}>
                  <Switch value={overdueOnly} onValueChange={setOverdueOnly} />
                  <Text style={styles.toggleLabel}>{t(lang, 'overdue_toggle')}</Text>
                </View>
                <View style={styles.filterToggle}>
                  <Switch value={hasAttachmentsOnly} onValueChange={setHasAttachmentsOnly} />
                  <Text style={styles.toggleLabel}>{t(lang, 'has_attachment_toggle')}</Text>
                </View>
                <View style={styles.filterToggle}>
                  <Switch value={includeArchived} onValueChange={setIncludeArchived} />
                  <Text style={styles.toggleLabel}>{t(lang, 'include_archived_toggle')}</Text>
                </View>
              </View>

              <View style={styles.filtersFooter}>
                <AppButton
                  label={t(lang, 'clear_filters_action')}
                  variant="ghost"
                  iconName="refresh-outline"
                  onPress={resetFilters}
                />
              </View>
            </View>
          )}
        </Surface>

        <SegmentedControl
          value={statusFilter}
          onChange={handleStatusChange}
          options={[
            { value: 'all', label: t(lang, 'filter_all') },
            { value: 'unpaid', label: t(lang, 'filter_unpaid') },
            { value: 'paid', label: t(lang, 'filter_paid') },
            { value: 'archived', label: t(lang, 'filter_archived') },
          ]}
        />

        <View style={styles.billsPrimaryActionsRow}>
          <View style={styles.flex1} />
          <AppButton
            label={t(lang, 'add_bill_action')}
            iconName="add-outline"
            variant="secondary"
            onPress={() => navigation.navigate('Scan')}
          />
        </View>

        <View style={styles.listMetaRow}>
          <Text style={styles.listMetaText}>{resultsLabel}</Text>
          <Text style={styles.listMetaSecondary}>{t(lang, 'filters_tip_bills_list')}</Text>
        </View>

        <View style={styles.listWrapper}>
          {loadingBills && bills.length === 0 ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={themeColors.primary} />
              <Text style={styles.mutedText}>{t(lang, 'loading_bills')}</Text>
            </View>
          ) : (
            <FlatList
              data={filteredBills}
              keyExtractor={(item) => item.id}
              renderItem={renderBillItem}
              contentContainerStyle={[
                styles.listContent,
                { paddingBottom: listBottomPadding },
                filteredBills.length === 0 && styles.emptyListContent,
              ]}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadBills(true)} />}
              ListEmptyComponent={renderEmpty}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </View>

      {isIOS && iosPickerVisible && (
        <View style={styles.iosPickerOverlay}>
          <Surface elevated style={styles.iosPickerSheet}>
            <Text style={styles.filterLabel}>{t(lang, 'select_date_title')}</Text>
            <DateTimePicker
              mode="date"
              display="inline"
              value={iosPickerValue}
              onChange={(_, selected) => {
                if (selected) setIosPickerValue(selected)
              }}
            />
            <View style={styles.iosPickerActions}>
              <AppButton label={t(lang, 'cancel_action')} variant="ghost" onPress={cancelIosPicker} />
              <AppButton label={t(lang, 'use_date_action')} onPress={confirmIosPicker} />
            </View>
          </Surface>
        </View>
      )}
    </Screen>
  )
}

function HomeScreen() {
  const navigation = useNavigation<any>()
  const { space, spaceId, loading } = useActiveSpace()
  const { lang } = useLang()
  const spacesCtx = useSpacesContext()
  const { snapshot: entitlements } = useEntitlements()
  const [summary, setSummary] = useState<{ totalUnpaid: number; overdueCount: number; nextDueDate: string | null } | null>(null)

  const [payerNameDraft, setPayerNameDraft] = useState('')
  const [needsPayerName, setNeedsPayerName] = useState(false)
  const [creatingPayer2, setCreatingPayer2] = useState(false)
  const [payer2NameDraft, setPayer2NameDraft] = useState('')
  const [upgradeModalVisible, setUpgradeModalVisible] = useState(false)
  const [renameVisible, setRenameVisible] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')

  const payerOptions = useMemo(() => {
    const base = spacesCtx.spaces
      .filter((s) => isPayerSpaceId(s.id))
      .map((s) => ({ value: s.id, label: payerLabelFromSpaceId(s.id) }))
    if (base.length >= 2) return base
    const second = entitlements.plan === 'pro'
      ? { value: '__create_payer2__', label: t(lang, 'payer_2_label') }
      : { value: '__locked_payer2__', label: t(lang, 'payer_2_label') }
    return base.concat([second])
  }, [entitlements.plan, lang, spacesCtx.spaces])

  useEffect(() => {
    ;(async () => {
      if (loading) return
      if (!spaceId) return
      try {
        const key = 'billbox.onboarding.payer1Named'
        const raw = await AsyncStorage.getItem(key)
        const named = raw === '1'
        setNeedsPayerName(!named)
        if (!named) setPayerNameDraft('')
      } catch {}
    })()
  }, [loading, spaceId, spacesCtx.current])

  const savePayer1Name = useCallback(async () => {
    const trimmed = payerNameDraft.trim()
    if (!trimmed) {
      Alert.alert(t(lang, 'name_required_title'), t(lang, 'please_enter_name_for_payer_1_message'))
      return
    }
    await spacesCtx.rename('personal', trimmed)
    try {
      await AsyncStorage.setItem('billbox.onboarding.payer1Named', '1')
    } catch {}
    setNeedsPayerName(false)
  }, [lang, payerNameDraft, spacesCtx])

  const saveRename = useCallback(async () => {
    const target = spacesCtx.current
    if (!target) return
    const trimmed = renameDraft.trim()
    if (!trimmed) {
      Alert.alert(t(lang, 'name_required_title'), tf(lang, 'please_enter_name_for_payer_message', { payer: payerLabelFromSpaceId(target.id) }))
      return
    }
    await spacesCtx.rename(target.id, trimmed)
    if (target.id === 'personal') {
      try { await AsyncStorage.setItem('billbox.onboarding.payer1Named', '1') } catch {}
      setNeedsPayerName(false)
    }
    setRenameVisible(false)
  }, [lang, renameDraft, spacesCtx])

  const handlePayerChange = useCallback(async (id: string) => {
    if (id === '__locked_payer2__') {
      setUpgradeModalVisible(true)
      return
    }
    if (id === '__create_payer2__') {
      setCreatingPayer2(true)
      setPayer2NameDraft(t(lang, 'payer_2_label'))
      return
    }
    await spacesCtx.setCurrent(id)
  }, [lang, spacesCtx])

  const savePayer2 = useCallback(async () => {
    const trimmed = payer2NameDraft.trim()
    if (!trimmed) {
      Alert.alert(t(lang, 'name_required_title'), t(lang, 'please_enter_name_for_payer_2_message'))
      return
    }
    await spacesCtx.addSpace({
      name: trimmed,
      kind: 'personal',
      plan: spacesCtx.current?.plan || 'free',
    })
    setCreatingPayer2(false)
  }, [lang, payer2NameDraft, spacesCtx])

  const planSavings = useMemo(() => {
    const basicMonthly = 2.2
    const basicYearly = 20
    const proMonthly = 4
    const proYearly = 38
    return {
      basic: Math.max(0, Math.round((basicMonthly * 12 - basicYearly) * 100) / 100),
      pro: Math.max(0, Math.round((proMonthly * 12 - proYearly) * 100) / 100),
    }
  }, [])

  useEffect(() => {
    (async () => {
      if (loading || !spaceId) return
      try {
        const supabase = getSupabase()
        let bills: Bill[] = []
        if (supabase) {
          const { data, error } = await listBills(supabase, spaceId)
          if (error) throw error
          bills = data || []
        } else {
          const locals = await loadLocalBills(spaceId)
          bills = (locals as any) || []
        }

        const todayIso = new Date().toISOString().slice(0, 10)
        let totalUnpaid = 0
        let overdueCount = 0
        let nextDue: string | null = null

        for (const bill of bills) {
          if (bill.status !== 'unpaid') continue
          totalUnpaid += bill.amount || 0
          if (!bill.due_date) continue
          const due = bill.due_date
          if (due < todayIso) {
            overdueCount += 1
          } else {
            if (!nextDue || due < nextDue) nextDue = due
          }
        }

        setSummary({ totalUnpaid, overdueCount, nextDueDate: nextDue })
      } catch (e) {
        console.warn('Home summary load failed', e)
        setSummary(null)
      }
    })()
  }, [loading, spaceId])

  if (loading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{t(lang, 'preparing_workspace')}</Text>
        </View>
      </Screen>
    )
  }

  const tiles = [
    { label: t(lang, 'home_tile_scan_label'), icon: 'scan-outline', description: t(lang, 'home_tile_scan_description'), target: 'Scan' },
    { label: t(lang, 'home_tile_bills_label'), icon: 'receipt-outline', description: t(lang, 'home_tile_bills_description'), target: 'Bills' },
    { label: t(lang, 'home_tile_pay_label'), icon: 'card-outline', description: t(lang, 'home_tile_pay_description'), target: 'Pay' },
    { label: t(lang, 'home_tile_warranties_label'), icon: 'shield-checkmark-outline', description: t(lang, 'home_tile_warranties_description'), target: 'Warranties' },
    { label: t(lang, 'home_tile_reports_label'), icon: 'bar-chart-outline', description: t(lang, 'home_tile_reports_description'), target: 'Reports' },
    { label: t(lang, 'home_tile_exports_label'), icon: 'download-outline', description: t(lang, 'home_tile_exports_description'), target: 'Exports' },
  ]

  return (
    <Screen title="Home">
      <View style={[styles.pageStack, { gap: themeSpacing.xs }]}>
        <Surface elevated padded={false} style={[styles.card, styles.homeSummaryCard]}>
          <View style={styles.screenHeader}>
            <View style={styles.screenHeaderText}>
              <Pressable
                onPress={() => {
                  setRenameDraft(space?.name || '')
                  setRenameVisible(true)
                }}
              >
                <Text style={styles.screenHeaderTitle}>{space?.name || payerLabelFromSpaceId(space?.id)}</Text>
              </Pressable>
              <Text style={styles.screenHeaderSubtitle}>
                {payerLabelFromSpaceId(space?.id)} • {planLabel(entitlements.plan)}
              </Text>
            </View>
            {space?.plan === 'free' ? (
              <View style={styles.screenHeaderTrailing}>
                <AppButton
                  label={t(lang, 'upgrade_action')}
                  variant="secondary"
                  iconName="arrow-up-circle-outline"
                  onPress={() => {
                    if (IS_EXPO_GO) {
                      Alert.alert(
                        t(lang, 'upgrade_title'),
                        t(lang, 'iap_disabled_expo_go_message')
                      )
                      return
                    }
                    navigation.navigate('Payments')
                  }}
                />
              </View>
            ) : spacesCtx.spaces.length > 1 ? (
              <View style={styles.screenHeaderTrailing}>
                <AppButton
                  label={t(lang, 'switch_space_action')}
                  variant="secondary"
                  iconName="swap-horizontal-outline"
                  onPress={() => navigation.navigate('Settings')}
                />
              </View>
            ) : null}
          </View>

          <View style={{ marginTop: themeSpacing.xs }}>
            <Text style={styles.mutedText}>
              Total unpaid: {summary ? `EUR ${summary.totalUnpaid.toFixed(2)}` : '—'}
            </Text>
            <Text style={styles.mutedText}>
              Overdue: {summary ? `${summary.overdueCount} bill${summary.overdueCount === 1 ? '' : 's'}` : '—'}
            </Text>
            <Text style={styles.mutedText}>
              Next due date: {summary ? (summary.nextDueDate || 'None') : '—'}
            </Text>
          </View>

          <View style={{ marginTop: themeSpacing.sm }}>
            <Text style={styles.mutedText}>Active payer</Text>

            <View style={{ marginTop: themeSpacing.xs }}>
              <Text style={styles.payerNameTitle} numberOfLines={1}>{(space?.name || '').trim() || payerLabelFromSpaceId(space?.id)}</Text>
              <Text style={styles.payerSlotLabel}>{payerLabelFromSpaceId(space?.id)}</Text>
            </View>

            <SegmentedControl
              value={spacesCtx.current?.id || spaceId || ''}
              onChange={(id) => { handlePayerChange(id) }}
              options={payerOptions}
              style={{ marginTop: themeSpacing.xs }}
            />

            {needsPayerName ? (
              <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
                <Image source={BRAND_WORDMARK} style={styles.wordmarkOnboarding} resizeMode="contain" accessibilityLabel="BILLBOX" />
                <Text style={styles.bodyText}>{t(lang, 'name_payer_1_to_continue_message')}</Text>
                <AppInput placeholder={t(lang, 'payer_1_name_placeholder')} value={payerNameDraft} onChangeText={setPayerNameDraft} />
                <AppButton label="Save" iconName="checkmark-outline" onPress={savePayer1Name} />
              </View>
            ) : null}

            {creatingPayer2 ? (
              <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
                <Text style={styles.bodyText}>{t(lang, 'create_payer_2_pro_only_message')}</Text>
                <AppInput placeholder={t(lang, 'payer_2_name_placeholder')} value={payer2NameDraft} onChangeText={setPayer2NameDraft} />
                <View style={{ flexDirection: 'row', gap: themeLayout.gap }}>
                  <AppButton label="Cancel" variant="ghost" onPress={() => setCreatingPayer2(false)} />
                  <AppButton label="Create" iconName="add-outline" onPress={savePayer2} />
                </View>
              </View>
            ) : null}

            <Text style={[styles.mutedText, { marginTop: themeSpacing.xs }]}>{t(lang, 'active_payer_scopes_message')}</Text>
          </View>
        </Surface>
        <View style={styles.gridWrap}>
          {tiles.map((tile) => (
            <Pressable
              key={tile.label}
              onPress={() => {
                if (needsPayerName) {
                  Alert.alert(t(lang, 'name_required_title'), t(lang, 'please_name_payer_1_to_continue_message'))
                  return
                }
                navigation.navigate(tile.target)
              }}
              style={({ pressed }) => [styles.statCardPressable, pressed && styles.statCardPressed]}
            >
              <Surface elevated padded={false} style={[styles.statCard, tile.target === 'Scan' && styles.statCardPrimary]}>
                <View style={styles.statIconWrap}>
                  <Ionicons name={tile.icon as keyof typeof Ionicons.glyphMap} size={20} color={themeColors.primary} />
                </View>
                <Text style={styles.statLabel}>{tile.label}</Text>
                <Text style={styles.statValue} numberOfLines={1}>
                  {tile.description}
                </Text>
              </Surface>
            </Pressable>
          ))}
        </View>
      </View>

      <Modal visible={upgradeModalVisible} transparent animationType="fade" onRequestClose={() => setUpgradeModalVisible(false)}>
        <View style={styles.iosPickerOverlay}>
          <Surface elevated style={styles.iosPickerSheet}>
            <SectionHeader title={t(lang, 'add_second_payer_title')} />
            <Text style={styles.bodyText}>{t(lang, 'payer_2_available_on_pro_message')}</Text>
            <View style={{ gap: themeSpacing.xs, marginTop: themeSpacing.sm }}>
              <Text style={styles.bodyText}>{t(lang, 'second_payer_benefit_1')}</Text>
              <Text style={styles.bodyText}>{t(lang, 'second_payer_benefit_2')}</Text>
              <Text style={styles.bodyText}>{t(lang, 'second_payer_benefit_3')}</Text>
              <Text style={styles.mutedText}>{tf(lang, 'yearly_billing_savings_message', { basicSavings: planSavings.basic, proSavings: planSavings.pro })}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
              <AppButton label={t(lang, 'not_now_action')} variant="ghost" onPress={() => setUpgradeModalVisible(false)} />
              <AppButton
                label={t(lang, 'upgrade_to_pro_action')}
                iconName="arrow-up-outline"
                onPress={() => {
                  setUpgradeModalVisible(false)
                  if (IS_EXPO_GO) {
                    Alert.alert('Upgrade', 'Purchases are disabled in Expo Go preview. Use a store/dev build to upgrade.')
                    return
                  }
                  navigation.navigate('Payments')
                }}
              />
            </View>
          </Surface>
        </View>
      </Modal>

      <Modal visible={renameVisible} transparent animationType="fade" onRequestClose={() => setRenameVisible(false)}>
        <View style={styles.iosPickerOverlay}>
          <Surface elevated style={styles.iosPickerSheet}>
            <SectionHeader title={`Rename ${payerLabelFromSpaceId(spacesCtx.current?.id)}`} />
            <AppInput placeholder="New name" value={renameDraft} onChangeText={setRenameDraft} />
            <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
              <AppButton label="Cancel" variant="ghost" onPress={() => setRenameVisible(false)} />
              <AppButton label="Save" iconName="checkmark-outline" onPress={saveRename} />
            </View>
          </Surface>
        </View>
      </Modal>
    </Screen>
  )
}

function WarrantiesScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const navigation = useNavigation<any>()
  const spacesCtx = useSpacesContext()
  const [items, setItems] = useState<Warranty[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null)
  const [billQuery, setBillQuery] = useState('')
  const [itemName, setItemName] = useState('')
  const [supplier, setSupplier] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [durationMonths, setDurationMonths] = useState('')
  const [pendingAttachment, setPendingAttachment] = useState<{ uri: string; name: string; type?: string } | null>(null)
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()
  useEffect(() => { (async ()=>{
    if (spaceLoading || !space) return
    if (supabase) {
      const { data } = await listWarranties(supabase, spaceId)
      setItems(data)
      const { data: b } = await listBills(supabase, spaceId)
      setBills(b || [])
    }
    else {
      const locals = await loadLocalWarranties(spaceId)
      setItems(locals as any)
      const bLocals = await loadLocalBills(spaceId)
      setBills((bLocals as any) || [])
    }
  })() }, [supabase, spaceLoading, space, spaceId])

  const linkedBillIds = useMemo(() => {
    const set = new Set<string>()
    for (const w of items || []) {
      const id = (w as any)?.bill_id
      if (id) set.add(id)
    }
    return set
  }, [items])

  const selectableBills = useMemo(() => {
    const term = billQuery.trim().toLowerCase()
    return (bills || [])
      .filter((b) => !linkedBillIds.has(b.id))
      .filter((b) => (term ? String(b.supplier || '').toLowerCase().includes(term) : true))
      .slice(0, 25)
  }, [billQuery, bills, linkedBillIds])

  const selectedBill = useMemo(() => {
    if (!selectedBillId) return null
    return (bills || []).find((b) => b.id === selectedBillId) || null
  }, [bills, selectedBillId])

  async function addManual() {
    if (!selectedBillId) {
      Alert.alert('Linked bill required', 'Select the bill this warranty belongs to.')
      return
    }
    const existingLinked = (items || []).find((w: any) => w.bill_id === selectedBillId) || null
    if (existingLinked) {
      Alert.alert('Already linked', 'This bill already has a warranty. Opening the existing warranty.')
      navigation.navigate('Warranty Details', { warrantyId: (existingLinked as any).id })
      return
    }
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
      const { data, error } = await createWarranty(supabase!, { item_name: itemName, supplier: supplier || null, purchase_date: purchaseDate || null, expires_at: computedExpires || null, bill_id: selectedBillId, space_id: spaceId })
      if (error) { Alert.alert('Error', error.message); return }
      if (data) {
        const up = await uploadAttachmentFromUri(spaceId, 'warranties', data.id, pendingAttachment.uri, pendingAttachment.name, pendingAttachment.type)
        if (up.error) Alert.alert('Attachment upload failed', up.error)
        setItems(prev=>[data, ...prev])
      }
    } else {
      const local = await addLocalWarranty(spaceId, { item_name: itemName, supplier: supplier || null, purchase_date: purchaseDate || null, expires_at: computedExpires || null, bill_id: selectedBillId })
      await addLocalAttachment(spaceId, 'warranties', local.id, { name: pendingAttachment.name, path: `${local.id}/${pendingAttachment.name}`, created_at: new Date().toISOString(), uri: pendingAttachment.uri })
      setItems((prev:any)=>[local, ...prev])
    }
    setItemName(''); setSupplier(''); setPurchaseDate(''); setExpiresAt(''); setDurationMonths('')
    setSelectedBillId(null)
    setBillQuery('')
    setPendingAttachment(null)
    Alert.alert('Saved', supabase ? 'Warranty saved' : 'Saved locally (Not synced)')
  }

  async function del(id: string) {
    Alert.alert('Are you sure? This will also delete attached files.', 'Confirm deletion of this warranty and attachments.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deleteAllAttachmentsForRecord(spaceId, 'warranties', id); if (supabase) { const { error } = await deleteWarranty(supabase!, id, spaceId); if (error) Alert.alert('Error', error.message) } else { await deleteLocalWarranty(spaceId, id) } setItems(prev=>prev.filter(w=>w.id!==id)) } }
    ])
  }

  async function ocrPhoto() {
    if (!entitlements.canUseOCR) {
      showUpgradeAlert('ocr')
      return
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
    if (res.canceled) return
    const asset = res.assets?.[0]
    if (!asset?.uri) return
    const base = getFunctionsBase()
    if (!base) { Alert.alert('OCR unavailable', 'Missing EXPO_PUBLIC_FUNCTIONS_BASE'); return }
    try {
      const fileResp = await fetch(asset.uri)
      const blob = await fileResp.blob()
      const supa = getSupabase()
      let authHeader: Record<string, string> = {}
      if (supa) {
        try {
          const { data } = await supa.auth.getSession()
          const token = data?.session?.access_token
          if (token) authHeader = { Authorization: `Bearer ${token}` }
        } catch {}
      }
      const resp = await fetch(`${base}/.netlify/functions/ocr`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream', ...authHeader }, body: blob })
      const data = await resp.json()
      if (!resp.ok || !data?.ok) throw new Error(data?.error || `OCR failed (${resp.status})`)
      const f = data.fields || {}
      setItemName(f.supplier || itemName)
      setSupplier(f.supplier || supplier)
      setPurchaseDate(f.due_date || purchaseDate)
      setPendingAttachment({ uri: asset.uri, name: asset.fileName || 'photo.jpg', type: asset.type || 'image/jpeg' })

      if (!selectedBillId) {
        Alert.alert('OCR extracted', 'Select a linked bill, then press “Save warranty”.')
        return
      }

      const existingLinked = (items || []).find((w: any) => w.bill_id === selectedBillId) || null
      if (existingLinked) {
        Alert.alert('Already linked', 'This bill already has a warranty. Opening the existing warranty.')
        navigation.navigate('Warranty Details', { warrantyId: (existingLinked as any).id })
        return
      }

      Alert.alert('OCR extracted', 'Fields prefilling from photo. Review and press “Save warranty”.')
    } catch (e: any) {
      Alert.alert('OCR error', e?.message || 'Failed')
    }
  }

  if (spaceLoading || !space) {
    return (
      <Screen title="Warranties" scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>Loading warranties…</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen title="Warranties" scroll={false}>
      <View style={styles.pageStack}>
        <Surface elevated>
          <SectionHeader title="New warranty" />
          {spacesCtx.spaces.length > 1 ? (
            <View style={{ marginBottom: themeSpacing.sm }}>
              <Text style={styles.mutedText}>Payer</Text>
              <SegmentedControl
                value={spacesCtx.current?.id || spaceId || ''}
                onChange={(id) => { spacesCtx.setCurrent(id) }}
                options={spacesCtx.spaces.map((s) => ({ value: s.id, label: s.name }))}
                style={{ marginTop: themeSpacing.xs }}
              />
            </View>
          ) : null}

          <Disclosure title="Linked bill (required)">
            <Text style={styles.bodyText}>Warranties must be linked 1:1 to a bill.</Text>
            {linkedBillIds.size > 0 ? (
              <Text style={styles.mutedText}>Bills already linked are hidden from this list.</Text>
            ) : null}
            <AppInput placeholder="Find bill by supplier" value={billQuery} onChangeText={setBillQuery} />
            {selectedBill ? (
              <InlineInfo
                tone="info"
                iconName="link-outline"
                message={`Selected bill: ${selectedBill.supplier} • due ${selectedBill.due_date} • ${selectedBill.currency} ${selectedBill.amount.toFixed(2)}`}
              />
            ) : (
              <InlineInfo tone="warning" iconName="alert-circle-outline" message="Select a bill before saving the warranty." />
            )}
            <View style={{ gap: themeSpacing.xs, marginTop: themeSpacing.sm }}>
              {selectableBills.length === 0 ? (
                <Text style={styles.mutedText}>No available bills to link.</Text>
              ) : (
                selectableBills.map((b) => (
                  <Pressable
                    key={b.id}
                    onPress={() => {
                      setSelectedBillId(b.id)
                      if (!supplier) setSupplier(b.supplier)
                      if (!itemName) setItemName(b.supplier)
                      if (!purchaseDate) setPurchaseDate(b.due_date)
                    }}
                    style={({ pressed }) => [styles.billCardPressable, pressed && styles.billCardPressed]}
                    hitSlop={8}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: themeSpacing.sm }}>
                      <Text style={styles.bodyText} numberOfLines={1}>{b.supplier}</Text>
                      <Text style={styles.mutedText}>{b.due_date}</Text>
                    </View>
                  </Pressable>
                ))
              )}
            </View>
          </Disclosure>

          <View style={{ gap: themeSpacing.sm }}>
            <View style={{ flexDirection: 'row', gap: themeSpacing.sm }}>
              <AppInput
                placeholder="Item name"
                value={itemName}
                onChangeText={setItemName}
                style={{ flex: 1 }}
              />
              <AppInput
                placeholder="Supplier"
                value={supplier}
                onChangeText={setSupplier}
                style={{ flex: 1 }}
              />
            </View>
            <View style={{ flexDirection: 'row', gap: themeSpacing.sm }}>
              <AppInput
                placeholder="Purchase YYYY-MM-DD"
                value={purchaseDate}
                onChangeText={setPurchaseDate}
                style={{ flex: 1 }}
              />
              <AppInput
                placeholder="Expires YYYY-MM-DD"
                value={expiresAt}
                onChangeText={setExpiresAt}
                style={{ flex: 1 }}
              />
              <AppInput
                placeholder="Duration (months)"
                value={durationMonths}
                onChangeText={setDurationMonths}
                keyboardType="numeric"
                style={{ flex: 1 }}
              />
            </View>
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
            <AppButton
              label="Attach image"
              variant="secondary"
              iconName="image-outline"
              onPress={async ()=>{
          const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
          if (res.canceled) return
          const asset = res.assets?.[0]
          if (!asset?.uri) return
          setPendingAttachment({ uri: asset.uri, name: asset.fileName || 'photo.jpg', type: asset.type || 'image/jpeg' })
          Alert.alert('Attachment selected', 'Image will be attached on save.')
        }}
            />
            <AppButton
              label="Attach PDF"
              variant="secondary"
              iconName="document-attach-outline"
              onPress={async ()=>{
          const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
          if (res.canceled) return
          const file = res.assets?.[0]
          if (!file?.uri) return
          setPendingAttachment({ uri: file.uri, name: file.name || 'document.pdf', type: 'application/pdf' })
          Alert.alert('Attachment selected', 'PDF will be attached on save.')
        }}
            />
          </View>

          {!!pendingAttachment && (
            <View style={{ marginTop: themeSpacing.sm }}>
              <Text style={styles.bodyText}>Attachment preview:</Text>
              {pendingAttachment.type?.startsWith('image/') ? (
                <Image source={{ uri: pendingAttachment.uri }} style={{ width: 160, height: 120, borderRadius: 12, marginTop: themeSpacing.xs }} />
              ) : (
                <Text style={styles.bodyText}>{pendingAttachment.name}</Text>
              )}
            </View>
          )}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
            <AppButton
              label="Save warranty"
              iconName="save-outline"
              onPress={addManual}
            />
            <AppButton
              label="OCR from photo"
              variant="secondary"
              iconName="scan-outline"
              onPress={ocrPhoto}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Existing warranties" />
          {items.length === 0 ? (
            <View style={styles.brandEmptyWrap}>
              <Image source={BRAND_WORDMARK} style={styles.wordmarkEmpty} resizeMode="contain" accessibilityLabel="BILLBOX" />
              <EmptyState
                title="No warranties yet"
                message="Save a warranty and attach a receipt or invoice to keep proof of purchase in one place."
                actionLabel="Add warranty"
                onActionPress={addManual}
                iconName="shield-checkmark-outline"
              />
            </View>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(w)=>w.id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item }) => (
                <Surface elevated style={styles.billRowCard}>
                  <View style={styles.billRowHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle} numberOfLines={1}>
                        {item.item_name}{(item as any)?.unsynced ? ' • Not synced' : ''}
                      </Text>
                      <Text style={styles.mutedText}>
                        {item.supplier || '—'} • purchased {item.purchase_date || '—'} • expires {item.expires_at || '—'}{(item as any)?.bill_id ? ' • linked bill' : ''}
                      </Text>
                    </View>
                    <Badge label={item.expires_at ? 'Active' : 'No expiry'} tone={item.expires_at ? 'info' : 'neutral'} />
                  </View>
                  <View style={styles.billActionsRow}>
                    <AppButton
                      label="Details"
                      variant="secondary"
                      iconName="information-circle-outline"
                      onPress={()=> navigation.navigate('Warranty Details', { warrantyId: item.id })}
                    />
                    <AppButton
                      label="Delete"
                      variant="ghost"
                      iconName="trash-outline"
                      onPress={()=>del(item.id)}
                    />
                  </View>
                </Surface>
              )}
            />
          )}
        </Surface>
      </View>
    </Screen>
  )
}

function WarrantyDetailsScreen() {
  const route = useRoute<any>()
  const navigation = useNavigation<any>()
  const supabase = useMemo(() => getSupabase(), [])
  const { lang } = useLang()
  const warrantyId: string | null = route.params?.warrantyId || null
  const [warranty, setWarranty] = useState<Warranty | null>(null)
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [linkedBill, setLinkedBill] = useState<Bill | null>(null)
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  useEffect(() => { (async ()=>{
    if (!warrantyId || spaceLoading || !space) return
    if (supabase) {
      const userId = await getCurrentUserId(supabase!)
      const { data } = await supabase!.from('warranties').select('*').eq('user_id', userId).eq('id', warrantyId).single()
      setWarranty((data as Warranty) || null)
      setAttachments(await listRemoteAttachments(supabase!, 'warranties', warrantyId, spaceId))

      try {
        const billId = (data as any)?.bill_id || null
        if (billId) {
          const { data: bills } = await listBills(supabase!, spaceId)
          const match = (bills || []).find((b: any) => b.id === billId) || null
          setLinkedBill(match)
        } else {
          setLinkedBill(null)
        }
      } catch {
        setLinkedBill(null)
      }
    } else {
      const locals = await loadLocalWarranties(spaceId)
      const w = locals.find(l=> l.id===warrantyId) || null
      setWarranty(w as any)
      setAttachments(await listLocalAttachments(spaceId, 'warranties', warrantyId))

      try {
        const billId = (w as any)?.bill_id || null
        if (billId) {
          const bills = await loadLocalBills(spaceId)
          const match = (bills as any[]).find((b: any) => b.id === billId) || null
          setLinkedBill(match as any)
        } else {
          setLinkedBill(null)
        }
      } catch {
        setLinkedBill(null)
      }
    }
  })() }, [warrantyId, supabase, spaceLoading, space, spaceId])

  async function refresh() {
    if (!warrantyId || spaceLoading || !space) return
    if (supabase) setAttachments(await listRemoteAttachments(supabase!, 'warranties', warrantyId, spaceId))
    else setAttachments(await listLocalAttachments(spaceId, 'warranties', warrantyId))
  }
  async function addImage() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
    if (res.canceled) return
    const asset = res.assets?.[0]
    if (!asset?.uri) return
    const up = await uploadAttachmentFromUri(spaceId, 'warranties', warrantyId!, asset.uri, asset.fileName || 'photo.jpg', asset.type || 'image/jpeg')
    if (up.error) Alert.alert(t(lang, 'upload_failed_title'), up.error || t(lang, 'upload_failed_message_generic'))
    else Alert.alert(t(lang, 'attachment_uploaded_title'), t(lang, 'image_attached_to_warranty_message'))
    await refresh()
  }
  async function addPdf() {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
    if (res.canceled) return
    const file = res.assets?.[0]
    if (!file?.uri) return
    const up = await uploadAttachmentFromUri(spaceId, 'warranties', warrantyId!, file.uri, file.name || 'document.pdf', 'application/pdf')
    if (up.error) Alert.alert(t(lang, 'upload_failed_title'), up.error || t(lang, 'upload_failed_message_generic'))
    else Alert.alert(t(lang, 'attachment_uploaded_title'), t(lang, 'pdf_attached_to_warranty_message'))
    await refresh()
  }
  async function openAttachment(path: string, uri?: string) {
    if (supabase) { const url = await getSignedUrl(supabase!, path); if (url) Linking.openURL(url); else Alert.alert(t(lang, 'open_failed_title'), t(lang, 'could_not_get_url_message')) }
    else if (uri) Linking.openURL(uri)
    else Alert.alert(t(lang, 'offline_title'), t(lang, 'attachment_stored_locally_message'))
  }
  async function remove(path: string) {
    Alert.alert(t(lang, 'delete_attachment_title'), t(lang, 'delete_attachment_message'), [
      { text: t(lang, 'cancel_action'), style: 'cancel' },
      {
        text: t(lang, 'delete_action'),
        style: 'destructive',
        onPress: async () => {
          const { error } = await deleteAttachment(spaceId, 'warranties', warrantyId!, path)
          if (error) Alert.alert(t(lang, 'delete_failed_title'), String(error))
          else await refresh()
        },
      },
    ])
  }
  if (!warranty || spaceLoading || !space) {
    return (
      <Screen title={t(lang, 'warranty_fallback_title')} scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{t(lang, 'warranty_not_found_message')}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen title={warranty.item_name || t(lang, 'warranty_fallback_title')}>
      <View style={styles.pageStack}>
        <Surface elevated>
          <SectionHeader title={t(lang, 'warranty_summary_title')} />
          <Text style={styles.bodyText}>
            {t(lang, 'supplier_label')}: {warranty.supplier || '—'} • {t(lang, 'purchase_date_label')}: {warranty.purchase_date || '—'} • {t(lang, 'expires_label')}: {warranty.expires_at || '—'}
          </Text>
        </Surface>

        {(linkedBill || (warranty as any)?.bill_id) ? (
          <Surface elevated>
            <SectionHeader title={t(lang, 'linked_bill_title')} />
            {linkedBill ? (
              <>
                <Text style={styles.bodyText}>
                  {linkedBill.supplier} • {linkedBill.currency} {linkedBill.amount.toFixed(2)} • {t(lang, 'due_label')} {linkedBill.due_date}
                </Text>
                <AppButton
                  label={t(lang, 'open_bill_action')}
                  variant="secondary"
                  iconName="open-outline"
                  onPress={() => navigation.navigate('Bill Details', { bill: linkedBill })}
                />
              </>
            ) : (
              <Text style={styles.mutedText}>{t(lang, 'warranty_linked_bill_not_found_message')}</Text>
            )}
          </Surface>
        ) : null}

        <Surface elevated>
          <SectionHeader title={t(lang, 'reminders_title')} />
          {!warranty.expires_at ? (
            <InlineInfo
              tone="warning"
              iconName="alert-circle-outline"
              message={t(lang, 'no_expiry_date_warranty_reminders_message')}
            />
          ) : null}
          <View style={styles.billActionsRow}>
            <AppButton
              label={t(lang, 'schedule_defaults')}
              variant="secondary"
              iconName="alarm-outline"
              onPress={async ()=>{
                if (!warranty.expires_at) {
                  Alert.alert(t(lang, 'missing_expiry_date_title'), t(lang, 'add_expiry_date_to_schedule_warranty_reminders_message'))
                  return
                }
                await ensureNotificationConfig()
                const ok = await requestPermissionIfNeeded()
                if (!ok) {
                  Alert.alert(t(lang, 'enable_reminders_title'), t(lang, 'enable_notifications_in_settings_message'))
                  return
                }
                await scheduleWarrantyReminders({ id: warranty.id, item_name: warranty.item_name || 'Warranty', supplier: warranty.supplier || null, expires_at: warranty.expires_at, space_id: spaceId } as any, undefined, spaceId)
                Alert.alert(t(lang, 'reminders_scheduled_title'), t(lang, 'scheduled_default_warranty_reminders_message'))
              }}
            />
            <AppButton
              label={t(lang, 'cancel_reminders')}
              variant="ghost"
              iconName="notifications-off-outline"
              onPress={async ()=>{
                await cancelWarrantyReminders(warranty.id, spaceId)
                Alert.alert(t(lang, 'reminders_title'), t(lang, 'canceled_for_this_warranty_message'))
              }}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={t(lang, 'attachments_title')} />
          <View style={styles.attachmentRow}>
            <AppButton
              label={t(lang, 'add_image')}
              variant="secondary"
              iconName="image-outline"
              onPress={addImage}
            />
            <AppButton
              label={t(lang, 'add_pdf')}
              variant="secondary"
              iconName="document-attach-outline"
              onPress={addPdf}
            />
          </View>
          {attachments.length === 0 ? (
            <EmptyState
              title="No attachments"
              message="Attach a receipt or invoice so you can prove purchase when claiming this warranty."
              actionLabel="Add image"
              onActionPress={addImage}
              iconName="document-text-outline"
            />
          ) : (
            <FlatList
              data={attachments}
              keyExtractor={(a)=>a.path}
              contentContainerStyle={styles.listContent}
              renderItem={({ item })=> (
                <Surface elevated style={styles.billRowCard}>
                  <Text style={styles.cardTitle}>{item.name}</Text>
                  <View style={styles.billActionsRow}>
                    <AppButton
                      label="Open"
                      variant="secondary"
                      iconName="open-outline"
                      onPress={()=>openAttachment(item.path, item.uri)}
                    />
                    <AppButton
                      label="Delete"
                      variant="ghost"
                      iconName="trash-outline"
                      onPress={()=>remove(item.path)}
                    />
                  </View>
                </Surface>
              )}
            />
          )}
        </Surface>
      </View>
    </Screen>
  )
}

function ReportsScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const navigation = useNavigation<any>()
  const [bills, setBills] = useState<Bill[]>([])
  const [range, setRange] = useState<{ start: string; end: string }>({ start: new Date(new Date().getFullYear(),0,1).toISOString().slice(0,10), end: new Date().toISOString().slice(0,10) })
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const effectiveSpaceId = spaceId || space?.id || 'default'
  const { snapshot: entitlements } = useEntitlements()

  useEffect(() => { (async ()=>{
    if (spaceLoading || !space) return
    if (supabase) { const { data } = await listBills(supabase, spaceId); setBills(data) }
    else { const locals = await loadLocalBills(spaceId); setBills(locals as any) }
  })() }, [supabase, spaceLoading, space, spaceId])

  const filtered = bills.filter(b=> b.due_date >= range.start && b.due_date <= range.end)
  const monthly: Record<string, number> = {}
  for (const b of filtered) {
    const ym = b.due_date.slice(0,7)
    monthly[ym] = (monthly[ym] || 0) + (b.currency==='EUR'? b.amount : 0)
  }
  const suppliers: Record<string, number> = {}
  for (const b of filtered) suppliers[b.supplier] = (suppliers[b.supplier] || 0) + (b.currency==='EUR'? b.amount : 0)

  const totalBillsInRange = filtered.length
  const totalAmountEur = filtered.reduce((sum, b) => sum + (b.currency === 'EUR' ? b.amount : 0), 0)
  const unpaidTotalEur = filtered.reduce((sum, b) => {
    if (b.status !== 'unpaid') return sum
    return sum + (b.currency === 'EUR' ? b.amount : 0)
  }, 0)

  // exports are intentionally separated into ExportsScreen

  if (spaceLoading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>Loading reports…</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen title="Reports">
      <View style={styles.pageStack}>
        <Surface elevated>
          <SectionHeader title="Filters" />
          <View style={styles.filtersBody}>
            <View style={styles.dateFilterSection}>
              <Text style={styles.filterLabel}>Due date range</Text>
              <View style={styles.manualDateRow}>
                <AppInput
                  placeholder="Start YYYY-MM-DD"
                  value={range.start}
                  onChangeText={(v)=>setRange(r=>({ ...r, start: v }))}
                  style={styles.flex1}
                />
                <AppInput
                  placeholder="End YYYY-MM-DD"
                  value={range.end}
                  onChangeText={(v)=>setRange(r=>({ ...r, end: v }))}
                  style={styles.flex1}
                />
              </View>
              <Text style={styles.helperText}>Reports currently use bill due dates between Start and End.</Text>
            </View>
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Exports" />
          <Text style={styles.bodyText}>Exports are separated from analytics.</Text>
          <AppButton
            label="Open Exports"
            variant="secondary"
            iconName="download-outline"
            onPress={() => navigation.navigate('Exports', { start: range.start, end: range.end })}
          />
          {!entitlements.exportsEnabled ? (
            <View style={{ marginTop: themeSpacing.sm }}>
              <InlineInfo
                tone="info"
                iconName="sparkles-outline"
                message="Exports are locked on the Free plan. Upgrade to Basic or Pro to enable CSV, PDF, ZIP, and JSON exports."
              />
            </View>
          ) : null}
        </Surface>

        <Surface elevated>
          <SectionHeader title="Totals in range" />
          <View style={{ marginTop: themeSpacing.sm, gap: themeSpacing.xs }}>
            <Text style={styles.bodyText}>Bills in range: {totalBillsInRange}</Text>
            <Text style={styles.bodyText}>Total amount (EUR): EUR {totalAmountEur.toFixed(2)}</Text>
            <Text style={styles.bodyText}>Unpaid total (EUR): EUR {unpaidTotalEur.toFixed(2)}</Text>
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Monthly spend" />
          <View style={{ paddingVertical: themeSpacing.sm }}>
            {Object.keys(monthly).length === 0 ? (
              <Text style={styles.mutedText}>No bills in this range.</Text>
            ) : (
              Object.keys(monthly).sort().map((k)=> (
                <View key={k} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                  <Text style={{ width: 80 }}>{k}</Text>
                  <View style={{ flex: 1, height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: '#E5E7EB' }}>
                    <View style={{ height: '100%', width: `${Math.min(100, monthly[k])}%`, backgroundColor: themeColors.primary }} />
                  </View>
                  <Text style={{ marginLeft: 8 }}>EUR {monthly[k].toFixed(2)}</Text>
                </View>
              ))
            )}
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Top suppliers" />
          <View style={{ paddingVertical: themeSpacing.sm }}>
            {Object.keys(suppliers).length === 0 ? (
              <Text style={styles.mutedText}>No suppliers for this period.</Text>
            ) : (
              Object.entries(suppliers).sort((a,b)=> b[1]-a[1]).slice(0,10).map(([s,amt])=> (
                <View key={s} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                  <Text style={{ flex: 1 }}>{s}</Text>
                  <Text>EUR {amt.toFixed(2)}</Text>
                </View>
              ))
            )}
          </View>
        </Surface>
      </View>
    </Screen>
  )
}

function ExportsScreen() {
  const route = useRoute<any>()
  const navigation = useNavigation<any>()
  const supabase = useMemo(() => getSupabase(), [])
  const [bills, setBills] = useState<Bill[]>([])
  const [warranties, setWarranties] = useState<Warranty[]>([])
  const [range, setRange] = useState<{ start: string; end: string }>({
    start: route.params?.start || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10),
    end: route.params?.end || new Date().toISOString().slice(0, 10),
  })
  const [dateMode, setDateMode] = useState<'due' | 'invoice' | 'created'>('due')
  const [supplierQuery, setSupplierQuery] = useState('')
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')
  const [hasAttachmentsOnly, setHasAttachmentsOnly] = useState(false)
  const [status, setStatus] = useState<'all' | 'unpaid' | 'paid' | 'archived'>('all')
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const effectiveSpaceId = spaceId || space?.id || 'default'
  const { snapshot: entitlements } = useEntitlements()

  useEffect(() => {
    if (route.params?.start || route.params?.end) {
      setRange((r) => ({
        start: route.params?.start || r.start,
        end: route.params?.end || r.end,
      }))
    }
  }, [route.params?.start, route.params?.end])

  useEffect(() => { (async ()=>{
    if (spaceLoading || !space) return
    if (supabase) {
      const { data: b } = await listBills(supabase, spaceId)
      setBills(b || [])
      const { data: w } = await listWarranties(supabase, spaceId)
      setWarranties(w || [])
    } else {
      const locals = await loadLocalBills(spaceId)
      setBills((locals as any) || [])
      const wLocals = await loadLocalWarranties(spaceId)
      setWarranties((wLocals as any) || [])
    }
  })() }, [supabase, spaceLoading, space, spaceId])

  useEffect(() => {
    if (!spaceId) {
      setAttachmentCounts({})
      return
    }
    let cancelled = false
    async function resolveCounts() {
      if (!bills.length) {
        if (!cancelled) setAttachmentCounts({})
        return
      }
      const entries = await Promise.all(
        bills.map(async (bill) => {
          try {
            const list = supabase
              ? await listRemoteAttachments(supabase, 'bills', bill.id, spaceId)
              : await listLocalAttachments(effectiveSpaceId, 'bills', bill.id)
            return [bill.id, list.length] as const
          } catch {
            return [bill.id, 0] as const
          }
        })
      )
      if (!cancelled) {
        const next: Record<string, number> = {}
        for (const [id, count] of entries) next[id] = count
        setAttachmentCounts(next)
      }
    }
    resolveCounts()
    return () => {
      cancelled = true
    }
  }, [bills, effectiveSpaceId, spaceId, supabase])

  const warrantyByBillId = useMemo(() => {
    const map = new Map<string, Warranty>()
    for (const w of warranties || []) {
      const billId = (w as any)?.bill_id
      if (billId && !map.has(billId)) map.set(billId, w)
    }
    return map
  }, [warranties])

  function getBillDateForMode(bill: Bill, mode: typeof dateMode): string {
    if (mode === 'invoice') {
      const raw = (bill as any).invoice_date || bill.created_at
      return String(raw || '').slice(0, 10) || bill.due_date
    }
    if (mode === 'created') {
      return String(bill.created_at || '').slice(0, 10) || bill.due_date
    }
    return String(bill.due_date || '').slice(0, 10)
  }

  const filtered = useMemo(() => {
    const supplierTerm = supplierQuery.trim().toLowerCase()
    const minVal = amountMin ? Number(String(amountMin).replace(',', '.')) : null
    const maxVal = amountMax ? Number(String(amountMax).replace(',', '.')) : null

    return bills
      .filter((b) => {
        const d = getBillDateForMode(b, dateMode)
        if (!d) return false
        if (d < range.start || d > range.end) return false

        if (status !== 'all' && b.status !== status) return false

        if (supplierTerm && !String(b.supplier || '').toLowerCase().includes(supplierTerm)) return false

        if (minVal !== null && !Number.isNaN(minVal) && b.amount < minVal) return false
        if (maxVal !== null && !Number.isNaN(maxVal) && b.amount > maxVal) return false

        if (hasAttachmentsOnly && (attachmentCounts[b.id] || 0) === 0) return false

        return true
      })
  }, [amountMax, amountMin, attachmentCounts, bills, dateMode, hasAttachmentsOnly, range.end, range.start, status, supplierQuery])

  function sanitizePathSegment(value: string) {
    return value.replace(/[^a-z0-9._-]/gi, '_') || 'attachment'
  }

  async function exportJSONRange() {
    if (entitlements.plan !== 'pro') {
      showUpgradeAlert('export')
      return
    }

    const out: any = {
      exported_at: new Date().toISOString(),
      space_id: effectiveSpaceId,
      filters: { start: range.start, end: range.end, status },
      bills: [],
    }

    for (const b of filtered) {
      const warranty = warrantyByBillId.get(b.id) || null
      let billAttachments: any[] = []
      let warrantyAttachments: any[] = []
      try {
        billAttachments = supabase
          ? await listRemoteAttachments(supabase!, 'bills', b.id, spaceId)
          : await listLocalAttachments(effectiveSpaceId, 'bills', b.id)
      } catch {}
      try {
        if (warranty?.id) {
          warrantyAttachments = supabase
            ? await listRemoteAttachments(supabase!, 'warranties', warranty.id, spaceId)
            : await listLocalAttachments(effectiveSpaceId, 'warranties', warranty.id)
        }
      } catch {}

      out.bills.push({
        bill: b,
        bill_attachments: (billAttachments || []).map((a: any) => ({ name: a.name, path: a.path })),
        warranty: warranty ? {
          id: warranty.id,
          item_name: warranty.item_name,
          supplier: warranty.supplier,
          purchase_date: warranty.purchase_date,
          expires_at: warranty.expires_at,
        } : null,
        warranty_attachments: (warrantyAttachments || []).map((a: any) => ({ name: a.name, path: a.path })),
      })
    }

    const file = `${FileSystem.cacheDirectory}billbox-export.json`
    await FileSystem.writeAsStringAsync(file, JSON.stringify(out, null, 2))
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file)
    else Alert.alert('JSON saved', file)
  }

  async function exportCSV() {
    if (entitlements.plan !== 'pro') {
      showUpgradeAlert('export')
      return
    }

    function csvEscape(v: any) {
      const s = v === null || v === undefined ? '' : String(v)
      return `"${s.replace(/"/g, '""')}"`
    }

    const base = getFunctionsBase()
    const s = getSupabase()

    // Prefer server-side export only when status is not filtering
    if (status === 'all' && base && s) {
      try {
        const { data } = await s.auth.getSession()
        const token = data?.session?.access_token
        if (token) {
          const resp = await fetch(`${base}/.netlify/functions/export-csv`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ from: range.start, to: range.end, dateField: 'due_date' }),
          })
          const json = await resp.json().catch(() => null)
          if (resp.ok && json?.ok && typeof json.csv === 'string') {
            const file = `${FileSystem.cacheDirectory}billbox-export.csv`
            await FileSystem.writeAsStringAsync(file, json.csv)
            if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file)
            else Alert.alert('CSV saved', file)
            return
          }
        }
      } catch {}
    }

    const header = [
      'supplier',
      'creditor_name',
      'amount',
      'currency',
      'due_date',
      'status',
      'iban',
      'reference',
      'purpose',
      'created_at',
      'space_id',
    ]

    const rows = [header].concat(
      filtered.map((b: any) => [
        b.supplier,
        b.creditor_name,
        b.amount,
        b.currency,
        b.due_date,
        b.status,
        b.iban,
        b.reference,
        b.purpose,
        b.created_at,
        b.space_id,
      ]),
    )

    const csv = rows.map((r: any[]) => r.map(csvEscape).join(',')).join('\n')
    const file = `${FileSystem.cacheDirectory}billbox-export.csv`
    await FileSystem.writeAsStringAsync(file, csv)
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file)
    else Alert.alert('CSV saved', file)
  }

  async function exportPDFRange() {
    if (entitlements.plan !== 'pro') {
      showUpgradeAlert('export')
      return
    }
    const itemsHtml = filtered
      .map((b) => `<tr><td>${b.supplier}</td><td>${b.currency} ${b.amount.toFixed(2)}</td><td>${b.due_date}</td><td>${b.status}</td></tr>`)
      .join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>BillBox Export</title><style>table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px}</style></head><body><h1>BillBox Export</h1><p>Range: ${range.start} → ${range.end}</p><p>Status: ${status}</p><table><thead><tr><th>Supplier</th><th>Amount</th><th>Due</th><th>Status</th></tr></thead><tbody>${itemsHtml}</tbody></table></body></html>`
    const { uri } = await Print.printToFileAsync({ html })
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri)
    else Alert.alert('PDF saved', uri)
  }

  async function exportPDFSingle(bill: Bill) {
    if (entitlements.plan !== 'pro') {
      showUpgradeAlert('export')
      return
    }
    const warranty = warrantyByBillId.get(bill.id) || null
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bill</title><style>body{font-family:-apple-system,system-ui}h1{margin:0 0 8px 0}p{margin:4px 0}</style></head><body><h1>${bill.supplier}</h1><p>Amount: ${bill.currency} ${bill.amount.toFixed(2)}</p><p>Due: ${bill.due_date}</p><p>Status: ${bill.status}</p>${bill.iban ? `<p>IBAN: ${bill.iban}</p>` : ''}${bill.reference ? `<p>Reference: ${bill.reference}</p>` : ''}${bill.purpose ? `<p>Purpose: ${bill.purpose}</p>` : ''}${warranty ? `<hr/><h2>Linked warranty</h2><p>${warranty.item_name}</p><p>Expires: ${warranty.expires_at || '—'}</p>` : ''}</body></html>`
    const { uri } = await Print.printToFileAsync({ html })
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri)
    else Alert.alert('PDF saved', uri)
  }

  async function exportAttachmentsZip() {
    if (entitlements.plan !== 'pro') {
      showUpgradeAlert('export')
      return
    }
    if (!filtered.length) {
      Alert.alert('No bills in range', 'Adjust the filters to include bills with attachments')
      return
    }
    const zip = new JSZip()
    const errors: string[] = []

    for (const bill of filtered) {
      const year = bill.due_date.slice(0, 4) || 'unknown'
      const month = bill.due_date.slice(5, 7) || '00'
      const baseFolder = zip.folder(`${year}/${month}/${sanitizePathSegment(bill.supplier)}`)
      if (!baseFolder) continue

      try {
        const billAttachments = supabase
          ? await listRemoteAttachments(supabase!, 'bills', bill.id, spaceId)
          : await listLocalAttachments(effectiveSpaceId, 'bills', bill.id)
        for (const attachment of billAttachments) {
          try {
            const name = sanitizePathSegment(attachment.name)
            if (supabase) {
              const signedUrl = await getSignedUrl(supabase!, attachment.path)
              if (!signedUrl) throw new Error('No signed URL')
              const resp = await fetch(signedUrl)
              if (!resp.ok) throw new Error(`Download failed (${resp.status})`)
              const arrayBuffer = await resp.arrayBuffer()
              baseFolder.file(name, new Uint8Array(arrayBuffer))
            } else {
              const sourceUri = attachment.uri || attachment.path
              if (!sourceUri) throw new Error('Missing file reference')
              const normalized = sourceUri.startsWith('file://') ? sourceUri : `file://${sourceUri}`
              const data = await FileSystem.readAsStringAsync(normalized, { encoding: FileSystem.EncodingType.Base64 })
              baseFolder.file(name, data, { base64: true })
            }
          } catch (e: any) {
            errors.push(`${attachment.name}: ${e?.message || 'failed'}`)
          }
        }

        const linkedWarranty = warrantyByBillId.get(bill.id) || null
        if (linkedWarranty?.id) {
          const warrantyFolder = baseFolder.folder('warranty')
          const warrantyAttachments = supabase
            ? await listRemoteAttachments(supabase!, 'warranties', linkedWarranty.id, spaceId)
            : await listLocalAttachments(effectiveSpaceId, 'warranties', linkedWarranty.id)
          for (const attachment of warrantyAttachments) {
            try {
              const name = sanitizePathSegment(attachment.name)
              if (supabase) {
                const signedUrl = await getSignedUrl(supabase!, attachment.path)
                if (!signedUrl) throw new Error('No signed URL')
                const resp = await fetch(signedUrl)
                if (!resp.ok) throw new Error(`Download failed (${resp.status})`)
                const arrayBuffer = await resp.arrayBuffer()
                warrantyFolder?.file(name, new Uint8Array(arrayBuffer))
              } else {
                const sourceUri = attachment.uri || attachment.path
                if (!sourceUri) throw new Error('Missing file reference')
                const normalized = sourceUri.startsWith('file://') ? sourceUri : `file://${sourceUri}`
                const data = await FileSystem.readAsStringAsync(normalized, { encoding: FileSystem.EncodingType.Base64 })
                warrantyFolder?.file(name, data, { base64: true })
              }
            } catch (e: any) {
              errors.push(`${attachment.name}: ${e?.message || 'failed'}`)
            }
          }
        }
      } catch (e: any) {
        errors.push(`${bill.supplier}: ${e?.message || 'failed'}`)
      }
    }

    const zipContent = await zip.generateAsync({ type: 'base64' })
    const zipPath = `${FileSystem.cacheDirectory}billbox-attachments.zip`
    await FileSystem.writeAsStringAsync(zipPath, zipContent, { encoding: FileSystem.EncodingType.Base64 })
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(zipPath, { mimeType: 'application/zip', dialogTitle: 'Share attachments ZIP' })
    else Alert.alert('ZIP saved', zipPath)
    if (errors.length) {
      Alert.alert('Some attachments skipped', errors.slice(0, 5).join('\n'))
    }
  }

  if (spaceLoading || !space) {
    return (
      <Screen title="Exports" scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>Loading exports…</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen title="Exports">
      <View style={styles.pageStack}>
        {entitlements.plan !== 'pro' ? (
          <Surface elevated>
            <InlineInfo
              tone="warning"
              iconName="lock-closed-outline"
              message="Exports are available on Pro. Upgrade to unlock CSV, PDF, ZIP and JSON exports."
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
              <AppButton
                label="Upgrade to Pro"
                variant="secondary"
                iconName="arrow-up-circle-outline"
                onPress={() => {
                  if (IS_EXPO_GO) {
                    Alert.alert('Upgrade', 'Purchases are disabled in Expo Go preview. Use a store/dev build to upgrade.')
                    return
                  }
                  navigation.navigate('Payments', { plan: 'pro' })
                }}
              />
            </View>
          </Surface>
        ) : null}

        <Surface elevated>
          <SectionHeader title="Filters" />
          <View style={styles.filtersBody}>
            <View style={styles.dateFilterSection}>
              <Text style={styles.filterLabel}>Date range</Text>
              <SegmentedControl
                value={dateMode}
                onChange={(value) => setDateMode(value as typeof dateMode)}
                options={[
                  { value: 'due', label: 'Due' },
                  { value: 'invoice', label: 'Invoice' },
                  { value: 'created', label: 'Created' },
                ]}
                style={{ marginTop: themeSpacing.xs }}
              />
              <View style={styles.manualDateRow}>
                <AppInput placeholder="Start YYYY-MM-DD" value={range.start} onChangeText={(v)=>setRange(r=>({ ...r, start: v }))} style={styles.flex1} />
                <AppInput placeholder="End YYYY-MM-DD" value={range.end} onChangeText={(v)=>setRange(r=>({ ...r, end: v }))} style={styles.flex1} />
              </View>
            </View>

            <View style={{ marginTop: themeSpacing.sm }}>
              <AppInput placeholder="Supplier" value={supplierQuery} onChangeText={setSupplierQuery} />
              <View style={styles.filterRow}>
                <AppInput placeholder="Min amount" keyboardType="numeric" value={amountMin} onChangeText={setAmountMin} style={styles.flex1} />
                <AppInput placeholder="Max amount" keyboardType="numeric" value={amountMax} onChangeText={setAmountMax} style={styles.flex1} />
              </View>
              <View style={styles.filterToggleRow}>
                <View style={styles.filterToggle}>
                  <Switch value={hasAttachmentsOnly} onValueChange={setHasAttachmentsOnly} />
                  <Text style={styles.toggleLabel}>Has attachment</Text>
                </View>
              </View>
            </View>

            <View style={{ marginTop: themeSpacing.sm }}>
              <Text style={styles.filterLabel}>Status</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                <AppButton label="All" variant={status === 'all' ? 'secondary' : 'ghost'} onPress={() => setStatus('all')} />
                <AppButton label="Unpaid" variant={status === 'unpaid' ? 'secondary' : 'ghost'} onPress={() => setStatus('unpaid')} />
                <AppButton label="Paid" variant={status === 'paid' ? 'secondary' : 'ghost'} onPress={() => setStatus('paid')} />
                <AppButton label="Archived" variant={status === 'archived' ? 'secondary' : 'ghost'} onPress={() => setStatus('archived')} />
              </View>
              <Text style={styles.helperText}>Exports are scoped to the active payer and the filters above.</Text>
            </View>
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Export range" />
          <Text style={styles.bodyText}>Exports include linked warranty files when present.</Text>
          <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
            <AppButton label="Export CSV" variant="secondary" iconName="document-outline" onPress={exportCSV} />
            <AppButton label="Export PDF report" variant="secondary" iconName="print-outline" onPress={exportPDFRange} />
            <AppButton label="Export ZIP (attachments)" variant="secondary" iconName="cloud-download-outline" onPress={exportAttachmentsZip} />
            <AppButton label="Export JSON (backup)" variant="secondary" iconName="code-outline" onPress={exportJSONRange} />
          </View>
          <Text style={[styles.mutedText, { marginTop: themeSpacing.sm }]}>Free: JSON only • Basic: CSV + JSON • Pro: CSV + PDF + ZIP + JSON</Text>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Single bill PDF" />
          {filtered.length === 0 ? (
            <Text style={styles.mutedText}>No bills match the current filters.</Text>
          ) : (
            <FlatList
              data={filtered.slice(0, 25)}
              keyExtractor={(b) => b.id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item }) => (
                <Surface elevated style={styles.billRowCard}>
                  <View style={styles.billRowHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle} numberOfLines={1}>{item.supplier}</Text>
                      <Text style={styles.mutedText}>{item.currency} {item.amount.toFixed(2)} • due {item.due_date} • {item.status}</Text>
                    </View>
                  </View>
                  <View style={styles.billActionsRow}>
                    <AppButton label="Export PDF" variant="secondary" iconName="print-outline" onPress={() => exportPDFSingle(item)} />
                  </View>
                </Surface>
              )}
            />
          )}
        </Surface>
      </View>
    </Screen>
  )
}

function PayScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const [items, setItems] = useState<Bill[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [planningDate, setPlanningDate] = useState(new Date().toISOString().slice(0,10))
  const [permissionExplained, setPermissionExplained] = useState(false)
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  useEffect(() => { (async ()=>{
    if (!permissionExplained) {
      await ensureNotificationConfig()
      const ok = await requestPermissionIfNeeded()
      if (!ok) {
        // Continue without notifications
      }
      setPermissionExplained(true)
    }
    if (spaceLoading || !space) return
    if (supabase) { const { data } = await listBills(supabase, spaceId); setItems(data) } else { const locals = await loadLocalBills(spaceId); setItems(locals as any) }
  })() }, [supabase, permissionExplained, spaceLoading, space, spaceId])
  const upcoming = items.filter(b=> b.status==='unpaid').sort((a,b)=> (a.pay_date||a.due_date).localeCompare(b.pay_date||b.due_date))
  const today = new Date().toISOString().slice(0,10)
  const thisWeekEnd = new Date(Date.now()+7*24*3600*1000).toISOString().slice(0,10)
  const groups = {
    today: upcoming.filter(b=> (b.pay_date||b.due_date)===today),
    thisWeek: upcoming.filter(b=> (b.pay_date||b.due_date)>today && (b.pay_date||b.due_date)<=thisWeekEnd),
    later: upcoming.filter(b=> (b.pay_date||b.due_date)>thisWeekEnd),
  }
  async function markPaid(b: Bill) {
    if (supabase) { const { data } = await setBillStatus(supabase!, b.id, 'paid', spaceId); if (data) setItems(prev=>prev.map(x=>x.id===b.id?data:x)) }
    else { await setLocalBillStatus(spaceId, b.id, 'paid'); setItems(prev=>prev.map((x:any)=>x.id===b.id? { ...x, status: 'paid' }:x)) }
    await cancelBillReminders(b.id, spaceId)
  }
  async function snooze(b: Bill, days: number) { await snoozeBillReminder({ ...b, space_id: spaceId } as any, days, spaceId) }
  async function planSelected() {
    const dateISO = planningDate
    const picked = upcoming.filter(b=> selected[b.id])
    if (!picked.length) { Alert.alert('Select bills', 'Pick 2+ bills to plan'); return }
    for (const b of picked) {
      if (supabase) { await setBillStatus(supabase!, b.id, b.status, spaceId) }
      // locally store pay_date using local map (since remote schema may not have it)
      setItems(prev=> prev.map(x=> x.id===b.id ? { ...x, pay_date: dateISO } as any : x))
      await scheduleBillReminders({ ...b, due_date: dateISO, space_id: spaceId } as any, undefined, spaceId)
    }
    await scheduleGroupedPaymentReminder(dateISO, picked.length, spaceId)
    Alert.alert('Planned', `Payment planned for ${picked.length} bill(s) on ${dateISO}`)
  }
  function toggleSel(id: string) { setSelected(prev=> ({ ...prev, [id]: !prev[id] })) }
  function Chip({ text }: { text: string }) {
    return (
      <View style={{ backgroundColor: '#EDF2F7', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
        <Text style={{ color: '#4A5568', fontSize: 12 }} numberOfLines={1}>
          {text}
        </Text>
      </View>
    )
  }

  if (spaceLoading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>Loading payment plan…</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen title="Pay" scroll={false}>
      <View style={styles.pageStack}>

        <Surface elevated padded={false} style={styles.paySectionCard}>
          <SectionHeader title="Batch payment" />
          <View style={styles.payBatchRow}>
            <AppInput
              placeholder="Pay YYYY-MM-DD"
              value={planningDate}
              onChangeText={setPlanningDate}
              style={{ flex: 1 }}
            />
            <AppButton
              label="Pay batch"
              iconName="card-outline"
              onPress={planSelected}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Upcoming bills" />
          {upcoming.length === 0 ? (
            <EmptyState
              title="No unpaid bills"
              message="Once you have unpaid bills, they will appear here so you can plan payments."
              iconName="checkmark-done-outline"
            />
          ) : (
            <FlatList
              data={upcoming}
              keyExtractor={(b)=>b.id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item })=> (
                <Surface elevated style={styles.billRowCard}>
                  <View style={styles.billRowHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>{item.supplier}</Text>
                      <Text style={styles.mutedText}>
                        {item.currency} {item.amount.toFixed(2)} • due {item.due_date}{item.pay_date? ` • planned ${item.pay_date}`:''}
                      </Text>
                    </View>
                    <Pressable onPress={()=>toggleSel(item.id)}>
                      <Ionicons
                        name={selected[item.id] ? 'checkbox-outline' : 'square-outline'}
                        size={20}
                        color={themeColors.primary}
                      />
                    </Pressable>
                  </View>
                  <View style={styles.billActionsRow}>
                    <Chip text={item.pay_date ? `Planned for ${item.pay_date}` : (new Date(item.due_date).getTime()-Date.now())/(24*3600*1000) < 1 ? 'Due today' : 'Upcoming reminder'} />
                    <AppButton
                      label="Mark as paid"
                      variant="secondary"
                      iconName="checkmark-circle-outline"
                      onPress={()=>markPaid(item)}
                    />
                    <AppButton
                      label="Snooze"
                      variant="secondary"
                      iconName="time-outline"
                      onPress={()=>snooze(item, 1)}
                    />
                    <AppButton
                      label="Use due date"
                      variant="ghost"
                      iconName="calendar-outline"
                      onPress={()=> setPlanningDate(item.due_date)}
                    />
                  </View>
                </Surface>
              )}
            />
          )}
        </Surface>

        <Surface elevated padded={false} style={styles.paySectionCard}>
          <SectionHeader title="Payment plan overview" />
          <View style={styles.payOverviewRow}>
            <Surface elevated padded={false} style={[styles.payOverviewCard, { flex: 1 }]}> 
              <Text style={styles.cardTitle}>Today</Text>
              <Text style={styles.bodyText}>{groups.today.length} bills</Text>
            </Surface>
            <Surface elevated padded={false} style={[styles.payOverviewCard, { flex: 1 }]}> 
              <Text style={styles.cardTitle}>This week</Text>
              <Text style={styles.bodyText}>{groups.thisWeek.length} bills</Text>
            </Surface>
            <Surface elevated padded={false} style={[styles.payOverviewCard, { flex: 1 }]}> 
              <Text style={styles.cardTitle}>Later</Text>
              <Text style={styles.bodyText}>{groups.later.length} bills</Text>
            </Surface>
          </View>
        </Surface>
      </View>
    </Screen>
  )
}

function PaymentsScreen() {
  const { snapshot: entitlements, refresh: refreshEntitlements } = useEntitlements()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const iapAvailable = ENABLE_IAP && !IS_EXPO_GO && Platform.OS !== 'web'

  async function handleSubscribe(plan: PlanId, interval: Interval) {
    if (!iapAvailable) {
      Alert.alert('Purchases unavailable', 'Purchases are available only in the store build.')
      return
    }
    const productId = resolveProductId(plan, interval)
    if (!productId) {
      Alert.alert('Payments not configured', 'Product ID is missing in environment variables.')
      return
    }
    try {
      setBusy(true)
      setStatus(null)
      const InAppPurchases = await import('expo-in-app-purchases')
      await InAppPurchases.connectAsync()
      await InAppPurchases.getProductsAsync([productId])
      await InAppPurchases.purchaseItemAsync(productId)
      const ok = await verifyIapOnBackend(productId)
      if (ok) {
        refreshEntitlements()
        setStatus('Subscription updated. Thank you!')
      } else {
        Alert.alert('Verification failed', 'We could not verify your purchase. Please try again later.')
      }
    } catch (e) {
      Alert.alert('Purchase error', 'Something went wrong while processing the purchase.')
    } finally {
      setBusy(false)
    }
  }

  async function handleRestore() {
    if (!iapAvailable) {
      Alert.alert('Purchases unavailable', 'Purchases are available only in the store build.')
      return
    }
    try {
      setBusy(true)
      setStatus(null)
      const InAppPurchases = await import('expo-in-app-purchases')
      await InAppPurchases.connectAsync()
      const { results } = await InAppPurchases.getPurchaseHistoryAsync()
      const last = Array.isArray(results) && results.length > 0 ? results[0] : null
      const productId = last?.productId
      if (!productId) {
        Alert.alert('No purchases', 'No previous purchases were found for this account.')
        return
      }
      const ok = await verifyIapOnBackend(productId)
      if (ok) {
        refreshEntitlements()
        setStatus('Purchases restored. Your plan is up to date.')
      } else {
        Alert.alert('Restore failed', 'We could not restore your purchases. Please try again later.')
      }
    } catch (e) {
      Alert.alert('Restore error', 'Something went wrong while restoring purchases.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title="Payments">
      <View style={styles.pageStack}>

        <Surface elevated>
          <SectionHeader title="Current plan" />
          <Text style={styles.bodyText}>Your plan: {entitlements.plan.toUpperCase()}</Text>
          <Text style={styles.bodyText}>
            Payers: {entitlements.payerLimit} • OCR: {entitlements.canUseOCR ? 'enabled' : 'disabled'} • Exports:{' '}
            {entitlements.exportsEnabled ? 'enabled' : 'disabled'}
          </Text>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Subscription plans" />
          <Text style={styles.bodyText}>Free: €0 • Basic: €2.20 / month or €20 / year • Pro: €4 / month or €38 / year.</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
            <AppButton
              label="Basic monthly"
              iconName="card-outline"
              onPress={() => handleSubscribe('basic', 'monthly')}
              disabled={busy}
            />
            <AppButton
              label="Basic yearly"
              variant="secondary"
              iconName="card-outline"
              onPress={() => handleSubscribe('basic', 'yearly')}
              disabled={busy}
            />
            <AppButton
              label="Pro monthly"
              variant="secondary"
              iconName="card-outline"
              onPress={() => handleSubscribe('pro', 'monthly')}
              disabled={busy}
            />
            <AppButton
              label="Pro yearly"
              variant="secondary"
              iconName="card-outline"
              onPress={() => handleSubscribe('pro', 'yearly')}
              disabled={busy}
            />
          </View>
          <View style={{ marginTop: themeSpacing.sm }}>
            <AppButton
              label="Restore purchases"
              variant="outline"
              iconName="refresh-outline"
              onPress={handleRestore}
              disabled={busy}
            />
          </View>
          {busy && (
            <View style={{ marginTop: themeSpacing.sm, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator />
              <Text style={styles.mutedText}>Processing payment…</Text>
            </View>
          )}
          {status ? (
            <View style={{ marginTop: themeSpacing.sm }}>
              <Text style={styles.bodyText}>{status}</Text>
            </View>
          ) : null}
        </Surface>
      </View>
    </Screen>
  )
}

const Tab = createBottomTabNavigator()
const Stack = createNativeStackNavigator()

function MainTabs() {
  const insets = useSafeAreaInsets()
  const bottomPadding = Math.max(insets.bottom, 12)
  const navigation = useNavigation<any>()

  return (
    <View style={{ flex: 1 }} pointerEvents="box-none">
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: themeColors.primary,
          tabBarInactiveTintColor: '#94A3B8',
          tabBarStyle: {
            borderTopColor: '#E5E7EB',
            borderTopWidth: StyleSheet.hairlineWidth,
            backgroundColor: '#FFFFFF',
            paddingTop: 4,
            paddingBottom: bottomPadding,
            height: 56 + bottomPadding,
          },
          tabBarIcon: ({ color, size }) => {
            const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
              Home: 'home-outline',
              Scan: 'scan-outline',
              Bills: 'document-text-outline',
              Pay: 'card-outline',
              Settings: 'settings-outline',
            }

            const iconName = icons[route.name] ?? 'ellipse-outline'
            return <Ionicons name={iconName} size={size} color={color} />
          },
        })}
      >
        <Tab.Screen name="Home" component={HomeScreen} />
        <Tab.Screen name="Scan" component={ScanBillScreen} />
        <Tab.Screen name="Bills" component={BillsListScreen} />
        <Tab.Screen name="Pay" component={PayScreen} />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>

      <Pressable
        onPress={() => navigation.navigate('AI Assistant')}
        style={({ pressed }) => [styles.aiFab, { bottom: 56 + bottomPadding + 16 }, pressed && { opacity: 0.92 }]}
        hitSlop={10}
      >
        <Ionicons name="chatbubble-ellipses-outline" size={18} color="#FFFFFF" />
        <Text style={styles.aiFabLabel}>Ask BillBox</Text>
      </Pressable>
    </View>
  )
}

function AIAssistantScreen() {
  const navigation = useNavigation<any>()
  const { snapshot: entitlements } = useEntitlements()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<
    Array<{ id: string; role: 'user' | 'assistant'; text: string; actions?: Array<{ label: string; route: string; params?: any }> }>
  >([
    {
      id: 'welcome',
      role: 'assistant',
      text: 'Tell me what you want to do (scan, pay, warranties, reports, exports).',
      actions: [
        { label: 'Scan a bill', route: 'Scan' },
        { label: 'Open Inbox', route: 'Inbox' },
      ],
    },
  ])

  async function send() {
    const text = draft.trim()
    if (!text || busy) return

    const now = Date.now()
    setMessages((prev) => prev.concat({ id: String(now), role: 'user', text }))
    setDraft('')
    setBusy(true)
    try {
      const base = getFunctionsBase()
      if (!base) {
        setMessages((prev) =>
          prev.concat({
            id: String(now + 1),
            role: 'assistant',
            text: 'AI is not configured in this build (missing EXPO_PUBLIC_FUNCTIONS_BASE).',
          })
        )
        return
      }
      const resp = await fetch(`${base}/.netlify/functions/ai-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          context: {
            plan: entitlements.plan,
            exportsEnabled: entitlements.exportsEnabled,
            payerLimit: entitlements.payerLimit,
          },
        }),
      })
      const json = await resp.json().catch(() => null)
      if (!resp.ok || !json) {
        setMessages((prev) => prev.concat({ id: String(now + 2), role: 'assistant', text: 'AI request failed. Please try again.' }))
        return
      }
      const assistantText = typeof json.message === 'string' ? json.message : 'Here are a few next steps.'
      const actions = Array.isArray(json.suggestedActions) ? json.suggestedActions : []
      setMessages((prev) => prev.concat({ id: String(now + 3), role: 'assistant', text: assistantText, actions }))
    } catch {
      setMessages((prev) => prev.concat({ id: String(Date.now()), role: 'assistant', text: 'AI request failed. Please try again.' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title="AI Assistant">
      <View style={styles.pageStack}>
        <Surface elevated>
          <Text style={styles.bodyText}>Ask BillBox for guidance. Suggested actions can open the right screen.</Text>
        </Surface>

        <Surface elevated padded={false}>
          <ScrollView contentContainerStyle={{ padding: themeLayout.screenPadding, gap: themeSpacing.sm }}>
            {messages.map((m) => (
              <View key={m.id} style={[styles.aiMsg, m.role === 'user' ? styles.aiMsgUser : styles.aiMsgAssistant]}>
                <Text style={[styles.bodyText, m.role === 'user' ? { color: '#FFFFFF' } : null]}>{m.text}</Text>
                {m.role === 'assistant' && Array.isArray(m.actions) && m.actions.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                    {m.actions.slice(0, 3).map((a, idx) => (
                      <AppButton
                        key={`${m.id}-${idx}`}
                        label={String(a?.label || 'Open')}
                        variant="secondary"
                        iconName="arrow-forward-outline"
                        onPress={() => {
                          const route = String((a as any)?.route || '')
                          if (!route) return
                          navigation.navigate(route, (a as any)?.params || undefined)
                        }}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            ))}
            {busy ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <ActivityIndicator />
                <Text style={styles.mutedText}>Thinking…</Text>
              </View>
            ) : null}
          </ScrollView>
        </Surface>

        <Surface elevated>
          <View style={{ flexDirection: 'row', gap: themeLayout.gap, alignItems: 'center' }}>
            <AppInput placeholder="Type your question…" value={draft} onChangeText={setDraft} style={{ flex: 1 }} />
            <AppButton label="Send" iconName="send-outline" onPress={send} disabled={busy || !draft.trim()} />
          </View>
        </Surface>
      </View>
    </Screen>
  )
}

function SettingsScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const navigation = useNavigation<any>()
  const { lang, setLang } = useLang()
  async function changeLang(l: Lang) { setLang(l) }
  const [notifStatus, setNotifStatus] = useState<string>('')
  useEffect(()=>{ (async()=>{ const p = await Notifications.getPermissionsAsync(); setNotifStatus(p.status) })() }, [])
  const spacesCtx = useSpacesContext()
  const { space } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameVisible, setRenameVisible] = useState(false)
  const [creatingPayer2, setCreatingPayer2] = useState(false)
  const [payer2NameDraft, setPayer2NameDraft] = useState('')

  const planSavings = useMemo(() => {
    const basicMonthly = 2.2
    const basicYearly = 20
    const proMonthly = 4
    const proYearly = 38
    return {
      basic: Math.max(0, Math.round((basicMonthly * 12 - basicYearly) * 100) / 100),
      pro: Math.max(0, Math.round((proMonthly * 12 - proYearly) * 100) / 100),
    }
  }, [])

  const saveRename = useCallback(async () => {
    if (!renameTarget) return
    const trimmed = renameDraft.trim()
    if (!trimmed) {
      Alert.alert('Name required', 'Please enter a name.')
      return
    }
    await spacesCtx.rename(renameTarget, trimmed)
    if (renameTarget === 'personal') {
      try { await AsyncStorage.setItem('billbox.onboarding.payer1Named', '1') } catch {}
    }
    setRenameVisible(false)
    setRenameTarget(null)
  }, [renameDraft, renameTarget, spacesCtx])

  const savePayer2 = useCallback(async () => {
    const trimmed = payer2NameDraft.trim()
    if (!trimmed) {
      Alert.alert('Name required', 'Please enter a name for Payer 2.')
      return
    }
    await spacesCtx.addSpace({ name: trimmed, kind: 'personal', plan: spacesCtx.current?.plan || 'free' })
    setCreatingPayer2(false)
  }, [payer2NameDraft, spacesCtx])

  function openLegal(path: '/privacy' | '/terms' | '/account-deletion') {
    if (!PUBLIC_SITE_URL) {
      Alert.alert('Not configured', 'Website URL is missing for this build. Configure PUBLIC_SITE_URL to open legal pages.')
      return
    }
    Linking.openURL(`${PUBLIC_SITE_URL}${path}`)
  }

  if (spacesCtx.loading || !space) {
    return (
      <Screen title="Settings" scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>Loading settings…</Text>
        </View>
      </Screen>
    )
  }
  return (
    <Screen title="Settings">
      <View style={styles.pageStack}>
        {space?.name ? (
          <Text style={[styles.mutedText, { marginBottom: themeSpacing.xs }]}>{`Workspace: ${space.name}`}</Text>
        ) : null}
        <Text style={[styles.mutedText, { marginBottom: themeSpacing.sm }]}>{t(lang, 'internal_test_build')}</Text>

        <Surface elevated>
          <SectionHeader title="Workspace" />
          <Text style={styles.bodyText}>{supabase ? 'Cloud sync enabled' : 'Offline mode (cloud sync disabled)'}</Text>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Payers" />
          {(['personal', 'personal2'] as const).map((id) => {
            const sp = spacesCtx.spaces.find((s) => s.id === id) || null
            const active = spacesCtx.current?.id === id
            const slotLabel = payerLabelFromSpaceId(id)
            const locked = id === 'personal2' && (!sp || entitlements.plan !== 'pro')

            if (!sp) {
              return (
                <View
                  key={id}
                  style={{ marginBottom: themeSpacing.xs, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 6, padding: themeSpacing.xs }}
                >
                  <Text style={{ fontWeight: '600' }}>{slotLabel}</Text>
                  <Text style={styles.mutedText}>{locked ? 'Locked (Pro only)' : 'Not created yet'}</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                    {locked ? (
                      <AppButton
                        label="Upgrade to Pro"
                        variant="secondary"
                        iconName="arrow-up-circle-outline"
                        onPress={() => {
                          if (IS_EXPO_GO) {
                            Alert.alert('Upgrade', 'Purchases are disabled in Expo Go preview. Use a store/dev build to upgrade.')
                            return
                          }
                          navigation.navigate('Payments')
                        }}
                      />
                    ) : (
                      <AppButton
                        label="Create Payer 2"
                        variant="secondary"
                        iconName="add-outline"
                        onPress={() => {
                          setCreatingPayer2(true)
                          setPayer2NameDraft('Payer 2')
                        }}
                      />
                    )}
                  </View>
                </View>
              )
            }

            return (
              <View
                key={sp.id}
                style={{ marginBottom: themeSpacing.xs, borderWidth: 1, borderColor: active ? '#2b6cb0' : '#e2e8f0', borderRadius: 6, padding: themeSpacing.xs }}
              >
                <Text style={{ fontWeight: '600' }}>{slotLabel} {active ? '• Active' : ''}</Text>
                <Text style={styles.mutedText}>Name: {sp.name || '—'}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                  {!active && (
                    <AppButton
                      label="Switch"
                      variant="secondary"
                      iconName="swap-horizontal-outline"
                      onPress={() => spacesCtx.setCurrent(sp.id)}
                    />
                  )}
                  <AppButton
                    label="Rename"
                    variant="secondary"
                    iconName="create-outline"
                    onPress={() => {
                      setRenameTarget(sp.id)
                      setRenameDraft(sp.name || '')
                      setRenameVisible(true)
                    }}
                  />
                  <AppButton
                    label="Remove"
                    variant="ghost"
                    iconName="trash-outline"
                    onPress={() => spacesCtx.remove(sp.id)}
                  />
                </View>
              </View>
            )
          })}
        </Surface>

        <Surface elevated>
          <SectionHeader title="Subscription" />
          <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.xs }}>
            <View style={[styles.planRow, entitlements.plan === 'free' && styles.planRowActive]}>
              <View style={styles.planRowHeader}>
                <Text style={styles.planRowTitle}>FREE</Text>
                {entitlements.plan === 'free' ? <Badge label="Active" tone="info" /> : null}
              </View>
              <Text style={styles.planRowItem}>• 1 payer</Text>
              <Text style={styles.planRowItem}>• Basic scan</Text>
              <Text style={styles.planRowItem}>• OCR up to 3 / month</Text>
              <Text style={styles.planRowItem}>• No exports</Text>
            </View>

            <View style={[styles.planRow, entitlements.plan === 'basic' && styles.planRowActive]}>
              <View style={styles.planRowHeader}>
                <Text style={styles.planRowTitle}>BASIC</Text>
                {entitlements.plan === 'basic' ? <Badge label="Active" tone="info" /> : null}
              </View>
              <Text style={styles.planRowItem}>• 1 payer</Text>
              <Text style={styles.planRowItem}>• Unlimited bills + warranties</Text>
              <Text style={styles.planRowItem}>• Reminders</Text>
              <Text style={styles.planRowItem}>• OCR up to 100 / month</Text>
              <Text style={styles.planRowItem}>• No exports</Text>
            </View>

            <View style={[styles.planRow, entitlements.plan === 'pro' && styles.planRowActive]}>
              <View style={styles.planRowHeader}>
                <Text style={styles.planRowTitle}>PRO</Text>
                {entitlements.plan === 'pro' ? <Badge label="Active" tone="info" /> : null}
              </View>
              <Text style={styles.planRowItem}>• 2 payers</Text>
              <Text style={styles.planRowItem}>• Separate data</Text>
              <Text style={styles.planRowItem}>• OCR up to 300 / month</Text>
              <Text style={styles.planRowItem}>• CSV + PDF + ZIP + JSON export</Text>
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, alignItems: 'center' }}>
              {entitlements.plan === 'free' ? (
                <>
                  <AppButton
                    label="Upgrade to Basic"
                    variant="secondary"
                    iconName="arrow-up-circle-outline"
                    onPress={() => {
                      if (IS_EXPO_GO) {
                        Alert.alert('Subscription', 'Purchases are disabled in Expo Go preview. Use a store/dev build to manage your subscription.')
                        return
                      }
                      navigation.navigate('Payments', { plan: 'basic' })
                    }}
                  />
                  <AppButton
                    label="Upgrade to Pro"
                    variant="secondary"
                    iconName="arrow-up-circle-outline"
                    onPress={() => {
                      if (IS_EXPO_GO) {
                        Alert.alert('Subscription', 'Purchases are disabled in Expo Go preview. Use a store/dev build to manage your subscription.')
                        return
                      }
                      navigation.navigate('Payments', { plan: 'pro' })
                    }}
                  />
                </>
              ) : entitlements.plan === 'basic' ? (
                <AppButton
                  label="Upgrade to Pro"
                  variant="secondary"
                  iconName="arrow-up-circle-outline"
                  onPress={() => {
                    if (IS_EXPO_GO) {
                      Alert.alert('Subscription', 'Purchases are disabled in Expo Go preview. Use a store/dev build to manage your subscription.')
                      return
                    }
                    navigation.navigate('Payments', { plan: 'pro' })
                  }}
                />
              ) : (
                <AppButton
                  label="Manage subscription"
                  variant="secondary"
                  iconName="arrow-up-circle-outline"
                  onPress={() => {
                    if (IS_EXPO_GO) {
                      Alert.alert('Subscription', 'Purchases are disabled in Expo Go preview. Use a store/dev build to manage your subscription.')
                      return
                    }
                    navigation.navigate('Payments')
                  }}
                />
              )}
              {entitlements.plan !== 'pro' ? (
                <Text style={styles.mutedText}>
                  {entitlements.plan === 'free'
                    ? `Save €${planSavings.basic} with yearly billing`
                    : `Save €${planSavings.pro} with yearly billing`}
                </Text>
              ) : null}
            </View>
          </View>
        </Surface>

        <Surface elevated style={{ marginTop: themeSpacing.md }}>
          <SectionHeader title="Language" />
          <View style={styles.languageGrid}>
            {(['sl', 'en', 'hr', 'it', 'de'] as Lang[]).map((code) => {
              const selected = lang === code
              const labelKey =
                code === 'sl' ? 'slovenian' : code === 'en' ? 'english' : code === 'hr' ? 'croatian' : code === 'it' ? 'italian' : 'german'
              return (
                <TouchableOpacity
                  key={code}
                  style={[styles.languageOption, selected && styles.languageOptionSelected]}
                  onPress={() => changeLang(code)}
                >
                  <Text style={[styles.languageOptionLabel, selected && styles.languageOptionLabelSelected]}>{t(lang, labelKey)}</Text>
                </TouchableOpacity>
              )
            })}
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Reminders & notifications" />
          <Text style={styles.bodyText}>Status: {notifStatus || 'unknown'}</Text>
          <Text style={[styles.bodyText, { marginTop: themeSpacing.xs }]}>Local reminders work in Expo Go. Push notifications are only available in standalone builds when enabled for this project.</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
            <AppButton
              label="Enable reminders"
              variant="secondary"
              iconName="notifications-outline"
              onPress={async ()=>{
                const ok = await requestPermissionIfNeeded()
                const p = await Notifications.getPermissionsAsync()
                setNotifStatus(p.status)
                if (!ok) {
                  Alert.alert('Enable reminders', 'Open system settings to allow notifications')
                  try { await Linking.openSettings() } catch {}
                }
              }}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Legal" />
          <Text style={styles.bodyText}>
            View the privacy policy, terms of use, and account deletion instructions in the web app.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
            <AppButton
              label="Privacy policy"
              variant="secondary"
              iconName="document-text-outline"
              onPress={() => openLegal('/privacy')}
            />
            <AppButton
              label="Terms of use"
              variant="secondary"
              iconName="list-outline"
              onPress={() => openLegal('/terms')}
            />
            <AppButton
              label="Delete account & data"
              variant="secondary"
              iconName="trash-outline"
              onPress={() => openLegal('/account-deletion')}
            />
          </View>
        </Surface>

        <Modal visible={renameVisible} transparent animationType="fade" onRequestClose={() => setRenameVisible(false)}>
          <View style={styles.iosPickerOverlay}>
            <Surface elevated style={styles.iosPickerSheet}>
              <SectionHeader title={`Rename ${payerLabelFromSpaceId(renameTarget)}`} />
              <AppInput placeholder="New name" value={renameDraft} onChangeText={setRenameDraft} />
              <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
                <AppButton label="Cancel" variant="ghost" onPress={() => setRenameVisible(false)} />
                <AppButton label="Save" iconName="checkmark-outline" onPress={saveRename} />
              </View>
            </Surface>
          </View>
        </Modal>

        <Modal visible={creatingPayer2} transparent animationType="fade" onRequestClose={() => setCreatingPayer2(false)}>
          <View style={styles.iosPickerOverlay}>
            <Surface elevated style={styles.iosPickerSheet}>
              <SectionHeader title="Create Payer 2" />
              <AppInput placeholder="Payer 2 name" value={payer2NameDraft} onChangeText={setPayer2NameDraft} />
              <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
                <AppButton label="Cancel" variant="ghost" onPress={() => setCreatingPayer2(false)} />
                <AppButton label="Create" iconName="add-outline" onPress={savePayer2} />
              </View>
            </Surface>
          </View>
        </Modal>

        {supabase && (
          <AppButton
            label="Sign out"
            variant="ghost"
            iconName="log-out-outline"
            onPress={async ()=>{ try { await supabase!.auth.signOut(); Alert.alert('Signed out'); } catch(e:any) { Alert.alert('Error', e?.message||'Failed') } }}
          />
        )}
      </View>
    </Screen>
  )
}

type AppNavigationProps = {
  loggedIn: boolean
  setLoggedIn: (value: boolean) => void
  demoMode: boolean
  setDemoMode: (value: boolean) => void
  lang: Lang
  setLang: (value: Lang) => void
  authLoading: boolean
}

function AppNavigation({ loggedIn, setLoggedIn, demoMode, setDemoMode, lang, setLang, authLoading }: AppNavigationProps) {
  const { space, spaceId, loading } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()
  const spacesCtx = useSpacesContext()
  const { initError, initTimedOut, retryInit } = useSpacesContext()
  const navRef = React.useRef<NavigationContainerRef<any>>(null)
  const lastHandled = React.useRef<string | null>(null)
  const shownInitAlert = React.useRef(false)

  useEffect(() => {
    setUpgradeHandler((plan) => {
      if (IS_EXPO_GO) {
        Alert.alert('Upgrade', 'Purchases are disabled in Expo Go preview. Use a store/dev build to upgrade.')
        return
      }
      navRef.current?.navigate('Payments', { plan })
    })
    return () => {
      setUpgradeHandler(null)
    }
  }, [])
  const handleShareUrl = useCallback(async (incoming: string | null) => {
    if (!incoming || loading || !space) return
    if (lastHandled.current === incoming) return
    lastHandled.current = incoming
    let targetUri = incoming
    let fileName = 'document'
    let mimeType: string | undefined
    if (incoming.startsWith('billbox://')) {
      try {
        const url = new URL(incoming)
        if (url.host === 'import') {
          const rawUri = url.searchParams.get('uri')
          if (!rawUri) return
          targetUri = decodeURIComponent(rawUri)
          fileName = url.searchParams.get('name') || fileName
          mimeType = url.searchParams.get('mime') || undefined
        } else {
          return
        }
      } catch {
        return
      }
    }
    if (targetUri.startsWith('content://') || targetUri.startsWith('file://')) {
      if (fileName === 'document') {
        const guessed = targetUri.split(/[\\/]/).pop()
        if (guessed) fileName = guessed
      }
      try {
        let targetSpaceId = spaceId
        if (spacesCtx.spaces.length > 1) {
          targetSpaceId = await new Promise<string | null>((resolve) => {
            const buttons = spacesCtx.spaces.map((s) => ({ text: s.name, onPress: () => resolve(s.id) }))
            buttons.push({ text: 'Cancel', style: 'cancel', onPress: () => resolve(null) } as any)
            Alert.alert('Choose payer', 'Import this file into which payer?', buttons)
          })
          if (!targetSpaceId) return
        }

        const item = await addToInbox({ spaceId: targetSpaceId, uri: targetUri, name: fileName, mimeType })
        Alert.alert('Inbox', `${item.name} added to Inbox`) 
        setTimeout(() => {
          navRef.current?.navigate('Inbox', { highlight: item.id })
        }, 250)
      } catch (e: any) {
        Alert.alert('Import failed', e?.message || 'Unable to capture document')
      }
    }
  }, [loading, space, spaceId, spacesCtx.spaces])

  useEffect(() => {
    lastHandled.current = null
  }, [spaceId])

  useEffect(() => {
    if (loading || !space) return
    let mounted = true
    ;(async () => {
      const initial = await Linking.getInitialURL()
      if (mounted) await handleShareUrl(initial)
    })()
    const sub = Linking.addEventListener('url', ({ url }) => { handleShareUrl(url) })
    return () => {
      mounted = false
      sub.remove()
    }
  }, [handleShareUrl, loading, space])

  useEffect(() => {
    if (!loggedIn) {
      shownInitAlert.current = false
      return
    }
    if (!(initTimedOut || initError)) return
    if (shownInitAlert.current) return
    shownInitAlert.current = true

    Alert.alert(
      'Payer preparation issue',
      initTimedOut ? 'Payer preparation timed out.' : 'Payer preparation failed.',
      [
        {
          text: 'Retry',
          onPress: () => {
            shownInitAlert.current = false
            retryInit()
          },
        },
        {
          text: 'Continue to Login',
          style: 'cancel',
          onPress: () => {
            setDemoMode(false)
            setLoggedIn(false)
          },
        },
      ]
    )
  }, [initError, initTimedOut, loggedIn, retryInit, setDemoMode, setLoggedIn])

  let content: React.ReactNode

  if (authLoading) {
    content = (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{t(lang, 'checking_session')}</Text>
        </View>
      </Screen>
    )
  } else if (!loggedIn) {
    content = (
      <NavigationContainer ref={navRef}>
        <Stack.Navigator>
          <Stack.Screen name="Login" options={{ headerShown: coerceBool(false) }}>
            {() => (
              <LoginScreen
                onLoggedIn={(mode) => {
                  setDemoMode(mode === 'demo')
                  setLoggedIn(true)
                }}
                lang={lang}
                setLang={(l) => {
                  setLang(l)
                  saveLang(l)
                }}
              />
            )}
          </Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>
    )
  } else if (loading || !space) {
    // Only after auth/demo: show payer prep (with timeout/error handling).
    content = (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2b6cb0" />
          <Text style={{ marginTop: 8 }}>Preparing payers…</Text>
      </View>
    )
  } else {
    content = (
      <NavigationContainer ref={navRef}>
        <Stack.Navigator>
          <>
            <Stack.Screen name="BillBox" component={MainTabs} options={{ headerShown: coerceBool(false) }} />
            <Stack.Screen name="Inbox" component={InboxScreen} options={{ headerShown: coerceBool(false) }} />
            <Stack.Screen name="Warranties" component={WarrantiesScreen} options={{ headerShown: coerceBool(false) }} />
            <Stack.Screen name="Reports" component={ReportsScreen} options={{ headerShown: coerceBool(false) }} />
            <Stack.Screen name="Exports" component={ExportsScreen} options={{ headerShown: coerceBool(false) }} />
            <Stack.Screen name="Payments" component={PaymentsScreen} options={{ headerShown: coerceBool(false) }} />
            <Stack.Screen name="AI Assistant" component={AIAssistantScreen} options={{ headerShown: coerceBool(false) }} />
            <Stack.Screen name="Bill Details" component={BillDetailsScreen} options={{ headerShown: coerceBool(false) }} />
            <Stack.Screen name="Warranty Details" component={WarrantyDetailsScreen} options={{ headerShown: coerceBool(false) }} />
          </>
        </Stack.Navigator>
      </NavigationContainer>
    )
  }

  return content
}

export default function App() {
  const supabase = useMemo(() => getSupabase(), [])
  const [loggedIn, setLoggedIn] = useState(false)
  const [demoMode, setDemoMode] = useState(false)
  const [authLoading, setAuthLoading] = useState(true)
  const [lang, setLang] = useState<Lang>('en')
  useEffect(()=>{ (async()=> setLang(await loadLang()))() }, [])
  useEffect(() => {
    let mounted = true
    if (!supabase) {
      // Always show Login/Demo first.
      setLoggedIn(false)
      setDemoMode(false)
      setAuthLoading(false)
      return
    }
    supabase.auth.getSession()
      .then(({ data }) => {
        if (mounted) {
          setLoggedIn(!!data?.session)
          setDemoMode(false)
        }
      })
      .catch(() => {
        if (mounted) {
          setLoggedIn(false)
          setDemoMode(false)
        }
      })
      .finally(() => {
        if (mounted) setAuthLoading(false)
      })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setLoggedIn(!!session)
      if (session) setDemoMode(false)
    })
    return () => {
      mounted = false
      listener?.subscription?.unsubscribe()
    }
  }, [supabase])
  useEffect(() => { (async ()=>{ 
    await ensureNotificationConfig()
    // iOS action buttons
    try {
      await (Notifications as any).setNotificationCategoryAsync?.('bill', [
        { identifier: 'SNOOZE_1', buttonTitle: 'Snooze 1 day', options: { isDestructive: false, isAuthenticationRequired: false } },
        { identifier: 'SNOOZE_3', buttonTitle: 'Snooze 3 days', options: { isDestructive: false, isAuthenticationRequired: false } },
        { identifier: 'SNOOZE_7', buttonTitle: 'Snooze 7 days', options: { isDestructive: false, isAuthenticationRequired: false } },
      ])
    } catch {}
    const sub = Notifications.addNotificationResponseReceivedListener(async (resp)=>{
      try {
        const payload = resp?.notification?.request?.content?.data as any
        const billId = payload?.bill_id
        const targetSpace = payload?.space_id || null
        const action = resp?.actionIdentifier
        if (!billId || !action) return
        const days = action==='SNOOZE_1' ? 1 : action==='SNOOZE_3' ? 3 : action==='SNOOZE_7' ? 7 : 0
        if (days>0) {
          // Construct lightweight bill for snooze
          const fake: any = { id: billId, supplier: 'Bill', amount: 0, currency: 'EUR', due_date: new Date().toISOString().slice(0,10), status: 'unpaid', space_id: targetSpace }
          await snoozeBillReminder(fake, days, targetSpace)
        }
      } catch {}
    })
    const isExpoGo = (Constants as any)?.appOwnership === 'expo' || (Constants as any)?.executionEnvironment === 'storeClient'
    if (ENABLE_PUSH_NOTIFICATIONS && !isExpoGo) {
      try {
        const granted = await requestPermissionIfNeeded()
        if (granted) {
          try {
            const token = await Notifications.getExpoPushTokenAsync()
            // For now we just log the token; server-side registration will be added in V2.
            console.log('Expo push token', (token as any)?.data || token)
          } catch (e) {
            console.warn('Push token fetch failed', e)
          }
        }
      } catch (e) {
        console.warn('Push registration failed', e)
      }
    }
    return () => { sub && Notifications.removeNotificationSubscription(sub) }
  })() }, [])

  const setLangAndSave = useCallback((value: Lang) => {
    setLang(value)
    saveLang(value)
  }, [])

  return (
    <LangContext.Provider value={{ lang, setLang: setLangAndSave }}>
      <EntitlementsProvider supabase={supabase}>
        <SpaceProvider enabled={loggedIn} demoMode={demoMode}>
          <SafeAreaView style={{ flex: 1 }}>
            <StatusBar style="dark" />
            <AppNavigation loggedIn={loggedIn} setLoggedIn={setLoggedIn} demoMode={demoMode} setDemoMode={setDemoMode} lang={lang} setLang={setLangAndSave} authLoading={authLoading} />
          </SafeAreaView>
        </SpaceProvider>
      </EntitlementsProvider>
    </LangContext.Provider>
  )
}

const styles = StyleSheet.create({
  loginSafeArea: { flex: 1, backgroundColor: themeColors.background },
  loginKeyboard: { flex: 1 },
  loginScroll: { flexGrow: 1, padding: themeLayout.screenPadding, paddingTop: themeSpacing.xl, paddingBottom: themeSpacing.xl },
  loginWrapper: { flexGrow: 1, gap: themeSpacing.lg },
  loginHeader: { alignItems: 'center', gap: themeSpacing.sm },
  loginLogo: { width: 56, height: 56, borderRadius: 28, backgroundColor: themeColors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  loginLogoImage: { width: 34, height: 34 },
  loginTitle: { fontSize: 24, fontWeight: '700', color: themeColors.text },
  loginSubtitle: { fontSize: 15, color: themeColors.textMuted, textAlign: 'center' },
  feedbackBanner: { alignSelf: 'stretch' },
  authCard: { gap: themeSpacing.md },
  authCardTitle: { fontSize: 20, fontWeight: '700', color: themeColors.text },
  authCardSubtitle: { fontSize: 14, color: themeColors.textMuted },
  authForm: { gap: themeSpacing.sm },
  authHintPressable: { marginTop: themeSpacing.xs },
  authHintText: { fontSize: 13, color: themeColors.textMuted },
  authPrimaryButton: { marginTop: themeSpacing.sm },
  authDivider: { marginVertical: themeSpacing.sm },
  socialStack: { gap: themeSpacing.sm },
  authLinks: { marginTop: themeSpacing.md, gap: themeSpacing.xs, alignItems: 'flex-start' },
  authLink: { color: themeColors.primary, fontWeight: '600' },
  languageCard: { gap: themeSpacing.md },
  languageTitle: { fontSize: 16, fontWeight: '600', color: themeColors.text },
  languageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: themeSpacing.sm },
  languageOption: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border, backgroundColor: themeColors.surface },
  languageOptionSelected: { backgroundColor: themeColors.primary, borderColor: themeColors.primary },
  languageOptionLabel: { fontSize: 14, color: themeColors.textMuted, fontWeight: '500' },
  languageOptionLabelSelected: { color: '#FFFFFF' },
  container: { flex: 1, padding: themeLayout.screenPadding },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: themeLayout.screenPadding },
  pageStack: { flex: 1, gap: themeSpacing.sm },
  screenHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: themeSpacing.sm, gap: themeLayout.gap },
  screenHeaderText: { flexShrink: 1, gap: 2 },
  screenHeaderTitle: { fontSize: 18, fontWeight: '700', color: themeColors.text },
  screenHeaderSubtitle: { fontSize: 12, color: themeColors.textMuted },
  screenHeaderTrailing: { marginLeft: 'auto' },
  primaryBtn: { backgroundColor: themeColors.primary, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '600' },
  secondaryBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: '#EEF2FF' },
  secondaryBtnActive: { backgroundColor: themeColors.primary },
  secondaryBtnText: { color: '#1F2937', fontWeight: '600' },
  secondaryBtnTextActive: { color: '#FFFFFF' },
  inboxControlsRow: { flexDirection: 'row', gap: themeLayout.gap, flexWrap: 'wrap', alignItems: 'center' },
  inboxFilterRow: { flexDirection: 'row', gap: 8 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 16 },
  sectionTitle: { fontSize: 20, fontWeight: '600', marginBottom: 10 },
  card: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, padding: 10, marginBottom: 6, backgroundColor: '#FFFFFF' },
  cardTitle: { fontSize: 16, fontWeight: '600', color: '#111827' },
  bodyText: { fontSize: 14, color: '#374151' },
  mutedText: { fontSize: 12, color: '#9CA3AF' },
  listContent: { paddingBottom: themeSpacing.xxl + themeSpacing.xxl + themeSpacing.xl },

  aiFab: {
    position: 'absolute',
    right: themeLayout.screenPadding,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: themeColors.primary,
  },
  aiFabLabel: { color: '#FFFFFF', fontWeight: '700' },
  aiMsg: { borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 },
  aiMsgUser: { alignSelf: 'flex-end', backgroundColor: themeColors.primary },
  aiMsgAssistant: { alignSelf: 'flex-start', backgroundColor: themeColors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border },

  brandEmptyWrap: { marginTop: themeSpacing.lg, alignItems: 'center', gap: themeSpacing.md },
  wordmarkEmpty: { height: 26, width: 180 },
  wordmarkOnboarding: { height: 22, width: 160, alignSelf: 'flex-start' },
  wordmarkSettingsHeader: { height: 22, width: 160, alignSelf: 'flex-start', marginTop: themeSpacing.xs },

  // Inbox
  inboxHeroCard: { marginTop: themeSpacing.sm, marginBottom: themeSpacing.md },
  inboxHeroRow: { flexDirection: 'row', gap: themeLayout.gap, marginBottom: themeSpacing.md, alignItems: 'flex-start' },
  inboxHeroIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center' },
  segmentWrap: { marginBottom: themeSpacing.md },
  inboxItemCard: { marginBottom: themeSpacing.md },
  inboxItemHighlighted: { borderWidth: 1, borderColor: '#22C55E' },
  inboxItemHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: themeSpacing.sm, gap: themeLayout.gap },
  inboxExtractedBlock: { marginTop: themeSpacing.sm },
  inboxExtractedTitle: { fontSize: 13, fontWeight: '600', color: '#111827', marginBottom: 2 },
  inboxActionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm },
  inboxSecondaryActionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs, justifyContent: 'flex-end' },

  // Bills list
  filtersCard: { paddingHorizontal: themeLayout.cardPadding, paddingVertical: themeSpacing.sm },
  filtersHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeLayout.gap },
  filtersHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: themeSpacing.xs, flexShrink: 1 },
  filtersHeaderLabel: { fontSize: 12, color: '#4B5563' },
  filtersBody: { gap: themeSpacing.sm, marginTop: themeSpacing.sm },
  filterRow: { flexDirection: 'row', gap: themeLayout.gap },
  dateFilterSection: { gap: themeSpacing.xs },
  filterLabel: { fontSize: 12, fontWeight: '600', color: '#1F2937' },
  dateRow: { flexDirection: 'row', gap: themeLayout.gap },
  dateButton: { flexDirection: 'row', alignItems: 'center', gap: themeSpacing.xs, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border, backgroundColor: '#FFFFFF' },
  dateButtonText: { fontSize: 13, color: themeColors.text },
  manualDateRow: { flexDirection: 'row', gap: themeLayout.gap },
  filterToggleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap },
  filterToggle: { flexDirection: 'row', alignItems: 'center', gap: themeSpacing.xs },
  toggleLabel: { fontSize: 12, color: '#374151' },
  filtersFooter: { flexDirection: 'row', justifyContent: 'flex-end' },
  listMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: themeLayout.gap },
  listMetaText: { fontSize: 13, fontWeight: '600', color: '#111827' },
  listMetaSecondary: { fontSize: 12, color: '#6B7280' },
  listWrapper: { flex: 1 },
  emptyListContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: themeSpacing.lg, paddingBottom: themeSpacing.xxl + themeSpacing.xl },
  emptyStateWrapper: { marginTop: themeSpacing.lg },
  billsPrimaryActionsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  billCard: { marginBottom: themeSpacing.sm, borderRadius: 12, padding: themeLayout.cardPadding, backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border },
  billHighlighted: { borderColor: themeColors.primary, borderWidth: 2 },
  billCardPressable: { flex: 1, gap: themeSpacing.sm },
  billCardPressed: { opacity: 0.86 },
  billHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: themeLayout.gap },
  billSupplier: { fontSize: 15, fontWeight: '600', color: '#111827', flex: 1 },
  billAmount: { fontSize: 15, fontWeight: '700', color: themeColors.primary },
  billMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: themeSpacing.sm },
  billMetaGroup: { flexDirection: 'row', alignItems: 'center', gap: themeSpacing.xs },
  billMetaText: { fontSize: 12, color: '#4B5563' },
  billMetaSecondary: { fontSize: 12, color: '#6B7280' },
  attachmentPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: 'rgba(30, 78, 216, 0.12)' },
  attachmentText: { fontSize: 12, color: themeColors.primary },
  fab: { position: 'absolute', right: themeSpacing.xl, bottom: isIOS ? themeSpacing.xl : themeSpacing.xxl + themeSpacing.lg },
  iosPickerOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(15, 23, 42, 0.35)', justifyContent: 'flex-end', padding: themeLayout.screenPadding },
  iosPickerSheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: themeSpacing.lg, gap: themeSpacing.md },
  iosPickerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap },
  billRowCard: { marginBottom: themeSpacing.sm },
  billRowHighlighted: { borderWidth: 1, borderColor: '#22C55E' },
  billRowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: themeLayout.gap, flexWrap: 'wrap' },
  billActionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: themeSpacing.xs, marginTop: themeSpacing.xs },

  // Add bill
  helperText: { fontSize: 12, color: '#6B7280', marginTop: themeSpacing.xs },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-start', gap: themeLayout.gap, marginTop: themeSpacing.sm },
  cameraCard: { marginTop: themeSpacing.xs, marginBottom: themeSpacing.sm },
  captureCard: { gap: themeSpacing.xs },
  capturePlaceholder: { alignItems: 'center', justifyContent: 'center', gap: themeSpacing.sm, paddingVertical: themeSpacing.sm },
  captureMessage: { fontSize: 14, color: themeColors.textMuted, textAlign: 'center' },
  captureActions: { flexDirection: 'row', flexWrap: 'wrap', gap: themeSpacing.sm, justifyContent: 'center' },
  cameraFrame: { borderRadius: 16, overflow: 'hidden', backgroundColor: '#000', position: 'relative' },
  cameraPreview: { height: 190, width: '100%' },
  cameraOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  cameraFocusBox: { width: '70%', height: '55%', borderRadius: 16, borderWidth: 2, borderColor: '#FFFFFFAA' },
  cameraActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start', gap: themeLayout.gap, marginTop: themeSpacing.xs },
  formCard: { gap: themeSpacing.sm },
  formIntro: { fontSize: 13, color: themeColors.textMuted },
  formNotice: { alignSelf: 'stretch' },
  formSection: { gap: themeSpacing.sm },
  formSectionTitle: { fontSize: 13, fontWeight: '600', color: themeColors.textMuted, textTransform: 'uppercase' },
  formStack: { gap: themeSpacing.sm },
  formRow: { flexDirection: 'row', gap: themeLayout.gap },
  flex1: { flex: 1 },
  currencyInput: { width: 96 },
  datePickerContainer: { marginTop: themeSpacing.sm, gap: themeLayout.gap },
  datePickerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap },
  formDivider: { marginVertical: themeSpacing.sm },
  attachmentButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap },
  saveButton: { marginTop: themeSpacing.md },
  attachmentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm },
  attachmentPreview: { marginTop: themeSpacing.sm, gap: themeLayout.gap },
  attachmentImage: { width: 160, height: 120, borderRadius: 12 },
  codeBlock: { marginTop: themeSpacing.xs, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 12, color: '#374151' },

  // Home tiles
  gridWrap: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  statCardPressable: { width: '48%', height: 104, marginBottom: themeSpacing.sm },
  statCardPressed: { opacity: 0.9 },
  homeSummaryCard: { padding: themeSpacing.sm },
  statCard: { paddingVertical: themeSpacing.xs, paddingHorizontal: themeSpacing.sm, gap: themeSpacing.xs, flex: 1, justifyContent: 'space-between' },
  statCardPrimary: { borderWidth: 1, borderColor: themeColors.primary },
  statIconWrap: { width: 28, height: 28, borderRadius: 14, backgroundColor: themeColors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  statLabel: { fontSize: 13, fontWeight: '600', color: themeColors.text },
  statValue: { fontSize: 11, color: themeColors.textMuted },

  payerNameTitle: { fontSize: 16, fontWeight: '600', color: themeColors.text },
  payerSlotLabel: { fontSize: 12, color: themeColors.textMuted },

  planRow: { borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border, borderRadius: 12, padding: themeSpacing.sm, backgroundColor: '#FFFFFF' },
  planRowActive: { borderColor: themeColors.primary, borderWidth: 1 },
  planRowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: themeSpacing.xs },
  planRowTitle: { fontSize: 13, fontWeight: '700', color: themeColors.text },
  planRowItem: { fontSize: 13, color: themeColors.textMuted },

  // Pay
  paySectionCard: { padding: themeSpacing.sm },
  payBatchRow: { flexDirection: 'row', alignItems: 'center', gap: themeSpacing.xs, flexWrap: 'wrap' },
  payOverviewRow: { flexDirection: 'row', gap: themeSpacing.xs },
  payOverviewCard: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 10, paddingVertical: themeSpacing.sm, paddingHorizontal: themeSpacing.sm, backgroundColor: '#FFFFFF' },
})
