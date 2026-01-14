/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AppState, FlatList, RefreshControl, StyleSheet, Text as RNText, Button, View, Platform, Linking, Image, Switch, ActivityIndicator, Pressable, KeyboardAvoidingView, TextInput, ScrollView, TouchableOpacity, Modal, Animated, PanResponder } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
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
import { colors as themeColors, layout as themeLayout, spacing as themeSpacing, ThemeProvider, useTheme } from './src/ui/theme'
import type { Lang } from './src/i18n'
import { t, loadLang, saveLang, getCurrentLang } from './src/i18n'
import type { InboxItem } from './src/inbox'
import { listInbox, addToInbox, updateInboxItem, removeInboxItem, clearInbox } from './src/inbox'
import { ensureNotificationConfig, requestPermissionIfNeeded, scheduleBillReminders, cancelBillReminders, snoozeBillReminder, scheduleGroupedPaymentReminder, scheduleWarrantyReminders, cancelWarrantyReminders, scheduleInboxReviewReminder, cancelInboxReviewReminder } from './src/reminders'
import { ENABLE_PUSH_NOTIFICATIONS, PUBLIC_SITE_URL, ENABLE_IAP } from './src/env'
import type { Space, SpacePlan } from './src/spaces'
import { ensureDefaults as ensureSpacesDefaults, upsertSpace, removeSpace, loadCurrentSpaceId, saveCurrentSpaceId, loadSpaces } from './src/spaces'
import { showUpgradeAlert, setUpgradeNavigation, setUpgradePrompt, type EntitlementsSnapshot, type PlanId, useEntitlements, EntitlementsProvider } from './src/entitlements'

const BRAND_WORDMARK = require('./assets/logo/logo-wordmark.png')
const BRAND_ICON = require('./assets/logo/logo-icon.png')

function tr(key: string, vars?: any): string {
  return t(getCurrentLang(), key, vars)
}

function translateStringPreserveSpace(input: string): string {
  if (!input) return input
  if (!input.trim()) return input
  const leading = input.match(/^\s*/)?.[0] || ''
  const trailing = input.match(/\s*$/)?.[0] || ''
  const core = input.trim()
  return leading + tr(core) + trailing
}

function Text(props: any) {
  const { children, accessibilityLabel, ...rest } = props || {}
  const translatedChildren = Array.isArray(children)
    ? children.map((c) => (typeof c === 'string' ? translateStringPreserveSpace(c) : c))
    : typeof children === 'string'
      ? translateStringPreserveSpace(children)
      : children
  const translatedAccessibilityLabel = typeof accessibilityLabel === 'string' ? tr(accessibilityLabel) : accessibilityLabel
  return (
    <RNText accessibilityLabel={translatedAccessibilityLabel} {...rest}>
      {translatedChildren}
    </RNText>
  )
}

// Centralized translation for all alert dialogs.
// This keeps the UI fully localized without touching every call site.
const __originalAlert = Alert.alert.bind(Alert)
;(Alert as any).alert = (
  title: string,
  message?: string,
  buttons?: any,
  options?: any
) => {
  const lang = getCurrentLang()
  const mappedButtons = Array.isArray(buttons)
    ? buttons.map((b) => (typeof b?.text === 'string' ? { ...b, text: t(lang, b.text) } : b))
    : buttons
  return __originalAlert(
    typeof title === 'string' ? t(lang, title) : title,
    typeof message === 'string' ? t(lang, message) : message,
    mappedButtons,
    options
  )
}

type AiChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

type AiTip = {
  id: string
  text: string
  action?: AiSuggestedAction
}

type AiSuggestedAction = {
  label: string
  route: string
  params?: any | null
}

type LangContextValue = {
  lang: Lang
  setLang: (value: Lang) => void
}

const LangContext = React.createContext<LangContextValue | null>(null)

function useLangContext(): LangContextValue {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('LangContext is not available')
  return ctx
}

function TabTopBar({ titleKey, title, left, right }: { titleKey?: string; title?: string; left?: React.ReactNode; right?: React.ReactNode }) {
  const { lang } = useLangContext()
  return (
    <View style={styles.tabTopBar}>
      <View style={styles.tabTopBarLeft}>
        {left ? <View style={{ marginRight: themeSpacing.xs }}>{left}</View> : null}
        <Image source={BRAND_ICON} style={styles.tabTopBarLogo} resizeMode="contain" accessibilityLabel="BILLBOX" />
        <Text style={styles.tabTopBarTitle}>{title ? title : t(lang, titleKey || '')}</Text>
      </View>
      {right ? <View style={styles.tabTopBarRight}>{right}</View> : <View style={styles.tabTopBarRight} />}
    </View>
  )
}

function AiAssistant({ context }: { context: any }) {
  const navigation = useNavigation<any>()
  const { colors } = useTheme()
  const { lang } = useLangContext()
  const insets = useSafeAreaInsets()
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [tips, setTips] = useState<AiTip[]>([])
  const [aiActions, setAiActions] = useState<AiSuggestedAction[]>([])
  const lastTipsScreenRef = useRef<string>('')

  const bottomBarHeight = 56 + Math.max(insets.bottom, 12)

  const dedupeActions = useCallback((actions: AiSuggestedAction[]): AiSuggestedAction[] => {
    const out: AiSuggestedAction[] = []
    const seen = new Set<string>()
    for (const a of actions) {
      if (!a || !a.route) continue
      const route = String(a.route)
      const paramsKey = a.params ? JSON.stringify(a.params) : ''
      const key = `${route}|${paramsKey}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ...a, route })
    }
    return out
  }, [])

  const pushLocalTips = useCallback(
    (seed: number) => {
      const tipsByScreen: Record<string, { tipKey: string; action?: AiSuggestedAction }[]> = {
        Home: [
          {
            tipKey: 'Use “Scan bill” to capture a payment QR and auto-fill IBAN, reference, and amount.',
            action: { label: t(lang, 'Scan bill'), route: 'Scan' },
          },
          {
            tipKey: 'If you have many bills, use Filters to quickly find overdue or unpaid ones.',
            action: { label: t(lang, 'Open Bills'), route: 'Bills' },
          },
          { tipKey: 'Add due dates so reminders can be scheduled automatically.', action: { label: t(lang, 'Open Bills'), route: 'Bills' } },
        ],
        Bills: [
          { tipKey: 'Tap Filters to narrow by date range, supplier, amount, status, or attachments.' },
          { tipKey: 'Mark bills as paid to keep your totals accurate.' },
          { tipKey: 'Attach a PDF/photo so you can always find the original later.' },
        ],
        Pay: [
          { tipKey: 'Plan payments by selecting upcoming bills and setting a Pay date.' },
          { tipKey: 'Use “Use due date” to quickly set a planning date.' },
        ],
        Settings: [
          { tipKey: 'Rename “Profil 1/2” so your workspace is easier to navigate.' },
          { tipKey: 'If something looks untranslated, switch language and back to refresh UI strings.' },
        ],
      }

      const screenKey = String(context?.screen || '')
      lastTipsScreenRef.current = screenKey
      const pool = tipsByScreen[screenKey] || tipsByScreen.Home
      const pick = pool[seed % pool.length]
      const second = pool[(seed + 1) % pool.length]

      const nextTips: AiTip[] = [pick, second].map((t0, idx) => ({
        id: `tip_${seed}_${idx}`,
        text: t(lang, t0.tipKey),
        action: t0.action,
      }))
      setTips(nextTips)
      const actions = dedupeActions(nextTips.map((x) => x.action).filter(Boolean) as AiSuggestedAction[]).slice(0, 3)
      setAiActions(actions)
    },
    [context?.screen, dedupeActions, lang]
  )

  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_evt, gesture) => Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3,
        onPanResponderGrant: () => {
          pan.setOffset({ x: (pan as any).x._value, y: (pan as any).y._value })
          pan.setValue({ x: 0, y: 0 })
        },
        onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
        onPanResponderRelease: () => {
          pan.flattenOffset()
        },
      }),
    [pan]
  )

  const callAi = useCallback(
    async (text: string) => {
      const base = getFunctionsBase()
      if (!base) {
        setMessages((prev) => prev.concat([{ id: `a_${Date.now()}`, role: 'assistant', text: t(lang, 'AI is not available right now.') }]))
        return
      }

      setBusy(true)
      try {
        const resp = await fetch(`${base}/.netlify/functions/ai-assistant`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, context: context || {} }),
        })
        const json = await resp.json().catch(() => null)
        if (!resp.ok || !json) {
          setMessages((prev) => prev.concat([{ id: `a_${Date.now()}`, role: 'assistant', text: t(lang, 'AI request failed.') }]))
          return
        }

        const assistantText = String(json.message || '').trim() || t(lang, 'Here are a few helpful next steps.')
        const actions = Array.isArray(json.suggestedActions) ? json.suggestedActions : []

        setMessages((prev) => prev.concat([{ id: `a_${Date.now()}`, role: 'assistant', text: assistantText }]))
        setAiActions(dedupeActions(actions as any).slice(0, 3))
      } catch (e: any) {
        setMessages((prev) => prev.concat([{ id: `a_${Date.now()}`, role: 'assistant', text: t(lang, 'AI request failed.') }]))
      } finally {
        setBusy(false)
      }
    },
    [context, dedupeActions, lang]
  )

  const open = useCallback(() => {
    setVisible(true)
    if (!tips.length || lastTipsScreenRef.current !== String(context?.screen || '')) {
      pushLocalTips(Date.now())
    }
  }, [context?.screen, pushLocalTips, tips.length])

  const newChat = useCallback(() => {
    setInput('')
    setBusy(false)
    setMessages([])
    setAiActions([])
    pushLocalTips(Date.now())
  }, [pushLocalTips])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setMessages((prev) => prev.concat([{ id: `u_${Date.now()}`, role: 'user', text }]))
    void callAi(text)
  }, [busy, callAi, input])

  const displayActions = useMemo(() => {
    const fromTips = tips.map((x) => x.action).filter(Boolean) as AiSuggestedAction[]
    return dedupeActions([...(aiActions || []), ...fromTips]).slice(0, 3)
  }, [aiActions, dedupeActions, tips])

  return (
    <>
      <Animated.View
        {...panResponder.panHandlers}
        style={[
          {
            position: 'absolute',
            right: themeSpacing.lg,
            bottom: bottomBarHeight + themeSpacing.md,
            transform: pan.getTranslateTransform(),
            zIndex: 50,
          },
        ]}
      >
        <TouchableOpacity
          onPress={open}
          activeOpacity={0.88}
          style={{
            width: 46,
            height: 46,
            borderRadius: 23,
            backgroundColor: colors.primary,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Ionicons name="sparkles-outline" size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </Animated.View>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}> 
          <Surface elevated style={{ width: '100%', maxWidth: 520, alignSelf: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeSpacing.sm }}>
              <Text style={styles.screenHeaderTitle}>{t(lang, 'AI assistant')}</Text>
              <View style={{ flexDirection: 'row', gap: themeSpacing.xs }}>
                <AppButton label={t(lang, 'New chat')} variant="ghost" iconName="add-outline" onPress={newChat} />
                <AppButton label={t(lang, 'Close')} variant="ghost" iconName="close-outline" onPress={() => setVisible(false)} />
              </View>
            </View>

            {displayActions.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
                {displayActions.map((a, idx) => (
                  <AppButton
                    key={`${a.label}_${idx}`}
                    label={String(a.label || t(lang, 'Open'))}
                    variant="secondary"
                    iconName="navigate-outline"
                    onPress={() => {
                      setVisible(false)
                      try {
                        navigation.navigate(String(a.route), a.params || undefined)
                      } catch {}
                    }}
                  />
                ))}
              </View>
            ) : null}

            {tips.length ? (
              <View style={{ marginTop: themeSpacing.sm }}>
                <Text style={[styles.mutedText, { fontWeight: '700' }]}>{t(lang, 'Tips')}</Text>
                <View style={{ marginTop: themeSpacing.xs, gap: themeSpacing.xs }}>
                  {tips.map((tip) => (
                    <View
                      key={tip.id}
                      style={{
                        paddingVertical: 10,
                        paddingHorizontal: 12,
                        borderRadius: 14,
                        backgroundColor: 'rgba(148, 163, 184, 0.10)',
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: colors.border,
                      }}
                    >
                      <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{tip.text}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            <View style={{ marginTop: themeSpacing.sm, maxHeight: 360 }}>
              <Text style={[styles.mutedText, { fontWeight: '700' }]}>{t(lang, 'Answers')}</Text>
              <ScrollView contentContainerStyle={{ gap: themeSpacing.xs, paddingVertical: themeSpacing.xs }}>
                {messages.length === 0 ? (
                  <Text style={styles.mutedText}>{t(lang, 'Ask a question to get an answer.')}</Text>
                ) : null}
                {messages.map((m) => (
                  <View
                    key={m.id}
                    style={{
                      alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                      maxWidth: '92%',
                      paddingVertical: 10,
                      paddingHorizontal: 12,
                      borderRadius: 14,
                      backgroundColor: m.role === 'user' ? colors.primarySoft : 'rgba(148, 163, 184, 0.14)',
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: colors.border,
                    }}
                  >
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{m.text}</Text>
                  </View>
                ))}
                {busy ? <Text style={styles.mutedText}>{t(lang, 'Thinking…')}</Text> : null}
              </ScrollView>
            </View>

            <Divider style={{ marginTop: themeSpacing.sm }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: themeSpacing.xs, marginTop: themeSpacing.sm }}>
              <AppInput
                placeholder={t(lang, 'Ask a question…')}
                value={input}
                onChangeText={setInput}
                style={{ flex: 1 }}
              />
              <AppButton label={t(lang, 'Send')} iconName="send-outline" onPress={send} disabled={busy} />
            </View>
          </Surface>
        </View>
      </Modal>
    </>
  )
}

function payerLabelFromSpaceId(spaceId: string | null | undefined): 'Profil 1' | 'Profil 2' {
  return spaceId === 'personal2' ? 'Profil 2' : 'Profil 1'
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
  if (plan === 'pro') return 'Več'
  if (plan === 'basic') return 'Moje'
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

async function setBillDueDate(
  supabase: SupabaseClient,
  id: string,
  due_date: string,
  _spaceId?: string | null,
): Promise<{ data: Bill | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase
    .from('bills')
    .update({ due_date })
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

// --- Installment obligations (local-only, per-space) ---
// Stored locally so it persists across app updates even without Supabase.
type InstallmentObligation = {
  id: string
  created_at: string
  space_id: string
  title: string
  amount: number
  currency: string
  start_month: string // YYYY-MM
  due_day: number // 1-31 (clamped per month)
  creditor_name?: string | null
  iban?: string | null
  reference?: string | null
  purpose?: string | null
  end_month?: string | null // YYYY-MM, optional
}

const LS_INSTALLMENTS_PREFIX = 'billbox.local.installments.'

function installmentsKey(spaceId?: string | null) {
  return `${LS_INSTALLMENTS_PREFIX}${normalizeSpaceId(spaceId)}`
}

async function loadLocalInstallments(spaceId?: string | null): Promise<InstallmentObligation[]> {
  try {
    const raw = await AsyncStorage.getItem(installmentsKey(spaceId))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

async function saveLocalInstallments(spaceId: string | null | undefined, items: InstallmentObligation[]): Promise<void> {
  try {
    await AsyncStorage.setItem(installmentsKey(spaceId), JSON.stringify(items))
  } catch {}
}

async function addLocalInstallment(spaceId: string | null | undefined, input: Omit<InstallmentObligation, 'id' | 'created_at' | 'space_id'>): Promise<InstallmentObligation> {
  const items = await loadLocalInstallments(spaceId)
  const now = new Date().toISOString()
  const obligation: InstallmentObligation = {
    id: `inst_${Math.random().toString(36).slice(2)}`,
    created_at: now,
    space_id: normalizeSpaceId(spaceId),
    ...input,
  }
  items.unshift(obligation)
  await saveLocalInstallments(spaceId, items)
  return obligation
}

const INSTALLMENT_BILL_TAG = '#bbx:installment'

function installmentBillMarker(obligationId: string, month: string): string {
  return `${INSTALLMENT_BILL_TAG}:${obligationId}:${month}`
}

function isInstallmentBill(bill: Bill): boolean {
  const hay = `${bill.reference || ''}\n${bill.purpose || ''}`
  return hay.includes(INSTALLMENT_BILL_TAG)
}

function monthKeyFromDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function addMonthsToYYYYMM(yyyyMm: string, delta: number): string {
  const parts = yyyyMm.split('-')
  const y = Number(parts[0])
  const m = Number(parts[1])
  if (!y || !m) return yyyyMm
  const base = new Date(y, m - 1, 1)
  base.setMonth(base.getMonth() + delta)
  return monthKeyFromDate(base)
}

function compareYYYYMM(a: string, b: string): number {
  return a.localeCompare(b)
}

function daysInMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate()
}

function dueDateForMonth(yyyyMm: string, dueDay: number): string {
  const [yRaw, mRaw] = yyyyMm.split('-')
  const y = Number(yRaw)
  const m = Number(mRaw)
  const dim = daysInMonth(y, m)
  const day = Math.min(Math.max(1, Math.floor(dueDay || 1)), dim)
  const mm = String(m).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

async function ensureInstallmentBills(params: {
  spaceId: string
  supabase: SupabaseClient | null
  existingBills: Bill[]
  horizonMonths?: number
}): Promise<Bill[]> {
  const { spaceId, supabase, existingBills } = params
  const horizonMonths = Math.max(0, Math.min(24, params.horizonMonths ?? 2))
  const obligations = await loadLocalInstallments(spaceId)
  if (!obligations.length) return existingBills

  const nowYm = monthKeyFromDate(new Date())

  const horizon: string[] = []
  for (let i = 0; i <= horizonMonths; i += 1) horizon.push(addMonthsToYYYYMM(nowYm, i))

  const enumerateRange = (start: string, end: string, limit = 240): string[] => {
    const out: string[] = []
    if (!start || !end) return out
    let cur = start
    for (let i = 0; i < limit; i += 1) {
      if (compareYYYYMM(cur, end) > 0) break
      out.push(cur)
      cur = addMonthsToYYYYMM(cur, 1)
    }
    return out
  }

  const created: Bill[] = []
  const hasMarker = (b: Bill, marker: string) => {
    const hay = `${b.reference || ''}\n${b.purpose || ''}`
    return hay.includes(marker)
  }

  for (const ob of obligations) {
    const months = ob.end_month ? enumerateRange(ob.start_month, ob.end_month) : horizon
    for (const ym of months) {
      if (compareYYYYMM(ym, ob.start_month) < 0) continue
      if (ob.end_month && compareYYYYMM(ym, ob.end_month) > 0) continue

      const marker = installmentBillMarker(ob.id, ym)
      const already = existingBills.some((b) => hasMarker(b, marker)) || created.some((b) => hasMarker(b, marker))
      if (already) continue

      const due = dueDateForMonth(ym, ob.due_day)
      const purposeLines = [
        ob.purpose ? String(ob.purpose) : '',
        `${INSTALLMENT_BILL_TAG}: ${ob.title} (${ym})`,
        marker,
      ].filter((x) => String(x || '').trim().length > 0)

      const input: CreateBillInput = {
        supplier: ob.title,
        amount: ob.amount,
        currency: ob.currency || 'EUR',
        due_date: due,
        status: 'unpaid',
        creditor_name: ob.creditor_name || null,
        iban: ob.iban || null,
        reference: ob.reference || null,
        purpose: purposeLines.join('\n'),
        space_id: spaceId,
      }

      try {
        if (supabase) {
          const { data, error } = await createBill(supabase, input)
          if (error) throw error
          if (data) created.push(data)
        } else {
          const b = await addLocalBill(spaceId, input)
          created.push(b as any)
        }
      } catch {
        // Best-effort: skip failures; next refresh can retry.
      }
    }
  }

  return created.length ? existingBills.concat(created) : existingBills
}

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

async function setLocalBillDueDate(spaceId: string | null | undefined, id: string, due_date: string): Promise<void> {
  const items = await loadLocalBills(spaceId)
  await saveLocalBills(spaceId, items.map((b) => (b.id === id ? { ...b, due_date } : b)))
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

function SpaceProvider({ children }: { children: React.ReactNode }) {
  const [spaces, setSpaces] = useState<Space[]>([])
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const { snapshot: entitlements } = useEntitlements()

  useEffect(() => {
    (async () => {
      try {
        const { spaces: initial, currentId } = await ensureSpacesDefaults()
        setSpaces(initial)
        setSpaceId(currentId)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

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
      ? `This will delete all bills, warranties, reminders, and attachments for ${displayName}.\n\nAfter removal, ${slotLabel} will be re-created and you will be asked to name it again.`
      : `This will delete all bills, warranties, reminders, and attachments for ${displayName}.\n\nThis cannot be undone.`

    Alert.alert(`Remove ${slotLabel}?`, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          if (isPayer1) {
            try { await AsyncStorage.removeItem('billbox.onboarding.payer1Named') } catch {}
          }
          await purgePayerData(id)
          await removeSpace(id)
          const ensured = await ensureSpacesDefaults()
          setSpaces(ensured.spaces)
          setSpaceId(ensured.currentId)
        },
      },
    ])
  }, [spaces])

  const current = spaces.find((s) => s.id === spaceId) || null

  const value: SpaceContextValue = {
    spaces,
    current,
    spaceId,
    loading,
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
    if (up.error) Alert.alert(tr('Upload failed'), up.error)
    else Alert.alert(tr('Attachment uploaded'), tr('Image attached to bill'))
  }

  async function addPdf() {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
    if (res.canceled) return
    const file = res.assets?.[0]
    if (!file?.uri) return
    const name = file.name || 'document.pdf'
    const up = await uploadAttachmentFromUri(spaceId, 'bills', bill!.id, file.uri, name, 'application/pdf')
    if (up.error) Alert.alert(tr('Upload failed'), up.error)
    else Alert.alert(tr('Attachment uploaded'), tr('PDF attached to bill'))
    await refresh()
  }

  async function openAttachment(path: string, uri?: string) {
    if (supabase) {
      const url = await getSignedUrl(supabase!, path)
      if (url) Linking.openURL(url)
      else Alert.alert(tr('Open failed'), tr('Could not get URL'))
    } else {
      if (uri) Linking.openURL(uri)
      else Alert.alert(tr('Offline'), tr('Attachment stored locally. Preview is unavailable.'))
    }
  }

  async function remove(path: string) {
    Alert.alert(tr('Delete attachment?'), tr('This file will be removed.'), [
      { text: tr('Cancel'), style: 'cancel' },
      { text: tr('Delete'), style: 'destructive', onPress: async () => { const { error } = await deleteAttachment(spaceId, 'bills', bill!.id, path); if (error) Alert.alert(tr('Delete failed'), error); else await refresh() } }
    ])
  }

  if (!bill || spaceLoading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{tr('Loading bill…')}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen>
      <View style={styles.pageStack}>
        <TabTopBar
          title={bill.supplier || tr('Bill')}
          left={
            <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8} accessibilityLabel={tr('Back')}>
              <Ionicons name="chevron-back" size={22} color={themeColors.text} />
            </TouchableOpacity>
          }
        />

        <Surface elevated>
          <SectionHeader title={tr('Bill summary')} />
          <Text style={styles.bodyText}>{bill.currency} {bill.amount.toFixed(2)} • {tr('Due')} {bill.due_date}</Text>
          {!!bill.reference && <Text style={styles.bodyText}>Ref: {bill.reference}</Text>}
          {!!bill.iban && <Text style={styles.bodyText}>IBAN: {bill.iban}</Text>}
          {!bill.due_date && (
            <InlineInfo
              tone="warning"
              iconName="alert-circle-outline"
              message={tr('No due date — reminders cannot be scheduled.')}
            />
          )}
          {linkedWarranty ? (
            <AppButton
              label={tr('View linked warranty')}
              variant="secondary"
              iconName="shield-checkmark-outline"
              onPress={() => navigation.navigate('Warranty Details', { warrantyId: linkedWarranty.id })}
            />
          ) : (
            <AppButton
              label={tr('Create warranty from this bill')}
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
                        Alert.alert(tr('Warranty already exists'), tr('Opening the existing warranty for this bill.'))
                        navigation.navigate('Warranty Details', { warrantyId: existing.id })
                        return
                      }
                    } else {
                      const locals = await loadLocalWarranties(spaceId)
                      const existing = (locals || []).find((w: any) => w.bill_id === bill.id) || null
                      if ((existing as any)?.id) {
                        Alert.alert(tr('Warranty already exists'), tr('Opening the existing warranty for this bill.'))
                        navigation.navigate('Warranty Details', { warrantyId: (existing as any).id })
                        return
                      }
                    }
                  } catch {}

                  const s = getSupabase()
                  let createdId: string | null = null
                  if (s) {
                    const { data, error } = await createWarranty(s, { item_name: bill.supplier, supplier: bill.supplier, purchase_date: bill.due_date, bill_id: bill.id, space_id: spaceId })
                    if (error) { Alert.alert(tr('Warranty error'), error.message); return }
                    createdId = data?.id || null
                  } else {
                    const local = await addLocalWarranty(spaceId, { item_name: bill.supplier, supplier: bill.supplier, purchase_date: bill.due_date, bill_id: bill.id })
                    createdId = local.id
                  }
                  if (createdId) {
                    Alert.alert(tr('Warranty created'), tr('Linked to this bill.'))
                    navigation.navigate('Warranty Details', { warrantyId: createdId })
                  }
                } catch (e: any) {
                  Alert.alert(tr('Create warranty failed'), e?.message || tr('Unknown error'))
                }
              }}
            />
          )}
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Reminders')} />
          <View style={styles.billActionsRow}>
            <AppButton
              label={tr('Schedule defaults')}
              variant="secondary"
              iconName="alarm-outline"
              onPress={async ()=>{
                if (!bill.due_date) { Alert.alert(tr('Missing due date'), tr('Add a due date to schedule reminders.')); return }
                await ensureNotificationConfig()
                const ok = await requestPermissionIfNeeded()
                if (!ok) {
                  Alert.alert(tr('Enable reminders'), tr('Please enable notifications in system settings.'))
                  return
                }
                await scheduleBillReminders({ ...bill, space_id: spaceId } as any, undefined, spaceId)
                Alert.alert(tr('Reminders'), tr('Scheduled default reminders for this bill.'))
              }}
            />
            <AppButton
              label={tr('Cancel reminders')}
              variant="ghost"
              iconName="notifications-off-outline"
              onPress={async ()=>{
                await cancelBillReminders(bill.id, spaceId)
                Alert.alert(tr('Reminders'), tr('Canceled for this bill.'))
              }}
            />
          </View>
          <View style={styles.billActionsRow}>
            <AppButton
              label={tr('Snooze 1 day')}
              variant="secondary"
              onPress={async ()=>{ await snoozeBillReminder({ ...bill, space_id: spaceId } as any, 1, spaceId); Alert.alert(tr('Snoozed'), tr('Next reminder in 1 day.')) }}
            />
            <AppButton
              label={tr('Snooze 3 days')}
              variant="secondary"
              onPress={async ()=>{ await snoozeBillReminder({ ...bill, space_id: spaceId } as any, 3, spaceId); Alert.alert(tr('Snoozed'), tr('Next reminder in 3 days.')) }}
            />
            <AppButton
              label={tr('Snooze 7 days')}
              variant="secondary"
              onPress={async ()=>{ await snoozeBillReminder({ ...bill, space_id: spaceId } as any, 7, spaceId); Alert.alert(tr('Snoozed'), tr('Next reminder in 7 days.')) }}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Attachments')} />
          <View style={styles.attachmentRow}>
            <AppButton
              label={tr('Add image')}
              variant="secondary"
              iconName="image-outline"
              onPress={addImage}
            />
            <AppButton
              label={tr('Add PDF')}
              variant="secondary"
              iconName="document-attach-outline"
              onPress={addPdf}
            />
          </View>
          {attachments.length === 0 ? (
            <EmptyState
              title={tr('No attachments yet')}
              message={tr('Attach the original bill or receipt for easier approvals and audits.')}
              actionLabel={tr('Attach image or PDF')}
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
                      label={tr('Open')}
                      variant="secondary"
                      iconName="open-outline"
                      onPress={()=>openAttachment(item.path, item.uri)}
                    />
                    <AppButton
                      label={tr('Delete')}
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
          <SectionHeader title={tr('Danger zone')} />
          <AppButton
            label={tr('Delete bill')}
            variant="ghost"
            iconName="trash-outline"
            onPress={() => {
              Alert.alert(tr('Delete bill?'), tr('Are you sure? This cannot be undone. Attachments will be deleted too.'), [
                { text: tr('Cancel'), style: 'cancel' },
                {
                  text: tr('Delete'),
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
                      Alert.alert(tr('Deleted'), tr('Bill removed.'))
                      navigation.goBack()
                    } catch (e: any) {
                      Alert.alert(tr('Delete failed'), e?.message || tr('Unable to delete bill'))
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
  onLoggedIn: () => void
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
        onLoggedIn()
        return
      }
      const { error } = await supabase.auth.signInWithPassword({ email: trimmedEmail, password })
      if (error) {
        setFeedback({ tone: 'danger', message: error.message })
        return
      }
      await rememberEmail(trimmedEmail)
      onLoggedIn()
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
                <Ionicons name="cube-outline" size={28} color={themeColors.primary} />
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
                onPress={onLoggedIn}
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
  const [purchaseItem, setPurchaseItem] = useState('')
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
    setPurchaseItem('')
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
    if (!t) { setFormat('Unknown'); setParsed(null); Alert.alert(tr('QR detected but no text decoded')); return }
    const epc = parseEPC(t)
    const upn = !epc ? parseUPN(t) : null
    const p = epc || upn
    if (!p) { setFormat('Unknown'); setParsed(null); Alert.alert(tr('Unsupported QR format')); return }
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
      Alert.alert(tr('OCR extracted'), `${summary}\n\n${tr('The selected image will be attached on save.')}`)
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
      Alert.alert(tr('Missing data'), tr('Paste QR text to extract payment fields.'))
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
      Alert.alert(tr('Supplier required'), tr('Enter the supplier or issuer of the bill.'))
      return
    }
    if (!currency.trim()) {
      Alert.alert(tr('Currency required'), tr('Enter a currency (for example EUR).'))
      return
    }
    const amt = Number(String(amountStr).replace(',', '.'))
    if (Number.isNaN(amt) || amt <= 0) {
      Alert.alert(tr('Invalid amount'), tr('Provide a numeric amount greater than 0.'))
      return
    }

    const trimmedDue = dueDate.trim()
    const effectiveDueDate = trimmedDue || new Date().toISOString().slice(0, 10)

    if (!archiveOnly) {
      const effectivePurpose = purpose.trim() || purchaseItem.trim()
      if (!creditorName.trim()) {
        Alert.alert(tr('Creditor required'), tr('Enter the creditor/payee name (often the same as the supplier).'))
        return
      }
      if (!iban.trim()) {
        Alert.alert(tr('IBAN required'), tr('Enter the IBAN for the payment.'))
        return
      }
      if (iban.trim().length < 10) {
        Alert.alert(tr('Invalid IBAN'), tr('IBAN looks too short. Please double-check it.'))
        return
      }
      if (!reference.trim()) {
        Alert.alert(tr('Reference required'), tr('Enter the payment reference.'))
        return
      }
      if (!effectivePurpose) {
        Alert.alert(tr('Purpose required'), tr('Enter the payment purpose/description.'))
        return
      }
      if (!trimmedDue) {
        Alert.alert(tr('Due date required'), tr('Add a due date so reminders can be scheduled.'))
        return
      }
      if (!pendingAttachment?.uri) {
        Alert.alert(tr('Attachment required'), tr('Attach a PDF or image of the original bill.'))
        return
      }
    }
    try {
      setSaving(true)
      const s = getSupabase()
      if (entitlements.plan === 'free') {
        try {
          const now = new Date()
          const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
          const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1)
          let currentCount = 0
          if (s) {
            let q = s
              .from('bills')
              .select('created_at')
              .gte('created_at', monthStart.toISOString())
              .lt('created_at', nextMonthStart.toISOString())
            if (spaceId) q = q.eq('space_id', spaceId)
            const { data } = await q
            currentCount = Array.isArray(data) ? data.length : 0
          } else {
            const locals = await loadLocalBills(spaceId)
            currentCount = (Array.isArray(locals) ? locals : []).filter((b) => {
              const created = b?.created_at ? new Date(b.created_at) : null
              if (!created || Number.isNaN(created.getTime())) return false
              return created >= monthStart && created < nextMonthStart
            }).length
          }
          if (currentCount >= 10) {
            showUpgradeAlert('bills_limit')
            setSaving(false)
            return
          }
        } catch {}
      }
      let savedId: string | null = null
      if (s) {
        const effectivePurpose = purpose.trim() || purchaseItem.trim()
        const { data, error } = await createBill(s, {
          supplier: supplier.trim(),
          amount: amt,
          currency: currency.trim() || 'EUR',
          due_date: effectiveDueDate,
          status: archiveOnly ? 'archived' : 'unpaid',
          creditor_name: (creditorName.trim() || supplier.trim()) || null,
          iban: iban.trim() || null,
          reference: reference.trim() || null,
          purpose: effectivePurpose || null,
          space_id: spaceId,
        })
        if (error) {
          Alert.alert(tr('Save failed'), error.message)
          setSaving(false)
          return
        }
        savedId = data?.id || null
      } else {
        const effectivePurpose = purpose.trim() || purchaseItem.trim()
        const local = await addLocalBill(spaceId, {
          supplier: supplier.trim(),
          amount: amt,
          currency: currency.trim() || 'EUR',
          due_date: effectiveDueDate,
          status: archiveOnly ? 'archived' : 'unpaid',
          creditor_name: (creditorName.trim() || supplier.trim()) || null,
          iban: iban.trim() || null,
          reference: reference.trim() || null,
          purpose: effectivePurpose || null,
        })
        savedId = local.id
      }

      if (savedId && pendingAttachment?.uri) {
        const up = await uploadAttachmentFromUri(spaceId, 'bills', savedId, pendingAttachment.uri, pendingAttachment.name || 'attachment', pendingAttachment.type)
        if (up.error) Alert.alert(tr('Attachment upload failed'), up.error)
      }

      if (inboxSourceId) {
        await updateInboxItem(spaceId, inboxSourceId, { status: 'processed' })
        setInboxSourceId(null)
      }

      Alert.alert(tr('Bill saved'), archiveOnly ? tr('Saved as archived (already paid)') : (s ? tr('Bill created successfully') : tr('Saved locally (Not synced)')))
      clearExtraction()
      try { (navigation as any)?.navigate?.('Bills', { highlightBillId: savedId }) } catch {}
    } catch (e: any) {
      Alert.alert(tr('Save error'), e?.message || tr('Unable to save.'))
    } finally {
      setSaving(false)
    }
  }

  if (spaceLoading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{tr('Loading spaces…')}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen>
      <View style={styles.pageStack}>
        <TabTopBar titleKey="scan" />

        {spacesCtx.spaces.length > 1 ? (
          <Surface elevated>
            <SectionHeader title="Profile" />
            <SegmentedControl
              value={spacesCtx.current?.id || spaceId || ''}
              onChange={(id) => { spacesCtx.setCurrent(id) }}
              options={spacesCtx.spaces.map((s) => ({ value: s.id, label: s.name }))}
              style={{ marginTop: themeSpacing.xs }}
            />
            <Text style={[styles.mutedText, { marginTop: themeSpacing.xs }]}>{tr('Bills you save are assigned to the active profile.')}</Text>
          </Surface>
        ) : null}

        <InlineInfo
          tone="info"
          iconName="scan-outline"
          message={tr('Scan or import a bill, review the draft below, then save.')}
        />

        {!permission?.granted ? (
          <Surface elevated>
            <SectionHeader title={tr('Capture bill')} />
            <Text style={styles.bodyText}>{tr('Scan a QR code or import a bill image/PDF to start a draft.')}</Text>
            <View style={styles.actionRow}>
              <AppButton label={tr('Enable camera')} iconName="camera-outline" onPress={requestPermission} />
              <AppButton label={ocrBusy ? tr('Extracting…') : tr('Import photo')} variant="secondary" iconName="image-outline" onPress={pickImage} loading={ocrBusy} />
              <AppButton label={ocrBusy ? tr('Extracting…') : tr('Import PDF')} variant="secondary" iconName="document-text-outline" onPress={pickPdfForOCR} loading={ocrBusy} />
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
                    label={torch === 'on' ? tr('Torch off') : tr('Torch on')}
                    variant="ghost"
                    iconName={torch === 'on' ? 'flash-off-outline' : 'flash-outline'}
                    onPress={() => setTorch((prev) => (prev === 'on' ? 'off' : 'on'))}
                  />
                  <AppButton
                    label={ocrBusy ? tr('Extracting…') : tr('Import photo')}
                    variant="secondary"
                    iconName="image-outline"
                    onPress={pickImage}
                    loading={ocrBusy}
                  />
                  <AppButton
                    label={ocrBusy ? tr('Extracting…') : tr('Import PDF')}
                    variant="secondary"
                    iconName="document-text-outline"
                    onPress={pickPdfForOCR}
                    loading={ocrBusy}
                  />
                </View>
                <Text style={styles.helperText}>{tr('Align the QR code inside the frame. We will extract IBAN, reference, and amount automatically.')}</Text>
              </>
            ) : (
              <View style={styles.capturePlaceholder}>
                <Ionicons name="scan-outline" size={36} color={themeColors.primary} />
                <Text style={styles.captureMessage}>{tr('QR details captured. Review the draft below or scan again if anything looks off.')}</Text>
                <View style={styles.captureActions}>
                  <AppButton
                    label={tr('Scan again')}
                    variant="secondary"
                    iconName="scan-outline"
                    onPress={() => {
                      setCameraVisible(true)
                      setLastQR('')
                        setTorch('on')
                    }}
                  />
                  <AppButton
                    label={ocrBusy ? tr('Extracting…') : tr('Import photo')}
                    variant="secondary"
                    iconName="image-outline"
                    onPress={pickImage}
                    loading={ocrBusy}
                  />
                  <AppButton
                    label={ocrBusy ? tr('Extracting…') : tr('Import PDF')}
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
          <SectionHeader title="Installments" />
          <Text style={styles.bodyText}>{tr('This creates a monthly bill so it appears in Bills and Pay automatically.')}</Text>
          <View style={styles.actionRow}>
            <AppButton
              label={tr('Installment obligation')}
              iconName="repeat-outline"
              variant="secondary"
              onPress={() => {
                try { (navigation as any)?.navigate?.('Bills', { openInstallment: true }) } catch {}
              }}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Bill data sources')} actionLabel={tr('Clear')} onActionPress={clearExtraction} />
          <Text style={styles.bodyText}>{tr('Use any source below to prefill the bill. All fields stay editable before you save.')}</Text>
          <Disclosure title={tr('Paste QR text (advanced)')}>
            <Text style={styles.mutedText}>{tr('Paste the raw text from the QR (EPC/UPN) to extract payment fields.')}</Text>
            <AppInput
              placeholder={tr('Paste QR text')}
              value={manual}
              onChangeText={setManual}
              multiline
            />
            <View style={styles.actionRow}>
              <AppButton label={tr('Extract fields')} iconName="sparkles-outline" onPress={handleManualExtract} />
              <Badge label={format ? `${tr('Detected:')} ${format}` : tr('Awaiting data')} tone={format ? 'info' : 'neutral'} />
            </View>
          </Disclosure>
          <Disclosure title={tr('Show raw details')}>
            <Text style={styles.codeBlock}>{rawText || tr('No QR data captured yet.')}</Text>
          </Disclosure>
        </Surface>

        <Surface elevated style={styles.formCard}>
          <SectionHeader title={tr('Bill draft')} actionLabel={tr('Clear')} onActionPress={clearExtraction} />
          <Text style={styles.formIntro}>{tr('Double-check every field before saving.')}</Text>
          {!hasBillData && (
            <InlineInfo
              tone="info"
              iconName="scan-outline"
              message={tr('Scan or import a bill, review the draft below, then save.')}
              style={styles.formNotice}
            />
          )}

          <View style={styles.formSection}>
            <Text style={styles.formSectionTitle}>{tr('Summary')}</Text>
            <View style={styles.formStack}>
              <AppInput placeholder={tr('Supplier')} value={supplier} onChangeText={setSupplier} />
              <AppInput placeholder={tr('Purchase item (optional)')} value={purchaseItem} onChangeText={setPurchaseItem} />
              <View style={styles.formRow}>
                <AppInput placeholder={tr('Amount')} value={amountStr} onChangeText={setAmountStr} keyboardType="numeric" style={styles.flex1} />
                <AppInput placeholder={tr('Currency')} value={currency} onChangeText={setCurrency} style={styles.currencyInput} />
              </View>

              <View style={styles.filterToggle}>
                <Switch value={archiveOnly} onValueChange={setArchiveOnly} />
                <Text style={styles.toggleLabel}>{tr('Archive / already paid (no payment)')}</Text>
              </View>
              {archiveOnly && (
                <InlineInfo
                  tone="info"
                  iconName="archive-outline"
                  message={tr('Archived bills are excluded from Pay by default. Payment fields and attachments become optional.')}
                  style={styles.formNotice}
                />
              )}

              <View style={{ gap: themeSpacing.xs }}>
                <Text style={styles.formSectionTitle}>{tr('Dates')}</Text>
                <View style={styles.formRow}>
                  <AppInput
                    placeholder={tr('Due date (YYYY-MM-DD)')}
                    value={dueDate}
                    onChangeText={setDueDate}
                    hint={tr('Due date (used for reminders and overdue status).')}
                    style={styles.flex1}
                  />
                  <AppButton
                    label={dueDate ? tr('Change date') : tr('Pick date')}
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
                        <AppButton label={tr('Done')} variant="primary" onPress={() => setShowDuePicker(false)} />
                      </View>
                    )}
                  </View>
                )}
              </View>
            </View>
          </View>

          <Divider style={styles.formDivider} />

          <View style={styles.formSection}>
            <Text style={styles.formSectionTitle}>{tr('Payment details')}</Text>
            <View style={styles.formStack}>
              <AppInput placeholder={tr('Creditor')} value={creditorName} onChangeText={setCreditorName} />
              <AppInput placeholder={tr('IBAN')} value={iban} onChangeText={setIban} />
              <AppInput placeholder={tr('Reference')} value={reference} onChangeText={setReference} />
              <AppInput placeholder={tr('Purpose')} value={purpose} onChangeText={setPurpose} multiline />
            </View>
          </View>

          <Divider style={styles.formDivider} />

          <View style={styles.formSection}>
            <Text style={styles.formSectionTitle}>{tr('Attachments')}</Text>
            {!pendingAttachment && (
              <InlineInfo tone="warning" iconName="alert-circle-outline" message={tr('Attach a PDF or image of the original bill.')} style={styles.formNotice} />
            )}
            <View style={styles.attachmentButtons}>
              <AppButton
                label={pendingAttachment?.type?.startsWith('image/') ? tr('Replace image') : tr('Attach image')}
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
                label={pendingAttachment?.type === 'application/pdf' ? tr('Replace PDF') : tr('Attach PDF')}
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
                <Text style={styles.bodyText}>{tr('Staged attachment:')} {pendingAttachment.name}</Text>
                {pendingAttachment.type?.startsWith('image/') && (
                  <Image source={{ uri: pendingAttachment.uri }} style={styles.attachmentImage} />
                )}
                <AppButton label={tr('Remove attachment')} variant="ghost" iconName="close-circle-outline" onPress={() => setPendingAttachment(null)} />
              </View>
            )}
          </View>

          <AppButton
            label={saving ? tr('Saving bill…') : tr('Save bill')}
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
      const item = await addToInbox({ spaceId, uri: file.uri, name: file.name || 'document', mimeType: file.mimeType || undefined })
      await scheduleInboxReviewReminder(item.id, item.name, spaceId)
      await refresh()
      Alert.alert('Inbox', 'Document added to Inbox')
    } catch (e: any) {
      Alert.alert('Import failed', e?.message || 'Unable to import document')
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
      const sourceUri = (item as any).localPath || item.uri
      const { fields, summary } = await performOCR(sourceUri)

      const looksLikeBill = !!(fields && (fields.iban || fields.reference) && typeof fields.amount === 'number')
      await updateInboxItem(spaceId, item.id, { extractedFields: fields, notes: summary, status: looksLikeBill ? 'pending' : 'new' })
      if (looksLikeBill) await cancelInboxReviewReminder(item.id, spaceId)
      else await scheduleInboxReviewReminder(item.id, item.name, spaceId)
      await refresh()
      Alert.alert('OCR completed', summary)
    } catch (e: any) {
      Alert.alert('OCR failed', e?.message || 'Unable to process document')
    } finally {
      setBusy(null)
    }
  }

  async function openItem(item: InboxItem) {
    try {
      const uri = (item as any).localPath || item.uri
      await Linking.openURL(uri)
    } catch {
      Alert.alert('Open failed', 'Unable to open this file. You can export it from the Inbox screen.')
    }
  }

  async function attachToBill(item: InboxItem) {
    if (!item.extractedFields) {
      Alert.alert('Run OCR first', 'Scan the document so we can prefill the bill.')
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
    await cancelInboxReviewReminder(item.id, spaceId)
    await refresh()
  }

  async function removeItem(item: InboxItem) {
    Alert.alert(tr('Delete?'), tr('Remove this inbox item permanently?'), [
      { text: tr('Cancel'), style: 'cancel' },
      { text: tr('Delete'), style: 'destructive', onPress: async () => { await cancelInboxReviewReminder(item.id, spaceId); await removeInboxItem(spaceId, item.id); await refresh() } },
    ])
  }

  if (spaceLoading || !space) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2b6cb0" />
        <Text style={{ marginTop: 8 }}>{tr('Loading space…')}</Text>
      </View>
    )
  }

  return (
    <Screen>
      <View style={styles.pageStack}>
        <TabTopBar titleKey="Inbox" />
        <View style={styles.inboxControlsRow}>
          <TouchableOpacity style={[styles.primaryBtn, importing && styles.primaryBtnDisabled]} onPress={importFromDevice} disabled={importing}>
            <Text style={styles.primaryBtnText}>{importing ? tr('Importing…') : tr('Import from device')}</Text>
          </TouchableOpacity>
          <View style={styles.inboxFilterRow}>
            <TouchableOpacity style={[styles.secondaryBtn, filter==='pending' ? styles.secondaryBtnActive : null]} onPress={()=>setFilter('pending')}>
              <Text style={[styles.secondaryBtnText, filter==='pending' ? styles.secondaryBtnTextActive : null]}>{tr('Pending')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.secondaryBtn, filter==='archived' ? styles.secondaryBtnActive : null]} onPress={()=>setFilter('archived')}>
              <Text style={[styles.secondaryBtnText, filter==='archived' ? styles.secondaryBtnTextActive : null]}>{tr('Archived')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.secondaryBtn, filter==='all' ? styles.secondaryBtnActive : null]} onPress={()=>setFilter('all')}>
              <Text style={[styles.secondaryBtnText, filter==='all' ? styles.secondaryBtnTextActive : null]}>{tr('All')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.listWrapper}>
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text>{tr('No documents yet. Share a PDF, image, or email attachment to BillBox.')}</Text>}
            renderItem={({ item }) => (
              <Surface elevated style={[styles.card, highlightId === item.id ? styles.inboxItemHighlighted : null]}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                <Text>{item.mimeType} • {new Date(item.created_at).toLocaleString()}</Text>
                <Text>Status: {item.status}</Text>
                {item.extractedFields && (
                  <View style={{ marginTop: 6 }}>
                    <Text style={{ fontWeight: '600' }}>Extracted</Text>
                    {item.notes ? <Text>{item.notes}</Text> : null}
                  </View>
                )}
                <View style={styles.inboxActionsRow}>
                  <Button title="Open" onPress={()=>openItem(item)} />
                  <Button title={busy===item.id ? 'Processing…' : 'Run OCR'} onPress={()=>runOcr(item)} disabled={busy===item.id} />
                  <Button title="Attach to bill" onPress={()=>attachToBill(item)} />
                  <Button title="Archive" onPress={()=>archiveItem(item)} />
                  <Button title="Delete" color="#c53030" onPress={()=>removeItem(item)} />
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
  const { snapshot: entitlements } = useEntitlements()
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
  const [warrantyBillIds, setWarrantyBillIds] = useState<Record<string, true>>({})

  const [iosPickerVisible, setIosPickerVisible] = useState(false)
  const [iosPickerField, setIosPickerField] = useState<'from' | 'to' | null>(null)
  const [iosPickerValue, setIosPickerValue] = useState(new Date())

  const [installmentVisible, setInstallmentVisible] = useState(false)
  const [installmentTitle, setInstallmentTitle] = useState('')
  const [installmentAmount, setInstallmentAmount] = useState('')
  const [installmentCurrency, setInstallmentCurrency] = useState('EUR')
  const [installmentStartMonth, setInstallmentStartMonth] = useState(monthKeyFromDate(new Date()))
  const [installmentDueDay, setInstallmentDueDay] = useState(String(new Date().getDate()))
  const [installmentCreditor, setInstallmentCreditor] = useState('')
  const [installmentIban, setInstallmentIban] = useState('')
  const [installmentReference, setInstallmentReference] = useState('')
  const [installmentPurpose, setInstallmentPurpose] = useState('')
  const [installmentMonths, setInstallmentMonths] = useState('')
  const [installmentEndMonth, setInstallmentEndMonth] = useState('')
  const [installmentSaving, setInstallmentSaving] = useState(false)

  const dateFieldLabels: Record<typeof dateMode, string> = {
    due: 'Due date',
    invoice: 'Invoice date',
    created: 'Created date',
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
        let next = (data || []) as Bill[]
        if (entitlements.plan === 'pro') {
          next = await ensureInstallmentBills({ spaceId, supabase, existingBills: next, horizonMonths: 2 })
        } else {
          next = next.filter((b) => !isInstallmentBill(b))
        }
        setBills(next)
      } else {
        const locals = await loadLocalBills(spaceId)
        let next = ((locals as any) || []) as Bill[]
        if (entitlements.plan === 'pro') {
          next = await ensureInstallmentBills({ spaceId, supabase: null, existingBills: next, horizonMonths: 2 })
        } else {
          next = next.filter((b) => !isInstallmentBill(b))
        }
        setBills(next)
      }
    } catch (e: any) {
      Alert.alert('Bills', e?.message || 'Unable to load bills')
    } finally {
      hasLoadedRef.current = true
      silent ? setRefreshing(false) : setLoadingBills(false)
    }
  }, [spaceLoading, space, supabase, spaceId, entitlements.plan])

  const loadWarrantyLinks = useCallback(async () => {
    if (spaceLoading || !space) return
    try {
      const warranties = supabase ? (await listWarranties(supabase, spaceId)).data : ((await loadLocalWarranties(spaceId)) as any)
      const next: Record<string, true> = {}
      for (const w of warranties || []) {
        const billId = (w as any)?.bill_id
        if (billId) next[String(billId)] = true
      }
      setWarrantyBillIds(next)
    } catch {
      setWarrantyBillIds({})
    }
  }, [spaceLoading, space, supabase, spaceId])

  useFocusEffect(
    useCallback(() => {
      loadBills(hasLoadedRef.current)
      loadWarrantyLinks()
      return () => {}
    }, [loadBills, loadWarrantyLinks])
  )

  const openInstallment = useCallback(() => {
    setInstallmentTitle('')
    setInstallmentAmount('')
    setInstallmentCurrency('EUR')
    setInstallmentStartMonth(monthKeyFromDate(new Date()))
    setInstallmentDueDay(String(new Date().getDate()))
    setInstallmentCreditor('')
    setInstallmentIban('')
    setInstallmentReference('')
    setInstallmentPurpose('')
    setInstallmentMonths('')
    setInstallmentEndMonth('')
    setInstallmentVisible(true)
  }, [])

  useEffect(() => {
    const shouldOpen = Boolean((route as any)?.params?.openInstallment)
    if (!shouldOpen) return
    openInstallment()
    navigation.setParams?.({ openInstallment: null })
  }, [route, navigation, openInstallment])

  const saveInstallment = useCallback(async () => {
    if (installmentSaving) return

    if (entitlements.plan !== 'pro') {
      Alert.alert(
        tr('Upgrade required'),
        tr('Installment obligations are available on Več.'),
        [
          { text: tr('Cancel'), style: 'cancel' },
          {
            text: tr('Upgrade'),
            onPress: () => {
              setInstallmentVisible(false)
              navigation.navigate('Payments', { focusPlan: 'pro' })
            },
          },
        ]
      )
      return
    }

    const title = installmentTitle.trim()
    if (!title) {
      Alert.alert(tr('Missing supplier'), tr('Please enter the supplier name.'))
      return
    }
    const amt = Number(String(installmentAmount).replace(',', '.'))
    if (!Number.isFinite(amt) || amt <= 0) {
      Alert.alert(tr('Invalid amount'), tr('Please enter a valid amount.'))
      return
    }

    const creditor = installmentCreditor.trim()
    const iban = installmentIban.trim()
    const reference = installmentReference.trim()
    const purpose = installmentPurpose.trim()
    if (!creditor || !iban || !reference || !purpose) {
      Alert.alert(tr('Missing payment details'), tr('Please fill creditor, IBAN, reference, and purpose.'))
      return
    }

    const startMonth = installmentStartMonth.trim()
    if (!/^\d{4}-\d{2}$/.test(startMonth)) {
      Alert.alert(tr('Invalid month'), tr('Use YYYY-MM for the start month.'))
      return
    }

    let endMonth: string | null = null
    const endRaw = installmentEndMonth.trim()
    if (endRaw) {
      if (!/^\d{4}-\d{2}$/.test(endRaw)) {
        Alert.alert(tr('Invalid month'), tr('Use YYYY-MM for the end month.'))
        return
      }
      endMonth = endRaw
    } else {
      const monthsCount = Math.floor(Number(String(installmentMonths).trim()))
      if (!Number.isFinite(monthsCount) || monthsCount < 1) {
        Alert.alert(tr('Missing duration'), tr('Enter number of months or an end month.'))
        return
      }
      endMonth = addMonthsToYYYYMM(startMonth, monthsCount - 1)
    }
    if (endMonth && compareYYYYMM(endMonth, startMonth) < 0) {
      Alert.alert(tr('Invalid month'), tr('End month must be after start month.'))
      return
    }
    const day = Math.floor(Number(String(installmentDueDay).trim()))
    if (!Number.isFinite(day) || day < 1 || day > 31) {
      Alert.alert(tr('Invalid day'), tr('Use a day number between 1 and 31.'))
      return
    }

    try {
      setInstallmentSaving(true)
      await addLocalInstallment(spaceId, {
        title,
        amount: amt,
        currency: (installmentCurrency || 'EUR').trim() || 'EUR',
        start_month: startMonth,
        due_day: day,
        creditor_name: creditor,
        iban,
        reference,
        purpose,
        end_month: endMonth,
      })

      await loadBills(true)
      setInstallmentVisible(false)
      Alert.alert(tr('Saved'), tr('Installment obligation saved.'))
    } catch (e: any) {
      Alert.alert(tr('Save failed'), e?.message || tr('Unable to save.'))
    } finally {
      setInstallmentSaving(false)
    }
  }, [
    entitlements.plan,
    installmentAmount,
    installmentCreditor,
    installmentCurrency,
    installmentDueDay,
    installmentIban,
    installmentPurpose,
    installmentReference,
    installmentSaving,
    installmentStartMonth,
    installmentTitle,
    loadBills,
    navigation,
    spaceId,
  ])

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
    ? tr('{count} bills', { count: totalCount || 0 })
    : tr('{shown} of {total} bills', { shown: filteredBills.length, total: totalCount || 0 })

  const renderEmpty = useCallback(() => {
    if (loadingBills) return null
    return (
      <View style={[styles.brandEmptyWrap, { gap: themeSpacing.sm }]}>
        <Image source={BRAND_ICON} style={{ width: 18, height: 18 }} resizeMode="contain" accessibilityLabel="BILLBOX" />
        <EmptyState
          iconName="document-text-outline"
          title={tr('No bills found')}
          message={tr('Adjust your filters or add a new bill.')}
          actionLabel={tr('Add bill')}
          onActionPress={() => navigation.navigate('Scan')}
        />
      </View>
    )
  }, [loadingBills, navigation])

  const formatAmount = useCallback((value: number, currency?: string | null) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(value)
    } catch {
      return `${value.toFixed(2)} ${currency || 'EUR'}`
    }
  }, [])

  const relativeDueText = useCallback((due: Date | null) => {
    if (!due) return 'No due date'
    const diffDays = Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
    if (diffDays === 0) return 'Due today'
    if (diffDays > 0) return `Due in ${diffDays} day${diffDays === 1 ? '' : 's'}`
    return `Overdue by ${Math.abs(diffDays)} day${diffDays === -1 ? '' : 's'}`
  }, [today])

  const renderBillItem = useCallback(({ item }: { item: Bill }) => {
    const dueDate = parseDateValue(item.due_date)
    const trackedDate = getBillDate(item, dateMode)
    const isOverdue = dueDate ? item.status === 'unpaid' && dueDate.getTime() < today.getTime() : false
    const statusLabel = item.status === 'archived' ? 'Archived' : isOverdue ? 'Overdue' : item.status === 'paid' ? 'Paid' : 'Unpaid'
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: themeSpacing.xs, flex: 1 }}>
              <Text style={styles.billSupplier} numberOfLines={1}>
                {item.supplier || tr('Untitled bill')}
              </Text>
              {warrantyBillIds[item.id] ? (
                <Ionicons name="shield-checkmark-outline" size={16} color={themeColors.primary} />
              ) : null}
            </View>
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
                  {attachments} {tr(attachments === 1 ? 'attachment' : 'attachments')}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.billMetaRow}>
            <View style={styles.billMetaGroup}>
              <Ionicons name="person-circle-outline" size={16} color="#6B7280" />
              <Text style={styles.billMetaSecondary}>{space?.name || tr('Default space')}</Text>
            </View>
          </View>

          {dateMode !== 'due' && (
            <View style={styles.billMetaGroup}>
              <Ionicons name="calendar-clear-outline" size={16} color="#6B7280" />
              <Text style={styles.billMetaSecondary}>
                {tr(dateMode === 'invoice' ? 'Invoice date' : 'Created')}: {formatDisplayDate(trackedDate)}
              </Text>
            </View>
          )}
        </Pressable>
      </Surface>
    )
  }, [attachmentCounts, dateMode, formatAmount, formatDisplayDate, getBillDate, highlightId, navigation, parseDateValue, relativeDueText, space, today, warrantyBillIds])

  if (spaceLoading || !space) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={themeColors.primary} />
        <Text style={styles.mutedText}>{tr('Loading space…')}</Text>
      </View>
    )
  }

  const listBottomPadding = Math.max(insets.bottom, 12) + themeSpacing.xl + 56

  return (
    <Screen scroll={false}>
      <FlatList
        style={{ flex: 1 }}
        data={loadingBills && bills.length === 0 ? [] : filteredBills}
        keyExtractor={(item) => item.id}
        renderItem={renderBillItem}
        contentContainerStyle={[styles.listContent, { paddingBottom: listBottomPadding }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadBills(true)} />}
        ListHeaderComponent={
          <View style={[styles.pageStack, { paddingBottom: themeSpacing.sm }]}>
            <TabTopBar titleKey="bills" />

            {!supabase && (
              <InlineInfo
                tone="warning"
                iconName="cloud-offline-outline"
                message="Cloud sync is disabled. Bills are stored locally until you connect Supabase."
              />
            )}

            <Surface elevated padded={false} style={styles.filtersCard}>
              <Pressable style={styles.filtersHeader} onPress={() => setFiltersExpanded((prev) => !prev)} hitSlop={8}>
                <Text style={styles.sectionTitle}>{tr('Filters')}</Text>
                <View style={styles.filtersHeaderRight}>
                  <Text style={styles.filtersHeaderLabel}>
                    {tr(
                      dateMode === 'due'
                        ? 'Filtering by due date'
                        : dateMode === 'invoice'
                          ? 'Filtering by invoice date'
                          : 'Filtering by created date'
                    )}
                  </Text>
                  <Badge label={tr(dateFieldLabels[dateMode])} tone="info" />
                  <Ionicons name={filtersExpanded ? 'chevron-up' : 'chevron-down'} size={18} color={themeColors.textMuted} />
                </View>
              </Pressable>

              {filtersExpanded && (
                <View style={styles.filtersBody}>
                  <SegmentedControl
                    value={dateMode}
                    onChange={(value) => setDateMode(value as typeof dateMode)}
                    options={[
                      { value: 'due', label: 'Due' },
                      { value: 'invoice', label: 'Invoice' },
                      { value: 'created', label: 'Created' },
                    ]}
                  />

                  <AppInput
                    placeholder="Supplier"
                    value={supplierQuery}
                    onChangeText={setSupplierQuery}
                  />

                  <View style={styles.filterRow}>
                    <AppInput
                      placeholder="Min amount"
                      keyboardType="numeric"
                      value={amountMin}
                      onChangeText={setAmountMin}
                      style={styles.flex1}
                    />
                    <AppInput
                      placeholder="Max amount"
                      keyboardType="numeric"
                      value={amountMax}
                      onChangeText={setAmountMax}
                      style={styles.flex1}
                    />
                  </View>

                  <View style={styles.dateFilterSection}>
                    <Text style={styles.filterLabel}>{tr('Date range')}</Text>
                    <View style={styles.dateRow}>
                      <Pressable style={styles.dateButton} onPress={() => openDatePicker('from')} hitSlop={8}>
                        <Ionicons name="calendar-outline" size={16} color={themeColors.primary} />
                        <Text style={styles.dateButtonText}>{dateFrom || tr('Start date')}</Text>
                      </Pressable>
                      <Pressable style={styles.dateButton} onPress={() => openDatePicker('to')} hitSlop={8}>
                        <Ionicons name="calendar-outline" size={16} color={themeColors.primary} />
                        <Text style={styles.dateButtonText}>{dateTo || tr('End date')}</Text>
                      </Pressable>
                    </View>
                    <View style={styles.manualDateRow}>
                      <AppInput
                        placeholder="YYYY-MM-DD"
                        value={dateFrom}
                        onChangeText={setDateFrom}
                        style={styles.flex1}
                        hint="Manual entry optional"
                      />
                      <AppInput
                        placeholder="YYYY-MM-DD"
                        value={dateTo}
                        onChangeText={setDateTo}
                        style={styles.flex1}
                      />
                    </View>
                  </View>

                  <View style={styles.filterToggleRow}>
                    <View style={styles.filterToggle}>
                      <Switch value={unpaidOnly} onValueChange={handleUnpaidToggle} />
                      <Text style={styles.toggleLabel}>{tr('Unpaid only')}</Text>
                    </View>
                    <View style={styles.filterToggle}>
                      <Switch value={overdueOnly} onValueChange={setOverdueOnly} />
                      <Text style={styles.toggleLabel}>{tr('Overdue')}</Text>
                    </View>
                    <View style={styles.filterToggle}>
                      <Switch value={hasAttachmentsOnly} onValueChange={setHasAttachmentsOnly} />
                      <Text style={styles.toggleLabel}>{tr('Has attachment')}</Text>
                    </View>
                    <View style={styles.filterToggle}>
                      <Switch value={includeArchived} onValueChange={setIncludeArchived} />
                      <Text style={styles.toggleLabel}>{tr('Include archived')}</Text>
                    </View>
                  </View>

                  <View style={styles.filtersFooter}>
                    <AppButton
                      label="Clear filters"
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
                { value: 'all', label: 'All' },
                { value: 'unpaid', label: 'Unpaid' },
                { value: 'paid', label: 'Paid' },
                { value: 'archived', label: 'Archived' },
              ]}
            />

            <View style={styles.billsPrimaryActionsRow}>
              <View style={styles.flex1} />
              <AppButton
                label="Add bill"
                iconName="add-outline"
                variant="secondary"
                onPress={() => navigation.navigate('Scan')}
              />
            </View>

            <View style={styles.listMetaRow}>
              <Text style={styles.listMetaText}>{resultsLabel}</Text>
              <Text style={styles.listMetaSecondary}>{tr('Tap "Filters" to adjust date, supplier, amount, status, and attachments.')}</Text>
            </View>
          </View>
        }
        ListEmptyComponent={
          loadingBills && bills.length === 0 ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={themeColors.primary} />
              <Text style={styles.mutedText}>{tr('Loading bills…')}</Text>
            </View>
          ) : (
            renderEmpty
          )
        }
        showsVerticalScrollIndicator={false}
      />

      {isIOS && iosPickerVisible && (
        <View style={styles.iosPickerOverlay}>
          <Surface elevated style={styles.iosPickerSheet}>
            <Text style={styles.filterLabel}>{tr('Select date')}</Text>
            <DateTimePicker
              mode="date"
              display="inline"
              value={iosPickerValue}
              onChange={(_, selected) => {
                if (selected) setIosPickerValue(selected)
              }}
            />
            <View style={styles.iosPickerActions}>
              <AppButton label="Cancel" variant="ghost" onPress={cancelIosPicker} />
              <AppButton label="Use date" onPress={confirmIosPicker} />
            </View>
          </Surface>
        </View>
      )}

      <Modal visible={installmentVisible} transparent animationType="fade" onRequestClose={() => setInstallmentVisible(false)}>
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
          <Surface elevated style={{ width: '100%', maxWidth: 520, alignSelf: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeSpacing.sm }}>
              <Text style={styles.screenHeaderTitle}>{tr('Installment obligation')}</Text>
              <AppButton label={tr('Close')} variant="ghost" iconName="close-outline" onPress={() => setInstallmentVisible(false)} />
            </View>

            <Text style={[styles.mutedText, { marginTop: themeSpacing.xs }]}>
              {tr('This creates a monthly bill so it appears in Bills and Pay automatically.')}
            </Text>

            <Divider style={{ marginTop: themeSpacing.sm }} />

            <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
              <AppInput placeholder={tr('Supplier')} value={installmentTitle} onChangeText={setInstallmentTitle} />
              <View style={styles.filterRow}>
                <AppInput
                  placeholder={tr('Amount')}
                  keyboardType="numeric"
                  value={installmentAmount}
                  onChangeText={setInstallmentAmount}
                  style={styles.flex1}
                />
                <AppInput
                  placeholder={tr('Currency')}
                  value={installmentCurrency}
                  onChangeText={setInstallmentCurrency}
                  style={styles.flex1}
                />
              </View>

              <View style={styles.filterRow}>
                <AppInput
                  placeholder={tr('Start month (YYYY-MM)')}
                  value={installmentStartMonth}
                  onChangeText={setInstallmentStartMonth}
                  style={styles.flex1}
                />
                <AppInput
                  placeholder={tr('Due day (1-31)')}
                  keyboardType="numeric"
                  value={installmentDueDay}
                  onChangeText={setInstallmentDueDay}
                  style={styles.flex1}
                />
              </View>

              <View style={styles.filterRow}>
                <AppInput
                  placeholder={tr('Number of months')}
                  keyboardType="numeric"
                  value={installmentMonths}
                  onChangeText={setInstallmentMonths}
                  style={styles.flex1}
                />
                <AppInput
                  placeholder={tr('End month (YYYY-MM)')}
                  value={installmentEndMonth}
                  onChangeText={setInstallmentEndMonth}
                  style={styles.flex1}
                />
              </View>
              <Text style={styles.mutedText}>{tr('Enter number of months or an end month.')}</Text>

              <Text style={styles.formSectionTitle}>{tr('Payment details')}</Text>
              <AppInput placeholder={tr('Creditor')} value={installmentCreditor} onChangeText={setInstallmentCreditor} />
              <AppInput placeholder={tr('IBAN')} value={installmentIban} onChangeText={setInstallmentIban} />
              <AppInput placeholder={tr('Reference')} value={installmentReference} onChangeText={setInstallmentReference} />
              <AppInput placeholder={tr('Purpose')} value={installmentPurpose} onChangeText={setInstallmentPurpose} multiline />

              <AppButton
                label={installmentSaving ? tr('Saving…') : tr('Save')}
                iconName="save-outline"
                onPress={saveInstallment}
                loading={installmentSaving}
              />

              {entitlements.plan !== 'pro' ? (
                <InlineInfo
                  tone="info"
                  iconName="sparkles-outline"
                  message={tr('You can enter this, but saving requires Več.')}
                />
              ) : null}
            </View>
          </Surface>
        </View>
      </Modal>
    </Screen>
  )
}

function HomeScreen() {
  const navigation = useNavigation<any>()
  const { space, spaceId, loading } = useActiveSpace()
  const spacesCtx = useSpacesContext()
  const { snapshot: entitlements } = useEntitlements()
  const { mode, setMode, colors } = useTheme()
  const { lang, setLang } = useLangContext()
  const insets = useSafeAreaInsets()
  const [summaries, setSummaries] = useState<
    { spaceId: string; spaceName: string; totalUnpaid: number; overdueCount: number; nextDueDate: string | null }[]
  >([])

  const [languagePickerVisible, setLanguagePickerVisible] = useState(false)
  const [homeSummarySettingsVisible, setHomeSummarySettingsVisible] = useState(false)
  const [homeSummaryVisibility, setHomeSummaryVisibility] = useState({ totalUnpaid: true, overdue: true, nextDue: true })

  const [payerNameDraft, setPayerNameDraft] = useState('')
  const [needsPayerName, setNeedsPayerName] = useState(false)
  const [creatingPayer2, setCreatingPayer2] = useState(false)
  const [payer2NameDraft, setPayer2NameDraft] = useState('')
  const [upgradeModalVisible, setUpgradeModalVisible] = useState(false)

  const payerOptions = useMemo(() => {
    const base = spacesCtx.spaces
      .filter((s) => isPayerSpaceId(s.id))
      .map((s) => ({ value: s.id, label: payerLabelFromSpaceId(s.id) }))
    if (base.length >= 2) return base
    const second = entitlements.plan === 'pro'
      ? { value: '__create_payer2__', label: 'Profil 2' }
      : { value: '__locked_payer2__', label: 'Profil 2' }
    return base.concat([second])
  }, [entitlements.plan, spacesCtx.spaces])

  useEffect(() => {
    ;(async () => {
      if (loading) return
      if (!spaceId) return
      try {
        const key = 'billbox.onboarding.payer1Named'
        const raw = await AsyncStorage.getItem(key)
        void raw
        const payer1 = spacesCtx.spaces.find((s) => s.id === 'personal') || null
        const currentName = (payer1?.name || '').trim()
        const looksDefault = !currentName || currentName.toLowerCase() === 'profil 1'
        setNeedsPayerName(looksDefault)
        if (looksDefault) setPayerNameDraft('')
      } catch {}
    })()
  }, [loading, spaceId, spacesCtx.current, spacesCtx.spaces])

  const savePayer1Name = useCallback(async () => {
    const trimmed = payerNameDraft.trim()
    if (!trimmed) {
      Alert.alert(tr('Name required'), tr('Please enter a name for Profil 1.'))
      return
    }
    if (trimmed.toLowerCase() === 'profil 1') {
      Alert.alert(tr('Name required'), tr('Please choose a custom name (not "Profil 1").'))
      return
    }
    await spacesCtx.rename('personal', trimmed)
    try {
      await AsyncStorage.setItem('billbox.onboarding.payer1Named', '1')
    } catch {}
    setNeedsPayerName(false)
  }, [payerNameDraft, spacesCtx])

  const handlePayerChange = useCallback(async (id: string) => {
    if (id === '__locked_payer2__') {
      setUpgradeModalVisible(true)
      return
    }
    if (id === '__create_payer2__') {
      setCreatingPayer2(true)
      setPayer2NameDraft('Profil 2')
      return
    }
    await spacesCtx.setCurrent(id)
  }, [spacesCtx])

  const savePayer2 = useCallback(async () => {
    const trimmed = payer2NameDraft.trim()
    if (!trimmed) {
      Alert.alert(tr('Name required'), tr('Please enter a name for Profil 2.'))
      return
    }
    await spacesCtx.addSpace({
      name: trimmed,
      kind: 'personal',
      plan: spacesCtx.current?.plan || 'free',
    })
    setCreatingPayer2(false)
  }, [payer2NameDraft, spacesCtx])

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
    ;(async () => {
      try {
        const key = 'billbox.home.summaryVisibility'
        const raw = await AsyncStorage.getItem(key)
        if (!raw) return
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return
        setHomeSummaryVisibility((prev) => ({
          totalUnpaid: typeof parsed.totalUnpaid === 'boolean' ? parsed.totalUnpaid : prev.totalUnpaid,
          overdue: typeof parsed.overdue === 'boolean' ? parsed.overdue : prev.overdue,
          nextDue: typeof parsed.nextDue === 'boolean' ? parsed.nextDue : prev.nextDue,
        }))
      } catch {}
    })()
  }, [])

  const updateHomeSummaryVisibility = useCallback(async (next: { totalUnpaid: boolean; overdue: boolean; nextDue: boolean }) => {
    setHomeSummaryVisibility(next)
    try {
      await AsyncStorage.setItem('billbox.home.summaryVisibility', JSON.stringify(next))
    } catch {}
  }, [])

  useEffect(() => {
    ;(async () => {
      if (loading) return
      const payerSpaces = (spacesCtx.spaces || []).filter((s) => isPayerSpaceId(s.id))
      if (!payerSpaces.length) {
        setSummaries([])
        return
      }

      try {
        const supabase = getSupabase()
        const todayIso = new Date().toISOString().slice(0, 10)

        const next: { spaceId: string; spaceName: string; totalUnpaid: number; overdueCount: number; nextDueDate: string | null }[] = []

        for (const sp of payerSpaces) {
          const sid = sp.id
          let bills: Bill[] = []
          if (supabase) {
            const { data, error } = await listBills(supabase, sid)
            if (error) throw error
            bills = data || []
          } else {
            const locals = await loadLocalBills(sid)
            bills = (locals as any) || []
          }

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

          next.push({
            spaceId: sid,
            spaceName: (sp?.name || '').trim() || payerLabelFromSpaceId(sid),
            totalUnpaid,
            overdueCount,
            nextDueDate: nextDue,
          })
        }

        setSummaries(next)
      } catch (e) {
        console.warn('Home summary load failed', e)
        setSummaries([])
      }
    })()
  }, [loading, spacesCtx.spaces])

  if (loading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{t(lang, 'Preparing your workspace…')}</Text>
        </View>
      </Screen>
    )
  }

  const tiles = [
    { label: tr('Scan bill'), icon: 'scan-outline', description: tr('Capture QR codes or import documents.'), target: 'Scan' },
    { label: tr('Bills'), icon: 'receipt-outline', description: tr('Review and manage all bills.'), target: 'Bills' },
    { label: tr('Pay'), icon: 'card-outline', description: tr('Plan and schedule payments.'), target: 'Pay' },
    { label: tr('Warranties'), icon: 'shield-checkmark-outline', description: tr('Track product warranties.'), target: 'Warranties' },
    { label: tr('Reports'), icon: 'bar-chart-outline', description: tr('Analytics and totals.'), target: 'Reports' },
    { label: tr('Exports'), icon: 'download-outline', description: tr('PDF, ZIP, CSV, JSON.'), target: 'Exports' },
  ]

  return (
    <Screen>
      <View style={[styles.pageStack, { gap: themeSpacing.xs }]}>
        <TabTopBar
          titleKey="home"
          right={
            <>
              <TouchableOpacity
                onPress={() => setMode(mode === 'dark' ? 'light' : 'dark')}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                }}
                accessibilityLabel="Toggle dark mode"
              >
                <Ionicons name={mode === 'dark' ? 'sunny-outline' : 'moon-outline'} size={18} color={colors.text} />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setLanguagePickerVisible(true)}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                }}
                accessibilityLabel="Change language"
              >
                <Ionicons name="language-outline" size={18} color={colors.text} />
              </TouchableOpacity>

              {space?.plan === 'free' ? (
                <AppButton
                  label={tr('Upgrade')}
                  variant="secondary"
                  iconName="arrow-up-circle-outline"
                  onPress={() => {
                    if (IS_EXPO_GO) {
                      Alert.alert(
                        tr('Upgrade'),
                        tr(
                          'Purchases are disabled in Expo Go preview. Use an EAS dev/prod build with EXPO_PUBLIC_ENABLE_IAP=true to enable real in-app purchases.'
                        )
                      )
                      return
                    }
                    navigation.navigate('Payments')
                  }}
                />
              ) : spacesCtx.spaces.length > 1 ? (
                <AppButton
                  label={tr('Switch space')}
                  variant="secondary"
                  iconName="swap-horizontal-outline"
                  onPress={() => navigation.navigate('Settings')}
                />
              ) : null}
            </>
          }
        />

        <Surface elevated padded={false} style={[styles.card, styles.homeSummaryCard]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeLayout.gap }}>
            <Text style={styles.mutedText}>{tr('Home summary')}</Text>
            <TouchableOpacity
              onPress={() => setHomeSummarySettingsVisible(true)}
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.border,
                backgroundColor: colors.surface,
              }}
              accessibilityLabel="Home summary settings"
            >
              <Ionicons name="options-outline" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>

          <View style={{ marginTop: themeSpacing.xs }}>
            {(summaries || []).length ? (
              (summaries || []).map((s) => {
                const active = (spacesCtx.current?.id || spaceId) === s.spaceId
                const mask = '•••'
                return (
                  <View key={s.spaceId} style={{ marginBottom: themeSpacing.xs }}>
                    <Text style={[styles.mutedText, active ? { color: themeColors.text } : null]}>
                      {payerLabelFromSpaceId(s.spaceId)} • {s.spaceName}{active ? ` • ${tr('Active')}` : ''}
                    </Text>
                    <Text style={styles.mutedText}>
                      {tr('Total unpaid')}: {homeSummaryVisibility.totalUnpaid ? `EUR ${Number(s.totalUnpaid || 0).toFixed(2)}` : mask}
                    </Text>
                    <Text style={styles.mutedText}>
                      {tr('Overdue')}: {homeSummaryVisibility.overdue ? tr('{count} bills', { count: s.overdueCount || 0 }) : mask}
                    </Text>
                    <Text style={styles.mutedText}>
                      {tr('Next due date')}: {homeSummaryVisibility.nextDue ? (s.nextDueDate || tr('None')) : mask}
                    </Text>
                  </View>
                )
              })
            ) : (
              <>
                <Text style={styles.mutedText}>{tr('Total unpaid')}: {homeSummaryVisibility.totalUnpaid ? '—' : '•••'}</Text>
                <Text style={styles.mutedText}>{tr('Overdue')}: {homeSummaryVisibility.overdue ? '—' : '•••'}</Text>
                <Text style={styles.mutedText}>{tr('Next due date')}: {homeSummaryVisibility.nextDue ? '—' : '•••'}</Text>
              </>
            )}
          </View>

          <View style={{ marginTop: themeSpacing.sm }}>
            <Text style={styles.mutedText}>{tr('Profiles')}</Text>
            <SegmentedControl
              value={spacesCtx.current?.id || spaceId || ''}
              onChange={(id) => { handlePayerChange(id) }}
              options={payerOptions}
              style={{ marginTop: themeSpacing.xs }}
            />

            {needsPayerName ? (
              <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
                <Image source={BRAND_WORDMARK} style={styles.wordmarkOnboarding} resizeMode="contain" accessibilityLabel="BILLBOX" />
                <Text style={styles.bodyText}>{tr('Please name Profil 1 to continue.')}</Text>
                <AppInput placeholder={tr('Profil 1 name')} value={payerNameDraft} onChangeText={setPayerNameDraft} />
                <AppButton label={tr('Save')} iconName="checkmark-outline" onPress={savePayer1Name} />
              </View>
            ) : null}

            {creatingPayer2 ? (
              <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
                <Text style={styles.bodyText}>{tr('Create Profil 2 (Več only).')}</Text>
                <AppInput placeholder={tr('Profil 2 name')} value={payer2NameDraft} onChangeText={setPayer2NameDraft} />
                <View style={{ flexDirection: 'row', gap: themeLayout.gap }}>
                  <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setCreatingPayer2(false)} />
                  <AppButton label={tr('Create Profil 2')} iconName="add-outline" onPress={savePayer2} />
                </View>
              </View>
            ) : null}

            <Text style={[styles.mutedText, { marginTop: themeSpacing.xs }]}>{tr('Active profile scopes Bills, Scan, Pay, Exports, and Warranties.')}</Text>
          </View>
        </Surface>
        <View style={styles.gridWrap}>
          {tiles.map((tile) => (
            <Pressable
              key={tile.label}
              onPress={() => {
                if (needsPayerName) {
                  Alert.alert(tr('Name required'), tr('Please name Profil 1 to continue.'))
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
        <View style={[styles.iosPickerOverlay, { paddingBottom: Math.max(insets.bottom, themeLayout.screenPadding) }]}>
          <Surface elevated style={styles.iosPickerSheet}>
            <SectionHeader title={tr('Add a second profile')} />
            <Text style={styles.bodyText}>{tr('Profil 2 is available on Več.')}</Text>
            <View style={{ gap: themeSpacing.xs, marginTop: themeSpacing.sm }}>
              <Text style={styles.bodyText}>{tr('• Keep personal and business bills separate')}</Text>
              <Text style={styles.bodyText}>{tr('• Independent exports and reports')}</Text>
              <Text style={styles.bodyText}>{tr('• Two profiles on one subscription')}</Text>
              <Text style={styles.mutedText}>
                {t(lang, 'Save with yearly billing: {planBasic} saves €{basicAmount} • {planPro} saves €{proAmount}', {
                  planBasic: t(lang, 'Moje'),
                  planPro: t(lang, 'Več'),
                  basicAmount: planSavings.basic,
                  proAmount: planSavings.pro,
                })}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
              <AppButton label={tr('Not now')} variant="ghost" onPress={() => setUpgradeModalVisible(false)} />
              <AppButton
                label={tr('Upgrade to Več')}
                iconName="arrow-up-outline"
                onPress={() => {
                  setUpgradeModalVisible(false)
                  if (IS_EXPO_GO) {
                    Alert.alert(tr('Upgrade'), tr('Purchases are disabled in Expo Go preview. Use a store/dev build to upgrade.'))
                    return
                  }
                  navigation.navigate('Payments', { focusPlan: 'pro' })
                }}
              />
            </View>
          </Surface>
        </View>
      </Modal>

      <Modal visible={languagePickerVisible} transparent animationType="slide" onRequestClose={() => setLanguagePickerVisible(false)}>
        <View style={[styles.iosPickerOverlay, { paddingBottom: Math.max(insets.bottom, themeLayout.screenPadding) }]}>
          <Surface elevated style={styles.iosPickerSheet}>
            <SectionHeader title={tr('Language')} />
            <Text style={styles.bodyText}>{tr('Choose language')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
              {([
                { code: 'sl', label: 'Slovenščina' },
                { code: 'en', label: 'English' },
                { code: 'hr', label: 'Hrvatski' },
                { code: 'it', label: 'Italiano' },
                { code: 'de', label: 'Deutsch' },
              ] as { code: Lang; label: string }[]).map((o) => (
                <AppButton
                  key={o.code}
                  label={o.label + (lang === o.code ? ' ✓' : '')}
                  variant={lang === o.code ? 'primary' : 'secondary'}
                  onPress={() => {
                    setLang(o.code)
                    setLanguagePickerVisible(false)
                  }}
                />
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
              <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setLanguagePickerVisible(false)} />
            </View>
          </Surface>
        </View>
      </Modal>

      <Modal
        visible={homeSummarySettingsVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setHomeSummarySettingsVisible(false)}
      >
        <View style={[styles.iosPickerOverlay, { paddingBottom: Math.max(insets.bottom, themeLayout.screenPadding) }]}>
          <Surface elevated style={styles.iosPickerSheet}>
            <SectionHeader title={tr('Home summary')} />
            <Text style={styles.bodyText}>{tr('Choose what to show on the Home screen summary.')}</Text>

            <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeLayout.gap }}>
                <Text style={styles.bodyText}>{tr('Show total unpaid')}</Text>
                <Switch
                  value={homeSummaryVisibility.totalUnpaid}
                  onValueChange={(v) => updateHomeSummaryVisibility({ ...homeSummaryVisibility, totalUnpaid: v })}
                />
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeLayout.gap }}>
                <Text style={styles.bodyText}>{tr('Show overdue')}</Text>
                <Switch
                  value={homeSummaryVisibility.overdue}
                  onValueChange={(v) => updateHomeSummaryVisibility({ ...homeSummaryVisibility, overdue: v })}
                />
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeLayout.gap }}>
                <Text style={styles.bodyText}>{tr('Show next due date')}</Text>
                <Switch
                  value={homeSummaryVisibility.nextDue}
                  onValueChange={(v) => updateHomeSummaryVisibility({ ...homeSummaryVisibility, nextDue: v })}
                />
              </View>
            </View>

            <View style={styles.iosPickerActions}>
              <AppButton
                label={tr('Reset')}
                variant="ghost"
                onPress={() => updateHomeSummaryVisibility({ totalUnpaid: true, overdue: true, nextDue: true })}
              />
              <AppButton label={tr('Done')} onPress={() => setHomeSummarySettingsVisible(false)} />
            </View>
          </Surface>
        </View>
      </Modal>

      <AiAssistant
        context={{
          screen: 'Home',
          plan: entitlements.plan,
          payerId: spacesCtx.current?.id || spaceId || null,
          payerName: space?.name || null,
        }}
      />
    </Screen>
  )
}

function WarrantiesScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const navigation = useNavigation<any>()
  const spacesCtx = useSpacesContext()
  const [items, setItems] = useState<Warranty[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [warrantyQuery, setWarrantyQuery] = useState('')
  const [warrantyView, setWarrantyView] = useState<'active' | 'archived'>('active')
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null)
  const [billQuery, setBillQuery] = useState('')
  const [itemName, setItemName] = useState('')
  const [supplier, setSupplier] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [durationMonths, setDurationMonths] = useState('')
  const [iosPickerVisible, setIosPickerVisible] = useState(false)
  const [iosPickerField, setIosPickerField] = useState<'purchase' | 'expires' | null>(null)
  const [iosPickerValue, setIosPickerValue] = useState(new Date())
  const [pendingAttachment, setPendingAttachment] = useState<{ uri: string; name: string; type?: string } | null>(null)
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()

  const today = useMemo(() => {
    const base = new Date()
    return new Date(base.getFullYear(), base.getMonth(), base.getDate())
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

  const formatDateInput = useCallback((value: Date) => {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }, [])

  const openDatePicker = useCallback((field: 'purchase' | 'expires') => {
    const current = parseDateValue(field === 'purchase' ? purchaseDate : expiresAt) || new Date()

    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        mode: 'date',
        value: current,
        onChange: (_event, selectedDate) => {
          if (!selectedDate) return
          const iso = formatDateInput(selectedDate)
          if (field === 'purchase') {
            setPurchaseDate(iso)
          } else {
            setExpiresAt(iso)
            setDurationMonths('')
          }
        },
      })
    } else {
      setIosPickerField(field)
      setIosPickerValue(current)
      setIosPickerVisible(true)
    }
  }, [expiresAt, formatDateInput, parseDateValue, purchaseDate])

  const confirmIosPicker = useCallback(() => {
    if (!iosPickerField) {
      setIosPickerVisible(false)
      return
    }

    const iso = formatDateInput(iosPickerValue)
    if (iosPickerField === 'purchase') {
      setPurchaseDate(iso)
    } else {
      setExpiresAt(iso)
      setDurationMonths('')
    }

    setIosPickerField(null)
    setIosPickerVisible(false)
  }, [formatDateInput, iosPickerField, iosPickerValue])

  const cancelIosPicker = useCallback(() => {
    setIosPickerField(null)
    setIosPickerVisible(false)
  }, [])
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

  const filteredWarranties = useMemo(() => {
    const term = warrantyQuery.trim().toLowerCase()
    const list = (items || []).filter((w) => {
      const expires = parseDateValue((w as any)?.expires_at)
      const isExpired = expires ? expires.getTime() < today.getTime() : false

      if (warrantyView === 'archived') {
        if (!isExpired) return false
      } else {
        if (isExpired) return false
      }

      if (!term) return true
      const itemText = String((w as any)?.item_name || '').toLowerCase()
      const supplierText = String((w as any)?.supplier || '').toLowerCase()
      return itemText.includes(term) || supplierText.includes(term)
    })

    return list.sort((a: any, b: any) => {
      const aExp = parseDateValue(a?.expires_at)
      const bExp = parseDateValue(b?.expires_at)
      const aTime = aExp ? aExp.getTime() : Number.POSITIVE_INFINITY
      const bTime = bExp ? bExp.getTime() : Number.POSITIVE_INFINITY
      if (aTime === bTime) return String(a?.item_name || '').localeCompare(String(b?.item_name || ''))
      return aTime - bTime
    })
  }, [items, parseDateValue, today, warrantyQuery, warrantyView])

  async function addManual() {
    if (!selectedBillId) {
      Alert.alert(tr('Linked bill required'), tr('Select the bill this warranty belongs to.'))
      return
    }
    const existingLinked = (items || []).find((w: any) => w.bill_id === selectedBillId) || null
    if (existingLinked) {
      Alert.alert(tr('Already linked'), tr('This bill already has a warranty. Opening the existing warranty.'))
      navigation.navigate('Warranty Details', { warrantyId: (existingLinked as any).id })
      return
    }
    const itemTrimmed = itemName.trim()
    const supplierTrimmed = supplier.trim()
    const purchaseTrimmed = purchaseDate.trim()
    const expiresTrimmed = expiresAt.trim()
    const durationTrimmed = durationMonths.trim()

    if (!itemTrimmed) { Alert.alert(tr('Validation'), tr('Enter item name')); return }
    if (!supplierTrimmed) { Alert.alert(tr('Missing supplier'), tr('Please enter the supplier name.')); return }
    if (!purchaseTrimmed) { Alert.alert(tr('Missing purchase date'), tr('Enter purchase date.')); return }
    if (!pendingAttachment) { Alert.alert(tr('Attachment required'), tr('Warranties must include an image or PDF attachment.')); return }

    const hasExpires = Boolean(expiresTrimmed)
    const hasDuration = Boolean(durationTrimmed)
    if (hasExpires && hasDuration) {
      Alert.alert(tr('Validation'), tr('Choose either Expires or Duration (not both).'))
      return
    }
    if (!hasExpires && !hasDuration) {
      Alert.alert(tr('Validation'), tr('Expiry or duration required.'))
      return
    }

    const parsedPurchase = parseDateValue(purchaseTrimmed)
    if (!parsedPurchase) {
      Alert.alert(tr('Validation'), tr('Enter purchase date.'))
      return
    }

    // Calculate expiry if duration and purchase date provided
    let computedExpires = expiresTrimmed
    if (!computedExpires && hasDuration) {
      const months = parseInt(durationTrimmed, 10)
      if (Number.isNaN(months) || months <= 0) {
        Alert.alert(tr('Validation'), tr('Invalid duration.'))
        return
      }
      const y = parsedPurchase.getFullYear()
      const m = parsedPurchase.getMonth() + months
      const nd = new Date(y, m, parsedPurchase.getDate())
      computedExpires = nd.toISOString().slice(0, 10)
    }

    if (computedExpires) {
      const parsedExpires = parseDateValue(computedExpires)
      if (!parsedExpires) {
        Alert.alert(tr('Validation'), tr('Expiry or duration required.'))
        return
      }
    }

    let savedWarranty: any = null
    if (supabase) {
      const { data, error } = await createWarranty(supabase!, { item_name: itemTrimmed, supplier: supplierTrimmed || null, purchase_date: purchaseTrimmed || null, expires_at: computedExpires || null, bill_id: selectedBillId, space_id: spaceId })
      if (error) { Alert.alert(tr('Error'), error.message); return }
      if (data) {
        const up = await uploadAttachmentFromUri(spaceId, 'warranties', data.id, pendingAttachment.uri, pendingAttachment.name, pendingAttachment.type)
        if (up.error) Alert.alert(tr('Attachment upload failed'), up.error)
        setItems(prev=>[data, ...prev])
        savedWarranty = data
      }
    } else {
      const local = await addLocalWarranty(spaceId, { item_name: itemTrimmed, supplier: supplierTrimmed || null, purchase_date: purchaseTrimmed || null, expires_at: computedExpires || null, bill_id: selectedBillId })
      await addLocalAttachment(spaceId, 'warranties', local.id, { name: pendingAttachment.name, path: `${local.id}/${pendingAttachment.name}`, created_at: new Date().toISOString(), uri: pendingAttachment.uri })
      setItems((prev:any)=>[local, ...prev])
      savedWarranty = local
    }

    // Auto-schedule the 1-month-before reminder when expiry is set.
    if (savedWarranty && computedExpires) {
      try {
        await ensureNotificationConfig()
        const ok = await requestPermissionIfNeeded()
        if (ok) {
          await scheduleWarrantyReminders({ ...savedWarranty, expires_at: computedExpires, item_name: itemTrimmed || tr('Warranty') } as any, undefined, spaceId)
        }
      } catch {}
    }

    setItemName(''); setSupplier(''); setPurchaseDate(''); setExpiresAt(''); setDurationMonths('')
    setSelectedBillId(null)
    setBillQuery('')
    setWarrantyQuery('')
    setWarrantyView('active')
    setPendingAttachment(null)
    Alert.alert(tr('Saved'), supabase ? tr('Warranty saved') : tr('Saved locally (Not synced)'))
  }

  async function del(id: string) {
    Alert.alert(tr('Are you sure? This will also delete attached files.'), tr('Confirm deletion of this warranty and attachments.'), [
      { text: tr('Cancel'), style: 'cancel' },
      { text: tr('Delete'), style: 'destructive', onPress: async () => { await deleteAllAttachmentsForRecord(spaceId, 'warranties', id); if (supabase) { const { error } = await deleteWarranty(supabase!, id, spaceId); if (error) Alert.alert(tr('Error'), error.message) } else { await deleteLocalWarranty(spaceId, id) } setItems(prev=>prev.filter(w=>w.id!==id)) } }
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
    if (!base) {
      Alert.alert(tr('OCR unavailable'), tr('Missing EXPO_PUBLIC_FUNCTIONS_BASE'))
      return
    }
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
      if (!resp.ok || !data?.ok) throw new Error(data?.error || `${tr('OCR failed')} (${resp.status})`)
      const f = data.fields || {}
      setItemName(f.supplier || itemName)
      setSupplier(f.supplier || supplier)
      setPurchaseDate(f.due_date || purchaseDate)
      setPendingAttachment({ uri: asset.uri, name: asset.fileName || 'photo.jpg', type: asset.type || 'image/jpeg' })

      if (!selectedBillId) {
        Alert.alert(tr('OCR extracted'), tr('Select a linked bill, then press “Save warranty”.'))
        return
      }

      const existingLinked = (items || []).find((w: any) => w.bill_id === selectedBillId) || null
      if (existingLinked) {
        Alert.alert(tr('Already linked'), tr('This bill already has a warranty. Opening the existing warranty.'))
        navigation.navigate('Warranty Details', { warrantyId: (existingLinked as any).id })
        return
      }

      Alert.alert(tr('OCR extracted'), tr('Fields prefilling from photo. Review and press “Save warranty”.'))
    } catch (e: any) {
      Alert.alert(tr('OCR error'), e?.message || tr('OCR failed'))
    }
  }

  async function ocrPdf() {
    if (!entitlements.canUseOCR) {
      showUpgradeAlert('ocr')
      return
    }
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
    if (res.canceled) return
    const file = res.assets?.[0]
    if (!file?.uri) return
    const base = getFunctionsBase()
    if (!base) {
      Alert.alert(tr('OCR unavailable'), tr('Missing EXPO_PUBLIC_FUNCTIONS_BASE'))
      return
    }
    try {
      const fileResp = await fetch(file.uri)
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

      const resp = await fetch(`${base}/.netlify/functions/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'application/pdf', ...authHeader },
        body: blob,
      })
      const data = await resp.json()
      if (!resp.ok || !data?.ok) throw new Error(data?.error || `${tr('OCR failed')} (${resp.status})`)

      const f = data.fields || {}
      if (typeof f.supplier === 'string' && f.supplier.trim()) {
        setSupplier(f.supplier)
        if (!itemName) setItemName(f.supplier)
      }
      if (typeof f.due_date === 'string' && f.due_date.trim() && !purchaseDate) {
        setPurchaseDate(f.due_date)
      }

      setPendingAttachment({ uri: file.uri, name: file.name || 'document.pdf', type: 'application/pdf' })

      if (!selectedBillId) {
        Alert.alert(tr('OCR extracted'), tr('Select a linked bill, then press “Save warranty”.'))
        return
      }

      const existingLinked = (items || []).find((w: any) => w.bill_id === selectedBillId) || null
      if (existingLinked) {
        Alert.alert(tr('Already linked'), tr('This bill already has a warranty. Opening the existing warranty.'))
        navigation.navigate('Warranty Details', { warrantyId: (existingLinked as any).id })
        return
      }

      Alert.alert(tr('OCR extracted'), tr('Fields prefilling from PDF. Review and press “Save warranty”.'))
    } catch (e: any) {
      Alert.alert(tr('OCR error'), e?.message || tr('OCR failed'))
    }
  }

  if (spaceLoading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{tr('Loading warranties…')}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen>
      <View style={styles.pageStack}>
        <TabTopBar titleKey="Warranties" />

        <Surface elevated>
          <SectionHeader title="New warranty" />
          {spacesCtx.spaces.length > 1 ? (
            <View style={{ marginBottom: themeSpacing.sm }}>
              <Text style={styles.mutedText}>{tr('Profile')}</Text>
              <SegmentedControl
                value={spacesCtx.current?.id || spaceId || ''}
                onChange={(id) => { spacesCtx.setCurrent(id) }}
                options={spacesCtx.spaces.map((s) => ({ value: s.id, label: s.name }))}
                style={{ marginTop: themeSpacing.xs }}
              />
            </View>
          ) : null}

          <Disclosure title="Linked bill (required)">
            <Text style={styles.bodyText}>{tr('Warranties must be linked 1:1 to a bill.')}</Text>
            {linkedBillIds.size > 0 ? (
              <Text style={styles.mutedText}>{tr('Bills already linked are hidden from this list.')}</Text>
            ) : null}
            <AppInput placeholder="Find bill by supplier" value={billQuery} onChangeText={setBillQuery} />
            {selectedBill ? (
              <InlineInfo
                tone="info"
                iconName="link-outline"
                message={tr('Selected bill: {supplier} • due {dueDate} • {currency} {amount}', {
                  supplier: selectedBill.supplier,
                  dueDate: selectedBill.due_date,
                  currency: selectedBill.currency,
                  amount: selectedBill.amount.toFixed(2),
                })}
                translate={false}
              />
            ) : (
              <InlineInfo tone="warning" iconName="alert-circle-outline" message="Select a bill before saving the warranty." />
            )}
            <View style={{ gap: themeSpacing.xs, marginTop: themeSpacing.sm }}>
              {selectableBills.length === 0 ? (
                <Text style={styles.mutedText}>{tr('No available bills to link.')}</Text>
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
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeSpacing.sm }}>
              <View style={{ flexGrow: 1, flexBasis: 160, minWidth: 160, gap: themeSpacing.xs }}>
                <AppButton
                  label="Purchase"
                  variant="secondary"
                  iconName="calendar-outline"
                  onPress={() => openDatePicker('purchase')}
                />
                <Text style={styles.mutedText}>{purchaseDate || tr('Pick date')}</Text>
              </View>

              <View style={{ flexGrow: 1, flexBasis: 160, minWidth: 160, gap: themeSpacing.xs }}>
                <AppButton
                  label="Expires"
                  variant="secondary"
                  iconName="calendar-outline"
                  onPress={() => openDatePicker('expires')}
                />
                <Text style={styles.mutedText}>{expiresAt || tr('Pick date')}</Text>
              </View>

              <View style={{ flexGrow: 1, flexBasis: 160, minWidth: 160, gap: themeSpacing.xs }}>
                <AppInput
                  placeholder="Duration (months)"
                  value={durationMonths}
                  onChangeText={(value) => {
                    setDurationMonths(value)
                    if (value.trim()) setExpiresAt('')
                  }}
                  keyboardType="numeric"
                />
              </View>
            </View>

            {Platform.OS !== 'android' && iosPickerVisible ? (
              <View style={styles.datePickerContainer}>
                <DateTimePicker
                  mode="date"
                  display="spinner"
                  value={iosPickerValue}
                  onChange={(_event, selectedDate) => {
                    if (!selectedDate) return
                    setIosPickerValue(selectedDate)
                  }}
                />
                <View style={styles.datePickerActions}>
                  <AppButton label="Cancel" variant="ghost" onPress={cancelIosPicker} />
                  <AppButton label="Done" onPress={confirmIosPicker} />
                </View>
              </View>
            ) : null}
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
          Alert.alert(tr('Attachment selected'), tr('Image will be attached on save.'))
        }}
            />
            <AppButton
              label={tr('Attach PDF')}
              variant="secondary"
              iconName="document-attach-outline"
              onPress={async ()=>{
          const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
          if (res.canceled) return
          const file = res.assets?.[0]
          if (!file?.uri) return
          setPendingAttachment({ uri: file.uri, name: file.name || 'document.pdf', type: 'application/pdf' })
          Alert.alert(tr('Attachment selected'), tr('PDF will be attached on save.'))
        }}
            />
          </View>

          {!!pendingAttachment && (
            <View style={{ marginTop: themeSpacing.sm }}>
              <Text style={styles.bodyText}>{tr('Attachment preview:')}</Text>
              {pendingAttachment.type?.startsWith('image/') ? (
                <Image source={{ uri: pendingAttachment.uri }} style={{ width: 160, height: 120, borderRadius: 12, marginTop: themeSpacing.xs }} />
              ) : (
                <Text style={styles.bodyText}>{pendingAttachment.name}</Text>
              )}
            </View>
          )}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
            <AppButton
              label={tr('Save warranty')}
              iconName="save-outline"
              onPress={addManual}
            />
            <AppButton
              label={tr('OCR from photo')}
              variant="secondary"
              iconName="scan-outline"
              onPress={ocrPhoto}
            />
            <AppButton
              label={tr('OCR from PDF')}
              variant="secondary"
              iconName="document-text-outline"
              onPress={ocrPdf}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Existing warranties')} />
          {items.length === 0 ? (
            <View style={[styles.brandEmptyWrap, { gap: themeSpacing.sm }]}>
              <Image source={BRAND_ICON} style={{ width: 18, height: 18 }} resizeMode="contain" accessibilityLabel="BILLBOX" />
              <EmptyState
                title={tr('No warranties yet')}
                message={tr('Save a warranty and attach a receipt or invoice to keep proof of purchase in one place.')}
                actionLabel={tr('Add warranty')}
                onActionPress={addManual}
                iconName="shield-checkmark-outline"
              />
            </View>
          ) : (
            <FlatList
              data={filteredWarranties}
              keyExtractor={(w)=>w.id}
              contentContainerStyle={styles.listContent}
              ListHeaderComponent={
                <View style={{ gap: themeSpacing.sm, paddingBottom: themeSpacing.sm }}>
                  <View style={{ flexDirection: 'row', gap: themeSpacing.sm, alignItems: 'center' }}>
                    <AppInput
                      placeholder={tr('Search warranties')}
                      value={warrantyQuery}
                      onChangeText={setWarrantyQuery}
                      style={{ flex: 1 }}
                    />
                    <AppButton
                      label={warrantyView === 'archived' ? tr('Active') : tr('Archived')}
                      variant="secondary"
                      iconName={warrantyView === 'archived' ? 'shield-checkmark-outline' : 'archive-outline'}
                      onPress={() => setWarrantyView((prev) => (prev === 'archived' ? 'active' : 'archived'))}
                    />
                  </View>
                  <Text style={styles.mutedText}>
                    {tr('{shown} of {total} warranties', { shown: filteredWarranties.length, total: items.length })}
                  </Text>
                </View>
              }
              ListEmptyComponent={
                <EmptyState
                  title={warrantyView === 'archived' ? tr('No expired warranties') : tr('No warranties found')}
                  message={warrantyView === 'archived' ? tr('Expired warranties will appear here.') : tr('Adjust your search or add a new warranty.')}
                  actionLabel={warrantyView === 'archived' ? undefined : tr('Add warranty')}
                  onActionPress={warrantyView === 'archived' ? undefined : addManual}
                  iconName={warrantyView === 'archived' ? 'archive-outline' : 'shield-checkmark-outline'}
                />
              }
              renderItem={({ item }) => (
                <Surface elevated style={styles.billRowCard}>
                  <View style={styles.billRowHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle} numberOfLines={1}>
                        {item.item_name}{(item as any)?.unsynced ? ` • ${tr('Not synced')}` : ''}
                      </Text>
                      <Text style={styles.mutedText}>
                        {item.supplier || '—'} • {tr('Purchase')}: {item.purchase_date || '—'} • {tr('Expires')}: {item.expires_at || '—'}{(item as any)?.bill_id ? ` • ${tr('Linked bill')}` : ''}
                      </Text>
                    </View>
                    {(() => {
                      const exp = parseDateValue((item as any)?.expires_at)
                      const expired = exp ? exp.getTime() < today.getTime() : false
                      const label = expired ? 'Expired' : item.expires_at ? 'Active' : 'No expiry'
                      const tone = expired ? 'warning' : item.expires_at ? 'info' : 'neutral'
                      return <Badge label={label} tone={tone as any} />
                    })()}
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
    if (up.error) Alert.alert(tr('Upload failed'), up.error)
    else Alert.alert(tr('Attachment uploaded'), tr('Image attached to warranty'))
    await refresh()
  }
  async function addPdf() {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
    if (res.canceled) return
    const file = res.assets?.[0]
    if (!file?.uri) return
    const up = await uploadAttachmentFromUri(spaceId, 'warranties', warrantyId!, file.uri, file.name || 'document.pdf', 'application/pdf')
    if (up.error) Alert.alert(tr('Upload failed'), up.error)
    else Alert.alert(tr('Attachment uploaded'), tr('PDF attached to warranty'))
    await refresh()
  }
  async function openAttachment(path: string, uri?: string) {
    if (supabase) { const url = await getSignedUrl(supabase!, path); if (url) Linking.openURL(url); else Alert.alert(tr('Open failed'), tr('Could not get URL')) }
    else if (uri) Linking.openURL(uri)
    else Alert.alert(tr('Offline'), tr('Attachment stored locally. Preview is unavailable.'))
  }
  async function remove(path: string) {
    Alert.alert(tr('Delete attachment?'), tr('This file will be removed.'), [
      { text: tr('Cancel'), style: 'cancel' },
      { text: tr('Delete'), style: 'destructive', onPress: async () => { const { error } = await deleteAttachment(spaceId, 'warranties', warrantyId!, path); if (error) Alert.alert(tr('Delete failed'), error); else await refresh() } }
    ])
  }
  if (!warranty || spaceLoading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{tr('Warranty not found.')}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen>
      <View style={styles.pageStack}>
        <TabTopBar
          title={warranty.item_name || tr('Warranty')}
          left={
            <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8} accessibilityLabel={tr('Back')}>
              <Ionicons name="chevron-back" size={22} color={themeColors.text} />
            </TouchableOpacity>
          }
        />

        <Surface elevated>
          <SectionHeader title="Warranty summary" />
          <Text style={styles.bodyText}>
            {warranty.supplier || '—'} • {tr('Purchase')}: {warranty.purchase_date || '—'} • {tr('Expires')}: {warranty.expires_at || '—'}
          </Text>
        </Surface>

        {(linkedBill || (warranty as any)?.bill_id) ? (
          <Surface elevated>
            <SectionHeader title="Linked bill" />
            {linkedBill ? (
              <>
                <Text style={styles.bodyText}>{linkedBill.supplier} • {linkedBill.currency} {linkedBill.amount.toFixed(2)} • {tr('Due')} {linkedBill.due_date}</Text>
                <AppButton
                  label={tr('Open bill')}
                  variant="secondary"
                  iconName="open-outline"
                  onPress={() => navigation.navigate('Bill Details', { bill: linkedBill })}
                />
              </>
            ) : (
              <Text style={styles.mutedText}>{tr('This warranty is linked to a bill, but it was not found in the current profile.')}</Text>
            )}
          </Surface>
        ) : null}

        <Surface elevated>
          <SectionHeader title={tr('Reminders')} />
          {!warranty.expires_at ? (
            <InlineInfo
              tone="warning"
              iconName="alert-circle-outline"
              message={tr('No expiry date — warranty reminders cannot be scheduled.')}
            />
          ) : null}
          <View style={styles.billActionsRow}>
            <AppButton
              label={tr('Schedule defaults')}
              variant="secondary"
              iconName="alarm-outline"
              onPress={async ()=>{
                if (!warranty.expires_at) { Alert.alert(tr('Missing expiry date'), tr('Add an expiry date to schedule reminders.')); return }
                await ensureNotificationConfig()
                const ok = await requestPermissionIfNeeded()
                if (!ok) {
                  Alert.alert(tr('Enable reminders'), tr('Please enable notifications in system settings.'))
                  return
                }
                await scheduleWarrantyReminders({ id: warranty.id, item_name: warranty.item_name || tr('Warranty'), supplier: warranty.supplier || null, expires_at: warranty.expires_at, space_id: spaceId } as any, undefined, spaceId)
                Alert.alert(tr('Reminders'), tr('Scheduled default warranty reminders.'))
              }}
            />
            <AppButton
              label={tr('Cancel reminders')}
              variant="ghost"
              iconName="notifications-off-outline"
              onPress={async ()=>{
                await cancelWarrantyReminders(warranty.id, spaceId)
                Alert.alert(tr('Reminders'), tr('Canceled for this warranty.'))
              }}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Attachments')} />
          <View style={styles.attachmentRow}>
            <AppButton
              label={tr('Add image')}
              variant="secondary"
              iconName="image-outline"
              onPress={addImage}
            />
            <AppButton
              label={tr('Add PDF')}
              variant="secondary"
              iconName="document-attach-outline"
              onPress={addPdf}
            />
          </View>
          {attachments.length === 0 ? (
            <EmptyState
              title={tr('No attachments')}
              message={tr('Attach a receipt or invoice so you can prove purchase when claiming this warranty.')}
              actionLabel={tr('Add image')}
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
                      label={tr('Open')}
                      variant="secondary"
                      iconName="open-outline"
                      onPress={()=>openAttachment(item.path, item.uri)}
                    />
                    <AppButton
                      label={tr('Delete')}
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
  const spacesCtx = useSpacesContext()
  const [bills, setBills] = useState<(Bill & { __spaceId?: string })[]>([])
  const [loadingReports, setLoadingReports] = useState(true)
  const [range, setRange] = useState<{ start: string; end: string }>({
    start: new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10),
    end: new Date().toISOString().slice(0, 10),
  })
  const [advancedMode, setAdvancedMode] = useState<'basic' | 'advanced'>('basic')
  const [dateMode, setDateMode] = useState<'due' | 'invoice' | 'created'>('due')
  const [groupBy, setGroupBy] = useState<'month' | 'year'>('month')
  const [status, setStatus] = useState<'all' | 'unpaid' | 'paid' | 'archived'>('all')
  const [supplierQuery, setSupplierQuery] = useState('')
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')
  const [exportBusy, setExportBusy] = useState(false)
  const [exportBusyLabel, setExportBusyLabel] = useState<string>('')
  const [iosPickerVisible, setIosPickerVisible] = useState(false)
  const [iosPickerField, setIosPickerField] = useState<'start' | 'end' | null>(null)
  const [iosPickerValue, setIosPickerValue] = useState(new Date())
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()

  const analyticsLevel: 'basic' | 'advanced' = entitlements.plan === 'pro' ? 'advanced' : 'basic'

  const payerSpaces = useMemo(() => {
    return (spacesCtx.spaces || []).filter((s) => isPayerSpaceId(s.id))
  }, [spacesCtx.spaces])

  const [selectedPayerIds, setSelectedPayerIds] = useState<string[]>(() => {
    const current = spaceId
    if (current && isPayerSpaceId(current)) return [current]
    const fallback = payerSpaces[0]?.id
    return fallback ? [fallback] : ['personal']
  })

  useEffect(() => {
    if (analyticsLevel === 'basic') setAdvancedMode('basic')
  }, [analyticsLevel])

  useEffect(() => {
    if (entitlements.plan !== 'pro') {
      setSelectedPayerIds((prev) => prev.filter((id) => id !== 'personal2'))
      if (spaceId === 'personal2') {
        // ensure we don't get stuck on a hidden/locked selection
        setSelectedPayerIds(['personal'])
      }
    }
  }, [entitlements.plan, spaceId])

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
    const [y, m, d] = parts.map((p) => Number(p))
    if ([y, m, d].some((p) => Number.isNaN(p))) return null
    return new Date(y, m - 1, d)
  }, [])

  const openDatePicker = useCallback((field: 'start' | 'end') => {
    const current = parseDateValue(field === 'start' ? range.start : range.end) || new Date()
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        mode: 'date',
        value: current,
        onChange: (_event, selectedDate) => {
          if (!selectedDate) return
          const iso = formatDateInput(selectedDate)
          setRange((r) => (field === 'start' ? { ...r, start: iso } : { ...r, end: iso }))
        },
      })
    } else {
      setIosPickerField(field)
      setIosPickerValue(current)
      setIosPickerVisible(true)
    }
  }, [formatDateInput, parseDateValue, range.end, range.start])

  const confirmIosPicker = useCallback(() => {
    if (!iosPickerField) {
      setIosPickerVisible(false)
      return
    }
    const iso = formatDateInput(iosPickerValue)
    setRange((r) => (iosPickerField === 'start' ? { ...r, start: iso } : { ...r, end: iso }))
    setIosPickerField(null)
    setIosPickerVisible(false)
  }, [formatDateInput, iosPickerField, iosPickerValue])

  const cancelIosPicker = useCallback(() => {
    setIosPickerField(null)
    setIosPickerVisible(false)
  }, [])

  function togglePayer(id: string, enabled: boolean) {
    setSelectedPayerIds((prev) => {
      const set = new Set(prev)
      if (enabled) set.add(id)
      else set.delete(id)
      const next = Array.from(set)
      return next.length ? next : prev
    })
  }

  function getBillDateForMode(bill: Bill, mode: typeof dateMode): string {
    if (mode === 'invoice') {
      const raw = (bill as any).invoice_date || bill.created_at
      return String(raw || '').slice(0, 10) || String(bill.due_date || '').slice(0, 10)
    }
    if (mode === 'created') {
      return String(bill.created_at || '').slice(0, 10) || String(bill.due_date || '').slice(0, 10)
    }
    return String(bill.due_date || '').slice(0, 10)
  }

  function yyyymmKey(iso: string): string {
    return String(iso || '').slice(0, 7)
  }

  function yyyyKey(iso: string): string {
    return String(iso || '').slice(0, 4)
  }

  useEffect(() => { (async ()=>{
    if (spaceLoading || !space) return
    setLoadingReports(true)
    try {
      const ids = (selectedPayerIds || []).filter(Boolean)
      const next: (Bill & { __spaceId?: string })[] = []
      for (const sid of ids) {
        if (supabase) {
          const { data } = await listBills(supabase, sid)
          for (const b of ((data as any) || []) as any[]) next.push({ ...(b as any), __spaceId: sid })
        } else {
          const locals = await loadLocalBills(sid)
          for (const b of (((locals as any) || []) as any[])) next.push({ ...(b as any), __spaceId: sid })
        }
      }
      setBills(next)
    } finally {
      setLoadingReports(false)
    }
  })() }, [supabase, spaceLoading, space, selectedPayerIds])

  const filtered = useMemo(() => {
    const supplierTerm = supplierQuery.trim().toLowerCase()
    const minVal = amountMin ? Number(String(amountMin).replace(',', '.')) : null
    const maxVal = amountMax ? Number(String(amountMax).replace(',', '.')) : null
    const isAdvanced = analyticsLevel === 'advanced' && advancedMode === 'advanced'

    return (bills || []).filter((b) => {
      const d = getBillDateForMode(b, isAdvanced ? dateMode : 'due')
      if (!d) return false
      if (d < range.start || d > range.end) return false

      if (status !== 'all' && b.status !== status) return false

      if (isAdvanced) {
        if (supplierTerm && !String(b.supplier || '').toLowerCase().includes(supplierTerm)) return false
        if (minVal !== null && !Number.isNaN(minVal) && b.amount < minVal) return false
        if (maxVal !== null && !Number.isNaN(maxVal) && b.amount > maxVal) return false
      }

      return true
    })
  }, [advancedMode, analyticsLevel, amountMax, amountMin, bills, dateMode, range.end, range.start, status, supplierQuery])

  const totals = useMemo(() => {
    const totalBillsInRange = filtered.length
    const totalAmountEur = filtered.reduce((sum, b) => sum + (b.currency === 'EUR' ? b.amount : 0), 0)
    const unpaidTotalEur = filtered.reduce((sum, b) => {
      if (b.status !== 'unpaid') return sum
      return sum + (b.currency === 'EUR' ? b.amount : 0)
    }, 0)
    return { totalBillsInRange, totalAmountEur, unpaidTotalEur }
  }, [filtered])

  const series = useMemo(() => {
    const keyFn = groupBy === 'year' ? yyyyKey : yyyymmKey
    const isAdvanced = analyticsLevel === 'advanced' && advancedMode === 'advanced'
    const modeForDate = isAdvanced ? dateMode : 'due'
    const grouped: Record<string, number> = {}
    for (const b of filtered) {
      const iso = getBillDateForMode(b, modeForDate)
      const key = keyFn(iso) || '—'
      grouped[key] = (grouped[key] || 0) + (b.currency === 'EUR' ? b.amount : 0)
    }
    const keys = Object.keys(grouped).sort()
    const max = keys.reduce((m, k) => Math.max(m, grouped[k] || 0), 0)
    const points = keys.map((k) => ({ key: k, value: grouped[k] || 0, pct: max > 0 ? (grouped[k] / max) * 100 : 0 }))
    return { points, max }
  }, [advancedMode, analyticsLevel, dateMode, filtered, groupBy])

  const supplierTotals = useMemo(() => {
    const grouped: Record<string, number> = {}
    for (const b of filtered) {
      const name = String(b.supplier || '').trim() || tr('Unknown')
      grouped[name] = (grouped[name] || 0) + (b.currency === 'EUR' ? b.amount : 0)
    }
    const top = Object.entries(grouped)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([supplier, value]) => ({ supplier, value }))
    const max = top.reduce((m, x) => Math.max(m, x.value), 0)
    return { top, max }
  }, [filtered])

  const reportPayload = useMemo(() => {
    const isAdvanced = analyticsLevel === 'advanced' && advancedMode === 'advanced'
    return {
      generated_at: new Date().toISOString(),
      plan: entitlements.plan,
      profiles: selectedPayerIds.map((id) => ({ id, label: payerLabelFromSpaceId(id) })),
      filters: {
        start: range.start,
        end: range.end,
        status,
        analytics_mode: isAdvanced ? 'advanced' : 'basic',
        date_mode: isAdvanced ? dateMode : 'due',
        group_by: groupBy,
        supplier_query: isAdvanced ? supplierQuery : '',
        amount_min: isAdvanced ? amountMin : '',
        amount_max: isAdvanced ? amountMax : '',
      },
      totals,
      series: series.points,
      top_suppliers: supplierTotals.top,
    }
  }, [advancedMode, amountMax, amountMin, analyticsLevel, dateMode, entitlements.plan, groupBy, range.end, range.start, selectedPayerIds, series.points, status, supplierQuery, supplierTotals.top, totals])

  function csvEscape(v: any) {
    const s = v === null || v === undefined ? '' : String(v)
    return `"${s.replace(/"/g, '""')}"`
  }

  async function exportReportJSON() {
    if (!entitlements.exportsEnabled) {
      showUpgradeAlert('export')
      return
    }
    setExportBusy(true)
    setExportBusyLabel(tr('Preparing JSON…'))
    try {
      const file = `${FileSystem.cacheDirectory}billbox-report.json`
      await FileSystem.writeAsStringAsync(file, JSON.stringify(reportPayload, null, 2))
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file)
      else Alert.alert(tr('Export ready'), file)
    } catch {
      Alert.alert(tr('Export'), tr('Export failed. Please try again.'))
    } finally {
      setExportBusy(false)
      setExportBusyLabel('')
    }
  }

  async function exportReportZIP() {
    if (!entitlements.exportsEnabled) {
      showUpgradeAlert('export')
      return
    }
    setExportBusy(true)
    setExportBusyLabel(tr('Preparing ZIP…'))
    try {
      const zip = new JSZip()
      zip.file('report.json', JSON.stringify(reportPayload, null, 2))
      const seriesRows = [['period', 'amount_eur']].concat(series.points.map((p) => [p.key, p.value.toFixed(2)]))
      const suppliersRows = [['supplier', 'amount_eur']].concat(supplierTotals.top.map((s) => [s.supplier, s.value.toFixed(2)]))
      zip.file('series.csv', seriesRows.map((r) => r.map(csvEscape).join(',')).join('\n'))
      zip.file('suppliers.csv', suppliersRows.map((r) => r.map(csvEscape).join(',')).join('\n'))
      const base64 = await zip.generateAsync({ type: 'base64' })
      const file = `${FileSystem.cacheDirectory}billbox-report.zip`
      await FileSystem.writeAsStringAsync(file, base64, { encoding: FileSystem.EncodingType.Base64 })
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file)
      else Alert.alert(tr('Export ready'), file)
    } catch {
      Alert.alert(tr('Export'), tr('Export failed. Please try again.'))
    } finally {
      setExportBusy(false)
      setExportBusyLabel('')
    }
  }

  async function exportReportPDF() {
    if (!entitlements.exportsEnabled) {
      showUpgradeAlert('export')
      return
    }
    setExportBusy(true)
    setExportBusyLabel(tr('Preparing PDF…'))
    try {
      const profileLabel = selectedPayerIds.map((id) => payerLabelFromSpaceId(id)).join(' + ')
      const html = `
        <html>
          <head>
            <meta charset="utf-8" />
            <style>
              body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; padding: 18px; color: #0f172a; }
              h1 { font-size: 18px; margin: 0 0 8px; }
              .meta { color: #64748b; font-size: 12px; margin-bottom: 14px; }
              .card { border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
              .row { display: flex; justify-content: space-between; gap: 10px; }
              .k { color: #64748b; font-size: 12px; }
              .v { font-size: 14px; font-weight: 600; }
              table { width: 100%; border-collapse: collapse; }
              th, td { border-bottom: 1px solid #e2e8f0; padding: 8px 6px; text-align: left; font-size: 12px; }
              th { color: #334155; }
            </style>
          </head>
          <body>
            <h1>${tr('Reports')}</h1>
            <div class="meta">
              ${tr('Profiles')}: ${profileLabel}<br/>
              ${tr('Date range')}: ${range.start} – ${range.end}<br/>
              ${tr('Generated')}: ${new Date().toISOString()}
            </div>
            <div class="card">
              <div class="row"><div class="k">${tr('Bills in range')}</div><div class="v">${totals.totalBillsInRange}</div></div>
              <div class="row"><div class="k">${tr('Total amount (EUR)')}</div><div class="v">EUR ${totals.totalAmountEur.toFixed(2)}</div></div>
              <div class="row"><div class="k">${tr('Unpaid total (EUR)')}</div><div class="v">EUR ${totals.unpaidTotalEur.toFixed(2)}</div></div>
            </div>
            <div class="card">
              <div class="k" style="margin-bottom:8px;">${groupBy === 'year' ? tr('Yearly spend') : tr('Monthly spend')}</div>
              <table>
                <thead><tr><th>${tr('Period')}</th><th>${tr('Amount (EUR)')}</th></tr></thead>
                <tbody>
                  ${series.points.map((p) => `<tr><td>${p.key}</td><td>EUR ${p.value.toFixed(2)}</td></tr>`).join('')}
                </tbody>
              </table>
            </div>
            <div class="card">
              <div class="k" style="margin-bottom:8px;">${tr('Top suppliers')}</div>
              <table>
                <thead><tr><th>${tr('Supplier')}</th><th>${tr('Amount (EUR)')}</th></tr></thead>
                <tbody>
                  ${supplierTotals.top.map((s) => `<tr><td>${s.supplier}</td><td>EUR ${s.value.toFixed(2)}</td></tr>`).join('')}
                </tbody>
              </table>
            </div>
          </body>
        </html>
      `
      const res = await Print.printToFileAsync({ html })
      const uri = (res as any)?.uri
      if (!uri) throw new Error('missing-uri')
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri)
      else Alert.alert(tr('Export ready'), uri)
    } catch {
      Alert.alert(tr('Export'), tr('Export failed. Please try again.'))
    } finally {
      setExportBusy(false)
      setExportBusyLabel('')
    }
  }

  if (spaceLoading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{tr('Loading reports…')}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen>
      <View style={styles.pageStack}>
        <TabTopBar titleKey="Reports" />

        <Surface elevated>
          <SectionHeader title={tr('Filters')} />
          <View style={styles.filtersBody}>
            {analyticsLevel === 'advanced' ? (
              <SegmentedControl
                value={advancedMode}
                onChange={(v) => setAdvancedMode(v as any)}
                options={[{ value: 'basic', label: tr('Basic') }, { value: 'advanced', label: tr('Advanced') }]}
              />
            ) : (
              <InlineInfo
                tone="info"
                iconName="information-circle-outline"
                message={tr('Basic analytics is available on Free and Moje. Upgrade to Več for advanced analytics.')}
              />
            )}

            <View style={{ marginTop: themeSpacing.sm }}>
              <Text style={styles.filterLabel}>{tr('Profiles')}</Text>
              <View style={styles.filterToggleRow}>
                {(['personal', 'personal2'] as const).map((id) => {
                  const exists = payerSpaces.some((s) => s.id === id)
                  const locked = id === 'personal2' && (!exists || entitlements.plan !== 'pro')
                  const enabled = selectedPayerIds.includes(id)
                  return (
                    <View key={id} style={styles.filterToggle}>
                      <Switch
                        value={enabled}
                        onValueChange={(v) => {
                          if (locked) {
                            showUpgradeAlert('profile2')
                            return
                          }
                          togglePayer(id, v)
                        }}
                        disabled={locked}
                      />
                      <Text style={styles.toggleLabel}>{tr(payerLabelFromSpaceId(id))}</Text>
                      {locked ? <Text style={[styles.mutedText, { marginLeft: 6 }]}>{tr('Locked (Več only)')}</Text> : null}
                    </View>
                  )
                })}
              </View>
              <Text style={styles.helperText}>{tr('Reports can include Profil 1, Profil 2, or both.')}</Text>
            </View>

            <View style={styles.dateFilterSection}>
              <Text style={styles.filterLabel}>{tr('Date range')}</Text>
              {analyticsLevel === 'advanced' && advancedMode === 'advanced' ? (
                <SegmentedControl
                  value={dateMode}
                  onChange={(value) => setDateMode(value as typeof dateMode)}
                  options={[
                    { value: 'due', label: tr('Due') },
                    { value: 'invoice', label: tr('Invoice') },
                    { value: 'created', label: tr('Created') },
                  ]}
                  style={{ marginTop: themeSpacing.xs }}
                />
              ) : null}

              <View style={styles.dateRow}>
                <Pressable style={styles.dateButton} onPress={() => openDatePicker('start')} hitSlop={8}>
                  <Ionicons name="calendar-outline" size={16} color={themeColors.primary} />
                  <Text style={styles.dateButtonText}>{range.start || tr('Start date')}</Text>
                </Pressable>
                <Pressable style={styles.dateButton} onPress={() => openDatePicker('end')} hitSlop={8}>
                  <Ionicons name="calendar-outline" size={16} color={themeColors.primary} />
                  <Text style={styles.dateButtonText}>{range.end || tr('End date')}</Text>
                </Pressable>
              </View>

              <View style={styles.manualDateRow}>
                <AppInput placeholder="YYYY-MM-DD" value={range.start} onChangeText={(v) => setRange((r) => ({ ...r, start: v }))} style={styles.flex1} />
                <AppInput placeholder="YYYY-MM-DD" value={range.end} onChangeText={(v) => setRange((r) => ({ ...r, end: v }))} style={styles.flex1} />
              </View>

              <Text style={styles.helperText}>{tr('Reports use the selected date field between Start and End.')}</Text>
            </View>

            <View style={{ marginTop: themeSpacing.sm }}>
              <Text style={styles.filterLabel}>{tr('Status')}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                <AppButton label={tr('All')} variant={status === 'all' ? 'secondary' : 'ghost'} onPress={() => setStatus('all')} />
                <AppButton label={tr('Unpaid')} variant={status === 'unpaid' ? 'secondary' : 'ghost'} onPress={() => setStatus('unpaid')} />
                <AppButton label={tr('Paid')} variant={status === 'paid' ? 'secondary' : 'ghost'} onPress={() => setStatus('paid')} />
                {analyticsLevel === 'advanced' && advancedMode === 'advanced' ? (
                  <AppButton label={tr('Archived')} variant={status === 'archived' ? 'secondary' : 'ghost'} onPress={() => setStatus('archived')} />
                ) : null}
              </View>
            </View>

            <View style={{ marginTop: themeSpacing.sm }}>
              <Text style={styles.filterLabel}>{tr('Group by')}</Text>
              <SegmentedControl
                value={groupBy}
                onChange={(v) => setGroupBy(v as any)}
                options={[{ value: 'month', label: tr('Month') }, { value: 'year', label: tr('Year') }]}
              />
            </View>

            {analyticsLevel === 'advanced' && advancedMode === 'advanced' ? (
              <View style={{ marginTop: themeSpacing.sm, gap: themeSpacing.sm }}>
                <AppInput placeholder={tr('Supplier')} value={supplierQuery} onChangeText={setSupplierQuery} />
                <View style={styles.filterRow}>
                  <AppInput placeholder={tr('Min amount')} keyboardType="numeric" value={amountMin} onChangeText={setAmountMin} style={styles.flex1} />
                  <AppInput placeholder={tr('Max amount')} keyboardType="numeric" value={amountMax} onChangeText={setAmountMax} style={styles.flex1} />
                </View>
              </View>
            ) : null}
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Report exports')} />
          {entitlements.plan !== 'pro' ? (
            <InlineInfo
              tone="info"
              iconName="sparkles-outline"
              message={tr('Report exports are available on Več (PDF, ZIP, JSON).')}
            />
          ) : (
            <>
              <Text style={styles.bodyText}>{tr('Export this report as PDF, ZIP, or JSON.')}</Text>
              {exportBusy ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
                  <ActivityIndicator size="small" color={themeColors.primary} />
                  <Text style={styles.mutedText}>{exportBusyLabel || tr('Preparing export…')}</Text>
                </View>
              ) : null}
              <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
                <AppButton label={tr('Export PDF report')} variant="secondary" iconName="print-outline" onPress={exportReportPDF} disabled={exportBusy} />
                <AppButton label={tr('Export ZIP')} variant="secondary" iconName="cloud-download-outline" onPress={exportReportZIP} disabled={exportBusy} />
                <AppButton label={tr('Export JSON')} variant="secondary" iconName="code-outline" onPress={exportReportJSON} disabled={exportBusy} />
              </View>
              {!entitlements.exportsEnabled ? (
                <View style={{ marginTop: themeSpacing.sm }}>
                  <InlineInfo
                    tone="info"
                    iconName="sparkles-outline"
                    message={tr('Report exports are available on Več (PDF, ZIP, JSON).')}
                  />
                </View>
              ) : null}
            </>
          )}
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Totals in range')} />
          <View style={{ marginTop: themeSpacing.sm, gap: themeSpacing.xs }}>
            <Text style={styles.bodyText}>{tr('Bills in range')}: {totals.totalBillsInRange}</Text>
            <Text style={styles.bodyText}>{tr('Total amount (EUR)')}: EUR {totals.totalAmountEur.toFixed(2)}</Text>
            <Text style={styles.bodyText}>{tr('Unpaid total (EUR)')}: EUR {totals.unpaidTotalEur.toFixed(2)}</Text>
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={groupBy === 'year' ? tr('Yearly spend') : tr('Monthly spend')} />
          <View style={{ paddingVertical: themeSpacing.sm }}>
            {series.points.length === 0 ? (
              <Text style={styles.mutedText}>{tr('No bills in this range.')}</Text>
            ) : (
              series.points.map((p) => (
                <View key={p.key} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                  <Text style={{ width: 80 }}>{p.key}</Text>
                  <View style={{ flex: 1, height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: '#E5E7EB' }}>
                    <View style={{ height: '100%', width: `${Math.max(0, Math.min(100, p.pct))}%`, backgroundColor: themeColors.primary }} />
                  </View>
                  <Text style={{ marginLeft: 8 }}>EUR {p.value.toFixed(2)}</Text>
                </View>
              ))
            )}
          </View>
        </Surface>

        {entitlements.plan === 'pro' ? (
          <Surface elevated>
            <SectionHeader title={tr('Top suppliers')} />
            <View style={{ paddingVertical: themeSpacing.sm }}>
              {supplierTotals.top.length === 0 ? (
                <Text style={styles.mutedText}>{tr('No suppliers for this period.')}</Text>
              ) : (
                supplierTotals.top.map((s) => (
                  <View key={s.supplier} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                    <Text style={{ flex: 1 }} numberOfLines={1}>{s.supplier}</Text>
                    <View style={{ width: 90, height: 10, borderRadius: 6, overflow: 'hidden', backgroundColor: '#E5E7EB', marginRight: 8 }}>
                      <View
                        style={{
                          height: '100%',
                          width: `${supplierTotals.max > 0 ? Math.max(0, Math.min(100, (s.value / supplierTotals.max) * 100)) : 0}%`,
                          backgroundColor: '#22C55E',
                        }}
                      />
                    </View>
                    <Text>EUR {s.value.toFixed(2)}</Text>
                  </View>
                ))
              )}
            </View>
          </Surface>
        ) : null}
      </View>

      {isIOS && iosPickerVisible ? (
        <View style={styles.iosPickerOverlay}>
          <Surface elevated style={styles.iosPickerSheet}>
            <Text style={styles.filterLabel}>{tr('Select date')}</Text>
            <DateTimePicker
              mode="date"
              display="inline"
              value={iosPickerValue}
              onChange={(_, selected) => {
                if (selected) setIosPickerValue(selected)
              }}
            />
            <View style={styles.iosPickerActions}>
              <AppButton label={tr('Cancel')} variant="ghost" onPress={cancelIosPicker} />
              <AppButton label={tr('Use date')} onPress={confirmIosPicker} />
            </View>
          </Surface>
        </View>
      ) : null}
    </Screen>
  )
}

function ExportsScreen() {
  const route = useRoute<any>()
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

  const [iosPickerVisible, setIosPickerVisible] = useState(false)
  const [iosPickerField, setIosPickerField] = useState<'start' | 'end' | null>(null)
  const [iosPickerValue, setIosPickerValue] = useState(new Date())

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
    const [y, m, d] = parts.map((p) => Number(p))
    if ([y, m, d].some((p) => Number.isNaN(p))) return null
    return new Date(y, m - 1, d)
  }, [])

  const openExportDatePicker = useCallback((field: 'start' | 'end') => {
    const current = parseDateValue(field === 'start' ? range.start : range.end) || new Date()
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        mode: 'date',
        value: current,
        onChange: (_event, selectedDate) => {
          if (!selectedDate) return
          const iso = formatDateInput(selectedDate)
          setRange((r) => (field === 'start' ? { ...r, start: iso } : { ...r, end: iso }))
        },
      })
    } else {
      setIosPickerField(field)
      setIosPickerValue(current)
      setIosPickerVisible(true)
    }
  }, [formatDateInput, parseDateValue, range.end, range.start])

  const confirmIosPicker = useCallback(() => {
    if (!iosPickerField) {
      setIosPickerVisible(false)
      return
    }
    const iso = formatDateInput(iosPickerValue)
    setRange((r) => (iosPickerField === 'start' ? { ...r, start: iso } : { ...r, end: iso }))
    setIosPickerField(null)
    setIosPickerVisible(false)
  }, [formatDateInput, iosPickerField, iosPickerValue])

  const cancelIosPicker = useCallback(() => {
    setIosPickerField(null)
    setIosPickerVisible(false)
  }, [])

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

  async function callExportFunction(
    fnName: 'export-pdf' | 'export-zip',
    payload: any,
    busyLabel: string,
  ): Promise<{ url: string; filename: string; contentType: string; sizeBytes: number } | null> {
    const base = getFunctionsBase()
    const s = getSupabase()
    if (!base) {
      Alert.alert(
        t(lang, 'Export'),
        t(lang, 'Export is unavailable (missing server configuration).'),
      )
      return null
    }
    if (!s) {
      Alert.alert(t(lang, 'Export'), t(lang, 'Exports require an online account.'))
      return null
    }

    setExportBusy(true)
    setExportBusyLabel(busyLabel)
    try {
      const { data } = await s.auth.getSession()
      const token = data?.session?.access_token
      if (!token) {
        Alert.alert(t(lang, 'Export'), t(lang, 'Please sign in again.'))
        return null
      }

      const resp = await fetch(`${base}/.netlify/functions/${fnName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload || {}),
      })
      const json = await resp.json().catch(() => null)

      if (resp.status === 401) {
        Alert.alert(t(lang, 'Export'), t(lang, 'Please sign in again.'))
        return null
      }
      if (resp.status === 403) {
        showUpgradeAlert('export')
        return null
      }
      if (!resp.ok || !json?.ok || !json?.url) {
        Alert.alert(t(lang, 'Export'), t(lang, 'Export failed. Please try again.'))
        return null
      }

      return {
        url: String(json.url),
        filename: String(json.filename || 'billbox-export'),
        contentType: String(json.contentType || 'application/octet-stream'),
        sizeBytes: Number(json.sizeBytes || 0),
      }
    } catch {
      Alert.alert(t(lang, 'Export'), t(lang, 'Export failed. Please try again.'))
      return null
    } finally {
      setExportBusy(false)
      setExportBusyLabel('')
    }
  }

  async function downloadAndShare(url: string, filename: string, mimeType: string) {
    try {
      const safe = filename.replace(/[^a-z0-9._-]/gi, '_') || 'billbox-export'
      const localPath = `${FileSystem.cacheDirectory}${safe}`
      await FileSystem.downloadAsync(url, localPath)
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(localPath, { mimeType, dialogTitle: t(lang, 'Share export') })
      } else {
        Alert.alert(t(lang, 'Export ready'), localPath)
      }
    } catch {
      Alert.alert(t(lang, 'Export'), t(lang, 'Export failed. Please try again.'))
    }
  }

  async function exportJSONRange() {
    if (!entitlements.exportsEnabled) {
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
    else Alert.alert(tr('JSON saved'), file)
  }

  async function exportCSV() {
    if (!entitlements.exportsEnabled) {
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
            else Alert.alert(tr('CSV saved'), file)
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
    else Alert.alert(tr('CSV saved'), file)
  }

  async function exportPDFRange() {
    if (!entitlements.exportsEnabled) {
      showUpgradeAlert('export')
      return
    }
    const res = await callExportFunction(
      'export-pdf',
      {
        kind: 'range',
        spaceId,
        filters: {
          start: range.start,
          end: range.end,
          dateMode,
          supplierQuery,
          amountMin,
          amountMax,
          hasAttachmentsOnly,
          status,
        },
      },
      tr('Preparing PDF…')
    )
    if (!res) return
    await downloadAndShare(res.url, res.filename, res.contentType)
  }

  async function exportPDFSingle(bill: Bill) {
    if (!entitlements.exportsEnabled) {
      showUpgradeAlert('export')
      return
    }
    const res = await callExportFunction(
      'export-pdf',
      {
        kind: 'single',
        spaceId,
        billId: bill.id,
      },
      tr('Preparing PDF…')
    )
    if (!res) return
    await downloadAndShare(res.url, res.filename, res.contentType)
  }

  async function exportAttachmentsZip() {
    if (!entitlements.exportsEnabled) {
      showUpgradeAlert('export')
      return
    }
    if (!filtered.length) {
      Alert.alert(tr('No bills match the current filters.'), tr('Adjust the filters to include bills with attachments.'))
      return
    }
    const res = await callExportFunction(
      'export-zip',
      {
        spaceId,
        filters: {
          start: range.start,
          end: range.end,
          dateMode,
          supplierQuery,
          amountMin,
          amountMax,
          hasAttachmentsOnly,
          status,
        },
      },
      tr('Preparing ZIP…')
    )
    if (!res) return
    await downloadAndShare(res.url, res.filename, res.contentType)
  }

  if (spaceLoading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{tr('Loading exports…')}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen>
      <View style={styles.pageStack}>
        <TabTopBar titleKey="Export attachments" />

        <Surface elevated>
          <SectionHeader title={tr('Filters')} />
          <View style={styles.filtersBody}>
            <View style={styles.dateFilterSection}>
              <Text style={styles.filterLabel}>{tr('Date range')}</Text>
              <SegmentedControl
                value={dateMode}
                onChange={(value) => setDateMode(value as typeof dateMode)}
                options={[
                  { value: 'due', label: tr('Due') },
                  { value: 'invoice', label: tr('Invoice') },
                  { value: 'created', label: tr('Created') },
                ]}
                style={{ marginTop: themeSpacing.xs }}
              />
              <View style={styles.dateRow}>
                <Pressable style={styles.dateButton} onPress={() => openExportDatePicker('start')} hitSlop={8}>
                  <Ionicons name="calendar-outline" size={16} color={themeColors.primary} />
                  <Text style={styles.dateButtonText}>{range.start || tr('Start date')}</Text>
                </Pressable>
                <Pressable style={styles.dateButton} onPress={() => openExportDatePicker('end')} hitSlop={8}>
                  <Ionicons name="calendar-outline" size={16} color={themeColors.primary} />
                  <Text style={styles.dateButtonText}>{range.end || tr('End date')}</Text>
                </Pressable>
              </View>
              <View style={styles.manualDateRow}>
                <AppInput placeholder="YYYY-MM-DD" value={range.start} onChangeText={(v)=>setRange(r=>({ ...r, start: v }))} style={styles.flex1} />
                <AppInput placeholder="YYYY-MM-DD" value={range.end} onChangeText={(v)=>setRange(r=>({ ...r, end: v }))} style={styles.flex1} />
              </View>
            </View>

            <View style={{ marginTop: themeSpacing.sm }}>
              <AppInput placeholder={tr('Supplier')} value={supplierQuery} onChangeText={setSupplierQuery} />
              <View style={styles.filterRow}>
                <AppInput placeholder={tr('Min amount')} keyboardType="numeric" value={amountMin} onChangeText={setAmountMin} style={styles.flex1} />
                <AppInput placeholder={tr('Max amount')} keyboardType="numeric" value={amountMax} onChangeText={setAmountMax} style={styles.flex1} />
              </View>
              <View style={styles.filterToggleRow}>
                <View style={styles.filterToggle}>
                  <Switch value={hasAttachmentsOnly} onValueChange={setHasAttachmentsOnly} />
                  <Text style={styles.toggleLabel}>{tr('Has attachment')}</Text>
                </View>
              </View>
            </View>

            <View style={{ marginTop: themeSpacing.sm }}>
              <Text style={styles.filterLabel}>{tr('Status')}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                <AppButton label={tr('All')} variant={status === 'all' ? 'secondary' : 'ghost'} onPress={() => setStatus('all')} />
                <AppButton label={tr('Unpaid')} variant={status === 'unpaid' ? 'secondary' : 'ghost'} onPress={() => setStatus('unpaid')} />
                <AppButton label={tr('Paid')} variant={status === 'paid' ? 'secondary' : 'ghost'} onPress={() => setStatus('paid')} />
                <AppButton label={tr('Archived')} variant={status === 'archived' ? 'secondary' : 'ghost'} onPress={() => setStatus('archived')} />
              </View>
              <Text style={styles.helperText}>{tr('Exports are scoped to the active profile and the filters above.')}</Text>
            </View>
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Export range')} />
          <Text style={styles.bodyText}>{tr('Exports include linked warranty files when present.')}</Text>
          {exportBusy ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
              <ActivityIndicator size="small" color={themeColors.primary} />
              <Text style={styles.mutedText}>{exportBusyLabel || tr('Preparing export…')}</Text>
            </View>
          ) : null}
          <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
            <AppButton label={tr('Export CSV')} variant="secondary" iconName="document-outline" onPress={exportCSV} disabled={exportBusy} />
            <AppButton label={tr('Export PDF report')} variant="secondary" iconName="print-outline" onPress={exportPDFRange} disabled={exportBusy} />
            <AppButton label={tr('Export attachments')} variant="secondary" iconName="cloud-download-outline" onPress={exportAttachmentsZip} disabled={exportBusy} />
            <AppButton label={tr('Export JSON (backup)')} variant="secondary" iconName="code-outline" onPress={exportJSONRange} disabled={exportBusy} />
          </View>
          {!entitlements.exportsEnabled ? (
            <View style={{ marginTop: themeSpacing.sm }}>
              <InlineInfo
                tone="info"
                iconName="sparkles-outline"
                message={tr('Exports are available on Več (CSV, PDF, ZIP, JSON).')}
              />
            </View>
          ) : null}
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Single bill PDF')} />
          {filtered.length === 0 ? (
            <Text style={styles.mutedText}>{tr('No bills match the current filters.')}</Text>
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
                      <Text style={styles.mutedText}>{item.currency} {item.amount.toFixed(2)} • {tr('Due')}: {item.due_date} • {item.status}</Text>
                    </View>
                  </View>
                  <View style={styles.billActionsRow}>
                    <AppButton label={tr('Export PDF')} variant="secondary" iconName="print-outline" onPress={() => exportPDFSingle(item)} disabled={exportBusy} />
                  </View>
                </Surface>
              )}
            />
          )}
        </Surface>
      </View>

      {isIOS && iosPickerVisible ? (
        <View style={styles.iosPickerOverlay}>
          <Surface elevated style={styles.iosPickerSheet}>
            <Text style={styles.filterLabel}>{tr('Select date')}</Text>
            <DateTimePicker
              mode="date"
              display="inline"
              value={iosPickerValue}
              onChange={(_, selected) => {
                if (selected) setIosPickerValue(selected)
              }}
            />
            <View style={styles.iosPickerActions}>
              <AppButton label={tr('Cancel')} variant="ghost" onPress={cancelIosPicker} />
              <AppButton label={tr('Use date')} onPress={confirmIosPicker} />
            </View>
          </Surface>
        </View>
      ) : null}
    </Screen>
  )
}

function PayScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const [items, setItems] = useState<Bill[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [planningDate, setPlanningDate] = useState(new Date().toISOString().slice(0,10))
  const [payActionVisible, setPayActionVisible] = useState(false)
  const [iosPickerVisible, setIosPickerVisible] = useState(false)
  const [iosPickerValue, setIosPickerValue] = useState(new Date())
  const [permissionExplained, setPermissionExplained] = useState(false)
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()

  const formatDateInput = useCallback((value: Date) => {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }, [])

  const parseDateValue = useCallback((value?: string | null): Date | null => {
    if (!value) return null
    const raw = String(value || '').trim()
    if (!raw) return null
    if (raw.includes('T')) {
      const parsed = new Date(raw)
      if (Number.isNaN(parsed.getTime())) return null
      return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
    }
    const parts = raw.split('-')
    if (parts.length !== 3) return null
    const [y, m, d] = parts.map((p) => Number(p))
    if ([y, m, d].some((p) => Number.isNaN(p))) return null
    return new Date(y, m - 1, d)
  }, [])

  const openDatePicker = useCallback(() => {
    const current = parseDateValue(planningDate) || new Date()
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        mode: 'date',
        value: current,
        onChange: (_event, selectedDate) => {
          if (!selectedDate) return
          setPlanningDate(formatDateInput(selectedDate))
        },
      })
    } else {
      setIosPickerValue(current)
      setIosPickerVisible(true)
    }
  }, [formatDateInput, parseDateValue, planningDate])

  const confirmIosPicker = useCallback(() => {
    setPlanningDate(formatDateInput(iosPickerValue))
    setIosPickerVisible(false)
  }, [formatDateInput, iosPickerValue])

  const cancelIosPicker = useCallback(() => {
    setIosPickerVisible(false)
  }, [])
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
    if (supabase) {
      const { data } = await listBills(supabase, spaceId)
      let next = (data || []) as Bill[]
      if (entitlements.plan === 'pro') {
        next = await ensureInstallmentBills({ spaceId, supabase, existingBills: next, horizonMonths: 2 })
      } else {
        next = next.filter((b) => !isInstallmentBill(b))
      }
      setItems(next)
    } else {
      const locals = await loadLocalBills(spaceId)
      let next = (locals as any) as Bill[]
      if (entitlements.plan === 'pro') {
        next = await ensureInstallmentBills({ spaceId, supabase: null, existingBills: next, horizonMonths: 2 })
      } else {
        next = next.filter((b) => !isInstallmentBill(b))
      }
      setItems(next)
    }
  })() }, [supabase, permissionExplained, spaceLoading, space, spaceId, entitlements.plan])
  const upcoming = items.filter(b=> b.status==='unpaid').sort((a,b)=> (a.pay_date||a.due_date).localeCompare(b.pay_date||b.due_date))
  const today = new Date().toISOString().slice(0,10)
  const thisWeekEnd = new Date(Date.now()+7*24*3600*1000).toISOString().slice(0,10)
  const groups = {
    today: upcoming.filter(b=> (b.pay_date||b.due_date)===today),
    thisWeek: upcoming.filter(b=> (b.pay_date||b.due_date)>today && (b.pay_date||b.due_date)<=thisWeekEnd),
    later: upcoming.filter(b=> (b.pay_date||b.due_date)>thisWeekEnd),
  }
  async function markPaid(b: Bill, paidDate?: string) {
    const nextStatus: BillStatus = isInstallmentBill(b) ? 'archived' : 'paid'
    if (supabase) {
      const { data } = await setBillStatus(supabase!, b.id, nextStatus, spaceId)
      if (data) setItems(prev=>prev.map((x:any)=>x.id===b.id? { ...(data as any), paid_at: paidDate || (x as any).paid_at }:x))
    } else {
      await setLocalBillStatus(spaceId, b.id, nextStatus)
      setItems(prev=>prev.map((x:any)=>x.id===b.id? { ...x, status: nextStatus, paid_at: paidDate || x.paid_at }:x))
    }
    await cancelBillReminders(b.id, spaceId)
  }
  async function snooze(b: Bill, days: number) { await snoozeBillReminder({ ...b, space_id: spaceId } as any, days, spaceId) }
  async function rescheduleSelected() {
    const dateISO = planningDate
    const picked = upcoming.filter(b=> selected[b.id])
    if (!picked.length) { Alert.alert(tr('Select bills'), tr('Select one or more bills.')); return }
    for (const b of picked) {
      if (supabase) { await setBillStatus(supabase!, b.id, b.status, spaceId) }
      // locally store pay_date using local map (since remote schema may not have it)
      setItems(prev=> prev.map(x=> x.id===b.id ? { ...x, pay_date: dateISO } as any : x))
      await scheduleBillReminders({ ...b, due_date: dateISO, space_id: spaceId } as any, undefined, spaceId)
    }
    await scheduleGroupedPaymentReminder(dateISO, picked.length, spaceId)
    Alert.alert(tr('Planned'), t(getCurrentLang(), 'Payment planned for {count} bill(s) on {date}.', { count: picked.length, date: dateISO }))
    setPayActionVisible(false)
  }

  async function paySelected() {
    const paidDate = planningDate
    const picked = upcoming.filter(b=> selected[b.id])
    if (!picked.length) { Alert.alert(tr('Select bills'), tr('Select one or more bills.')); return }
    for (const b of picked) {
      await markPaid(b, paidDate)
    }
    setSelected({})
    setPayActionVisible(false)
    Alert.alert(tr('Paid'), t(getCurrentLang(), 'Marked {count} bill(s) as paid.', { count: picked.length }))
  }

  function addDays(iso: string, days: number) {
    const d = parseDateValue(iso) || new Date()
    const out = new Date(d.getTime() + days * 24 * 3600 * 1000)
    return formatDateInput(out)
  }

  async function postponeBill(item: Bill, days: number) {
    const target = addDays((item as any).pay_date || item.due_date, days)
    setItems(prev=> prev.map(x=> x.id===item.id ? { ...x, pay_date: target } as any : x))
    await scheduleBillReminders({ ...item, due_date: target, space_id: spaceId } as any, undefined, spaceId)
  }

  async function postponeBillDue(item: Bill, days: number) {
    const target = addDays(item.due_date, days)
    try {
      if (supabase) {
        const { data } = await setBillDueDate(supabase!, item.id, target, spaceId)
        if (data) setItems((prev) => prev.map((x: any) => (x.id === item.id ? { ...x, due_date: target } : x)))
        else setItems((prev) => prev.map((x: any) => (x.id === item.id ? { ...x, due_date: target } : x)))
      } else {
        await setLocalBillDueDate(spaceId, item.id, target)
        setItems((prev) => prev.map((x: any) => (x.id === item.id ? { ...x, due_date: target } : x)))
      }
    } catch {
      setItems((prev) => prev.map((x: any) => (x.id === item.id ? { ...x, due_date: target } : x)))
    }
    await cancelBillReminders(item.id, spaceId)
    await scheduleBillReminders({ ...item, due_date: target, space_id: spaceId } as any, undefined, spaceId)
  }

  async function postponeGroup(list: Bill[], days: number) {
    if (!list.length) return
    const updates: Array<{ id: string; next: string }> = []
    for (const b of list) {
      const nextDate = addDays((b as any).pay_date || b.due_date, days)
      updates.push({ id: b.id, next: nextDate })
      await scheduleBillReminders({ ...b, due_date: nextDate, space_id: spaceId } as any, undefined, spaceId)
    }
    setItems(prev=> prev.map((x:any)=> {
      const u = updates.find(v=>v.id===x.id)
      return u ? { ...x, pay_date: u.next } : x
    }))
    Alert.alert(tr('Updated'), t(getCurrentLang(), 'Moved {count} bill(s) by {days} day(s).', { count: list.length, days }))
  }

  async function postponeGroupDue(list: Bill[], days: number) {
    if (!list.length) return
    for (const b of list) {
      await postponeBillDue(b, days)
    }
    Alert.alert(tr('Updated'), t(getCurrentLang(), 'Moved {count} bill(s) by {days} day(s).', { count: list.length, days }))
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
          <Text style={styles.mutedText}>{tr('Loading payment plan…')}</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen>
      <View style={styles.pageStack}>
        <TabTopBar titleKey="pay" />

        <Surface elevated padded={false} style={styles.paySectionCard}>
          <SectionHeader title={tr('Group payment')} />
          <View style={styles.payBatchRow}>
            <Pressable style={styles.dateButton} onPress={openDatePicker} hitSlop={8}>
              <Ionicons name="calendar-outline" size={16} color={themeColors.primary} />
              <Text style={styles.dateButtonText}>{planningDate || tr('Start date')}</Text>
            </Pressable>
            <AppInput placeholder="YYYY-MM-DD" value={planningDate} onChangeText={setPlanningDate} style={{ flex: 1 }} />
            <AppButton label={tr('Pay')} iconName="card-outline" onPress={() => setPayActionVisible(true)} />
          </View>
          <Text style={styles.helperText}>{tr('Select bills below, then pay or reschedule.')}</Text>
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Upcoming bills')} />
          {upcoming.length === 0 ? (
            <EmptyState
              title={tr('No unpaid bills')}
              message={tr('Once you have unpaid bills, they will appear here so you can plan payments.')}
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
                        {item.currency} {item.amount.toFixed(2)} • {tr('Due')}: {item.due_date}{(item as any).pay_date? ` • ${tr('Planned')}: ${(item as any).pay_date}`:''}
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
                    <Chip text={(item as any).pay_date ? `${tr('Planned')}: ${(item as any).pay_date}` : (new Date(item.due_date).getTime()-Date.now())/(24*3600*1000) < 1 ? tr('Due today') : tr('Upcoming')} />
                    <AppButton
                      label={tr('Mark as paid')}
                      variant="secondary"
                      iconName="checkmark-circle-outline"
                      onPress={()=>markPaid(item, today)}
                    />
                    <AppButton label={tr('+1d')} variant="ghost" iconName="time-outline" onPress={()=>postponeBill(item, 1)} />
                    <AppButton label={tr('+2d')} variant="ghost" iconName="time-outline" onPress={()=>postponeBill(item, 2)} />
                    <AppButton label={tr('+7d')} variant="ghost" iconName="time-outline" onPress={()=>postponeBill(item, 7)} />
                    <AppButton
                      label={`${tr('Due')} ${tr('+1d')}`}
                      variant="ghost"
                      iconName="calendar-outline"
                      onPress={() => postponeBillDue(item, 1)}
                    />
                    <AppButton
                      label={`${tr('Due')} ${tr('+7d')}`}
                      variant="ghost"
                      iconName="calendar-outline"
                      onPress={() => postponeBillDue(item, 7)}
                    />
                  </View>
                </Surface>
              )}
            />
          )}
        </Surface>

        <Surface elevated padded={false} style={styles.paySectionCard}>
          <SectionHeader title={tr('Payment plan overview')} />
          <View style={styles.payOverviewRow}>
            <Surface elevated padded={false} style={[styles.payOverviewCard, { flex: 1 }]}> 
              <Text style={styles.cardTitle}>{tr('Today')}</Text>
              <Text style={styles.bodyText}>{tr('{count} bills', { count: groups.today.length })}</Text>
              {groups.today.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  <AppButton label={tr('+1d')} variant="ghost" onPress={() => postponeGroup(groups.today, 1)} />
                  <AppButton label={tr('+7d')} variant="ghost" onPress={() => postponeGroup(groups.today, 7)} />
                  <AppButton label={`${tr('Due')} ${tr('+1d')}`} variant="ghost" onPress={() => postponeGroupDue(groups.today, 1)} />
                  <AppButton label={`${tr('Due')} ${tr('+7d')}`} variant="ghost" onPress={() => postponeGroupDue(groups.today, 7)} />
                </View>
              ) : null}
            </Surface>
            <Surface elevated padded={false} style={[styles.payOverviewCard, { flex: 1 }]}> 
              <Text style={styles.cardTitle}>{tr('This week')}</Text>
              <Text style={styles.bodyText}>{tr('{count} bills', { count: groups.thisWeek.length })}</Text>
              {groups.thisWeek.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  <AppButton label={tr('+1d')} variant="ghost" onPress={() => postponeGroup(groups.thisWeek, 1)} />
                  <AppButton label={tr('+7d')} variant="ghost" onPress={() => postponeGroup(groups.thisWeek, 7)} />
                  <AppButton label={`${tr('Due')} ${tr('+1d')}`} variant="ghost" onPress={() => postponeGroupDue(groups.thisWeek, 1)} />
                  <AppButton label={`${tr('Due')} ${tr('+7d')}`} variant="ghost" onPress={() => postponeGroupDue(groups.thisWeek, 7)} />
                </View>
              ) : null}
            </Surface>
            <Surface elevated padded={false} style={[styles.payOverviewCard, { flex: 1 }]}> 
              <Text style={styles.cardTitle}>{tr('Later')}</Text>
              <Text style={styles.bodyText}>{tr('{count} bills', { count: groups.later.length })}</Text>
            </Surface>
          </View>
        </Surface>
      </View>

      <Modal visible={payActionVisible} transparent animationType="fade" onRequestClose={() => setPayActionVisible(false)}>
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}> 
          <Surface elevated style={styles.iosPickerSheet}>
            <SectionHeader title={tr('Pay')} />
            <Text style={styles.bodyText}>{tr('Choose what to do with the selected bills:')}</Text>
            <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
              <AppButton label={tr('Pay selected')} iconName="card-outline" onPress={paySelected} />
              <AppButton label={tr('Reschedule selected')} variant="secondary" iconName="calendar-outline" onPress={rescheduleSelected} />
              <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setPayActionVisible(false)} />
            </View>
          </Surface>
        </View>
      </Modal>

      {isIOS && iosPickerVisible ? (
        <View style={styles.iosPickerOverlay}>
          <Surface elevated style={styles.iosPickerSheet}>
            <Text style={styles.filterLabel}>{tr('Select date')}</Text>
            <DateTimePicker
              mode="date"
              display="inline"
              value={iosPickerValue}
              onChange={(_, selectedDate) => {
                if (selectedDate) setIosPickerValue(selectedDate)
              }}
            />
            <View style={styles.iosPickerActions}>
              <AppButton label={tr('Cancel')} variant="ghost" onPress={cancelIosPicker} />
              <AppButton label={tr('Use date')} onPress={confirmIosPicker} />
            </View>
          </Surface>
        </View>
      ) : null}
    </Screen>
  )
}

function PaymentsScreen() {
  const { snapshot: entitlements, refresh: refreshEntitlements } = useEntitlements()
  const { lang } = useLangContext()
  const route = useRoute<any>()
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

  function PlanIcon({ plan }: { plan: PlanId }) {
    const color = themeColors.primary
    const size = 16
    if (plan === 'free') return <Ionicons name="gift-outline" size={size} color={color} />
    if (plan === 'basic') return <Ionicons name="star-outline" size={size} color={color} />
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
        <Ionicons name="star" size={size} color={color} />
        <Ionicons name="star" size={size} color={color} />
      </View>
    )
  }

  function planFeatures(plan: PlanId): string[] {
    if (plan === 'pro') {
      return [
        '• Unlimited bills + warranties',
        '• 2 profiles',
        '• Installment obligations (credits/leasing)',
        '• Import bills from email',
        '• 300 OCR / month',
        '• Export (CSV / PDF / ZIP / JSON)',
      ]
    }
    if (plan === 'basic') {
      return [
        '• Unlimited bills + warranties',
        '• 1 profile',
        '• 100 OCR / month',
        '• No exports',
      ]
    }
    return [
      '• 10 bills / month',
      '• 1 profile',
      '• 3 OCR / month',
      '• No exports',
    ]
  }

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

  const focusPlan: PlanId | null = useMemo(() => {
    const raw = route?.params?.focusPlan
    return raw === 'basic' || raw === 'pro' || raw === 'free' ? raw : null
  }, [route?.params?.focusPlan])

  return (
    <Screen>
      <View style={styles.pageStack}>
        <TabTopBar titleKey="Subscription plans" />

        <Surface elevated>
          <Text style={styles.mutedText}>{tr('Your plan')}: {tr(planLabel(entitlements.plan))}</Text>
          {entitlements.plan !== 'pro' ? (
            <Text style={styles.mutedText}>
              {entitlements.plan === 'free'
                ? t(lang, 'Save €{amount} with yearly billing', { amount: planSavings.basic })
                : t(lang, 'Save €{amount} with yearly billing', { amount: planSavings.pro })}
            </Text>
          ) : null}

          {(['free', 'basic', 'pro'] as PlanId[]).map((plan) => {
            const active = entitlements.plan === plan
            const suggested = focusPlan === plan
            return (
              <View
                key={plan}
                style={[styles.planRow, (active || suggested) && styles.planRowActive, { marginBottom: themeSpacing.sm }]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
                    <PlanIcon plan={plan} />
                    <Text style={styles.planRowTitle}>{tr(planLabel(plan))}</Text>
                  </View>
                  {active ? <Badge label="Active" tone="success" /> : null}
                </View>

                <Text style={styles.planRowItem}>{planPrice(plan)}</Text>

                <View style={{ marginTop: themeSpacing.xs, gap: 2 }}>
                  {planFeatures(plan).map((line) => (
                    <Text key={line} style={styles.planRowItem}>
                      {tr(line)}
                    </Text>
                  ))}
                </View>

                {plan === 'free' ? null : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
                    <AppButton
                      label="Monthly"
                      variant="outline"
                      iconName="card-outline"
                      onPress={() => handleSubscribe(plan, 'monthly')}
                      disabled={busy}
                    />
                    <AppButton
                      label={
                        plan === 'basic'
                          ? t(lang, 'Yearly (save €{amount})', { amount: planSavings.basic })
                          : t(lang, 'Yearly (save €{amount})', { amount: planSavings.pro })
                      }
                      variant="primary"
                      iconName="card-outline"
                      onPress={() => handleSubscribe(plan, 'yearly')}
                      disabled={busy}
                    />
                  </View>
                )}

                <Text style={[styles.mutedText, { marginTop: themeSpacing.xs }]}>
                  {t(lang, 'OCR helps extract data from photos/PDFs. Limits reset monthly.')}
                </Text>
              </View>
            )
          })}
          {busy && (
            <View style={{ marginTop: themeSpacing.sm, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator />
              <Text style={styles.mutedText}>{t(lang, 'Processing payment…')}</Text>
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
  const bottomPadding = Math.max(insets.bottom, 4)
  const { lang } = useLangContext()

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: themeColors.primary,
        tabBarInactiveTintColor: '#94A3B8',
        tabBarLabel: route.name === 'Scan'
          ? '+'
          : t(
            lang,
            (
              {
                Home: 'home',
                Scan: 'scan',
                Bills: 'bills',
                Pay: 'pay',
                Settings: 'settings',
              } as any
            )[route.name] || route.name
          ),
        tabBarStyle: {
          borderTopColor: '#E5E7EB',
          borderTopWidth: StyleSheet.hairlineWidth,
          backgroundColor: '#FFFFFF',
          paddingTop: 1,
          paddingBottom: bottomPadding,
          height: 42 + bottomPadding,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '600',
          marginTop: 0,
          marginBottom: 1,
        },
        tabBarIconStyle: {
          marginTop: 0,
        },
        tabBarIcon: ({ color, size }) => {
          const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
            Home: 'home-outline',
            Scan: 'add-circle-outline',
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
  )
}

function SettingsScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const navigation = useNavigation<any>()
  const { lang, setLang } = useLangContext()
  const insets = useSafeAreaInsets()
  function changeLang(l: Lang) { setLang(l) }
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

  const diagnostics = useMemo(() => {
    const appVersion = String((Constants as any)?.nativeAppVersion || '')
    return {
      appVersion: appVersion || '(unknown)',
      website: PUBLIC_SITE_URL,
      infoEmail: 'info@getbillbox.com',
    }
  }, [])

  const saveRename = useCallback(async () => {
    if (!renameTarget) return
    const trimmed = renameDraft.trim()
    if (!trimmed) {
      Alert.alert(tr('Name required'), tr('Please enter a name.'))
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
      Alert.alert(tr('Name required'), tr('Please enter a name for Profil 2.'))
      return
    }
    await spacesCtx.addSpace({ name: trimmed, kind: 'personal', plan: spacesCtx.current?.plan || 'free' })
    setCreatingPayer2(false)
  }, [payer2NameDraft, spacesCtx])
  if (spacesCtx.loading || !space) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.mutedText}>{tr('Loading settings…')}</Text>
        </View>
      </Screen>
    )
  }
  return (
    <Screen scroll={false}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.pageStack}>
          <TabTopBar titleKey="settings" />

        <Surface elevated>
          <SectionHeader title="Profiles" />
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
                  <Text style={styles.mutedText}>{locked ? tr('Locked (Več only)') : tr('Not created yet')}</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                    {locked ? (
                      <AppButton
                        label={tr('Upgrade to Več')}
                        variant="secondary"
                        iconName="arrow-up-circle-outline"
                        onPress={() => {
                          if (IS_EXPO_GO) {
                            Alert.alert(tr('Upgrade'), tr('Purchases are disabled in Expo Go preview. Use a store/dev build to upgrade.'))
                            return
                          }
                          navigation.navigate('Payments', { focusPlan: 'pro' })
                        }}
                      />
                    ) : (
                      <AppButton
                        label={tr('Create Profil 2')}
                        variant="secondary"
                        iconName="add-outline"
                        onPress={() => {
                          setCreatingPayer2(true)
                          setPayer2NameDraft('Profil 2')
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
                <Text style={{ fontWeight: '600' }}>{slotLabel} {active ? `• ${tr('Active')}` : ''}</Text>
                <Text style={styles.mutedText}>{tr('Name:')} {sp.name || '—'}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                  {!active && (
                    <AppButton
                      label={tr('Switch')}
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

        {entitlements.plan !== 'pro' ? (
          <Surface elevated>
            <SectionHeader title={tr('Subscription')} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, alignItems: 'center', marginTop: themeSpacing.xs }}>
              <AppButton
                label={tr('Upgrade package')}
                variant="secondary"
                iconName="arrow-up-circle-outline"
                onPress={() => {
                  if (IS_EXPO_GO) {
                    Alert.alert(tr('Subscription'), tr('Purchases are disabled in Expo Go preview. Use a store/dev build to upgrade.'))
                    return
                  }
                  navigation.navigate('Payments')
                }}
              />
            </View>
          </Surface>
        ) : null}

        <Surface elevated style={{ marginTop: themeSpacing.md }}>
          <SectionHeader title={tr('Language')} />
          <View style={{ flexDirection: 'row', gap: themeSpacing.sm, flexWrap: 'wrap', marginTop: themeSpacing.xs, paddingBottom: themeSpacing.xs }}>
          {(['sl','en','hr','it','de'] as Lang[]).map(code => (
            <TouchableOpacity
              key={code}
              style={[
                styles.secondaryBtn,
                {
                  backgroundColor: lang === code ? themeColors.primary : themeColors.primarySoft,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: lang === code ? themeColors.primary : themeColors.border,
                },
              ]}
              onPress={() => changeLang(code)}
            >
              <Text
                style={[
                  styles.secondaryBtnText,
                  {
                    color: lang === code ? '#FFFFFF' : themeColors.primary,
                  },
                ]}
              >
                {t(lang, code==='sl'?'slovenian':code==='en'?'english':code==='hr'?'croatian':code==='it'?'italian':'german')}
              </Text>
            </TouchableOpacity>
          ))}
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Reminders & notifications')} />
          <Text style={styles.bodyText}>{tr('Status:')} {notifStatus || tr('Unknown')}</Text>
          <Text style={[styles.bodyText, { marginTop: themeSpacing.xs }]}>Local reminders work in Expo Go. Push notifications are only available in standalone builds when enabled for this project.</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
            <AppButton
              label={tr('Enable reminders')}
              variant="secondary"
              iconName="notifications-outline"
              onPress={async ()=>{
                const ok = await requestPermissionIfNeeded()
                const p = await Notifications.getPermissionsAsync()
                setNotifStatus(p.status)
                if (!ok) {
                  Alert.alert(tr('Enable reminders'), tr('Open system settings to allow notifications'))
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
              onPress={() => Linking.openURL(`${PUBLIC_SITE_URL}/privacy`)}
            />
            <AppButton
              label="Terms of use"
              variant="secondary"
              iconName="list-outline"
              onPress={() => Linking.openURL(`${PUBLIC_SITE_URL}/terms`)}
            />
            <AppButton
              label="Delete account & data"
              variant="secondary"
              iconName="trash-outline"
              onPress={() => Linking.openURL(`${PUBLIC_SITE_URL}/account-deletion`)}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title="Diagnostics" />
          <Text style={styles.bodyText}>{tr('App version:')} {diagnostics.appVersion}</Text>
          <Text style={styles.bodyText}>{tr('Website:')} {diagnostics.website}</Text>
          <Text style={styles.bodyText}>{tr('Info email:')} {diagnostics.infoEmail}</Text>
        </Surface>

        <Modal visible={renameVisible} transparent animationType="fade" onRequestClose={() => setRenameVisible(false)}>
          <View style={[styles.iosPickerOverlay, { paddingBottom: Math.max(insets.bottom, themeLayout.screenPadding) }]}>
            <Surface elevated style={styles.iosPickerSheet}>
              <SectionHeader title={t(lang, 'Rename {payer}', { payer: payerLabelFromSpaceId(renameTarget) })} />
              <AppInput placeholder={tr('New name')} value={renameDraft} onChangeText={setRenameDraft} />
              <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
                <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setRenameVisible(false)} />
                <AppButton label={tr('Save')} iconName="checkmark-outline" onPress={saveRename} />
              </View>
            </Surface>
          </View>
        </Modal>

        <Modal visible={creatingPayer2} transparent animationType="fade" onRequestClose={() => setCreatingPayer2(false)}>
          <View style={[styles.iosPickerOverlay, { paddingBottom: Math.max(insets.bottom, themeLayout.screenPadding) }]}>
            <Surface elevated style={styles.iosPickerSheet}>
              <SectionHeader title="Create Profil 2" />
              <AppInput placeholder={tr('Profil 2 name')} value={payer2NameDraft} onChangeText={setPayer2NameDraft} />
              <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
                <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setCreatingPayer2(false)} />
                <AppButton label={tr('Create')} iconName="add-outline" onPress={savePayer2} />
              </View>
            </Surface>
          </View>
        </Modal>

        {supabase && (
          <AppButton
            label={tr('Sign out')}
            variant="ghost"
            iconName="log-out-outline"
            onPress={async ()=>{ try { await supabase!.auth.signOut(); Alert.alert(tr('Signed out')); } catch(e:any) { Alert.alert(tr('Error'), e?.message||tr('Failed')) } }}
          />
        )}
        </View>
      </ScrollView>

      <AiAssistant
        context={{
          screen: 'Settings',
          plan: entitlements.plan,
          payerId: spacesCtx.current?.id || null,
          payerName: space?.name || null,
        }}
      />
    </Screen>
  )
}

type AppNavigationProps = {
  loggedIn: boolean
  setLoggedIn: (value: boolean) => void
  lang: Lang
  setLang: (value: Lang) => void
  authLoading: boolean
}

function AppNavigation({ loggedIn, setLoggedIn, lang, setLang, authLoading }: AppNavigationProps) {
  const { space, spaceId, loading } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()
  const spacesCtx = useSpacesContext()
  const insets = useSafeAreaInsets()
  const navRef = React.useRef<NavigationContainerRef<any>>(null)

  const [upgradePrompt, setUpgradePromptState] = useState<null | { reason: string; targetPlan: PlanId }>(null)

  useEffect(() => {
    setUpgradePrompt((payload) => {
      setUpgradePromptState({ reason: payload.reason, targetPlan: payload.targetPlan })
    })
    return () => setUpgradePrompt(null)
  }, [])

  const dismissUpgradePrompt = useCallback(() => {
    setUpgradePromptState(null)
  }, [])

  const proceedUpgrade = useCallback(() => {
    const prompt = upgradePrompt
    dismissUpgradePrompt()
    if (!prompt) return
    if (IS_EXPO_GO) {
      Alert.alert(t(lang, 'Upgrade'), t(lang, 'Purchases are disabled in Expo Go preview. Use a store/dev build to upgrade.'))
      return
    }
    try {
      navRef.current?.navigate('Payments', { focusPlan: prompt.targetPlan, reason: prompt.reason })
    } catch {}
  }, [dismissUpgradePrompt, lang, upgradePrompt])
  const lastHandled = React.useRef<string | null>(null)
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
            Alert.alert('Choose profile', 'Import this file into which profile?', buttons)
          })
          if (!targetSpaceId) return
        }

        const item = await addToInbox({ spaceId: targetSpaceId, uri: targetUri, name: fileName, mimeType })
        await scheduleInboxReviewReminder(item.id, item.name, targetSpaceId)

        // Več: attempt OCR automatically for better "email/attachment import" flow.
        if (entitlements.plan === 'pro' && entitlements.canUseOCR) {
          try {
            const sourceUri = (item as any).localPath || item.uri
            const { fields, summary } = await performOCR(sourceUri)
            const looksLikeBill = !!(fields && (fields.iban || fields.reference) && typeof fields.amount === 'number')
            await updateInboxItem(targetSpaceId, item.id, { extractedFields: fields, notes: summary, status: looksLikeBill ? 'pending' : 'new' })
            if (looksLikeBill) await cancelInboxReviewReminder(item.id, targetSpaceId)
          } catch {
            // Keep reminder; user can open Inbox and run OCR manually.
          }
        }

        Alert.alert('Inbox', `${item.name} added to Inbox`) 
        setTimeout(() => {
          navRef.current?.navigate('Inbox', { highlight: item.id })
        }, 250)
      } catch (e: any) {
        Alert.alert('Import failed', e?.message || 'Unable to capture document')
      }
    }
  }, [loading, space, spaceId, spacesCtx.spaces, entitlements.plan, entitlements.canUseOCR])

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
  } else if (loading || !space) {
    content = (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2b6cb0" />
          <Text style={{ marginTop: 8 }}>{t(lang, 'Preparing profiles…')}</Text>
      </View>
    )
  } else {
    content = (
      <NavigationContainer
        ref={navRef}
        onReady={() => setUpgradeNavigation(navRef.current as any)}
        onStateChange={() => setUpgradeNavigation(navRef.current as any)}
      >
        <Stack.Navigator>
          {!loggedIn ? (
            <Stack.Screen name="Login" options={{ headerShown: coerceBool(false) }}>
              {() => <LoginScreen onLoggedIn={()=>setLoggedIn(true)} lang={lang} setLang={setLang} />}
            </Stack.Screen>
          ) : (
            <>
              <Stack.Screen name="BillBox" component={MainTabs} options={{ headerShown: coerceBool(false) }} />
              <Stack.Screen name="Inbox" component={InboxScreen} options={{ headerShown: coerceBool(false) }} />
              <Stack.Screen name="Warranties" component={WarrantiesScreen} options={{ headerShown: coerceBool(false) }} />
              <Stack.Screen name="Reports" component={ReportsScreen} options={{ headerShown: coerceBool(false) }} />
              <Stack.Screen name="Exports" component={ExportsScreen} options={{ headerShown: coerceBool(false) }} />
              <Stack.Screen name="Payments" component={PaymentsScreen} options={{ headerShown: coerceBool(false) }} />
              <Stack.Screen name="Bill Details" component={BillDetailsScreen} options={{ headerShown: coerceBool(false) }} />
              <Stack.Screen name="Warranty Details" component={WarrantyDetailsScreen} options={{ headerShown: coerceBool(false) }} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    )
  }

  const upgradeBody =
    upgradePrompt?.reason === 'export'
      ? t(lang, 'Exports are available on Več. Upgrade to Več to enable CSV, PDF, ZIP, and JSON exports.')
      : t(lang, 'upgrade_required_message')

  const upgradeCta =
    upgradePrompt?.targetPlan === 'pro' ? t(lang, 'Upgrade to Več') : t(lang, 'Upgrade to Moje')

  return (
    <LangContext.Provider value={{ lang, setLang }}>
      {content}
      <Modal
        visible={!!upgradePrompt}
        transparent
        animationType="fade"
        onRequestClose={dismissUpgradePrompt}
      >
        <View style={[styles.iosPickerOverlay, { paddingBottom: Math.max(insets.bottom, themeLayout.screenPadding) }]}>
          <Surface elevated style={styles.iosPickerSheet}>
            <SectionHeader title={t(lang, 'Upgrade required')} />
            <Text style={styles.bodyText}>{upgradeBody}</Text>
            <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
              <AppButton label={t(lang, 'Not now')} variant="ghost" onPress={dismissUpgradePrompt} />
              <AppButton label={upgradeCta} iconName="arrow-up-outline" onPress={proceedUpgrade} />
            </View>
          </Surface>
        </View>
      </Modal>
    </LangContext.Provider>
  )
}

function ThemedAppShell({ children }: { children: React.ReactNode }) {
  const { mode } = useTheme()
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      {children}
    </SafeAreaView>
  )
}

function PaymentReminderOverlay() {
  const supabase = useMemo(() => getSupabase(), [])
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const [visible, setVisible] = useState(false)
  const [dueBills, setDueBills] = useState<Bill[]>([])

  const parseLocalDate = useCallback((value?: string | null) => {
    if (!value) return null
    const raw = String(value).trim()
    if (!raw) return null
    const parts = raw.split('-')
    if (parts.length !== 3) return null
    const [y, m, d] = parts.map((p) => Number(p))
    if ([y, m, d].some((n) => Number.isNaN(n))) return null
    const dt = new Date(y, m - 1, d)
    return Number.isNaN(dt.getTime()) ? null : dt
  }, [])

  const ackKey = useCallback((billId: string, dueDate: string) => {
    return `billbox.reminders.ack.${spaceId || 'default'}.${billId}.${dueDate}`
  }, [spaceId])

  const refresh = useCallback(async () => {
    if (spaceLoading || !space || !spaceId) return
    let bills: Bill[] = []
    try {
      if (supabase) {
        const { data } = await listBills(supabase, spaceId)
        bills = data || []
      } else {
        bills = (await loadLocalBills(spaceId)) as any
      }
    } catch {
      bills = []
    }

    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    const candidates = bills.filter((b) => b.status !== 'paid' && !!b.due_date)
    const dueSoon: Bill[] = []
    for (const b of candidates) {
      const due = parseLocalDate(b.due_date)
      if (!due) continue
      const diffDays = Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
      if (diffDays > 3) continue
      let acked = false
      try {
        const raw = await AsyncStorage.getItem(ackKey(String(b.id), String(b.due_date)))
        acked = raw === '1'
      } catch {
        acked = false
      }
      if (!acked) dueSoon.push(b)
    }

    setDueBills(dueSoon)
    setVisible(dueSoon.length > 0)
    try {
      await Notifications.setBadgeCountAsync(dueSoon.length)
    } catch {}
  }, [ackKey, parseLocalDate, space, spaceId, spaceLoading, supabase])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh()
    })
    return () => {
      sub.remove()
    }
  }, [refresh])

  const acknowledgeAll = useCallback(async () => {
    const current = dueBills
    setVisible(false)
    try {
      for (const b of current) {
        if (!b?.id || !b?.due_date) continue
        await AsyncStorage.setItem(ackKey(String(b.id), String(b.due_date)), '1')
      }
    } catch {}
    try {
      await Notifications.setBadgeCountAsync(0)
    } catch {}
  }, [ackKey, dueBills])

  const openPay = useCallback(() => {
    try {
      ;(navRef as any)?.current?.navigate?.('BillBox', { screen: 'Pay' })
    } catch {}
  }, [])

  if (!visible || !dueBills.length) return null

  return (
    <Modal visible transparent animationType="fade" onRequestClose={acknowledgeAll}>
      <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
        <Surface elevated style={styles.iosPickerSheet}>
          <SectionHeader title={tr('Reminders')} />
          <Text style={styles.bodyText}>{tr('{count} bills', { count: dueBills.length })}</Text>
          <View style={{ gap: themeSpacing.xs }}>
            {dueBills.slice(0, 5).map((b) => (
              <View key={b.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: themeLayout.gap }}>
                <Text style={[styles.bodyText, { flex: 1 }]} numberOfLines={1}>
                  {b.supplier || tr('Untitled bill')}
                </Text>
                <Text style={styles.mutedText}>
                  {tr('Due')}: {b.due_date}
                </Text>
              </View>
            ))}
            {dueBills.length > 5 ? <Text style={styles.mutedText}>+{dueBills.length - 5}</Text> : null}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap }}>
            <AppButton label={tr('Pay')} variant="secondary" onPress={openPay} />
            <AppButton label={tr('Done')} onPress={acknowledgeAll} />
          </View>
        </Surface>
      </View>
    </Modal>
  )
}

export default function App() {
  const supabase = useMemo(() => getSupabase(), [])
  const [loggedIn, setLoggedIn] = useState(false)
  const [authLoading, setAuthLoading] = useState(true)
  const [lang, setLang] = useState<Lang>('en')
  useEffect(()=>{ (async()=> setLang(await loadLang()))() }, [])
  const setLangAndPersist = useCallback((l: Lang) => {
    setLang(l)
    void saveLang(l)
  }, [])
  useEffect(() => {
    let mounted = true
    if (!supabase) {
      setLoggedIn(true)
      setAuthLoading(false)
      return
    }
    supabase.auth.getSession()
      .then(({ data }) => {
        if (mounted) setLoggedIn(!!data?.session)
      })
      .catch(() => {
        if (mounted) setLoggedIn(false)
      })
      .finally(() => {
        if (mounted) setAuthLoading(false)
      })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setLoggedIn(!!session)
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
        { identifier: 'SNOOZE_1', buttonTitle: tr('Snooze 1 day'), options: { isDestructive: false, isAuthenticationRequired: false } },
        { identifier: 'SNOOZE_3', buttonTitle: tr('Snooze 3 days'), options: { isDestructive: false, isAuthenticationRequired: false } },
        { identifier: 'SNOOZE_7', buttonTitle: tr('Snooze 7 days'), options: { isDestructive: false, isAuthenticationRequired: false } },
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
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <EntitlementsProvider supabase={supabase}>
          <SpaceProvider>
            <ThemedAppShell>
              <AppNavigation loggedIn={loggedIn} setLoggedIn={setLoggedIn} lang={lang} setLang={setLangAndPersist} authLoading={authLoading} />
              <PaymentReminderOverlay />
            </ThemedAppShell>
          </SpaceProvider>
        </EntitlementsProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  loginSafeArea: { flex: 1, backgroundColor: themeColors.background },
  loginKeyboard: { flex: 1 },
  loginScroll: { flexGrow: 1, padding: themeLayout.screenPadding, paddingTop: themeSpacing.xl, paddingBottom: themeSpacing.xl },
  loginWrapper: { flexGrow: 1, gap: themeSpacing.lg },
  loginHeader: { alignItems: 'center', gap: themeSpacing.sm },
  loginLogo: { width: 56, height: 56, borderRadius: 28, backgroundColor: themeColors.primarySoft, alignItems: 'center', justifyContent: 'center' },
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

  // Tab header
  tabTopBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: themeLayout.gap },
  tabTopBarLeft: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  tabTopBarRight: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto' },
  tabTopBarLogo: { width: 18, height: 18, marginRight: themeSpacing.xs },
  tabTopBarTitle: { fontSize: 18, fontWeight: '700', color: themeColors.text, flexShrink: 1 },

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
  listContent: { paddingBottom: themeSpacing.xxl + themeSpacing.xl },

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
  cameraPreview: { height: 240, width: '100%' },
  cameraOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  cameraFocusBox: { width: '64%', height: '64%', borderRadius: 18, borderWidth: 2, borderColor: '#FFFFFFAA' },
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
