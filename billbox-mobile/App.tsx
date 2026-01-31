/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AppState, FlatList, RefreshControl, StyleSheet, Text as RNText, Button, View, Platform, Linking, Image, Switch, ActivityIndicator, Pressable, KeyboardAvoidingView, TextInput, ScrollView, TouchableOpacity, Modal, Animated, PanResponder, Keyboard } from 'react-native'
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
import * as FileSystem from 'expo-file-system/legacy'
import * as Print from 'expo-print'
import * as Sharing from 'expo-sharing'
import * as Clipboard from 'expo-clipboard'
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
import {
  ensureNotificationConfig,
  requestPermissionIfNeeded,
  scheduleBillReminders,
  cancelBillReminders,
  snoozeBillReminder,
  scheduleGroupedPaymentReminder,
  scheduleWarrantyReminders,
  cancelWarrantyReminders,
  scheduleInboxReviewReminder,
  cancelInboxReviewReminder,
  cancelAllReminders,
  getRemindersEnabled,
  setRemindersEnabled,
} from './src/reminders'
import { ENABLE_PUSH_NOTIFICATIONS, PUBLIC_SITE_URL, ENABLE_IAP } from './src/env'
import type { Space, SpacePlan } from './src/spaces'
import { ensureDefaults as ensureSpacesDefaults, upsertSpace, removeSpace, loadCurrentSpaceId, saveCurrentSpaceId, loadSpaces } from './src/spaces'
import { showUpgradeAlert, setUpgradeNavigation, setUpgradePrompt, type EntitlementsSnapshot, type PlanId, useEntitlements, EntitlementsProvider } from './src/entitlements'
import {
  DEFAULT_BILL_DRAFT_SELECTION,
  archiveOnlyFromBillDraftSelection,
} from './src/billDraftMode'
import { isUuidString, localPayerIdFromDbSpaceId, resolveDbSpaceIdFromEntitlements } from './src/space-id'

const BRAND_WORDMARK = require('./assets/logo/logo-wordmark.png')
const BRAND_ICON = require('./assets/logo/logo-icon.png')

function isDebugBuild(): boolean {
  const buildProfile = String(process.env.EXPO_PUBLIC_BUILD_PROFILE || (Constants as any)?.expoConfig?.extra?.eas?.buildProfile || (Constants as any)?.manifest2?.extra?.eas?.buildProfile || '')
  return __DEV__ || /preview|development/i.test(buildProfile)
}

async function ensureLocalReadableFile(
  uri: string,
  fileName?: string,
  mimeType?: string,
  opts?: { allowBase64Fallback?: boolean },
): Promise<{ uri: string; cachedUri: string; size: number | null }> {
  const sourceUri = String(uri || '')
  if (!sourceUri) throw new Error('missing_uri')
  if (Platform.OS === 'web') {
    return { uri: sourceUri, cachedUri: sourceUri, size: null }
  }

  const extFromName = (n?: string) => {
    const match = String(n || '').match(/(\.[a-z0-9]{2,5})$/i)
    return match ? match[1] : ''
  }
  const extFromMime = (m?: string) => {
    const t = String(m || '').toLowerCase()
    if (t.includes('pdf')) return '.pdf'
    if (t.includes('png')) return '.png'
    if (t.includes('webp')) return '.webp'
    if (t.includes('jpg') || t.includes('jpeg')) return '.jpg'
    return ''
  }
  const ext = extFromName(fileName) || extFromMime(mimeType) || ''
  const cachedUri = `${FileSystem.cacheDirectory || FileSystem.documentDirectory || ''}billbox_import_${Date.now()}${ext}`

  const tryCopy = async () => {
    await FileSystem.copyAsync({ from: sourceUri, to: cachedUri })
  }

  try {
    await tryCopy()
  } catch (e) {
    if (opts?.allowBase64Fallback) {
      const data = await FileSystem.readAsStringAsync(sourceUri, { encoding: FileSystem.EncodingType.Base64 })
      await FileSystem.writeAsStringAsync(cachedUri, data, { encoding: FileSystem.EncodingType.Base64 })
    } else {
      throw e
    }
  }

  let size: number | null = null
  try {
    const info = await FileSystem.getInfoAsync(cachedUri)
    if (typeof info?.size === 'number') size = info.size
  } catch {}

  return { uri: cachedUri, cachedUri, size }
}

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

function TabTopBar({
  titleKey,
  title,
  left,
  right,
  showBack = true,
}: {
  titleKey?: string
  title?: string
  left?: React.ReactNode
  right?: React.ReactNode
  showBack?: boolean
}) {
  const { lang } = useLangContext()
  const navigation = useNavigation<any>()
  const { colors } = useTheme()

  const canGoBack = showBack && !!navigation?.canGoBack?.() && navigation.canGoBack()
  const autoLeft = canGoBack ? (
    <TouchableOpacity
      onPress={() => {
        try { navigation.goBack() } catch {}
      }}
      style={styles.tabTopBarBackButton}
      hitSlop={10}
      accessibilityLabel={t(lang, 'Back')}
    >
      <Ionicons name="chevron-back" size={20} color={colors.text} />
    </TouchableOpacity>
  ) : null

  return (
    <View style={styles.tabTopBar}>
      <View style={styles.tabTopBarLeft}>
        {left ? <View style={{ marginRight: themeSpacing.xs }}>{left}</View> : (autoLeft ? <View style={{ marginRight: themeSpacing.xs }}>{autoLeft}</View> : null)}
        <Image source={BRAND_ICON} style={styles.tabTopBarLogo} resizeMode="contain" accessibilityLabel="BILLBOX" />
        <Text style={styles.tabTopBarTitle}>{title ? title : t(lang, titleKey || '')}</Text>
      </View>
      {right ? <View style={styles.tabTopBarRight}>{right}</View> : <View style={styles.tabTopBarRight} />}
    </View>
  )
}

function AiAssistant({ context }: { context: any }) {
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
            action: { label: t(lang, 'Add bill'), route: 'Scan' },
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
        const s = getSupabase()
        let token: string | null = null
        try {
          const sess = s ? await s.auth.getSession() : null
          token = sess?.data?.session?.access_token || null
        } catch {
          token = null
        }

        const resp = await fetch(`${base}/.netlify/functions/ai-assistant`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ message: text, context: context || {} }),
        })
        const json = await resp.json().catch(() => null as any)

        // Handle common auth/plan cases even when resp.ok is false.
        if (resp.status === 401) {
          setMessages((prev) => prev.concat([{ id: `a_${Date.now()}`, role: 'assistant', text: t(lang, 'AI is not available right now.') }]))
          return
        }
        if (resp.status === 403) {
          const code = String(json?.error || '').trim()
          if (code === 'trial_expired') {
            setMessages((prev) => prev.concat([{ id: `a_${Date.now()}`, role: 'assistant', text: t(lang, 'Free trial expired. Choose a plan to continue.') }]))
            return
          }
            if (code === 'ai_quota_exceeded') {
              const resetAt = (json as any)?.resetAt || null
              const dateLabel = (() => {
                if (!resetAt) return ''
                try {
                  const d = new Date(String(resetAt))
                  if (Number.isNaN(d.getTime())) return String(resetAt)
                  return d.toISOString().slice(0, 10)
                } catch {
                  return String(resetAt)
                }
              })()
              const msg = dateLabel
                ? t(lang, 'You reached the monthly AI limit. Continue after {date} or upgrade.', { date: dateLabel })
                : t(lang, 'AI assistance is currently limited. It will be available in the next period or with an upgrade.')
              setMessages((prev) => prev.concat([{ id: `a_${Date.now()}`, role: 'assistant', text: msg }]))
              return
            }
            if (code === 'ai_not_allowed') {
              setMessages((prev) => prev.concat([{ id: `a_${Date.now()}`, role: 'assistant', text: t(lang, 'AI assistance is currently limited. It will be available in the next period or with an upgrade.') }]))
              return
            }
          setMessages((prev) => prev.concat([{ id: `a_${Date.now()}`, role: 'assistant', text: t(lang, 'AI request failed.') }]))
          return
        }

        if (!resp.ok) {
          const serverMsg = typeof json?.message === 'string' && json.message.trim() ? json.message.trim() : null
          const serverErr = typeof json?.error === 'string' && json.error.trim() ? json.error.trim() : null
          const textOut = serverMsg || (serverErr ? `${t(lang, 'AI request failed.')} (${serverErr})` : t(lang, 'AI request failed.'))
          setMessages((prev) => prev.concat([{ id: `a_${Date.now()}`, role: 'assistant', text: textOut }]))
          return
        }

        const assistantText = String(json?.message || '').trim() || t(lang, 'Here are a few helpful next steps.')
        const actions = Array.isArray(json?.suggestedActions) ? json.suggestedActions : []

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

function createRequestId(prefix = 'req'): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
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
  return 'Trial'
}

function planPrice(plan: PlanId): string {
  if (plan === 'pro') return '€5 / month or €48 / year'
  if (plan === 'basic') return '€2.60 / month or €25 / year'
  return ''
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
  due_date?: string
  payment_details?: string
}

function parseDateToISO(input: string): string | null {
  const s = String(input || '')
  const dmy = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/)
  if (dmy) {
    const day = Number(dmy[1])
    const month = Number(dmy[2])
    let year = Number(dmy[3])
    if (year < 100) year += 2000
    if (year < 2000 || year > 2100) return null
    if (month < 1 || month > 12) return null
    if (day < 1 || day > 31) return null
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  const ymd = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`
  return null
}

function normalizeQrText(input: string): string {
  const s = (input ?? '').toString()
  // Some scanners deliver group-separator (GS) or CR-only separated payloads.
  let out = s.replace(/\u001d/g, '\n').replace(/\r/g, '\n')
  // Some providers use pipe-separated payloads.
  if (!out.includes('\n') && out.includes('|') && (/\bBCD\b/.test(out) || /UPNQR/i.test(out))) {
    out = out.replace(/\|/g, '\n')
  }
  return out
}

function normalizeIban(input: string | undefined): string | undefined {
  const s = String(input || '').toUpperCase().replace(/\s+/g, '')
  return s || undefined
}

function normalizeReference(input: string | undefined): string | undefined {
  // Keep common reference separators used in QR payloads (e.g. SI12 1234-56).
  const s = String(input || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9\-\/]/g, '')
  return s || undefined
}

function looksLikeIban(s: string) {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(s)
}

const IBAN_LENGTHS: Record<string, number> = {
  // Common SEPA / EU
  AL: 28,
  AD: 24,
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TR: 26,
}

function isValidIbanChecksum(ibanRaw: string): boolean {
  const s = normalizeIban(ibanRaw)
  if (!s) return false
  if (!looksLikeIban(s)) return false
  const expected = IBAN_LENGTHS[s.slice(0, 2)]
  if (expected && s.length !== expected) return false
  const rearranged = s.slice(4) + s.slice(0, 4)
  let remainder = 0
  for (let i = 0; i < rearranged.length; i++) {
    const ch = rearranged[i]
    const code = ch.charCodeAt(0)
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97
    } else {
      const val = code - 55
      remainder = (remainder * 100 + val) % 97
    }
  }
  return remainder === 1
}

function parseEPC(text: string): EPCResult | null {
  try {
    const lines = normalizeQrText(text).split(/\n+/).map((l) => l.trim())
    if (lines.length < 7) return null
    if (lines[0] !== 'BCD') return null
    const serviceTag = lines[3]
    if (serviceTag !== 'SCT') return null
    const name = lines[5] || ''
    const ibanRaw = normalizeIban(lines[6] || '')
    const iban = ibanRaw && isValidIbanChecksum(ibanRaw) ? ibanRaw : undefined
    const amountLine = lines[7] || ''
    let amount: number | undefined
    if (amountLine.startsWith('EUR')) {
      const num = amountLine.slice(3)
      const parsed = Number(num.replace(',', '.'))
      if (!Number.isNaN(parsed)) amount = parsed
    }
    // EPC QR payload is line-based, but some providers omit the 4-char purpose code line.
    const l8 = lines[8] || ''
    const nextLooksLikeReference = /\b(?:SI\d{2}|RF\d{2})\b/i.test(String(lines[9] || ''))
    const hasPurposeCode = /^[A-Z0-9]{4}$/.test(l8) || (nextLooksLikeReference && /^[A-Z0-9]{1,4}$/.test(l8))
    const remittance = (hasPurposeCode ? (lines[9] || '') : l8).trim()
    const info = (hasPurposeCode ? (lines[10] || '') : (lines[9] || '')).trim()
    const combined = [remittance, info].filter(Boolean).join('\n')

    const refMatch = combined.match(/(SI\d{2}\s*[0-9A-Z\-\/]{4,}|RF\d{2}[0-9A-Z]{4,})/i)
    const reference = refMatch ? String(refMatch[1] || '').replace(/\s+/g, '').toUpperCase() : ''
    let purpose = combined
    if (reference) {
      // Remove the reference token from the purpose if it's embedded in the remittance.
      purpose = purpose
        .replace(refMatch ? refMatch[1] : '', '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    }
    // Do not fallback to the raw combined text if it only contains the reference.
    if (!purpose) purpose = ''
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
    const normalized = normalizeQrText(text)
    const lines = normalized.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    const joined = lines.join('\n')
    if (!/UPNQR|\bUPN\b/i.test(joined) && !/\bSI\s*\d{2}\s*[0-9A-Z\-\/]{4,}\b/i.test(joined)) return null
    const findValidIbanInText = (t: string): string | undefined => {
      const matches = String(t || '').match(/\b[A-Z]{2}\d{2}(?:\s*[A-Z0-9]){11,34}\b/g) || []
      for (const m of matches) {
        const cand = normalizeIban(m)
        if (!cand) continue
        if (isValidIbanChecksum(cand)) return cand
      }
      return undefined
    }
    // IBAN: prefer lines explicitly labeled as IBAN; avoid accidentally treating reference (Sklic/Model) as IBAN.
    const iban = (() => {
      for (const l of lines) {
        if (!/\biban\b/i.test(l)) continue
        const v = findValidIbanInText(l)
        if (v) return v
      }
      for (const l of lines) {
        if (/\b(sklic|reference|ref\.?|model)\b/i.test(l)) continue
        const v = findValidIbanInText(l)
        if (v) return v
      }
      return findValidIbanInText(joined)
    })()
    let amount: number | undefined
    let currency: string | undefined

    // Prefer explicit EUR amount.
    for (const l of lines) {
      const eurMatch = l.match(/EUR\s*([0-9]+(?:[\.,][0-9]{1,2})?)/i)
      if (!eurMatch) continue
      const val = Number(eurMatch[1].replace(',', '.'))
      if (Number.isFinite(val) && val > 0) { amount = val; currency = 'EUR'; break }
    }

    // UPNQR often encodes amount as 11 digits (cents, leading zeros) without separators.
    if (typeof amount !== 'number') {
      for (const l of lines) {
        if (/^\d{11}$/.test(l)) {
          const cents = Number(l)
          if (Number.isFinite(cents) && cents > 0) { amount = cents / 100; currency = 'EUR'; break }
        }
      }
    }

    // Some scanners provide UPNQR as a single long line; attempt to find the first 11-digit cents block.
    if (typeof amount !== 'number' && lines.length === 1 && /UPNQR/i.test(lines[0] || '')) {
      const compact = normalized.replace(/\s+/g, '')
      const withoutIban = iban ? compact.replace(iban, '') : compact
      const m = withoutIban.match(/\d{11}/)
      if (m) {
        const cents = Number(m[0])
        const val = cents / 100
        if (Number.isFinite(val) && val > 0 && val <= 1000000) {
          amount = val
          currency = currency || 'EUR'
        }
      }
    }

    // Fallback: first reasonable numeric.
    if (typeof amount !== 'number') {
      for (const l of lines) {
        const amtMatch = l.match(/\b([0-9]+(?:[\.,][0-9]{1,2})?)\b/)
        if (!amtMatch) continue
        const val = Number(amtMatch[1].replace(',', '.'))
        if (Number.isFinite(val) && val > 0) { amount = val; break }
      }
    }
    let reference: string | undefined
    // Prefer labeled reference lines; never accept a value that is (or equals) a valid IBAN.
    for (const l of lines) {
      const labeled = l.match(/\b(sklic|reference|ref\.?|model)\b\s*:?\s*(.+)$/i)
      if (!labeled) continue
      const cand = normalizeReference(labeled[2])
      if (!cand) continue
      if (iban && cand === iban) continue
      reference = cand
      break
    }
    if (!reference) {
      for (const l of lines) {
        const m = l.match(/\bRF\d{2}[0-9A-Z]{4,}\b/i)
        if (!m) continue
        const cand = normalizeReference(m[0])
        if (!cand) continue
        reference = cand
        break
      }
    }
    if (!reference) {
      for (const l of lines) {
        if (/\biban\b/i.test(l)) continue
        const m = l.match(/\bSI\d{2}\s*[0-9A-Z\-\/]{4,}\b/i)
        if (!m) continue
        const cand = normalizeReference(m[0])
        if (!cand) continue
        if (iban && cand === iban) continue
        reference = cand
        break
      }
    }
    // Purpose (Namen): only accept explicit labeled values. Never guess.
    let purpose: string | undefined
    for (const l of lines) {
      const m = l.match(/(?:namen|purpose)\s*:?\s*(.+)$/i)
      if (!m) continue
      const v = String(m[1] || '').trim()
      if (v) { purpose = v; break }
    }
    let creditor_name: string | undefined
    for (const l of lines) {
      const m = l.match(/(?:prejemnik|recipient|payee|upravi\w*|name)\s*:?\s*(.+)$/i)
      if (!m) continue
      const n = String(m[1] || '').trim()
      if (!n) continue
      if (/UPNQR|\bUPN\b/i.test(n)) continue
      creditor_name = n
      break
    }

    // UPNQR often contains unlabeled creditor name; choose a plausible line before IBAN.
    if (!creditor_name) {
      const ibanIdx = lines.findIndex((l) => /[A-Z]{2}\d{2}[A-Z0-9]{11,34}/.test(l.replace(/\s+/g, '')))
      const scope = ibanIdx > 0 ? lines.slice(0, ibanIdx) : lines
      for (let i = scope.length - 1; i >= 0; i--) {
        const l = scope[i]
        if (/UPNQR|\bUPN\b/i.test(l)) continue
        if (/\b(sklic|reference|ref\.?|model|namen|purpose)\b/i.test(l)) continue
        if (/\b(rok|zapad|zapadl|valuta|datum|due|pay\s*by|payment\s*due)\b/i.test(l)) continue
        if (/\b(ra\u010dun|invoice|faktura|dokument|document)\b/i.test(l)) continue
        if (/\b\d{4}-\d{2}-\d{2}\b/.test(l) || /\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\b/.test(l)) continue
        if (!/[A-Za-zÀ-žČŠŽčšž]/.test(l)) continue
        if (l.length < 2 || l.length > 70) continue
        if (/\bEUR\b/i.test(l)) continue
        const digitCount = (String(l).match(/\d/g) || []).length
        if (digitCount >= 6) continue
        if (/^\d{11}$/.test(l) || /^[0-9\s.,:\-\/]+$/.test(l)) continue
        if (/\bSI\s*\d{2}\b/i.test(l) || /\bRF\s*\d{2}\b/i.test(l)) continue
        creditor_name = l.trim()
        break
      }
    }

    // Due date (Rok plačila / Due / Pay by): try labeled first, then first date.
    let due_date: string | undefined
    for (const l of lines) {
      const m = l.match(/\b(rok\s*pla\w*|rok|zapad\w*|due\s*date|pay\s*by)\b\s*[:\-]?\s*(.+)/i)
      if (!m) continue
      const iso = parseDateToISO(m[2] || '')
      if (iso) { due_date = iso; break }
    }
    if (!due_date) {
      for (const l of lines) {
        const iso = parseDateToISO(l)
        if (iso) { due_date = iso; break }
      }
    }

    const result: EPCResult = { iban, amount, purpose, reference, creditor_name, currency }
    if (due_date) result.due_date = due_date
    if (result.iban || typeof result.amount === 'number') return result
    return null
  } catch {
    return null
  }
}

function parsePaymentQR(text: string): EPCResult | null {
  return parseEPC(text) || parseUPN(text) || parseUrlPayment(text)
}

function parseUrlPayment(input: string): EPCResult | null {
  try {
    const raw = String(input || '').trim()
    if (!/^https?:\/\//i.test(raw)) return null

    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return null
    }

    const get = (...keys: string[]) => {
      for (const k of keys) {
        const v = url.searchParams.get(k)
        if (v != null && String(v).trim()) return String(v).trim()
      }
      return ''
    }

    const ibanRaw = get('iban', 'IBAN', 'account', 'acct', 'accountNumber', 'account_number').replace(/\s+/g, '')
    const iban = ibanRaw && isValidIbanChecksum(ibanRaw) ? ibanRaw : ''
    const name = get('name', 'recipient', 'payee', 'creditor', 'beneficiary', 'receiver')
    const purpose = get('purpose', 'message', 'remittance', 'note', 'reason', 'description')
    const reference = normalizeReference(get('reference', 'ref', 'paymentReference', 'payment_reference', 'variableSymbol', 'vs', 'sklic')) || ''
    const currency = get('currency', 'ccy').toUpperCase()
    const amountRaw = get('amount', 'amt', 'sum')
    const amountVal = amountRaw ? Number(amountRaw.replace(',', '.')) : NaN
    const dueRaw = get('due', 'dueDate', 'duedate', 'date', 'payBy', 'payby')
    const due = dueRaw ? parseDateToISO(dueRaw) : null

    const extras: string[] = []
    const bic = get('bic', 'BIC', 'swift', 'SWIFT')
    if (bic) extras.push(`SWIFT/BIC: ${bic}`)
    const routing = get('routing', 'routingNumber', 'routing_number', 'aba', 'ABA')
    if (routing) extras.push(`Routing: ${routing}`)
    const sort = get('sortCode', 'sort_code')
    if (sort) extras.push(`Sort code: ${sort}`)
    const bsb = get('bsb', 'BSB')
    if (bsb) extras.push(`BSB: ${bsb}`)
    const acctNo = get('acctNo', 'accountNo', 'account_no')
    if (acctNo) extras.push(`Account: ${acctNo}`)

    const out: EPCResult = {
      iban: iban || undefined,
      creditor_name: name || undefined,
      purpose: purpose || undefined,
      reference: reference || undefined,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : undefined,
      amount: Number.isFinite(amountVal) && amountVal > 0 ? amountVal : undefined,
      due_date: due || undefined,
      payment_details: extras.length ? extras.join('\n') : undefined,
    }

    if (out.iban || typeof out.amount === 'number' || out.reference || out.purpose || out.payment_details) return out
    return null
  } catch {
    return null
  }
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
  const raw = (process.env.EXPO_PUBLIC_FUNCTIONS_BASE as string | undefined) || (PUBLIC_SITE_URL as any)
  const base = typeof raw === 'string' ? raw.trim() : ''
  return base ? base.replace(/\/$/, '') : null
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
type BillStatus = 'pending' | 'unpaid' | 'paid' | 'archived'

const ARCHIVE_PURPOSE_MARKER = '[BILLBOX_ARCHIVED]'

function remapArchivedBillFromDb<T extends { status?: any; purpose?: any }>(bill: T): T {
  const status = (bill as any)?.status
  const purposeRaw = typeof (bill as any)?.purpose === 'string' ? String((bill as any).purpose) : ''
  if (status === 'paid' && purposeRaw.includes(ARCHIVE_PURPOSE_MARKER)) {
    const cleaned = purposeRaw
      .replace(ARCHIVE_PURPOSE_MARKER, '')
      .replace(/^\s*\n+/, '')
      .replace(/^\s+/, '')
    return { ...(bill as any), status: 'archived', purpose: cleaned ? cleaned : null }
  }
  return bill
}

function isBillUnpaid(status: any): boolean {
  return status === 'unpaid' || status === 'pending'
}

function billStatusForDb(status: any): 'pending' | 'paid' | 'archived' {
  // DB uses 'pending' (not 'unpaid') for unpaid bills.
  // Keep accepting legacy 'unpaid' locally and map it when writing to Supabase.
  if (status === 'paid') return 'paid'
  if (status === 'archived') return 'archived'
  return 'pending'
}

function isBillStatusConstraintError(error: any): boolean {
  const rawMsg = String(error?.message || '')
  return /bills\s+status\s+check|check\s+constraint.*status|violates\s+check\s+constraint/i.test(rawMsg)
}

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
  reference_model?: string | null
  purpose?: string | null
  invoice_number?: string | null
  category?: string | null
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
  reference_model?: string | null
  purpose?: string | null
  invoice_number?: string | null
  category?: string | null
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

type EntitlementsSpaceScope = { spaceId: string | null; spaceId2: string | null; payerLimit: number }
const entitlementsSpaceScopeCache = new Map<string, EntitlementsSpaceScope>()

async function loadEntitlementsSpaceScope(supabase: SupabaseClient): Promise<EntitlementsSpaceScope> {
  const userId = await getCurrentUserId(supabase)
  const cached = entitlementsSpaceScopeCache.get(userId)
  if (cached) return cached

  try {
    const { data } = await supabase
      .from('entitlements')
      .select('payer_limit,space_id,space_id2,space_id_2,plan')
      .eq('user_id', userId)
      .order('active_until', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    const payerLimit = typeof (data as any)?.payer_limit === 'number'
      ? (data as any).payer_limit
      : String((data as any)?.plan || '') === 'pro' ? 2 : 1
    const s1 = typeof (data as any)?.space_id === 'string' ? String((data as any).space_id).trim() : ''
    const s2raw = (data as any)?.space_id2 || (data as any)?.space_id_2
    const s2 = typeof s2raw === 'string' ? String(s2raw).trim() : ''

    const scope: EntitlementsSpaceScope = {
      payerLimit,
      spaceId: isUuidString(s1) ? s1 : null,
      spaceId2: isUuidString(s2) ? s2 : null,
    }
    entitlementsSpaceScopeCache.set(userId, scope)
    return scope
  } catch {
    const scope: EntitlementsSpaceScope = { payerLimit: 1, spaceId: null, spaceId2: null }
    entitlementsSpaceScopeCache.set(userId, scope)
    return scope
  }
}

function resolveDbSpaceIdFromSnapshot(
  entitlements: EntitlementsSnapshot | null | undefined,
  localSpaceId: string | null | undefined,
): string | null {
  return resolveDbSpaceIdFromEntitlements(entitlements || null, localSpaceId)
}

async function resolveDbSpaceId(
  supabase: SupabaseClient,
  localSpaceId: string | null | undefined,
  entitlements?: EntitlementsSnapshot | null,
): Promise<string | null> {
  const raw = typeof localSpaceId === 'string' ? localSpaceId.trim() : ''
  if (!raw) return null
  if (isUuidString(raw)) return raw

  const viaSnapshot = resolveDbSpaceIdFromSnapshot(entitlements || null, raw)
  if (viaSnapshot) return viaSnapshot

  const scope = await loadEntitlementsSpaceScope(supabase)
  if (raw === 'personal2') return scope.spaceId2
  return scope.spaceId
}

async function listBills(
  supabase: SupabaseClient,
  _spaceId?: string | string[] | null,
  entitlements?: EntitlementsSnapshot | null,
): Promise<{ data: Bill[]; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase
    .from('bills')
    .select('*')
    .eq('user_id', userId)

  const requested = Array.isArray(_spaceId)
    ? (_spaceId || []).filter(Boolean).length > 0
    : Boolean(String(_spaceId || '').trim())

  const rawIds = Array.isArray(_spaceId) ? (_spaceId || []) : [(_spaceId || null)]
  const resolved = (await Promise.all(
    rawIds
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
      .map((sid) => resolveDbSpaceId(supabase, sid, entitlements || null)),
  )).filter((v): v is string => Boolean(v && isUuidString(v)))

  const unique = Array.from(new Set(resolved))
  if (requested && unique.length === 0) return { data: [], error: null }
  if (unique.length === 1) q = q.eq('space_id', unique[0])
  else if (unique.length > 1) q = q.in('space_id', unique)

  const { data, error } = await q.order('due_date', { ascending: true })
  const rows = Array.isArray(data) ? (data as any[]).map((b) => remapArchivedBillFromDb(b as any)) : []
  return { data: (rows as Bill[]) || [], error }
}

type ExportPayerScope = 'payer1' | 'payer2' | 'both'

function localPayerIdsForExportScope(scope: ExportPayerScope): Array<'personal' | 'personal2'> {
  if (scope === 'both') return ['personal', 'personal2']
  if (scope === 'payer2') return ['personal2']
  return ['personal']
}

async function resolveDbExportScopePayload(
  supabase: SupabaseClient,
  entitlements: EntitlementsSnapshot | null | undefined,
  scope: ExportPayerScope,
): Promise<{ spaceId?: string; spaceIds?: string[] } | null> {
  const canUsePayer2 = Number(entitlements?.payerLimit || 1) >= 2
  if ((scope === 'payer2' || scope === 'both') && !canUsePayer2) return null

  const p1 = await resolveDbSpaceId(supabase, 'personal', entitlements || null)
  const p2 = await resolveDbSpaceId(supabase, 'personal2', entitlements || null)
  if (!p1) return null
  if (scope === 'payer1') return { spaceId: p1 }
  if (!p2) return null
  if (scope === 'payer2') return { spaceId: p2 }
  const ids = Array.from(new Set([p1, p2].filter(Boolean)))
  return ids.length ? { spaceIds: ids } : null
}

async function createBill(supabase: SupabaseClient, input: CreateBillInput): Promise<{ data: Bill | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const dbSpaceId = await resolveDbSpaceId(supabase, input.space_id || null)
  const desired = input.status || 'unpaid'
  const primaryStatus = billStatusForDb(desired)

  const payloadBase: any = { ...input, user_id: userId, space_id: dbSpaceId }
  const primaryPayload: any = { ...payloadBase, status: primaryStatus }
  const first = await supabase.from('bills').insert(primaryPayload).select().single()
  if (!first.error) return { data: (first.data as Bill) || null, error: null }

  // Backward-compatible: some DBs only allow 'unpaid'/'paid' (no 'pending' or 'archived').
  if (isBillStatusConstraintError(first.error)) {
    if (primaryStatus === 'pending') {
      const retry = await supabase.from('bills').insert({ ...payloadBase, status: 'unpaid' }).select().single()
      return { data: (retry.data as Bill) || null, error: (retry.error as any) || null }
    }
    if (primaryStatus === 'archived') {
      const purposeRaw = typeof (payloadBase as any)?.purpose === 'string' ? String((payloadBase as any).purpose) : ''
      const markedPurpose = purposeRaw.includes(ARCHIVE_PURPOSE_MARKER)
        ? purposeRaw
        : (purposeRaw ? `${ARCHIVE_PURPOSE_MARKER}\n${purposeRaw}` : ARCHIVE_PURPOSE_MARKER)
      const retry = await supabase
        .from('bills')
        .insert({ ...payloadBase, status: 'paid', purpose: markedPurpose })
        .select()
        .single()
      return { data: (retry.data as Bill) || null, error: (retry.error as any) || null }
    }
  }

  return { data: (first.data as Bill) || null, error: first.error }
}

async function deleteBill(supabase: SupabaseClient, id: string, _spaceId?: string | null): Promise<{ error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase.from('bills').delete().eq('user_id', userId).eq('id', id)
  const dbSpaceId = await resolveDbSpaceId(supabase, _spaceId || null)
  if (dbSpaceId) q = q.eq('space_id', dbSpaceId)
  const { error } = await q
  return { error }
}

async function setBillStatus(supabase: SupabaseClient, id: string, status: BillStatus, _spaceId?: string | null): Promise<{ data: Bill | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const primaryStatus = billStatusForDb(status)
  const baseMatch: any = { user_id: userId, id }

  const dbSpaceId = await resolveDbSpaceId(supabase, _spaceId || null)
  const applySpace = (q: any) => dbSpaceId ? q.eq('space_id', dbSpaceId) : q

  // First try with the preferred status mapping.
  let q = applySpace(
    supabase
      .from('bills')
      .update({ status: primaryStatus })
      .eq('user_id', baseMatch.user_id)
      .eq('id', baseMatch.id)
  )
  const first = await q.select().single()
  if (!first.error) return { data: (first.data as Bill) || null, error: null }

  if (isBillStatusConstraintError(first.error)) {
    if (primaryStatus === 'pending') {
      const retry = await applySpace(
        supabase
          .from('bills')
          .update({ status: 'unpaid' })
          .eq('user_id', baseMatch.user_id)
          .eq('id', baseMatch.id)
      ).select().single()
      return { data: (retry.data as Bill) || null, error: (retry.error as any) || null }
    }
    if (primaryStatus === 'archived') {
      // If DB doesn't support 'archived', store as 'paid' with an internal marker in purpose.
      const current = await applySpace(
        supabase
          .from('bills')
          .select('purpose')
          .eq('user_id', baseMatch.user_id)
          .eq('id', baseMatch.id)
          .maybeSingle()
      )
      const purposeRaw = typeof (current.data as any)?.purpose === 'string' ? String((current.data as any).purpose) : ''
      const markedPurpose = purposeRaw.includes(ARCHIVE_PURPOSE_MARKER)
        ? purposeRaw
        : (purposeRaw ? `${ARCHIVE_PURPOSE_MARKER}\n${purposeRaw}` : ARCHIVE_PURPOSE_MARKER)
      const retry = await applySpace(
        supabase
          .from('bills')
          .update({ status: 'paid', purpose: markedPurpose })
          .eq('user_id', baseMatch.user_id)
          .eq('id', baseMatch.id)
      ).select().single()
      return { data: (retry.data as Bill) || null, error: (retry.error as any) || null }
    }
  }

  return { data: (first.data as Bill) || null, error: first.error }
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
  const dbSpaceId = await resolveDbSpaceId(supabase, _spaceId || null)
  if (dbSpaceId) q = q.eq('space_id', dbSpaceId)
  const { data, error } = await q.select().single()
  return { data: (data as Bill) || null, error }
}

async function setBillInvoiceNumber(
  supabase: SupabaseClient,
  id: string,
  invoice_number: string | null,
  _spaceId?: string | null,
): Promise<{ data: Bill | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase
    .from('bills')
    .update({ invoice_number })
    .eq('user_id', userId)
    .eq('id', id)
  const dbSpaceId = await resolveDbSpaceId(supabase, _spaceId || null)
  if (dbSpaceId) q = q.eq('space_id', dbSpaceId)
  const { data, error } = await q.select().single()
  return { data: (data as Bill) || null, error }
}

async function listWarranties(
  supabase: SupabaseClient,
  _spaceId?: string | string[] | null,
  entitlements?: EntitlementsSnapshot | null,
): Promise<{ data: Warranty[]; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase
    .from('warranties')
    .select('*')
    .eq('user_id', userId)

  const requested = Array.isArray(_spaceId)
    ? (_spaceId || []).filter(Boolean).length > 0
    : Boolean(String(_spaceId || '').trim())

  const rawIds = Array.isArray(_spaceId) ? (_spaceId || []) : [(_spaceId || null)]
  const resolved = (await Promise.all(
    rawIds
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
      .map((sid) => resolveDbSpaceId(supabase, sid, entitlements || null)),
  )).filter((v): v is string => Boolean(v && isUuidString(v)))

  const unique = Array.from(new Set(resolved))
  if (requested && unique.length === 0) return { data: [], error: null }
  if (unique.length === 1) q = q.eq('space_id', unique[0])
  else if (unique.length > 1) q = q.in('space_id', unique)

  const { data, error } = await q.order('created_at', { ascending: false })
  return { data: (data as Warranty[]) || [], error }
}

async function createWarranty(supabase: SupabaseClient, input: CreateWarrantyInput): Promise<{ data: Warranty | null; error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  const dbSpaceId = await resolveDbSpaceId(supabase, input.space_id || null)
  const payload: any = { ...input, user_id: userId, space_id: dbSpaceId }
  const { data, error } = await supabase.from('warranties').insert(payload).select().single()
  return { data: (data as Warranty) || null, error }
}

async function deleteWarranty(supabase: SupabaseClient, id: string, _spaceId?: string | null): Promise<{ error: PostgrestError | null }>{
  const userId = await getCurrentUserId(supabase)
  let q = supabase.from('warranties').delete().eq('user_id', userId).eq('id', id)
  const dbSpaceId = await resolveDbSpaceId(supabase, _spaceId || null)
  if (dbSpaceId) q = q.eq('space_id', dbSpaceId)
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

function useDayKey(): string {
  const [dayKey, setDayKey] = useState(() => new Date().toISOString().slice(0, 10))

  useEffect(() => {
    let timer: any
    const schedule = () => {
      const now = new Date()
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1)
      const ms = Math.max(1000, next.getTime() - now.getTime())
      timer = setTimeout(() => {
        setDayKey(new Date().toISOString().slice(0, 10))
        schedule()
      }, ms)
    }
    schedule()
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [])

  return dayKey
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
const LS_CATEGORY_OVERRIDES_PREFIX = 'billbox.categoryOverrides.'

function normalizeSpaceId(id?: string | null): string {
  return id && id.trim().length > 0 ? id : 'default'
}

function billsKey(spaceId?: string | null) {
  return `${LS_BILLS_PREFIX}${normalizeSpaceId(spaceId)}`
}

async function getCategoryOverridesStorageKey(supabase: SupabaseClient | null): Promise<string | null> {
  if (!supabase) return `${LS_CATEGORY_OVERRIDES_PREFIX}local`
  try {
    const userId = await getCurrentUserId(supabase)
    return userId ? `${LS_CATEGORY_OVERRIDES_PREFIX}${userId}` : `${LS_CATEGORY_OVERRIDES_PREFIX}local`
  } catch {
    return `${LS_CATEGORY_OVERRIDES_PREFIX}local`
  }
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

async function setLocalBillInvoiceNumber(spaceId: string | null | undefined, id: string, invoice_number: string | null): Promise<void> {
  const items = await loadLocalBills(spaceId)
  await saveLocalBills(spaceId, items.map((b) => (b.id === id ? { ...b, invoice_number } : b)))
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

function nextMonthStartUtc(date: Date): Date {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0))
}

async function preflightOcrQuota(): Promise<{ ok: true } | { ok: false; resetAt?: string }> {
  try {
    const base = getFunctionsBase()
    const supabase = getSupabase()
    if (!base || !supabase) return { ok: true }
    const { data } = await supabase.auth.getSession()
    const token = data?.session?.access_token
    if (!token) return { ok: true }

    const resp = await fetch(`${base}/.netlify/functions/entitlements`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await resp.json().catch(() => null as any)
    const ent = json?.entitlements || null
    if (!ent) return { ok: true }

    const quota = typeof ent.ocrQuotaMonthly === 'number'
      ? ent.ocrQuotaMonthly
      : (typeof ent.ocr_quota_monthly === 'number' ? ent.ocr_quota_monthly : null)
    const used = typeof ent.ocrUsedThisMonth === 'number'
      ? ent.ocrUsedThisMonth
      : (typeof ent.ocr_used_this_month === 'number' ? ent.ocr_used_this_month : 0)
    if (quota === null || quota === undefined) return { ok: true }

    if (used >= quota) {
      const updatedRaw = ent.ocrUpdatedAt || ent.ocr_updated_at || ent.updatedAt || ent.updated_at || null
      const baseDate = updatedRaw ? new Date(updatedRaw) : new Date()
      const resetAt = nextMonthStartUtc(Number.isNaN(baseDate.getTime()) ? new Date() : baseDate).toISOString()
      return { ok: false, resetAt }
    }
  } catch {}
  return { ok: true }
}

async function performOCRFromBase64(
  base64: string,
  contentType: string,
  opts?: { preferQr?: boolean; allowAi?: boolean; aiMode?: string; languageHint?: string },
): Promise<{ fields: any; summary: string; rawText?: string; mode?: string; meta?: any; ai?: boolean; aiModel?: string | null; aiTier?: string | null }> {
  const base = getFunctionsBase()
  if (!base) {
    throw new Error('OCR unavailable: missing EXPO_PUBLIC_FUNCTIONS_BASE')
  }
  const supabase = getSupabase()
  let authHeader: Record<string, string> = {}
  if (supabase) {
    try {
      const { data } = await supabase.auth.getSession()
      const token = data?.session?.access_token
      if (token) authHeader = { Authorization: `Bearer ${token}` }
    } catch {}
  }
  if (!authHeader.Authorization) {
    const err: any = new Error('Sign in to use OCR.')
    err.status = 401
    err.code = 'auth_required'
    throw err
  }

  const preflight = await preflightOcrQuota()
  if (!preflight.ok) {
    const err: any = new Error(tr('OCR monthly quota exceeded.'))
    err.code = 'ocr_quota_exceeded'
    err.resetAt = preflight.resetAt || null
    throw err
  }

  const ct = (contentType && String(contentType).trim()) || 'application/octet-stream'
  const raw = String(base64 || '').trim()
  const approxBytes = Math.floor((raw.length * 3) / 4)
  if (approxBytes > 12 * 1024 * 1024) {
    const err: any = new Error('File too large for OCR.')
    err.code = 'file_too_large'
    throw err
  }

  const resp = await fetch(`${base}/.netlify/functions/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify(
      ct === 'application/pdf'
        ? { pdfBase64: raw, contentType: ct, preferQr: Boolean(opts?.preferQr), allowAi: Boolean(opts?.allowAi), aiMode: opts?.aiMode, language: opts?.languageHint }
        : { imageBase64: `data:${ct};base64,${raw}`, contentType: ct, preferQr: Boolean(opts?.preferQr), allowAi: Boolean(opts?.allowAi), aiMode: opts?.aiMode, language: opts?.languageHint },
    ),
  })
  const data = await resp.json().catch(() => null as any)
  if (!resp.ok || !data?.ok) {
    const detail = data?.detail ? ` (${data.detail})` : ''
    const message = data?.message || (data?.error ? `${data.error}${detail}` : tr('OCR failed ({status})', { status: resp.status }))
    const err: any = new Error(message)
    err.status = resp.status
    err.code = data?.error || null
    err.requestId = data?.requestId || null
    err.detail = data?.detail || null
    err.resetAt = data?.resetAt || data?.reset_at || null
    throw err
  }
  const f = data.fields || {}
  const rawText = typeof data.rawText === 'string' ? data.rawText : ''
  const mode = typeof data.mode === 'string' ? data.mode : undefined
  const meta = data && typeof data.meta === 'object' ? data.meta : undefined
  const ai = Boolean(data?.ai)
  const aiModel = typeof data?.aiModel === 'string' ? data.aiModel : null
  const aiTier = typeof data?.aiTier === 'string' ? data.aiTier : null
  const parts: string[] = []
  if (f.creditor_name || f.supplier) parts.push(`${tr('Creditor')}: ${f.creditor_name || f.supplier}`)
  if (typeof f.amount === 'number' && f.currency) parts.push(`${tr('Amount')}: ${f.currency} ${f.amount}`)
  if (f.due_date) parts.push(`${tr('Due')}: ${f.due_date}`)
  if (f.iban) parts.push(`${tr('IBAN')}: ${f.iban}`)
  if (f.reference) parts.push(`${tr('Reference number')}: ${f.reference}`)
  if (f.purpose) parts.push(`${tr('Purpose')}: ${f.purpose}`)
  if (f.payment_details) parts.push(`${tr('Payment details')}: ${String(f.payment_details).slice(0, 200)}`)
  const summary = parts.join('\n') || tr('No fields found')
  return { fields: f, summary, rawText, mode, meta, ai, aiModel, aiTier }
}

// --- OCR helper (Netlify function wrapper) ---
async function performOCR(
  uri: string,
  opts?: { preferQr?: boolean; contentType?: string; filename?: string; allowAi?: boolean; aiMode?: string; languageHint?: string },
): Promise<{ fields: any; summary: string; rawText?: string; mode?: string; meta?: any; ai?: boolean; aiModel?: string | null; aiTier?: string | null }>{
  const base = getFunctionsBase()
  if (!base) {
    throw new Error('OCR unavailable: missing EXPO_PUBLIC_FUNCTIONS_BASE')
  }
  const supabase = getSupabase()
  let authHeader: Record<string, string> = {}
  if (supabase) {
    try {
      const { data } = await supabase.auth.getSession()
      const token = data?.session?.access_token
      if (token) authHeader = { Authorization: `Bearer ${token}` }
    } catch {}
  }
  if (!authHeader.Authorization) {
    const err: any = new Error('Sign in to use OCR.')
    err.status = 401
    err.code = 'auth_required'
    throw err
  }

  // Reading local URIs via fetch/blob can be flaky on Android (content://, large PDFs).
  // Use expo-file-system base64 and send JSON (server supports imageBase64/pdfBase64).
  // For content:// URIs, copy into cache first.
  let base64: string
  let contentType = (opts?.contentType && String(opts.contentType).trim()) || 'application/octet-stream'
  let tempFileUri: string | null = null
  const isCsvType = (ct: string, name?: string) => {
    const c = String(ct || '').toLowerCase()
    if (c.includes('text/csv') || c.includes('application/csv') || c.includes('application/vnd.ms-excel')) return true
    const n = String(name || '').toLowerCase()
    return n.endsWith('.csv')
  }

  const inferContentTypeFromUri = (u: string): string => {
    const lower = String(u || '').toLowerCase()
    if (lower.endsWith('.pdf')) return 'application/pdf'
    if (lower.endsWith('.csv')) return 'text/csv'
    if (lower.endsWith('.png')) return 'image/png'
    if (lower.endsWith('.webp')) return 'image/webp'
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    return 'application/octet-stream'
  }

  const extFromContentType = (ct: string): string => {
    const c = String(ct || '').toLowerCase()
    if (c.includes('pdf')) return '.pdf'
    if (c.includes('png')) return '.png'
    if (c.includes('webp')) return '.webp'
    if (c.includes('jpg') || c.includes('jpeg')) return '.jpg'
    if (c.startsWith('image/')) return '.jpg'
    return ''
  }

  const ensureReadableFileUri = async (): Promise<string> => {
    const u = String(uri || '')
    if (!contentType || contentType === 'application/octet-stream') {
      contentType = inferContentTypeFromUri(u)
      if (!contentType || contentType === 'application/octet-stream') contentType = 'image/jpeg'
    }

    // Remote URL: download to cache.
    if (/^https?:\/\//i.test(u)) {
      const ext = extFromContentType(contentType)
      const target = `${FileSystem.cacheDirectory || FileSystem.documentDirectory || ''}billbox_ocr_${Date.now()}${ext}`
      const dl = await FileSystem.downloadAsync(u, target)
      tempFileUri = dl?.uri || target
      return tempFileUri
    }

    // content://: copy to cache first.
    if (/^content:\/\//i.test(u)) {
      const ext = extFromContentType(contentType)
      const target = `${FileSystem.cacheDirectory || FileSystem.documentDirectory || ''}billbox_ocr_${Date.now()}${ext}`
      await FileSystem.copyAsync({ from: u, to: target })
      tempFileUri = target
      return target
    }

    return u
  }

  try {
    const readableUri = await ensureReadableFileUri()
    // Guard: avoid trying to base64-encode huge files on device.
    try {
      const info = await FileSystem.getInfoAsync(readableUri)
      if (info && info.exists === false) throw new Error('file_missing')
      if (typeof info?.size === 'number' && info.size > 12 * 1024 * 1024) throw new Error('file_too_large')
    } catch (e: any) {
      const err: any = new Error(e?.message === 'file_too_large' ? 'File too large for OCR.' : 'Could not read the selected file.')
      err.code = e?.message || 'file_read_failed'
      throw err
    }

    if (isCsvType(contentType, opts?.filename || uri)) {
      try {
        const text = await FileSystem.readAsStringAsync(readableUri, { encoding: FileSystem.EncodingType.UTF8 })
        const resp = await fetch(`${base}/.netlify/functions/ocr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ text, contentType: 'text/csv', allowAi: Boolean(opts?.allowAi), aiMode: opts?.aiMode, language: opts?.languageHint }),
        })
        const data = await resp.json().catch(() => null as any)
        if (!resp.ok || !data?.ok) {
          const detail = data?.detail ? ` (${data.detail})` : ''
          const message = data?.message || (data?.error ? `${data.error}${detail}` : tr('OCR failed ({status})', { status: resp.status }))
          const err: any = new Error(message)
          err.status = resp.status
          err.code = data?.error || null
          err.requestId = data?.requestId || null
          err.detail = data?.detail || null
          err.resetAt = data?.resetAt || data?.reset_at || null
          throw err
        }
        const f = data.fields || {}
        const rawText = typeof data.rawText === 'string' ? data.rawText : ''
        const mode = typeof data.mode === 'string' ? data.mode : undefined
        const meta = data && typeof data.meta === 'object' ? data.meta : undefined
        const ai = Boolean(data?.ai)
        const aiModel = typeof data?.aiModel === 'string' ? data.aiModel : null
        const aiTier = typeof data?.aiTier === 'string' ? data.aiTier : null
        const parts: string[] = []
        if (f.creditor_name || f.supplier) parts.push(`${tr('Creditor')}: ${f.creditor_name || f.supplier}`)
        if (typeof f.amount === 'number' && f.currency) parts.push(`${tr('Amount')}: ${f.currency} ${f.amount}`)
        if (f.due_date) parts.push(`${tr('Due')}: ${f.due_date}`)
        if (f.iban) parts.push(`${tr('IBAN')}: ${f.iban}`)
        if (f.reference) parts.push(`${tr('Reference number')}: ${f.reference}`)
        if (f.purpose) parts.push(`${tr('Purpose')}: ${f.purpose}`)
        if (f.payment_details) parts.push(`${tr('Payment details')}: ${String(f.payment_details).slice(0, 200)}`)
        const summary = parts.join('\n') || tr('No fields found')
        return { fields: f, summary, rawText, mode, meta, ai, aiModel, aiTier }
      } catch (e) {
        throw e
      }
    }

    try {
      base64 = await FileSystem.readAsStringAsync(readableUri, { encoding: FileSystem.EncodingType.Base64 })
    } catch (e: any) {
      // Final fallback: try fetch->blob for edge cases.
      try {
        const resp = await fetch(readableUri)
        const b = await resp.blob()
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader: any = new (global as any).FileReader()
          reader.onload = () => resolve(String(reader.result || ''))
          reader.onerror = (err: any) => reject(err)
          reader.readAsDataURL(b)
        })
        const parts = dataUrl.split(',')
        base64 = parts.length > 1 ? parts[1] : ''
      } catch {
        const err: any = new Error('Could not read the selected file.')
        err.code = 'file_read_failed'
        throw err
      }
    }
  } finally {
    if (tempFileUri) {
      try { await FileSystem.deleteAsync(tempFileUri, { idempotent: true }) } catch {}
    }
  }

  const resp = await fetch(`${base}/.netlify/functions/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify(
      contentType === 'application/pdf'
        ? { pdfBase64: base64, contentType, preferQr: Boolean(opts?.preferQr), allowAi: Boolean(opts?.allowAi), aiMode: opts?.aiMode, language: opts?.languageHint }
        : { imageBase64: `data:${contentType};base64,${base64}`, contentType, preferQr: Boolean(opts?.preferQr), allowAi: Boolean(opts?.allowAi), aiMode: opts?.aiMode, language: opts?.languageHint },
    ),
  })
  const data = await resp.json().catch(() => null as any)
  if (!resp.ok || !data?.ok) {
    const detail = data?.detail ? ` (${data.detail})` : ''
    const message = data?.message || (data?.error ? `${data.error}${detail}` : tr('OCR failed ({status})', { status: resp.status }))
    const err: any = new Error(message)
    err.status = resp.status
    err.code = data?.error || null
    err.requestId = data?.requestId || null
    err.detail = data?.detail || null
    err.resetAt = data?.resetAt || data?.reset_at || null
    throw err
  }
  const f = data.fields || {}
  const rawText = typeof data.rawText === 'string' ? data.rawText : ''
  const mode = typeof data.mode === 'string' ? data.mode : undefined
  const meta = data && typeof data.meta === 'object' ? data.meta : undefined
  const ai = Boolean(data?.ai)
  const aiModel = typeof data?.aiModel === 'string' ? data.aiModel : null
  const aiTier = typeof data?.aiTier === 'string' ? data.aiTier : null
  const parts: string[] = []
  if (f.creditor_name || f.supplier) parts.push(`${tr('Creditor')}: ${f.creditor_name || f.supplier}`)
  if (typeof f.amount === 'number' && f.currency) parts.push(`${tr('Amount')}: ${f.currency} ${f.amount}`)
  if (f.due_date) parts.push(`${tr('Due')}: ${f.due_date}`)
  if (f.iban) parts.push(`${tr('IBAN')}: ${f.iban}`)
  if (f.reference) parts.push(`${tr('Reference number')}: ${f.reference}`)
  if (f.purpose) parts.push(`${tr('Purpose')}: ${f.purpose}`)
  if (f.payment_details) parts.push(`${tr('Payment details')}: ${String(f.payment_details).slice(0, 200)}`)
  const summary = parts.join('\n') || tr('No fields found')
  return { fields: f, summary, rawText, mode, meta, ai, aiModel, aiTier }
}

function extractWarrantyFieldsFromOcr(rawText: string): {
  itemName?: string
  supplier?: string
  purchaseDate?: string
  expiresAt?: string
  durationMonths?: string
} {
  const text = String(rawText || '')
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const normalizeSpaces = (s: string) => s.replace(/\s+/g, ' ').trim()

  const parseDate = (s: string): string | null => {
    const str = String(s || '')
    const dmy = str.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/)
    if (dmy) {
      const day = Number(dmy[1])
      const month = Number(dmy[2])
      let year = Number(dmy[3])
      if (year < 100) year += 2000
      if (year < 2000 || year > 2100) return null
      if (month < 1 || month > 12) return null
      if (day < 1 || day > 31) return null
      const dt = new Date(year, month - 1, day)
      if (Number.isNaN(dt.getTime())) return null
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
    const ymd = str.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
    if (ymd) {
      const year = Number(ymd[1])
      const month = Number(ymd[2])
      const day = Number(ymd[3])
      if (year < 2000 || year > 2100) return null
      if (month < 1 || month > 12) return null
      if (day < 1 || day > 31) return null
      return `${ymd[1]}-${ymd[2]}-${ymd[3]}`
    }
    return null
  }

  const pickLabeledValue = (labels: string[]): string | null => {
    const labelRe = new RegExp(
      `^(${labels.map((x) => x.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')).join('|')})\\s*[:.-]?\\s*(.+)$`,
      'i'
    )
    for (const line of lines) {
      const m = line.match(labelRe)
      if (m && m[2]) {
        const value = normalizeSpaces(m[2])
        if (value && value.length >= 2) return value
      }
    }
    return null
  }

  const itemName = pickLabeledValue([
    'Naziv izdelka',
    'Izdelek',
    'Artikel',
    'Artikl',
    'Product',
    'Item',
    'Description',
  ])

  const supplier = pickLabeledValue([
    'Dobavitelj',
    'Prodajalec',
    'Trgovec',
    'Supplier',
    'Merchant',
    'Seller',
  ])

  const purchaseDateRaw = pickLabeledValue([
    'Datum nakupa',
    'Purchase date',
    'Date of purchase',
    'Datum nakupa/servisa',
  ])
  const purchaseDate = purchaseDateRaw ? parseDate(purchaseDateRaw) : null

  const expiresRaw = pickLabeledValue([
    'Datum poteka',
    'Velja do',
    'Valid until',
    'Expires',
    'Expiry date',
  ])
  const expiresAt = expiresRaw ? parseDate(expiresRaw) : null

  let durationMonths: string | null = null
  const durationLabeled = pickLabeledValue(['Veljavnost', 'Trajanje', 'Garancija', 'Warranty', 'Duration'])
  const durationHay = [durationLabeled, text].filter(Boolean).join('\n')
  const dm = durationHay.match(/\b(\d{1,3})\s*(mesecev|meseci|mes\.|months)\b/i)
  if (dm) {
    const n = parseInt(dm[1], 10)
    if (Number.isFinite(n) && n > 0 && n <= 120) durationMonths = String(n)
  }

  return {
    itemName: itemName || undefined,
    supplier: supplier || undefined,
    purchaseDate: purchaseDate || undefined,
    expiresAt: expiresAt || undefined,
    durationMonths: durationMonths || undefined,
  }
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
    const isPayer1 = id === 'personal'
    if (isPayer1) {
      try { await AsyncStorage.removeItem('billbox.onboarding.payer1Named') } catch {}
    }
    await purgePayerData(id)
    await removeSpace(id)
    const ensured = await ensureSpacesDefaults()
    setSpaces(ensured.spaces)
    setSpaceId(ensured.currentId)
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
  const spaceIdOverride = typeof route.params?.spaceIdOverride === 'string' ? String(route.params.spaceIdOverride) : null
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [linkedWarranty, setLinkedWarranty] = useState<Warranty | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceSaving, setInvoiceSaving] = useState(false)
  const [defaultReminderInfo, setDefaultReminderInfo] = useState<string | null>(null)
  const [reminderInfo, setReminderInfo] = useState<string | null>(null)
  const [remindersEnabled, setRemindersEnabledState] = useState<boolean>(true)
  const [selectedReminderDelayDays, setSelectedReminderDelayDays] = useState<number | null>(null)
  const [detailNotice, setDetailNotice] = useState<string | null>(null)
  const detailNoticeTimerRef = useRef<any>(null)
  const [dangerConfirm, setDangerConfirm] = useState<{
    title: string
    message: string
    confirmLabel?: string
    onConfirm: () => void | Promise<void>
  } | null>(null)
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()

  const showDetailNotice = useCallback((message: string, durationMs = 2200) => {
    if (detailNoticeTimerRef.current) clearTimeout(detailNoticeTimerRef.current)
    setDetailNotice(message)
    detailNoticeTimerRef.current = setTimeout(() => {
      setDetailNotice(null)
      detailNoticeTimerRef.current = null
    }, Math.max(800, durationMs))
  }, [])

  useEffect(() => {
    return () => {
      if (detailNoticeTimerRef.current) clearTimeout(detailNoticeTimerRef.current)
    }
  }, [])

  const showDangerConfirm = useCallback((title: string, message: string, onConfirm: () => void | Promise<void>, confirmLabel?: string) => {
    setDangerConfirm({ title, message, onConfirm, confirmLabel })
  }, [])

  const effectiveSpaceId = spaceIdOverride || spaceId

  useEffect(() => {
    setInvoiceNumber(String((bill as any)?.invoice_number || ''))
    setDefaultReminderInfo(null)
    setReminderInfo(null)
    setSelectedReminderDelayDays(null)
  }, [bill?.id])

  useEffect(() => {
    ;(async () => {
      setRemindersEnabledState(await getRemindersEnabled())
    })()
  }, [])

  const formatReminderDateTime = useCallback((date: Date) => {
    try {
      return date.toLocaleString()
    } catch {
      return date.toISOString()
    }
  }, [])

  const buildBillReminderInfo = useCallback((dueDate?: string | null) => {
    if (!dueDate) return null
    const parsed = parseDateValue(dueDate)
    if (!parsed) return null
    const dueAt = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 9, 0, 0, 0)
    const threeDaysBefore = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() - 3, 10, 0, 0, 0)
    const upcoming = [threeDaysBefore, dueAt].filter((d) => d.getTime() > Date.now())
    if (!upcoming.length) return tr('No upcoming reminders.')
    const next = upcoming.sort((a, b) => a.getTime() - b.getTime())[0]
    return tr('Next reminder: {date}', { date: formatReminderDateTime(next) })
  }, [formatReminderDateTime, parseDateValue])

  useEffect(() => { (async ()=>{
    if (!bill || spaceLoading || !space) return
    if (supabase) setAttachments(await listRemoteAttachments(supabase!, 'bills', bill.id, effectiveSpaceId))
    else setAttachments(await listLocalAttachments(effectiveSpaceId, 'bills', bill.id))

    try {
      if (supabase) {
        const { data } = await listWarranties(supabase!, effectiveSpaceId)
        const match = (data || []).find((w: any) => w.bill_id === bill.id) || null
        setLinkedWarranty(match)
      } else {
        const locals = await loadLocalWarranties(effectiveSpaceId)
        const match = (locals || []).find((w: any) => w.bill_id === bill.id) || null
        setLinkedWarranty(match as any)
      }
    } catch {
      setLinkedWarranty(null)
    }
  })() }, [bill, effectiveSpaceId, spaceLoading, space, supabase])

  async function refresh() {
    if (!bill || spaceLoading || !space) return
    if (supabase) setAttachments(await listRemoteAttachments(supabase!, 'bills', bill.id, effectiveSpaceId))
    else setAttachments(await listLocalAttachments(effectiveSpaceId, 'bills', bill.id))
  }

  async function addImage() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
    if (res.canceled) return
    const asset = res.assets?.[0]
    if (!asset?.uri) return
    const name = asset.fileName || 'photo.jpg'
    const type = asset.type || 'image/jpeg'
    const up = await uploadAttachmentFromUri(effectiveSpaceId, 'bills', bill!.id, asset.uri, name, type)
    if (up.error) Alert.alert(tr('Upload failed'), up.error)
    else showDetailNotice(tr('Image attached to bill'))
  }

  async function addPdf() {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
    if (res.canceled) return
    const file = res.assets?.[0]
    if (!file?.uri) return
    const name = file.name || 'document.pdf'
    const up = await uploadAttachmentFromUri(effectiveSpaceId, 'bills', bill!.id, file.uri, name, 'application/pdf')
    if (up.error) Alert.alert(tr('Upload failed'), up.error)
    else showDetailNotice(tr('PDF attached to bill'))
    await refresh()
  }

  async function openAttachment(path: string, uri?: string) {
    async function openLocalUri(targetUri: string) {
      const hasScheme = /^[a-z]+:/.test(targetUri)
      const fileUri = hasScheme ? targetUri : `file://${targetUri}`
      if (Platform.OS === 'android' && fileUri.startsWith('file://')) {
        const contentUri = await FileSystem.getContentUriAsync(fileUri)
        await Linking.openURL(contentUri)
      } else {
        await Linking.openURL(fileUri)
      }
    }

    if (supabase) {
      const url = await getSignedUrl(supabase!, path)
      if (!url) {
        Alert.alert(tr('Open failed'), tr('Could not get URL'))
        return
      }
      try {
        await Linking.openURL(url)
      } catch {
        try {
          const fileName = path.split('/').pop() || `attachment-${Date.now()}`
          const target = `${FileSystem.cacheDirectory}${fileName}`
          const download = await FileSystem.downloadAsync(url, target)
          if (download?.uri) await openLocalUri(download.uri)
          else Alert.alert(tr('Open failed'), tr('Could not open this file.'))
        } catch {
          Alert.alert(tr('Open failed'), tr('Could not open this file.'))
        }
      }
      return
    }

    if (!uri) {
      Alert.alert(tr('Offline'), tr('Attachment stored locally. Preview is unavailable.'))
      return
    }
    try {
      await openLocalUri(uri)
    } catch {
      Alert.alert(tr('Open failed'), tr('Could not open this file.'))
    }
  }

  async function remove(path: string) {
    showDangerConfirm(
      tr('Delete attachment?'),
      tr('This file will be removed.'),
      async () => {
        const { error } = await deleteAttachment(effectiveSpaceId, 'bills', bill!.id, path)
        if (error) Alert.alert(tr('Delete failed'), error)
        else await refresh()
      },
      tr('Delete')
    )
  }

  async function saveInvoiceNumber() {
    if (!bill) return
    if (invoiceSaving) return
    setInvoiceSaving(true)
    try {
      const next = invoiceNumber.trim() || null
      if (supabase) {
        const { error } = await setBillInvoiceNumber(supabase, bill.id, next, effectiveSpaceId)
        if (error) throw error
      } else {
        await setLocalBillInvoiceNumber(effectiveSpaceId, bill.id, next)
      }
      showDetailNotice(tr('Invoice number saved.'))
    } catch (e: any) {
      Alert.alert(tr('Save failed'), e?.message || tr('Unable to save.'))
    } finally {
      setInvoiceSaving(false)
    }
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

        {detailNotice ? (
          <InlineInfo tone="success" iconName="checkmark-circle-outline" message={detailNotice} />
        ) : null}

        <Surface elevated>
          <SectionHeader title={tr('Bill summary')} />
          <Text style={styles.bodyText}>{bill.currency} {bill.amount.toFixed(2)} • {tr('Due')} {bill.due_date}</Text>
          {!!(bill as any).invoice_number && <Text style={styles.bodyText}>{tr('Invoice number')}: {(bill as any).invoice_number}</Text>}
          {!!bill.reference && <Text style={styles.bodyText}>{tr('Reference number')}: {bill.reference}</Text>}
          {!!bill.iban && <Text style={styles.bodyText}>{tr('IBAN')}: {bill.iban}</Text>}
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
              style={{ marginTop: themeSpacing.sm }}
              onPress={() => navigation.navigate('Warranty Details', { warrantyId: linkedWarranty.id })}
            />
          ) : (
            <AppButton
              label={tr('Create warranty from this bill')}
              variant="secondary"
              iconName="shield-checkmark-outline"
              style={{ marginTop: themeSpacing.sm }}
              onPress={async () => {
                try {
                  // Enforce 1:1 rule (one bill -> max one warranty)
                  try {
                    const s0 = getSupabase()
                    if (s0) {
                      const { data } = await listWarranties(s0, effectiveSpaceId)
                      const existing = (data || []).find((w: any) => w.bill_id === bill.id) || null
                      if (existing?.id) {
                        showDetailNotice(tr('Opening the existing warranty for this bill.'))
                        navigation.navigate('Warranty Details', { warrantyId: existing.id })
                        return
                      }
                    } else {
                      const locals = await loadLocalWarranties(effectiveSpaceId)
                      const existing = (locals || []).find((w: any) => w.bill_id === bill.id) || null
                      if ((existing as any)?.id) {
                        showDetailNotice(tr('Opening the existing warranty for this bill.'))
                        navigation.navigate('Warranty Details', { warrantyId: (existing as any).id })
                        return
                      }
                    }
                  } catch {}

                  const s = getSupabase()
                  let createdId: string | null = null
                  if (s) {
                    const { data, error } = await createWarranty(s, { item_name: bill.supplier, supplier: bill.supplier, purchase_date: bill.due_date, bill_id: bill.id, space_id: effectiveSpaceId })
                    if (error) { Alert.alert(tr('Warranty error'), error.message); return }
                    createdId = data?.id || null
                  } else {
                    const local = await addLocalWarranty(effectiveSpaceId, { item_name: bill.supplier, supplier: bill.supplier, purchase_date: bill.due_date, bill_id: bill.id })
                    createdId = local.id
                  }
                  if (createdId) {
                    showDetailNotice(tr('Linked to this bill.'))
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
                await scheduleBillReminders({ ...bill, space_id: effectiveSpaceId } as any, undefined, effectiveSpaceId)
                setDefaultReminderInfo(tr('Default reminders: 3 days before at 10:00 and on due date at 09:00.'))
                setReminderInfo(buildBillReminderInfo(bill.due_date))
                showDetailNotice(tr('Scheduled default reminders for this bill.'))
              }}
            />
            <AppButton
              label={tr('Cancel reminders')}
              variant="ghost"
              iconName="notifications-off-outline"
              onPress={async ()=>{
                await cancelBillReminders(bill.id, effectiveSpaceId)
                setReminderInfo(null)
                showDetailNotice(tr('Canceled for this bill.'))
              }}
            />
          </View>
          {defaultReminderInfo ? (
            <InlineInfo
              tone="info"
              iconName="information-circle-outline"
              message={defaultReminderInfo}
              style={{ marginTop: themeSpacing.xs }}
            />
          ) : null}
          {!remindersEnabled ? (
            <InlineInfo
              tone="warning"
              iconName="alert-circle-outline"
              message={tr('Reminders are disabled in Settings.')}
              style={{ marginTop: themeSpacing.xs }}
            />
          ) : null}
          {reminderInfo ? (
            <InlineInfo
              tone="info"
              iconName="time-outline"
              message={reminderInfo}
              style={{ marginTop: themeSpacing.xs }}
            />
          ) : null}
          <View style={styles.billActionsRow}>
            <AppButton
              label={tr('Send in 1 day')}
              variant={selectedReminderDelayDays === 1 ? 'secondary' : 'outline'}
              style={selectedReminderDelayDays === 1 ? undefined : { backgroundColor: '#FFFFFF' }}
              onPress={async ()=>{
                await snoozeBillReminder({ ...bill, space_id: effectiveSpaceId } as any, 1, effectiveSpaceId)
                setSelectedReminderDelayDays(1)
                setReminderInfo(tr('Next reminder: {date}', { date: formatReminderDateTime(new Date(Date.now() + 1 * 24 * 3600 * 1000)) }))
                showDetailNotice(tr('Next reminder in 1 day.'))
              }}
            />
            <AppButton
              label={tr('Send in 3 days')}
              variant={selectedReminderDelayDays === 3 ? 'secondary' : 'outline'}
              style={selectedReminderDelayDays === 3 ? undefined : { backgroundColor: '#FFFFFF' }}
              onPress={async ()=>{
                await snoozeBillReminder({ ...bill, space_id: effectiveSpaceId } as any, 3, effectiveSpaceId)
                setSelectedReminderDelayDays(3)
                setReminderInfo(tr('Next reminder: {date}', { date: formatReminderDateTime(new Date(Date.now() + 3 * 24 * 3600 * 1000)) }))
                showDetailNotice(tr('Next reminder in 3 days.'))
              }}
            />
            <AppButton
              label={tr('Send in 7 days')}
              variant={selectedReminderDelayDays === 7 ? 'secondary' : 'outline'}
              style={selectedReminderDelayDays === 7 ? undefined : { backgroundColor: '#FFFFFF' }}
              onPress={async ()=>{
                await snoozeBillReminder({ ...bill, space_id: effectiveSpaceId } as any, 7, effectiveSpaceId)
                setSelectedReminderDelayDays(7)
                setReminderInfo(tr('Next reminder: {date}', { date: formatReminderDateTime(new Date(Date.now() + 7 * 24 * 3600 * 1000)) }))
                showDetailNotice(tr('Next reminder in 7 days.'))
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
              contentContainerStyle={{ paddingTop: themeSpacing.sm, paddingBottom: themeSpacing.sm }}
              renderItem={({ item }) => (
                <Surface elevated padded={false} style={[styles.billRowCard, styles.attachmentCard]}>
                  <View style={styles.attachmentCardContent}>
                    <Text style={styles.attachmentFileName}>{item.name}</Text>
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
                  </View>
                </Surface>
              )}
            />
          )}
        </Surface>

        <Surface elevated>
          <AppButton
            label={tr('Delete bill')}
            variant="ghost"
            iconName="trash-outline"
            onPress={() => {
              showDangerConfirm(
                tr('Delete bill?'),
                tr('Are you sure? This cannot be undone. Attachments will be deleted too.'),
                async () => {
                  try {
                    await deleteAllAttachmentsForRecord(effectiveSpaceId, 'bills', bill.id)
                    if (supabase) {
                      const { error } = await deleteBill(supabase, bill.id, effectiveSpaceId)
                      if (error) throw error
                    } else {
                      await deleteLocalBill(effectiveSpaceId, bill.id)
                    }
                    showDetailNotice(tr('Bill removed.'))
                    navigation.goBack()
                  } catch (e: any) {
                    Alert.alert(tr('Delete failed'), e?.message || tr('Unable to delete bill'))
                  }
                },
                tr('Delete')
              )
            }}
          />
        </Surface>
      </View>

      <Modal visible={!!dangerConfirm} transparent animationType="fade" onRequestClose={() => setDangerConfirm(null)}>
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
          <Surface elevated style={{ width: '100%', maxWidth: 520, alignSelf: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: themeSpacing.sm }}>
              <Ionicons name="warning" size={20} color="#DC2626" />
              <Text style={[styles.screenHeaderTitle, { color: '#DC2626' }]}>{dangerConfirm?.title || ''}</Text>
            </View>
            <Text style={[styles.bodyText, { marginTop: themeSpacing.xs, color: '#DC2626' }]}>{dangerConfirm?.message || ''}</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
              <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setDangerConfirm(null)} />
              <AppButton
                label={dangerConfirm?.confirmLabel || tr('Delete')}
                iconName="alert-circle-outline"
                onPress={async () => {
                  const action = dangerConfirm?.onConfirm
                  setDangerConfirm(null)
                  if (action) await action()
                }}
              />
            </View>
          </Surface>
        </View>
      </Modal>
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
  const supabase = useMemo(() => getSupabase(), [])
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const spacesCtx = useSpacesContext()
  const { snapshot: entitlements } = useEntitlements()
  const effectiveSpaceId = spaceId || space?.id || 'default'

  const isIOS = Platform.OS === 'ios'

  const formatResetDate = useCallback((iso: string | null | undefined) => {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      return d.toISOString().slice(0, 10)
    } catch {
      return String(iso)
    }
  }, [])

  const [saving, setSaving] = useState(false)

  const [manual, setManual] = useState('')
  const [rawText, setRawText] = useState('')
  const [parsed, setParsed] = useState<any | null>(null)
  const [format, setFormat] = useState('')
  const [useDataActive, setUseDataActive] = useState(false)

  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrBusyAction, setOcrBusyAction] = useState<null | 'photo' | 'pdf'>(null)
  const [ocrError, setOcrError] = useState<string | null>(null)

  const [debugStatus, setDebugStatus] = useState<'IDLE' | 'RUNNING' | 'DONE' | 'ERROR'>('IDLE')
  const [debugQrFound, setDebugQrFound] = useState<boolean | null>(null)
  const [debugOcrLength, setDebugOcrLength] = useState(0)
  const [debugAiInfo, setDebugAiInfo] = useState<{ called: boolean; model?: string | null; tier?: string | null; enabled?: boolean | null; attempted?: boolean | null; error?: string | null; mode?: string | null } | null>(null)
  const [debugOcrMode, setDebugOcrMode] = useState<string | null>(null)
  const [debugFileInfo, setDebugFileInfo] = useState<{ source: 'original' | 'preview'; size?: number | null } | null>(null)
  const [debugRequestId, setDebugRequestId] = useState<string | null>(null)

  const [supplier, setSupplier] = useState('')
  const [purchaseItem, setPurchaseItem] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [currency, setCurrency] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [showDuePicker, setShowDuePicker] = useState(false)
  const [archiveOnly, setArchiveOnly] = useState(archiveOnlyFromBillDraftSelection(DEFAULT_BILL_DRAFT_SELECTION))
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const saveNoticeTimerRef = useRef<any>(null)

  const showSaveNotice = useCallback((message: string, durationMs = 2200) => {
    if (saveNoticeTimerRef.current) clearTimeout(saveNoticeTimerRef.current)
    setSaveNotice(message)
    saveNoticeTimerRef.current = setTimeout(() => {
      setSaveNotice(null)
      saveNoticeTimerRef.current = null
    }, Math.max(800, durationMs))
  }, [])

  useEffect(() => {
    return () => {
      if (saveNoticeTimerRef.current) clearTimeout(saveNoticeTimerRef.current)
    }
  }, [])

  const [creditorName, setCreditorName] = useState('')
  const [iban, setIban] = useState('')
  const [referenceModel, setReferenceModel] = useState('')
  const [reference, setReference] = useState('')
  const [purpose, setPurpose] = useState('')
  const [paymentDetails, setPaymentDetails] = useState('')
  const [payerName, setPayerName] = useState('')
  const [category, setCategory] = useState('')
  const [missingBasicFields, setMissingBasicFields] = useState({ supplier: false, purchaseItem: false, invoice: false, amount: false, currency: false })

  // Track manual edits so new scans can overwrite stale autofill,
  // while still respecting fields the user actively changed.
  const editedRef = useRef({
    supplier: false,
    purchaseItem: false,
    invoiceNumber: false,
    amount: false,
    currency: false,
    dueDate: false,
    creditorName: false,
    iban: false,
    referenceModel: false,
    reference: false,
    purpose: false,
    paymentDetails: false,
    category: false,
  })

  // Per-field source precedence (lower is stronger):
  // QR → PDF structured text → PDF vision OCR → Image vision OCR → AI
  const fieldSourceRankRef = useRef<Record<string, number>>({})

  const [ibanHint, setIbanHint] = useState<string | null>(null)
  const [referenceHint, setReferenceHint] = useState<string | null>(null)
  const [ibanOptions, setIbanOptions] = useState<string[]>([])
  const [ibanPickerVisible, setIbanPickerVisible] = useState(false)
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, string>>({})
  const [categoryPickerVisible, setCategoryPickerVisible] = useState(false)
  const lastAutoExtractUriRef = useRef<string>('')
  const lastOverdueWarnedRef = useRef<string>('')

  const [lastQR, setLastQR] = useState('')
  const [torch, setTorch] = useState<'on' | 'off'>('off')

  const [permission, requestPermission] = useCameraPermissions()
  const [pendingAttachment, setPendingAttachment] = useState<{ uri: string; name: string; type?: string } | null>(null)
  const [inboxSourceId, setInboxSourceId] = useState<string | null>(null)
  const [cameraVisible, setCameraVisible] = useState(true)
  const [missingManualVisible, setMissingManualVisible] = useState(false)

  useEffect(() => {
    loadCategoryOverrides()
  }, [supabase])

  // Auto-run OCR/AI extraction when the user stages an attachment in the form.
  // This ensures the draft is prefilled without requiring an extra tap.
  useEffect(() => {
    const uri = pendingAttachment?.uri || ''
    if (!uri) {
      lastAutoExtractUriRef.current = ''
      return
    }
    if (lastAutoExtractUriRef.current === uri) return
    lastAutoExtractUriRef.current = uri
    const languageHint = getCurrentLang()
    void extractWithOCR(uri, pendingAttachment?.type || undefined, { preferQr: true, allowAi: true, aiMode: 'document', languageHint })
  }, [pendingAttachment?.type, pendingAttachment?.uri])

  const buildAttachmentNameFromInvoiceNumber = useCallback((inv: string, originalName: string, mime?: string): string => {
    const invoice = String(inv || '').trim()
    if (!invoice) return originalName
    // Avoid renaming when we only have a generated placeholder.
    if (/^DOC-\d{8}-\d{3}$/i.test(invoice) || /^DOC-/i.test(invoice)) return originalName
    const safeBase = invoice
      .toUpperCase()
      .replace(/\s+/g, '-')
      .replace(/[^A-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
    if (!safeBase) return originalName

    const orig = String(originalName || '').trim()
    const extFromName = (() => {
      const m = orig.match(/\.([a-z0-9]{2,6})$/i)
      return m?.[1] ? `.${m[1].toLowerCase()}` : ''
    })()
    const extFromMime = (() => {
      const t = String(mime || '').toLowerCase()
      if (t.includes('pdf')) return '.pdf'
      if (t.includes('png')) return '.png'
      if (t.includes('jpg') || t.includes('jpeg')) return '.jpg'
      if (t.startsWith('image/')) return '.jpg'
      return ''
    })()
    const ext = extFromName || extFromMime
    return `${safeBase}${ext || ''}`
  }, [])

  useEffect(() => {
    if (!pendingAttachment?.uri) return
    const inv = String(invoiceNumber || '').trim()
    if (!inv) return
    const nextName = buildAttachmentNameFromInvoiceNumber(inv, pendingAttachment.name, pendingAttachment.type)
    if (!nextName) return
    if (nextName === pendingAttachment.name) return
    // Only rename once the invoice number is known; do not change the URI.
    setPendingAttachment((prev) => prev ? ({ ...prev, name: nextName }) : prev)
  }, [buildAttachmentNameFromInvoiceNumber, invoiceNumber, pendingAttachment?.name, pendingAttachment?.type, pendingAttachment?.uri])

  function looksLikeMisassignedName(input: any): boolean {
    const s = (input ?? '').toString().trim()
    if (!s) return true
    // Never treat URLs/domains as supplier/payee names.
    if (/(\bhttps?:\/\/|\bwww\.|\.(?:com|si|net)\b)/i.test(s)) return true
    if (/\b(rok|zapad|zapadl|valuta|datum|due|pay\s*by|payment\s*due)\b/i.test(s)) return true
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(s)) return true
    if (/\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\b/.test(s)) return true
    if (/\bEUR\b/i.test(s) || /€/.test(s)) return true
    const compact = s.replace(/\s+/g, '')
    if (/[A-Z]{2}\d{2}[A-Z0-9]{11,34}/.test(compact)) return true
    if (/SI\d{2}/i.test(compact)) return true
    if (/^[Rr]\d{6,}/.test(compact)) return true
    const digits = (s.match(/\d/g) || []).length
    const letters = (s.match(/[A-Za-zÀ-žČŠŽčšž]/g) || []).length
    if (letters === 0) return true
    if (digits >= 8 && digits > letters) return true
    if (s.length > 70) return true
    return false
  }

  const warnIfOverdueDueDate = useCallback((isoDate: string) => {
    const iso = String(isoDate || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return
    const today = new Date().toISOString().slice(0, 10)
    if (iso >= today) return
    if (lastOverdueWarnedRef.current === iso) return
    lastOverdueWarnedRef.current = iso
    Alert.alert(
      tr('Due date is in the past'),
      tr('This bill is overdue. Do you want to update the due date?'),
      [
        { text: tr('Change date'), onPress: () => setShowDuePicker(true) },
        { text: tr('Keep date'), style: 'cancel' },
      ],
    )
  }, [tr])

  function pickNameCandidate(...candidates: any[]): string {
    for (const c of candidates) {
      const s = (c ?? '').toString().trim()
      if (!s) continue
      if (!/[A-Za-zÀ-žČŠŽčšž]/.test(s)) continue
      if (/^[0-9\s.,:\-\/]+$/.test(s)) continue
      // Never accept URL-like strings as supplier/recipient.
      if (/(\bhttps?:\/\/|\bwww\.|\.(?:com|si|net)\b)/i.test(s)) continue
      // Never pick payer/customer names as supplier/payee.
      if (/\b(pla\u010dnik|placnik|payer|kupec|buyer|customer)\b/i.test(s)) continue
      // Avoid accidentally picking a consumer/person name as supplier.
      // (Common failure mode: OCR/AI returns the payer name from the invoice header.)
      const looksLikePersonName = (() => {
        const t = s.replace(/\s+/g, ' ').trim()
        if (!t) return false
        if (/[0-9]/.test(t)) return false
        if (/\b(d\.o\.o\.|d\.d\.|s\.p\.|gmbh|ag|oy|ab|sas|sarl|s\.r\.l\.|llc|ltd|inc)\b/i.test(t)) return false
        const parts = t.split(' ').filter(Boolean)
        if (parts.length < 2 || parts.length > 3) return false
        const cap = (w: string) => /^[A-ZČŠŽ][a-zà-žčšž]+$/.test(w)
        return parts.every(cap) && t.length <= 32
      })()
      if (looksLikePersonName) continue
      if (looksLikeMisassignedName(s)) continue
      return s
    }
    return ''
  }

  function normalizeCompanyName(input: string): string {
    const raw = String(input || '').replace(/\s+/g, ' ').trim()
    if (!raw) return ''
    const prefixRe = /^(?:uporabnik|obrazec|ra\u010dun|racun|dobavitelj|supplier|vendor|seller|issuer|prejemnik|recipient|payee|beneficiary|creditor|customer|payer)\s*[:\-]?\s*/i
    const labelOnlyRe = /^(?:uporabnik|obrazec|ra\u010dun|racun|dobavitelj|supplier|vendor|seller|issuer|prejemnik|recipient|payee|beneficiary|creditor|customer|payer)\b/i
    const splitRe = /[|•·]/
    const legalSuffixRe = /\b(d\.o\.o\.|d\.d\.|s\.p\.|gmbh|ag|s\.r\.l\.|srl|sas|sa|bv|oy|ab|kg|ltd|llc|inc|plc)\b/i
    const addressRe = /\b(ulica|cesta|street|st\.?|road|rd\.?|avenue|ave\.?|strasse|stra\u00dfe|via|trg|naselje|posta|po\u0161t\S*|zip)\b/i

    const parts = raw
      .split(splitRe)
      .map((p) => p.replace(prefixRe, '').replace(/^[\s:,-]+|[\s:,-]+$/g, '').trim())
      .filter(Boolean)

    const cleaned = parts
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => !/(\bhttps?:\/\/|\bwww\.|\.(?:com|si|net)\b|@)/i.test(p))
      .filter((p) => !labelOnlyRe.test(p))
      .filter((p) => !addressRe.test(p) || !/\d/.test(p))
      .filter((p) => /[A-Za-zÀ-žČŠŽčšž]/.test(p))

    if (!cleaned.length) return raw
    const withSuffix = cleaned.filter((p) => legalSuffixRe.test(p))
    const pickFrom = withSuffix.length ? withSuffix : cleaned
    pickFrom.sort((a, b) => a.length - b.length)
    return pickFrom[0]
  }

  async function extractTextWithAI(text: string) {
    const base = getFunctionsBase()
    if (!base) throw new Error('OCR unavailable: missing EXPO_PUBLIC_FUNCTIONS_BASE')
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
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...authHeader },
      body: String(text || ''),
    })
    const data = await resp.json().catch(() => null as any)
    if (!resp.ok || !data?.ok) throw new Error(data?.error || `Extract failed (${resp.status})`)
    return { fields: data.fields || {}, rawText: typeof data.rawText === 'string' ? data.rawText : '' }
  }

  function normalizeIban(input: string): string {
    // Keep only A-Z0-9; IBAN max length is 34.
    return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  }

  function looksLikeIban(input: string): boolean {
    return /^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(normalizeIban(input))
  }

  function extractFirstValidIban(text: string): string | null {
    const raw = String(text || '')
    const lines = raw.replace(/\r/g, '').split(/\n+/)

    const findIn = (s: string): string | null => {
      const matches = String(s || '').match(/\b[A-Z]{2}\d{2}(?:\s*[A-Z0-9]){11,34}\b/g) || []
      for (const m of matches) {
        const cand = normalizeIban(m)
        if (isValidIbanChecksum(cand)) return cand
      }
      return null
    }

    // Prefer explicit IBAN-labeled lines.
    for (const l of lines) {
      if (!/\biban\b/i.test(l)) continue
      const v = findIn(l)
      if (v) return v
    }
    // Avoid extracting IBANs from reference/model lines (these can look IBAN-ish in SI).
    for (const l of lines) {
      if (/\b(sklic|reference|ref\.?|model)\b/i.test(l)) continue
      const v = findIn(l)
      if (v) return v
    }
    return findIn(raw)
  }

  function normalizeReference(input: string): string {
    // Bank-safe: uppercase, no whitespace, allow common separators from QR payloads.
    return String(input || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9\-\/]/g, '')
  }

  function splitReferenceModel(raw: string): { model: string | null; number: string | null } {
    const compact = normalizeReference(raw)
    const m = compact.match(/^(SI|RF)(\d{2})([0-9A-Z\-\/]{4,})$/i)
    if (!m) return { model: null, number: null }
    return { model: `${m[1].toUpperCase()} ${m[2]}`, number: String(m[3] || '') }
  }

  function normalizeReferenceNumber(input: string): string {
    return String(input || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9\-\/]/g, '')
  }

  function buildReferenceFromModel(model: string, number: string): string {
    const m = String(model || '').replace(/\s+/g, '').toUpperCase()
    const n = normalizeReferenceNumber(number)
    if (!m || !n) return ''
    return `${m}${n}`
  }

  const CATEGORY_RULES = [
    { key: 'utilities', pattern: /(elektri\S*|power|electricity|plin|gas|voda\b|water|komunal\S*|waste|ogrevanj\S*|heating)/i },
    { key: 'telecom', pattern: /(telekom|telefon|mobile|mobitel|internet|broadband|fiber|fibre|tv|cable)/i },
    { key: 'grocery', pattern: /(\u017eivil|trgovin|market|supermarket|grocer|grocery|lidl|spar|hofer|aldi|mercator|muller|dm|shop)/i },
    { key: 'clothing', pattern: /(obla\u010dil|oblek|obutev|butik|fashion|apparel|clothing|shoes|footwear|boutique)/i },
    { key: 'fuel', pattern: /(gorivo|petrol|diesel|bencin|bencin|fuel|pumpa|gas\s*station|shell|omv|ina)/i },
    { key: 'subscription', pattern: /(naro\u010dnin|subscription|membership|plan|monthly|mese\u010dno)/i },
    { key: 'service', pattern: /(storitev|service|vzdr\u017eevanje|maintenance|servis|repair|popravilo)/i },
    { key: 'white_goods', pattern: /(bela\s*tehnika|elektrodom|gospodinjsk\S*\s*aparat|praln\S*\s*stroj|pomivaln\S*\s*stroj|hladilnik|zamrzovalnik|pe\u010dica|\u0161tedilnik|bojler|mikrovalovn\S*|su\u0161iln\S*\s*stroj|washing\s*machine|dishwasher|fridge|freezer|oven|stove)/i },
    { key: 'machines_equipment', pattern: /(stroj\S*|naprav\S*|machine\b|equipment\b|tool\b|kompresor|generator|motor\b|pump\b|\u010drpalka|bagger|excavat\S*)/i },
  ]

  const CATEGORY_OPTIONS = [
    { key: 'utilities', labelKey: 'Category: utilities' },
    { key: 'telecom', labelKey: 'Category: telecom' },
    { key: 'grocery', labelKey: 'Category: grocery' },
    { key: 'clothing', labelKey: 'Category: clothing' },
    { key: 'fuel', labelKey: 'Category: fuel' },
    { key: 'subscription', labelKey: 'Category: subscription' },
    { key: 'service', labelKey: 'Category: service' },
    { key: 'white_goods', labelKey: 'Category: white goods' },
    { key: 'machines_equipment', labelKey: 'Category: machines/equipment' },
    { key: 'other', labelKey: 'Category: other' },
  ]

  // Legacy categories: keep for label rendering, but do not show in the picker.
  const CATEGORY_LABEL_ONLY = [
    { key: 'warranty_product', labelKey: 'Category: warranty product' },
  ]

  const CATEGORY_OPTIONS_PICKER = CATEGORY_OPTIONS

  const CATEGORY_OPTIONS_ALL = [...CATEGORY_OPTIONS, ...CATEGORY_LABEL_ONLY]

  const getCategoryLabel = (key: string): string => {
    const found = CATEGORY_OPTIONS_ALL.find((c) => c.key === key)
    return found ? tr(found.labelKey) : key
  }

  const normalizeSupplierKey = (input: string): string =>
    String(input || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s]/g, '').trim()

  const detectCategoryFromText = (supplierName: string, purposeText: string, itemText: string): string | null => {
    const hay = `${supplierName} ${purposeText} ${itemText}`
    for (const rule of CATEGORY_RULES) {
      if (rule.pattern.test(hay)) return rule.key
    }
    return null
  }

  const loadCategoryOverrides = async (): Promise<void> => {
    try {
      const key = await getCategoryOverridesStorageKey(supabase)
      if (!key) return
      const raw = await AsyncStorage.getItem(key)
      const parsed = raw ? JSON.parse(raw) : {}
      const base = parsed && typeof parsed === 'object' ? parsed : {}

      if (supabase) {
        try {
          const userId = await getCurrentUserId(supabase)
          if (userId) {
            const { data } = await supabase
              .from('bill_category_overrides')
              .select('supplier_key, category')
              .eq('user_id', userId)
            if (Array.isArray(data)) {
              for (const row of data) {
                if (row?.supplier_key && row?.category) base[String(row.supplier_key)] = String(row.category)
              }
            }
          }
        } catch {}
      }

      setCategoryOverrides(base)
      await saveCategoryOverrides(base)
    } catch {}
  }

  const saveCategoryOverrides = async (next: Record<string, string>): Promise<void> => {
    try {
      const key = await getCategoryOverridesStorageKey(supabase)
      if (!key) return
      await AsyncStorage.setItem(key, JSON.stringify(next))
    } catch {}
  }

  const persistCategoryOverride = async (supplierKey: string, nextCategory: string): Promise<void> => {
    if (!supplierKey || !nextCategory) return
    const next = { ...categoryOverrides, [supplierKey]: nextCategory }
    setCategoryOverrides(next)
    await saveCategoryOverrides(next)

    if (supabase) {
      try {
        const userId = await getCurrentUserId(supabase)
        if (userId) {
          await supabase
            .from('bill_category_overrides')
            .upsert({ user_id: userId, supplier_key: supplierKey, category: nextCategory, updated_at: new Date().toISOString() })
        }
      } catch {}
    }
  }

  function extractReferenceCandidate(text: string): string | null {
    const raw = String(text || '')
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    // IMPORTANT: Do NOT treat every "SI\d\d..." token as IBAN-like.
    // Slovenian references also start with SI\d\d, so only overlap against IBANs that are
    // checksum-valid or appear on an IBAN-labeled line.
    const ibanLike: string[] = []
    const valid = extractFirstValidIban(raw)
    if (valid) ibanLike.push(normalizeIban(valid))
    for (const l of lines) {
      if (!/\biban\b/i.test(l)) continue
      const matches = String(l || '').match(/\b[A-Z]{2}\d{2}(?:\s*[A-Z0-9]){8,34}\b/g) || []
      for (const m of matches) {
        const cand = normalizeIban(m)
        if (cand) ibanLike.push(cand)
      }
    }
    const ibanLikeUniq = [...new Set(ibanLike.filter(Boolean))]
    const isOverlappingIbanLike = (cand: string): boolean => {
      const c = normalizeReference(cand)
      if (!c) return false
      if (!/^(SI|RF)\d{2}/i.test(c)) return false
      for (const ib of ibanLikeUniq) {
        if (!ib) continue
        if (ib.includes(c) || ib.startsWith(c) || c.startsWith(ib)) return true
      }
      return false
    }
    for (const l of lines) {
      const labeled = l.match(/\b(sklic|referenca|reference|ref\.?|model)\b\s*:?\s*(.+)$/i)
      if (!labeled) continue
      const cand = normalizeReference(labeled[2])
      if (cand.length >= 4 && !isOverlappingIbanLike(cand)) return cand
    }
    const si = raw.match(/\bSI\s*\d{2}\s*\d{3,}\b/gi)
    if (si?.[0]) {
      const cand = normalizeReference(si[0])
      // Fallback must be strict: reject short SI prefixes commonly coming from IBAN fragments.
      if (cand.length >= 10 && !isOverlappingIbanLike(cand)) return cand
    }
    const rf = raw.match(/\bRF\s*\d{2}\s*[A-Z0-9]{4,}\b/gi)
    if (rf?.[0]) {
      const cand = normalizeReference(rf[0])
      if (!isOverlappingIbanLike(cand)) return cand
    }
    return null
  }

  function extractAmountFromText(rawText: string): { amount: number; currency: string } | null {
    const text = String(rawText || '').replace(/\r/g, '')
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return null

    const detectCurrencyFromLine = (line: string): string => {
      const l = String(line || '')
      if (/€/.test(l)) return 'EUR'
      if (/\$/.test(l)) return 'USD'
      if (/£/.test(l)) return 'GBP'
      const code = l.match(/\b(EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|HUF|CZK|RON|HRK|BAM|MKD|RSD|TRY)\b/i)
      return code ? code[1].toUpperCase() : ''
    }

    const payableLabels = /(total\s*due|amount\s*due|balance\s*due|grand\s*total|za\s*pla\S*|za\s*pla\u010dat\S*|za\s*pla\u010dilo|za\s*pla\u010dati|payable|to\s*pay|pay\s*now|za\s*pla\u010dilo\s*z\s*ddv|za\s*pla\u010dilo\s*z\s*ddv)/i
    const ignoreContext = /(\bddv\b|\bvat\b|\btax\b|\bdavek\b|osnova|base\s*amount|\bsubtotal\b|sub\s*total|popust|discount|provizi\S*|fee\b|shipping|po\u0161tnina|delivery|surcharge)/i

    const parseMoney = (s: string): number | null => {
      const raw = String(s || '').trim()
      const cleaned = raw.replace(/[^0-9.,\-\s]/g, '').trim()
      if (!/[0-9]/.test(cleaned)) return null
      const compact = cleaned.replace(/\s+/g, '')
      const lastComma = compact.lastIndexOf(',')
      const lastDot = compact.lastIndexOf('.')
      let decimalSep: ',' | '.' | null = null
      if (lastComma >= 0 && lastDot >= 0) decimalSep = lastComma > lastDot ? ',' : '.'
      else if (lastComma >= 0) decimalSep = ','
      else if (lastDot >= 0) decimalSep = '.'

      let normalized = compact
      if (decimalSep === ',') normalized = compact.replace(/\./g, '').replace(',', '.')
      else if (decimalSep === '.') normalized = compact.replace(/,/g, '')
      normalized = normalized.replace(/(?!^)-/g, '')
      const num = Number(normalized)
      return Number.isFinite(num) ? num : null
    }

    const tryLine = (line: string): { amount: number; currency: string } | null => {
      const l = String(line || '')
      const eurCode = l.match(/\bEUR\b\s*([0-9][0-9.,\s-]{0,24})/i)
      if (eurCode) {
        const val = parseMoney(eurCode[1])
        if (val != null && val > 0) return { amount: val, currency: 'EUR' }
      }
      if (/€/.test(l)) {
        const m1 = l.match(/([0-9][0-9.,\s-]{0,24})\s*€/)
        const m2 = l.match(/€\s*([0-9][0-9.,\s-]{0,24})/)
        const picked = m1?.[1] || m2?.[1]
        const val = picked ? parseMoney(picked) : null
        if (val != null && val > 0) return { amount: val, currency: 'EUR' }
      }
      const code = l.match(/\b(USD|GBP|CHF|SEK|NOK|DKK|PLN|HUF|CZK|RON|HRK|BAM|MKD|RSD|TRY)\b\s*([0-9][0-9.,\s-]{0,24})/i)
      if (code) {
        const val = parseMoney(code[2])
        if (val != null && val > 0) return { amount: val, currency: code[1].toUpperCase() }
      }
      const sym = l.match(/([0-9][0-9.,\s-]{0,24})\s*(\$|£)/)
      if (sym) {
        const val = parseMoney(sym[1])
        if (val != null && val > 0) return { amount: val, currency: sym[2] === '$' ? 'USD' : 'GBP' }
      }
      return null
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const hasPayable = payableLabels.test(line)
      const hasIgnore = ignoreContext.test(line)
      if (!hasPayable) continue
      // Ignore VAT/subtotal-only lines unless they are payable (they are).
      const direct = tryLine(line)
      if (direct) return direct
      const next = lines[i + 1]
      const prev = lines[i - 1]
      const fromNext = next ? tryLine(next) : null
      if (fromNext) return fromNext
      const fromPrev = prev ? tryLine(prev) : null
      if (fromPrev && !hasIgnore) return fromPrev
    }

    // Fallback: any currency amount (very conservative: pick the largest under a reasonable cap)
    let best: { amount: number; currency: string } | null = null
    for (const l of lines) {
      const cand = tryLine(l)
      if (!cand) continue
      if (cand.amount <= 0 || cand.amount > 1000000) continue
      if (!best || cand.amount > best.amount) best = cand
    }
    if (best && best.currency) return best

    // Final fallback: detect currency on the same line as the largest amount.
    let bestRaw: { amount: number; currency: string } | null = null
    for (const l of lines) {
      const val = (() => {
        const m = l.match(/\b([0-9]+(?:[\.,][0-9]{1,2})?)\b/)
        if (!m) return null
        return parseMoney(m[1])
      })()
      if (val == null || val <= 0 || val > 1000000) continue
      const cur = detectCurrencyFromLine(l)
      if (!bestRaw || val > bestRaw.amount) bestRaw = { amount: val, currency: cur || '' }
    }
    return bestRaw
  }

  function hasTrOrAccountLabel(t: string): boolean {
    const s = String(t || '')
    // Slovenian invoices often use TR/TRR for "transakcijski račun" (bank account).
    // Only treat it as a label when it looks like a label (e.g. "TR:"), not a country code in an IBAN.
    return /(\btrr\b|\btr\s*[:\-]|transakcij\S*\s*ra\u010dun|transakcij\S*\s*racun|\bbic\b|\bswift\b|\bbanka\b|\bbank\b)/i.test(s)
  }

  function extractIbanCandidates(text: string, rawIban?: string): string[] {
    const raw = String(text || '')
    const all = new Set<string>()
    const add = (s: string) => { if (s) all.add(s) }

    const computeIbanChecksumDigits = (countryCode: string, bban: string): string | null => {
      const cc = String(countryCode || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2)
      const b = String(bban || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (!/^[A-Z]{2}$/.test(cc)) return null
      if (!b) return null

      // IBAN checksum calculation: place country+"00" at end, convert letters to numbers, mod 97.
      const rearranged = `${b}${cc}00`
      let remainder = 0
      for (let i = 0; i < rearranged.length; i++) {
        const ch = rearranged[i]
        const code = ch.charCodeAt(0)
        if (code >= 48 && code <= 57) {
          remainder = (remainder * 10 + (code - 48)) % 97
        } else {
          const val = code - 55
          remainder = (remainder * 100 + val) % 97
        }
      }
      const checksum = 98 - remainder
      if (!Number.isFinite(checksum) || checksum <= 0 || checksum >= 100) return null
      return String(checksum).padStart(2, '0')
    }

    const tryBuildIbanFromMissingChecksum = (candidate: string): string | null => {
      const norm = normalizeIban(candidate)
      if (!norm) return null
      const cc = norm.slice(0, 2)
      const expected = IBAN_LENGTHS[cc]
      if (!expected) return null
      // If the document omits the 2 checksum digits, we may get CC + BBAN (expected - 2 chars).
      if (norm.length !== expected - 2) return null
      const bban = norm.slice(2)
      if (!/^[A-Z0-9]+$/.test(bban)) return null
      const chk = computeIbanChecksumDigits(cc, bban)
      if (!chk) return null
      const built = `${cc}${chk}${bban}`
      return isValidIbanChecksum(built) ? built : null
    }

    const tryBuildSloveniaIbanFromBbanDigits = (digits: string): string | null => {
      const bbanDigits = String(digits || '').replace(/\D/g, '')
      // Slovenia BBAN is 15 digits; IBAN is SI + 2 checksum + 15 digits (= 19 chars).
      if (bbanDigits.length !== 15) return null
      const chk = computeIbanChecksumDigits('SI', bbanDigits)
      if (!chk) return null
      const built = `SI${chk}${bbanDigits}`
      return isValidIbanChecksum(built) ? built : null
    }

    const extractAccountLikeCandidates = (): string[] => {
      const out: string[] = []
      const lines = raw
        .replace(/\r/g, '')
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean)

      const labelRe = /(\biban\b|\btrr\b|\btr\b|bank\s*account|account\s*(?:no\.?|number)?|\bra\u010dun\b|\bracun\b)/i
      const bankContextRe = /(\bbic\b|\bswift\b|\bsepa\b|\bbank\b|\bbanka\b|\btrr\b|\btr\b|transakcij\S*\s*ra\u010dun|transakcij\S*\s*racun|\bnlb\b|\bskb\b|\bintesa\b|\bunicredit\b|\bsparkasse\b|\botp\b|\babanka\b|\bdelavska\b)/i
      const grabFromLine = (l: string) => {
        // Allow spaces and separators; we later normalize.
        const m = String(l || '').match(/([A-Z]{2}\s*[0-9A-Z\s\-]{9,40}|\d[\d\s\-]{12,30})/i)
        if (m?.[1]) out.push(String(m[1]))
      }

      const grabSiBbanFromContext = (l: string) => {
        const line = String(l || '')
        if (!bankContextRe.test(line)) return
        const chunks = line.match(/\b\d[\d\s\-]{13,22}\b/g) || []
        for (const c of chunks) {
          const digitsOnly = String(c || '').replace(/\D/g, '')
          if (digitsOnly.length === 15) out.push(digitsOnly)
        }
      }

      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        // Some invoices show only TRR/BBAN digits plus BIC/SWIFT/bank line without the word "IBAN".
        // Capture 15-digit SI account candidates only when bank context is present.
        grabSiBbanFromContext(l)
        if (!labelRe.test(l)) continue
        grabFromLine(l)
        const next = lines[i + 1]
        if (next) {
          grabFromLine(next)
          grabSiBbanFromContext(next)
        }
      }
      return out
    }

    const matches = raw.match(/\b[A-Z]{2}\d{2}(?:\s*[A-Z0-9]){11,34}\b/g) || []
    for (const m of matches) {
      const cand = normalizeIban(m)
      if (!cand) continue
      if (isValidIbanChecksum(cand)) add(cand)
      else {
        const repaired = tryRepairIbanChecksum(cand)
        if (repaired) add(repaired)
      }
    }

    // Some invoices provide pay-to account without checksum digits or without the SI prefix.
    // Try to rebuild a valid IBAN from labeled account/TRR lines.
    for (const acct of extractAccountLikeCandidates()) {
      const builtMissingChecksum = tryBuildIbanFromMissingChecksum(acct)
      if (builtMissingChecksum) add(builtMissingChecksum)

      const norm = normalizeIban(acct)
      if (norm && norm.startsWith('SI') && /^SI\d{15}$/.test(norm)) {
        const built = tryBuildSloveniaIbanFromBbanDigits(norm.slice(2))
        if (built) add(built)
      }

      const digitsOnly = String(acct || '').replace(/\D/g, '')
      const builtSi = tryBuildSloveniaIbanFromBbanDigits(digitsOnly)
      if (builtSi) add(builtSi)
    }

    if (rawIban) {
      const cand = normalizeIban(rawIban)
      if (cand && isValidIbanChecksum(cand)) add(cand)
      else {
        const repaired = tryRepairIbanChecksum(rawIban)
        if (repaired) add(repaired)
        const built = tryBuildIbanFromMissingChecksum(rawIban)
        if (built) add(built)
      }
    }
    return Array.from(all)
  }

  function tryRepairIbanChecksum(input: string): string | null {
    const iban = normalizeIban(input)
    if (!iban) return null
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(iban)) return null
    if (isValidIbanChecksum(iban)) return iban

    // Common OCR confusions.
    const repaired = iban
      .slice(0, 2) +
      iban
        .slice(2)
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1')
        .replace(/S/g, '5')
        .replace(/B/g, '8')
        .replace(/Z/g, '2')

    if (repaired !== iban && isValidIbanChecksum(repaired)) return repaired
    return null
  }

  function detectCurrencyFromText(rawText: string, ibanCandidate?: string): string {
    const text = String(rawText || '')
    if (/€/.test(text) || /\bEUR\b/i.test(text)) return 'EUR'
    if (/\$/.test(text) || /\bUSD\b/i.test(text)) return 'USD'
    if (/£/.test(text) || /\bGBP\b/i.test(text)) return 'GBP'
    const code = text.match(/\b(EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|HUF|CZK|RON|HRK|BAM|MKD|RSD|TRY)\b/i)
    if (code) return code[1].toUpperCase()
    const iban = normalizeIban(ibanCandidate || '')
    const cc = iban ? iban.slice(0, 2) : ''
    if (cc === 'SI' || cc === 'DE' || cc === 'AT' || cc === 'IT' || cc === 'FR' || cc === 'ES' || cc === 'PT' || cc === 'NL' || cc === 'BE' || cc === 'IE' || cc === 'SK' || cc === 'FI' || cc === 'EE' || cc === 'LV' || cc === 'LT' || cc === 'LU' || cc === 'MT' || cc === 'CY' || cc === 'GR') return 'EUR'
    if (cc === 'GB') return 'GBP'
    if (cc === 'US') return 'USD'
    return ''
  }

  function applyDataToForm(source: 'QR' | 'OCR' | 'GOOGLE', fields: any, rawText?: string) {
    const src = source === 'QR' ? 'qr' : (source === 'GOOGLE' ? 'google' : 'ocr')
    applyExtractedPaymentFields({ ...fields, rawText: rawText || fields?.rawText || '', _source: src }, src)
  }

  function inferArchiveOnlyFromText(rawText: string, fields: any): boolean {
    const text = String(rawText || '').toLowerCase()
    const hasDue = Boolean(fields?.due_date)
    const hasIban = Boolean(fields?.iban)
    const hasRef = Boolean(fields?.reference)
    // If there's a due date, treat as unpaid (to pay).
    if (hasDue) return false

    // If the document indicates it is already paid/settled, treat as archive-only.
    // Include common phrases across SL/HR/IT/DE + English.
    const paidRe = /(plačan|plačano|poravnano|zaprto|\bplačilo\b|\bplačana\b|plaćeno|uplaćeno|podmireno|\bplaćanje\b|pagato|pagata|pagati|saldato|saldati|ricevuta|scontrino|\bpagamento\b|bezahlt|beglichen|quittung|barzahlung|\bzahlung\s*erhalten\b|paid|payment\s*received|settled|\breceipt\b|fiscal)/i
    if (paidRe.test(text)) return true

    // IBAN+reference strongly suggests it's a bill to pay (unless marked paid above).
    if (hasIban && hasRef) return false

    return false
  }

  function isPayerLabelLine(line: string): boolean {
    return /\b(pla\u010dnik|placnik|payer|kupec|buyer|customer)\b\s*:?/i.test(String(line || ''))
  }

  function extractLabeledValueFromText(rawText: string, labels: RegExp[]): string | null {
    const lines = String(rawText || '')
      .replace(/\r/g, '')
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      for (const re of labels) {
        const m = l.match(re)
        if (!m) continue
        const direct = String(m[1] || '').trim()
        if (direct) return direct
        const next = String(lines[i + 1] || '').trim()
        if (next) return next
      }
    }
    return null
  }

  function extractCreditorNameFromText(rawText: string): string | null {
    const cand = extractLabeledValueFromText(rawText, [
    /^(?:prejemnik|recipient|payee|beneficiary|creditor|upravi\S*)\s*:?\s*(.+)$/i,
    /^(?:to)\s*:?\s*(.+)$/i,
    ])
    if (!cand) return null
    if (isPayerLabelLine(cand)) return null
    const cleaned = cand.replace(/\s+/g, ' ').trim()
    if (!cleaned) return null
    if (/(\bhttps?:\/\/|\bwww\.|\.(?:com|si|net)\b)/i.test(cleaned)) return null
    if (looksLikeMisassignedName(cleaned)) return null
    return cleaned
  }

  function extractSupplierNameFromText(rawText: string): string | null {
    const cand = extractLabeledValueFromText(rawText, [
      /^(?:dobavitelj|supplier|vendor|seller|issuer|bill\s*from|izdajatelj(?:\s+ra\u010duna)?|prodajalec|izdal)\s*:?\s*(.+)$/i,
    ])
    if (!cand) return null
    if (isPayerLabelLine(cand)) return null
    const cleaned = cand.replace(/\s+/g, ' ').trim()
    if (!cleaned) return null
    if (/(\bhttps?:\/\/|\bwww\.|\.(?:com|si|net)\b)/i.test(cleaned)) return null
    if (looksLikeMisassignedName(cleaned)) return null
    return cleaned
  }

  function pickBestNameFromWholeText(rawText: string): string | null {
    const text = String(rawText || '').replace(/\r/g, '')
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return null

    const isSupplierLabelLine = (l: string) => /\b(dobavitelj|supplier|vendor|seller|issuer|bill\s*from|izdajatelj(?:\s+ra\u010duna)?|prodajalec|izdal)\b/i.test(l)
    const isPayeeLabelLine = (l: string) => /\b(prejemnik|recipient|payee|beneficiary|creditor|upravi\S*|to)\b/i.test(l)

    const scoreLine = (line: string, idx: number): number => {
      const s = String(line || '').trim()
      if (!s) return -999
      if (/(\bhttps?:\/\/|\bwww\.|\.(?:com|si|net)\b)/i.test(s)) return -999
      if (!/[A-Za-zÀ-žČŠŽčšž]/.test(s)) return -999
      if (/^[0-9\s.,:\-\/]+$/.test(s)) return -999
      if (isPayerLabelLine(s)) return -999
      if (looksLikeMisassignedName(s)) return -999
      // Avoid reference/iban/purpose labels.
      if (/\b(iban|sklic|reference|model|namen|purpose|znesek|rok\s*pla\S*|zapad)\b/i.test(s)) return -5

      let score = 0
      // Anywhere in doc is allowed; slight preference for earlier lines.
      score += Math.max(0, 6 - Math.floor(idx / 12))

      if (isSupplierLabelLine(s) || isPayeeLabelLine(s)) score -= 2 // label lines themselves aren't names

      if (/\b(d\.o\.o\.|d\.d\.|s\.p\.|gmbh|ag|oy|ab|sas|sarl|s\.r\.l\.|llc|ltd|inc)\b/i.test(s)) score += 5
      if (/\bGEN\s*-?\s*I\b/i.test(s)) score += 20
      const letters = (s.match(/[A-Za-zÀ-žČŠŽčšž]/g) || []).length
      const digits = (s.match(/\d/g) || []).length
      if (letters >= 8 && digits <= 2) score += 3
      if (s.length >= 4 && s.length <= 50) score += 2
      return score
    }

    const candidates: Array<{ v: string; score: number }> = []

    // 1) Direct labeled values (same line after label)
    const labeledSupplier = extractSupplierNameFromText(text)
    if (labeledSupplier) candidates.push({ v: labeledSupplier, score: 100 })
    const labeledPayee = extractCreditorNameFromText(text)
    if (labeledPayee) candidates.push({ v: labeledPayee, score: 95 })

    // 2) Next-line after a label
    for (let i = 0; i < lines.length - 1; i++) {
      const l = lines[i]
      if (!isSupplierLabelLine(l) && !isPayeeLabelLine(l)) continue
      const next = lines[i + 1]
      const s = pickNameCandidate(next)
      if (s) candidates.push({ v: s, score: 85 })
    }

    // 3) Whole-document heuristic
    let best: { v: string; score: number } | null = null
    for (let i = 0; i < lines.length; i++) {
      const sc = scoreLine(lines[i], i)
      if (sc <= 0) continue
      const v = lines[i].replace(/\s+/g, ' ').trim()
      if (!v) continue
      if (!best || sc > best.score) best = { v, score: sc }
    }
    if (best) candidates.push(best)

    candidates.sort((a, b) => b.score - a.score)
    const picked = candidates[0]?.v
    return picked ? picked : null
  }

  function extractIssuerFromHeaderBlock(rawText: string): string |null {
    const text = String(rawText || '').replace(/\r/g, '')
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return null

    const headerCount = Math.max(1, Math.min(40, Math.ceil(lines.length * 0.25)))
    const header = lines.slice(0, headerCount)

    const taxOrContact = /\b(ddv|vat|tax|id\s*no|mati\u010dna|maticna|reg\.?\s*no|registration|tel\.?|phone|fax)\b/i
    const labelStrip = /^(?:dobavitelj|supplier|vendor|seller|issuer|prejemnik|recipient|payee|beneficiary|creditor)\s*:?(?:\s+)?(.+)$/i

    const isUrlOrEmailLike = (s: string) => /(\bhttps?:\/\/|\bwww\.|\.(?:com|si|net)\b|@)/i.test(String(s || ''))
    const hasLegalSuffix = (s: string) => /\b(d\.o\.o\.|d\.d\.|s\.p\.|gmbh|ag|srl|s\.p\.a\.|ltd|llc|inc|bv|oy|ab|kg|sas|sa|nv|plc)\b/i.test(String(s || ''))
    const isCustomerLabel = (s: string) => /\b(kupec|odjemalec|pla\u010dnik|placnik|payer|customer|buyer|bill\s*to|sold\s*to|recipient)\b/i.test(String(s || ''))
    const isAddressOnly = (s: string) => {
      const t = String(s || '').replace(/\s+/g, ' ').trim()
      if (!t) return true
      if (!/[A-Za-zÀ-žČŠŽčšž]/.test(t)) return true
      if (/\b(ulica|cesta|street|st\.?|road|rd\.?|avenue|ave\.?|strasse|stra\u00dfe|via|trg|naselje|posta|po\u0161t\S*|zip)\b/i.test(t) && /\d{1,4}\b/.test(t)) return true
      if (/\b\d{4,6}\b/.test(t) && !hasLegalSuffix(t) && t.length <= 40) return true
      return false
    }

    let best: { v: string; score: number } | null = null
    for (let i = 0; i < header.length; i++) {
      const raw = String(header[i] || '').replace(/\s+/g, ' ').trim()
      const stripped = raw.match(labelStrip)
      const v = String(stripped?.[1] || raw).replace(/\s+/g, ' ').trim()
      if (!v) continue
      if (isUrlOrEmailLike(v)) continue
      if (!/[A-Za-zÀ-žČŠŽčšž]/.test(v)) continue
      if (looksLikeMisassignedName(v)) continue
      if (isCustomerLabel(raw) || isCustomerLabel(v)) continue
      if (isAddressOnly(v)) continue
      if (/\b(iban|trr|sklic|referenca|reference|model|namen|purpose|znesek|rok\s*pla\S*|zapad|due\s*date)\b/i.test(raw)) continue

      let score = 0
      score += Math.max(0, 6 - Math.floor(i / 5))
      if (hasLegalSuffix(v)) score += 10
      const digits = (v.match(/\d/g) || []).length
      const letters = (v.match(/[A-Za-zÀ-žČŠŽčšž]/g) || []).length
      if (letters >= 8 && digits <= 2) score += 3
      if (v.length >= 4 && v.length <= 60) score += 2
      const window = [header[i - 2], header[i - 1], header[i], header[i + 1], header[i + 2]].filter(Boolean).join(' ')
      if (taxOrContact.test(window)) score += 4
      if (/\bGEN\s*-?\s*I\b/i.test(v)) score += 8

      if (!best || score > best.score) best = { v, score }
    }
    return best && best.score >= 6 ? best.v : null
  }

  function extractPayerNameFromText(rawText: string, issuer?: string): string | null {
    const lines = String(rawText || '').replace(/\r/g, '').split(/\n+/).map((l) => l.trim())
    const issuerNorm = String(issuer || '').replace(/\s+/g, ' ').trim().toUpperCase()
    const startRe = /^(?:kupec|odjemalec|pla\u010dnik|placnik|customer|buyer|bill\s*to|sold\s*to|recipient|destinatario|cliente|empf[a\u00e4]nger)\b\s*:?(.*)$/i
    const stopRe = /\b(iban|trr|sklic|referenca|reference|model|rok\s*pla\S*|due\s*date|znesek|amount|total|invoice|ra\u010dun)\b/i
    const isUrlOrEmailLike = (s: string) => /(\bhttps?:\/\/|\bwww\.|\.(?:com|si|net)\b|@)/i.test(String(s || ''))
    const isAddressOnly = (s: string) => {
      const t = String(s || '').replace(/\s+/g, ' ').trim()
      if (!t) return true
      if (!/[A-Za-zÀ-žČŠŽčšž]/.test(t)) return true
      if (/\b(ulica|cesta|street|st\.?|road|rd\.?|avenue|ave\.?|strasse|stra\u00dfe|via|trg|naselje|posta|po\u0161t\S*|zip)\b/i.test(t) && /\d{1,4}\b/.test(t)) return true
      return false
    }

    for (let i = 0; i < lines.length; i++) {
      const l = String(lines[i] || '').trim()
      const m = l.match(startRe)
      if (!m) continue

      const candidates: string[] = []
      const direct = String(m[1] || '').trim()
      if (direct) candidates.push(direct)
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const x = String(lines[j] || '').trim()
        if (!x) break
        if (stopRe.test(x)) break
        candidates.push(x)
      }

      for (const c of candidates) {
        const v = String(c || '').replace(/\s+/g, ' ').trim()
        if (!v) continue
        if (isUrlOrEmailLike(v)) continue
        if (looksLikeMisassignedName(v)) continue
        if (isAddressOnly(v)) continue
        const vNorm = v.toUpperCase()
        if (issuerNorm && (vNorm === issuerNorm || issuerNorm.includes(vNorm))) continue
        if (v.length < 2 || v.length > 70) continue
        return v
      }
    }
    return null
  }

  function extractMeaningfulPurposeFromText(rawText: string): string | null {
    const labeled = extractPurposeFromText(rawText)
    if (labeled) return labeled

    const text = String(rawText || '').replace(/\r/g, '')
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    const monthSl = /(januar|februar|marec|april|maj|junij|julij|avgust|september|oktober|november|december)\s+20\d{2}/i
    const monthEn = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}/i
    const service = /(elektri\S*\s*energija|electric\S*\s*energy|electricity|power\b|plin\b|gas\b|internet\b|zavarovanj\S*|komunal\S*|voda\b|waste\b|heating|ogrevanj\S*)/i
    const ignore = /(iban|trr|sklic|referenca|reference|model|rok\s*pla\S*|zapad|znesek|amount|total|ddv|vat|subtotal|grand\s*total|\btotal\b)/i

    let best: { v: string; score: number } | null = null
    for (const l of lines) {
      const v = String(l || '').replace(/\s+/g, ' ').trim()
      if (!v || v.length < 6 || v.length > 90) continue
      if (ignore.test(v)) continue
      if (!/[A-Za-zÀ-žČŠŽčšž]/.test(v)) continue
      let score = 0
      if (service.test(v)) score += 3
      if (monthSl.test(v) || monthEn.test(v)) score += 3
      if (!best || score > best.score) best = { v, score }
    }
    return best && best.score >= 6 ? best.v : null
  }

  function extractInvoiceNumberFromText(rawText: string): string | null {
    // IMPORTANT: Invoice number must ONLY come from labeled fields.
    // Allowed labels (multilingual): "Račun št", "Številka računa", "Račun številka", "Invoice No/#", "Document No".
    const cand = extractLabeledValueFromText(rawText, [
      /\b(?:ra\u010dun\s*(?:\u0161t\.?|st\.?|#)|ra\u010dun\s*\u0161tevilka|\u0161tevilka\s*ra\u010duna|invoice\s*(?:no\.?|#|number)?|document\s*(?:no\.?|#|number)?|dokument\s*(?:\u0161t\.?|st\.?|#|\u0161tevilka)?)\b\s*:?\s*(.+)$/i,
    ])
    const v = String(cand || '').trim()
    if (!v) return null

    // Reject generic issuer tokens (e.g. "GEN-1").
    if (/^GEN\s*[-_]?\s*1$/i.test(v) || /^GEN\s*[-_]?\s*I$/i.test(v)) return null

    const normalized = v.toUpperCase().replace(/\s+/g, '')
    // Must contain at least one digit
    if (!/\d/.test(normalized)) return null
    // Conservative bounds
    if (normalized.length < 3 || normalized.length > 32) return null
    // Must not be IBAN/reference/date
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(normalized)) return null
    if (/^(SI|RF)\d{2}[0-9A-Z\-\/]{4,}$/i.test(normalized)) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
    if (/^\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}$/.test(v)) return null
    return normalized

  }

  function extractPurposeFromText(rawText: string): string | null {
    const cand = extractLabeledValueFromText(rawText, [
      /^(?:namen|purpose|opis|description|memo|payment\s*for)\s*:?\s*(.+)$/i,
    ])
    const cleaned = String(cand || '').replace(/\s+/g, ' ').trim()
    return cleaned || null
  }

  function extractBillingPeriodFromText(rawText: string): string | null {
    const text = String(rawText || '').replace(/\r/g, '')
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    for (const l of lines) {
      if (!/\b(obdobje|za\s*obdobje|period)\b/i.test(l)) continue
      // Prefer the part after ':' when present.
      const after = (l.split(/:\s*/, 2)[1] || l).trim()
      // Match common numeric periods like 01/2026, 1-2026, 2026-01.
      const m1 = after.match(/\b(0?[1-9]|1[0-2])\s*[.\/-]\s*(20\d{2})\b/)
      if (m1) return `${String(m1[1]).padStart(2, '0')}/${m1[2]}`
      const m2 = after.match(/\b(20\d{2})\s*[.\/-]\s*(0?[1-9]|1[0-2])\b/)
      if (m2) return `${m2[1]}-${String(m2[2]).padStart(2, '0')}`
    }
    return null
  }

  function applyExtractedPaymentFields(fields: any, source?: string) {
    const warnings: string[] = []
    const rawCreditor = fields?.creditor_name ? String(fields.creditor_name) : ''
    const rawSupplier = fields?.supplier ? String(fields.supplier) : ''
    const rawInvoice = fields?.invoice_number ? String(fields.invoice_number) : ''
    const rawIban = fields?.iban ? String(fields.iban) : ''
    const rawRef = fields?.reference ? String(fields.reference) : ''
    const rawPurpose = fields?.purpose ? String(fields.purpose) : ''
    const rawItem = fields?.item_name ? String(fields.item_name) : ''
    const rawPaymentDetails = fields?.payment_details ? String(fields.payment_details) : ''
    const rawDue = fields?.due_date ? String(fields.due_date) : ''
    const rawText = fields?.rawText ? String(fields.rawText) : ''

    const sourceKey = String(source || fields?._source || fields?.mode || '').trim().toLowerCase()
    const rankForSource = (s: string): number => {
      if (!s) return 3
      if (s === 'qr' || s === 'qr_text' || s === 'qr_barcode') return 0
      if (s === 'ocr' || s === 'pdf_text' || s === 'text' || s === 'ai' || s.startsWith('ai_')) return 1
      if (s === 'google' || s === 'pdf_vision' || s === 'vision_text') return 1
      return 3
    }
    const incomingRank = rankForSource(sourceKey)
    const isAiOnly = sourceKey.startsWith('ai_')
    const canSetField = (key: string, nextValue: string, edited: boolean, currentValue: string) => {
      const v = String(nextValue || '').trim()
      if (!v) return false
      if (edited) return false
      const cur = String(currentValue || '').trim()
      if (key === 'currency' && cur === 'UNKNOWN') return true
      if (!cur) return true
      const prevRank = typeof fieldSourceRankRef.current[key] === 'number' ? fieldSourceRankRef.current[key] : 999
      return incomingRank < prevRank
    }
    const markFieldSource = (key: string, rankOverride?: number) => {
      fieldSourceRankRef.current[key] = typeof rankOverride === 'number' ? rankOverride : incomingRank
    }

    const rawTextTrimmed = String(rawText || '').trim()
    const isQr = incomingRank === 0 && (
      rawTextTrimmed.startsWith('BCD') ||
      rawTextTrimmed.startsWith('UPNQR') ||
      (rawTextTrimmed.length > 0 && rawTextTrimmed.length < 480 && /\bUPNQR\b/i.test(rawTextTrimmed))
    )

    const looksLikeTelecomIdentifier = (v: string): boolean => {
      const s = String(v || '').replace(/\s+/g, ' ').trim()
      if (!s) return false
      // Telecom invoices often contain identifiers that are NOT meaningful as "purchase item".
      if (/\bIP\s*-?\s*telefonsk/i.test(s)) return true
      if (/\b(?:msisdn|imei|imsi|iccid|sim|e-?sim)\b/i.test(s)) return true
      if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(s)) return true // IPv4
      if (/\b\+?\d{6,15}\b/.test(s)) return true // phone-like numbers
      if (/\b\d{6,}\b/.test(s) && /\b(telefon|phone|call|mob|mobile|telekom|telecom)\b/i.test(s)) return true
      return false
    }

    // FINAL GLOBAL FLOW: always map extracted fields into the draft.
    // Archive-only affects validation/required-ness, but should NOT prevent
    // prefilling payment fields from OCR/PDF (user may choose to pay later).
    const allowPaymentFields = true

    // Currency: try to set early (even when amount isn't detected yet).
    // QR (EPC) is always EUR, but OCR/AI may contain symbols/codes.
    if (!editedRef.current.currency) {
      const fromField = typeof fields?.currency === 'string' ? fields.currency.toUpperCase().trim() : ''
      const detected = fromField || detectCurrencyFromText(rawText, rawIban || undefined)
      if (detected && detected !== 'UNKNOWN' && canSetField('currency', detected, editedRef.current.currency, currency)) {
        setCurrency(detected)
        markFieldSource('currency')
      }
    }

    // Issuer (Dobavitelj/Prejemnik): invoice issuer. For non-QR sources, prefer header-block evidence.
    const creditorFromText = extractCreditorNameFromText(rawText)
    const supplierFromText = extractSupplierNameFromText(rawText)
    const bestFromText = pickBestNameFromWholeText(rawText)
    const issuerFromHeader = !isQr ? extractIssuerFromHeaderBlock(rawText) : null
    const normalizeIssuerName = (s: string): string => {
      const v = String(s || '').replace(/\s+/g, ' ').trim()
      if (!v) return ''
      if (/\bGEN\s*-?\s*I\b/i.test(v)) {
        if (/\bd\.o\.o\./i.test(v)) return 'GEN-I, d.o.o.'
        return 'GEN-I'
      }
      return v
    }
    const nameCandidateRaw = isAiOnly
      ? pickNameCandidate(rawSupplier, rawCreditor)
      : pickNameCandidate(issuerFromHeader, creditorFromText, supplierFromText, bestFromText, rawCreditor, rawSupplier)
    const nameCandidate = normalizeCompanyName(normalizeIssuerName(nameCandidateRaw))

    const payerFromDoc = !isQr ? extractPayerNameFromText(rawText, nameCandidate) : null
    if (payerFromDoc && payerFromDoc !== payerName) {
      setPayerName(payerFromDoc)
    }
    if (nameCandidate) {
      const canOverwriteSupplier = !editedRef.current.supplier || !supplier.trim() || looksLikeMisassignedName(supplier)
      if (canOverwriteSupplier && canSetField('supplier', nameCandidate, editedRef.current.supplier, supplier)) {
        setSupplier(nameCandidate)
        markFieldSource('supplier')
      }
      if (allowPaymentFields) {
        const canOverwriteCreditor = !editedRef.current.creditorName || !creditorName.trim() || looksLikeMisassignedName(creditorName)
        if (canOverwriteCreditor && canSetField('creditor_name', nameCandidate, editedRef.current.creditorName, creditorName)) {
          setCreditorName(nameCandidate)
          markFieldSource('creditor_name')
        }
      }
    }

    // Invoice number must ONLY come from labeled fields in the document.
    const hasInvoiceLabelEvidence = (text: string, invoice: string): boolean => {
      const inv = String(invoice || '').trim()
      if (!inv) return false
      const invNorm = inv.toUpperCase().replace(/\s+/g, '')
      const lines = String(text || '').replace(/\r/g, '').split(/\n+/)
      const labelRe = /\b(?:ra\u010dun\s*(?:\u0161t\.?|st\.?|#)|ra\u010dun\s*\u0161tevilka|\u0161tevilka\s*ra\u010duna|invoice\s*(?:no\.?|#|number)?|document\s*(?:no\.?|#|number)?|dokument\s*(?:\u0161t\.?|st\.?|#|\u0161tevilka)?)\b/i

      for (let i = 0; i < lines.length; i++) {
        const l = String(lines[i] || '').trim()
        if (!l) continue
        const lineNorm = l.toUpperCase().replace(/\s+/g, '')
        if (!lineNorm || !lineNorm.includes(invNorm)) continue
        if (labelRe.test(l)) return true
        for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
          if (labelRe.test(String(lines[j] || ''))) return true
        }
      }

      for (let i = 0; i < lines.length; i++) {
        const l = String(lines[i] || '').trim()
        if (!l) continue
        if (!labelRe.test(l)) continue
        const m = l.match(/\b(?:ra\u010dun\s*(?:\u0161t\.?|st\.?|#)|ra\u010dun\s*\u0161tevilka|\u0161tevilka\s*ra\u010duna|invoice\s*(?:no\.?|#|number)?|document\s*(?:no\.?|#|number)?|dokument\s*(?:\u0161t\.?|st\.?|#|\u0161tevilka)?)\b\s*:?\s*(.+)$/i)
        const direct = String(m?.[1] || '').trim()
        const directNorm = direct.toUpperCase().replace(/\s+/g, '')
        if (directNorm && directNorm.includes(invNorm)) return true
        const next = String(lines[i + 1] || '').trim()
        const nextNorm = next.toUpperCase().replace(/\s+/g, '')
        if (nextNorm && nextNorm.includes(invNorm)) return true
      }
      return false
    }
    const looksLikeInvoiceId = (s: string): boolean => {
      const v = String(s || '').trim()
      if (!v) return false
      if (v.length < 3 || v.length > 32) return false
      if (!/\d/.test(v)) return false
      const compact = v.toUpperCase().replace(/\s+/g, '')
      if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(compact)) return false
      if (/^(SI|RF)\d{2}[0-9A-Z\-\/]{4,}$/i.test(compact)) return false
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
      return true
    }

    const invFromDoc = extractInvoiceNumberFromText(rawText) || ''
    const invFromField = (rawInvoice || '').trim()
    let invCandidate = ''
    if (isAiOnly && invFromField && looksLikeInvoiceId(invFromField)) {
      invCandidate = invFromField.toUpperCase().replace(/\s+/g, '')
    } else {
      invCandidate = (invFromField && hasInvoiceLabelEvidence(rawText, invFromField) ? invFromField.toUpperCase().replace(/\s+/g, '') : '') || invFromDoc
    }
    let invoiceGenerated = false
    if (!invCandidate && !isQr && allowPaymentFields) {
      const baseIso = (String(rawDue || '').trim().match(/^\d{4}-\d{2}-\d{2}$/)?.[0]) || new Date().toISOString().slice(0, 10)
      const stamp = baseIso.replace(/-/g, '')
      invCandidate = `DOC-${stamp}-001`
      invoiceGenerated = true
    }
    if (invCandidate) {
      if (canSetField('invoice_number', invCandidate, editedRef.current.invoiceNumber, invoiceNumber)) {
        setInvoiceNumber(invCandidate)
        // Generated invoice numbers are low-priority fallbacks and must be overwritable.
        markFieldSource('invoice_number', invoiceGenerated ? 999 : undefined)
      }
    }

    // Purchase item / subject (archive-friendly): use AI item_name or a meaningful description.
    if (!editedRef.current.purchaseItem) {
      const purposeCandidate = String(rawPurpose || '').replace(/\s+/g, ' ').trim()
      const purposeLooksLikeItem = purposeCandidate && !/^pla\u010dilo\b/i.test(purposeCandidate)
      const detectedCategoryForItem = detectCategoryFromText(nameCandidate || rawSupplier || rawCreditor || '', String(rawPurpose || ''), String(rawItem || ''))
      const meaningfulFromText = !isQr ? (extractMeaningfulPurposeFromText(rawText) || '') : ''
      const rawItemClean = String(rawItem || '').replace(/\s+/g, ' ').trim()

      let itemCandidate = rawItemClean || meaningfulFromText || (purposeLooksLikeItem ? purposeCandidate : '')
      if (detectedCategoryForItem === 'telecom' && itemCandidate && looksLikeTelecomIdentifier(itemCandidate)) {
        itemCandidate = meaningfulFromText || (purposeLooksLikeItem ? purposeCandidate : '') || ''
      }
      if (itemCandidate && canSetField('purchase_item', itemCandidate, editedRef.current.purchaseItem, purchaseItem)) {
        setPurchaseItem(itemCandidate)
        markFieldSource('purchase_item')
      }
      if (isAiOnly && purposeCandidate && canSetField('purpose', purposeCandidate, editedRef.current.purpose, purpose)) {
        setPurpose(purposeCandidate)
        markFieldSource('purpose')
      }
    }

    // Bank-level rule: do not guess critical payment fields.
    // Prefer an explicit IBAN coming from the backend (even when multiple candidates exist).
    const preferredIban = allowPaymentFields && rawIban ? (tryRepairIbanChecksum(rawIban) || null) : null
    const ibanCandidates = allowPaymentFields ? extractIbanCandidates(rawText || '', rawIban) : []
    const foundIban = preferredIban || (ibanCandidates.length === 1 ? ibanCandidates[0] : null)

    const sawTrOrAccountLabel = allowPaymentFields
      ? hasTrOrAccountLabel(rawText || '') || hasTrOrAccountLabel(String(rawPaymentDetails || ''))
      : false

    if (allowPaymentFields && ibanCandidates.length) {
      console.log('[OCR] IBAN candidates:', ibanCandidates)
    }

    if (allowPaymentFields) {
      if (foundIban) {
        if (canSetField('iban', foundIban, editedRef.current.iban, iban)) {
          setIban(foundIban)
          markFieldSource('iban')
        }
        setIbanPickerVisible(false)
        setIbanOptions([])
      } else {
        if (ibanCandidates.length > 1 && !editedRef.current.iban && !iban.trim()) {
          setIbanOptions(ibanCandidates)
          setIbanPickerVisible(true)
        }
        if (ibanCandidates.length === 0 && !editedRef.current.iban && !iban.trim()) {
          warnings.push(
            sawTrOrAccountLabel
              ? tr('Payment account (TR/TRR) detected, but IBAN could not be determined. Please verify it.')
              : tr('IBAN not found.')
          )
        }
        if (rawIban) {
          warnings.push(tr('IBAN could not be validated. Please check it.'))
        }
      }
    }

    const isValidReferenceFormat = (r: string, model?: string): boolean => {
      const v = normalizeReference(r)
      if (!v) return false
      const hasModel = Boolean(String(model || '').trim())
      if (!hasModel) {
        if (!/^(SI|RF)\d{2}/i.test(v)) return false
        if (v.length < 6) return false
        if (looksLikeIban(v) && isValidIbanChecksum(v)) return false
        return true
      }
      // If model is provided, allow shorter numeric references (sklic number).
      if (v.length < 4) return false
      if (looksLikeIban(v) && isValidIbanChecksum(v)) return false
      return true
    }
    if (allowPaymentFields) {
      const refFromDoc = extractReferenceCandidate(rawText)
      const rawModel = fields?.reference_model ? String(fields.reference_model) : ''
      const rawRefNumber = fields?.reference_number ? String(fields.reference_number) : ''
      const split = splitReferenceModel(rawRef)
      const modelCandidate = normalizeReferenceModel(rawModel || split.model || '')
      let ref = ''
      if (modelCandidate) {
        ref = normalizeReferenceNumber(rawRefNumber || split.number || rawRef)
      } else {
        ref = normalizeReference(rawRef) || ''
      }
      // If the extracted reference is missing or suspicious, fall back to labeled Sklic/Reference lines.
      if (!ref || !isValidReferenceFormat(ref, modelCandidate)) {
        if (isAiOnly && rawRef && isValidReferenceFormat(rawRef, modelCandidate)) ref = modelCandidate ? normalizeReferenceNumber(rawRef) : normalizeReference(rawRef)
        else if (refFromDoc && isValidReferenceFormat(refFromDoc, modelCandidate)) ref = modelCandidate ? normalizeReferenceNumber(refFromDoc) : refFromDoc
      }
      if (isAiOnly && rawRef && !ref) {
        ref = modelCandidate ? normalizeReferenceNumber(rawRef) : normalizeReference(rawRef)
      }
      if (ref) {
        const fullRef = modelCandidate ? buildReferenceFromModel(modelCandidate, ref) : ref
        if (foundIban && fullRef && fullRef === foundIban) {
          warnings.push(tr('Reference matched the IBAN; it was ignored.'))
          ref = ''
        }
        // Only treat as IBAN fragment when it does NOT match a valid reference pattern.
        if (foundIban && ref && !isValidReferenceFormat(ref, modelCandidate) && ref.length < 10 && String(foundIban || '').startsWith(ref)) {
          warnings.push(tr('Reference looked like an IBAN fragment; it was ignored.'))
          ref = ''
        }
      }
      if (modelCandidate && canSetField('reference_model', modelCandidate, editedRef.current.referenceModel, referenceModel)) {
        setReferenceModel(modelCandidate)
        markFieldSource('reference_model')
      }
      if (ref && canSetField('reference', ref, editedRef.current.reference, reference)) {
        setReference(ref)
        markFieldSource('reference')
      }
    }

    if (allowPaymentFields) {
      const purposeClean = String(rawPurpose || '').replace(/\s+/g, ' ').trim()
      const meaningfulPurpose = !isQr ? extractMeaningfulPurposeFromText(rawText) : null
      const preferredPurpose = meaningfulPurpose || (purposeClean && purposeClean.toLowerCase() !== 'plačilo' ? purposeClean : '')
      if (preferredPurpose && canSetField('purpose', preferredPurpose, editedRef.current.purpose, purpose)) {
        setPurpose(preferredPurpose)
        markFieldSource('purpose')
      }
    }

    // Category: prefer per-user override, otherwise infer from supplier + keywords.
    const supplierKey = normalizeSupplierKey(nameCandidate || rawSupplier || rawCreditor || '')
    const overrideCategory = supplierKey ? categoryOverrides[supplierKey] : ''
    const inferredCategory = overrideCategory || detectCategoryFromText(nameCandidate || rawSupplier || rawCreditor || '', String(rawPurpose || ''), String(rawItem || ''))
    if (inferredCategory && canSetField('category', inferredCategory, editedRef.current.category, category)) {
      setCategory(inferredCategory)
      markFieldSource('category')
    }

    // Purpose is mandatory for payment flows (non-QR): fill deterministic fallback in strict order.
    if (allowPaymentFields && !editedRef.current.purpose && !purpose.trim()) {
      const paymentLabel = tr('Payment')
      const invForPurpose = String(invCandidate || invoiceNumber || '').trim()
      const payerForPurpose = String(payerFromDoc || '').trim()
      const purchaseItemForPurpose = String(purchaseItem || '').trim()
      const fallbackPurpose = purchaseItemForPurpose
        ? purchaseItemForPurpose
        : (invForPurpose
          ? `${paymentLabel} ${invForPurpose}`
          : (payerForPurpose ? `${paymentLabel} ${payerForPurpose}` : paymentLabel))
      if (canSetField('purpose', fallbackPurpose, editedRef.current.purpose, purpose)) {
        setPurpose(fallbackPurpose)
        // Fallback purposes must be overwritable by later extracted meaningful purposes.
        markFieldSource('purpose', 999)
      }
    }

    // Amount: apply extracted amount, otherwise fallback to OCR text (label-first).
    if (!editedRef.current.amount) {
      const parseMoney = (s: string): number | null => {
        const raw = String(s || '').trim()
        const cleaned = raw.replace(/[^0-9.,\-\s]/g, '').trim()
        if (!/[0-9]/.test(cleaned)) return null
        const compact = cleaned.replace(/\s+/g, '')
        const lastComma = compact.lastIndexOf(',')
        const lastDot = compact.lastIndexOf('.')
        let decimalSep: ',' | '.' | null = null
        if (lastComma >= 0 && lastDot >= 0) decimalSep = lastComma > lastDot ? ',' : '.'
        else if (lastComma >= 0) decimalSep = ','
        else if (lastDot >= 0) decimalSep = '.'
        let normalized = compact
        if (decimalSep === ',') normalized = compact.replace(/\./g, '').replace(',', '.')
        else if (decimalSep === '.') normalized = compact.replace(/,/g, '')
        normalized = normalized.replace(/(?!^)-/g, '')
        const num = Number(normalized)
        return Number.isFinite(num) ? num : null
      }

      let extractedAmount: { amount: number; currency: string } | null = null
      if (typeof fields?.amount === 'number' && Number.isFinite(fields.amount) && fields.amount > 0) {
        extractedAmount = { amount: fields.amount, currency: String(fields?.currency || '') }
      } else if (isAiOnly && typeof fields?.amount === 'string') {
        const amt = parseMoney(fields.amount)
        if (amt && amt > 0) {
          const cur = typeof fields?.currency === 'string' ? fields.currency.toUpperCase() : detectCurrencyFromText(fields.amount, foundIban || undefined)
          extractedAmount = { amount: amt, currency: cur || '' }
        }
      } else {
        extractedAmount = extractAmountFromText(rawText)
      }

      if (extractedAmount?.amount) {
        const nextAmount = String(extractedAmount.amount)
        if (canSetField('amount', nextAmount, editedRef.current.amount, amountStr)) {
          setAmountStr(nextAmount)
          markFieldSource('amount')
        }
        if (extractedAmount.currency) {
          const cur = String(extractedAmount.currency || '').toUpperCase()
          if (cur && cur !== 'UNKNOWN' && canSetField('currency', cur, editedRef.current.currency, currency)) {
            setCurrency(cur)
            markFieldSource('currency')
          }
        }
        if (!extractedAmount.currency) {
          const detected = detectCurrencyFromText(rawText, foundIban || undefined)
          if (detected && canSetField('currency', detected, editedRef.current.currency, currency)) {
            setCurrency(detected)
            markFieldSource('currency')
          } else if (canSetField('currency', 'UNKNOWN', editedRef.current.currency, currency)) {
            setCurrency('UNKNOWN')
            markFieldSource('currency')
          }
        }
      }
    }

    // Due date: accept ISO YYYY-MM-DD; AI-only also parses common EU formats.
    if (allowPaymentFields) {
      const dueClean = String(rawDue || '').trim()
      const parseDate = (s: string): string | null => {
        const iso = s.match(/^\d{4}-\d{2}-\d{2}$/)
        if (iso) return s
        const m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/)
        if (!m) return null
        let day = Number(m[1])
        let month = Number(m[2])
        let year = Number(m[3])
        if (year < 100) year += 2000
        if (month < 1 || month > 12 || day < 1 || day > 31) return null
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      }
      const parsedDue = isAiOnly ? (parseDate(dueClean) || dueClean) : dueClean
      if (parsedDue && /^\d{4}-\d{2}-\d{2}$/.test(parsedDue) && canSetField('due_date', parsedDue, editedRef.current.dueDate, dueDate)) {
        setDueDate(parsedDue)
        markFieldSource('due_date')
        warnIfOverdueDueDate(parsedDue)
      }
      if (!isQr && !editedRef.current.dueDate && !dueDate.trim() && !dueClean) {
        const base = new Date()
        base.setDate(base.getDate() + 14)
        const iso = base.toISOString().slice(0, 10)
        if (canSetField('due_date', iso, editedRef.current.dueDate, dueDate)) {
          setDueDate(iso)
          // Default due dates must be overwritable by later extracted due dates.
          markFieldSource('due_date', 999)
        }
      }
    }

    // Payment details (non-IBAN systems): treat as informational; still respect precedence.
    if (allowPaymentFields) {
      const detailsClean = String(rawPaymentDetails || '').trim()
      if (detailsClean && canSetField('payment_details', detailsClean, editedRef.current.paymentDetails, paymentDetails)) {
        setPaymentDetails(detailsClean)
        markFieldSource('payment_details')

        // If the OCR put the pay-to account into a free-form field, still try to fill
        // the structured fields (IBAN/reference) so "Save bill for payment" works.
        if (!editedRef.current.iban && !iban.trim()) {
          const extractedIban = extractFirstValidIban(detailsClean)
          const derivedCandidates = extractIbanCandidates(detailsClean)
          const derived = extractedIban || (derivedCandidates.length === 1 ? derivedCandidates[0] : null)
          if (derived && canSetField('iban', derived, editedRef.current.iban, iban)) {
            setIban(derived)
            markFieldSource('iban')
          }
        }
        if (!editedRef.current.reference && !reference.trim()) {
          const extractedRef = extractReferenceCandidate(detailsClean)
          if (extractedRef && canSetField('reference', extractedRef, editedRef.current.reference, reference)) {
            applyReferenceInput(extractedRef)
            markFieldSource('reference')
          }
        }
      }
    }

    setIbanHint(null)
    setReferenceHint(null)
    if (allowPaymentFields && warnings.length) {
      // Keep hints lightweight and actionable.
      setIbanHint(warnings[0] || null)
      if (warnings.length > 1) setReferenceHint(warnings[1] || null)
    }
  }

  function handleIbanChange(next: string) {
    editedRef.current.iban = true
    const raw = String(next || '')
    const extracted = extractFirstValidIban(raw)
    if (extracted) {
      setIban(extracted)
      setIbanHint(null)
      return
    }
    const norm = normalizeIban(raw)
    if (norm.length > 34) {
      setIban(norm.slice(0, 34))
      setIbanHint(tr('IBAN was too long — extra characters were ignored.'))
      return
    }
    setIban(norm)
    setIbanHint(null)
  }

  function applyReferenceInput(raw: string, opts?: { markEdited?: boolean }) {
    const split = splitReferenceModel(raw)
    const number = split.number ? normalizeReferenceNumber(split.number) : normalizeReferenceNumber(raw)
    const currentModel = split.model || referenceModel
    const normalizedModel = currentModel ? normalizeReferenceModel(currentModel) : ''
    if (opts?.markEdited) {
      editedRef.current.reference = true
      if (split.model) editedRef.current.referenceModel = true
    }
    if (split.model) setReferenceModel(normalizedModel)
    if (number) setReference(number)
    return { model: normalizedModel, number, full: normalizedModel ? buildReferenceFromModel(normalizedModel, number) : normalizeReference(raw) }
  }

  function handleReferenceChange(next: string) {
    const parsed = applyReferenceInput(next, { markEdited: true })
    const full = parsed.full || normalizeReference(next)
    const currentIban = normalizeIban(iban)
    if (full && currentIban && full === currentIban) {
      setReferenceHint(tr('Reference matched the IBAN; it was ignored.'))
      return
    }
    // Only warn about IBAN-looking references when the IBAN field is empty (otherwise SI references can false-positive).
    if (!currentIban && full && looksLikeIban(full) && isValidIbanChecksum(full)) {
      setReferenceHint(tr('This looks like an IBAN, not a reference.'))
    } else {
      setReferenceHint(null)
    }
  }

  function handleReferenceModelChange(next: string) {
    editedRef.current.referenceModel = true
    const cleaned = normalizeReferenceModel(next)
    setReferenceModel(cleaned)
    if (reference.trim()) {
      const full = cleaned ? buildReferenceFromModel(cleaned, normalizeReferenceNumber(reference)) : normalizeReference(reference)
      const currentIban = normalizeIban(iban)
      if (full && currentIban && full === currentIban) setReferenceHint(tr('Reference matched the IBAN; it was ignored.'))
      else if (!currentIban && full && looksLikeIban(full) && isValidIbanChecksum(full)) setReferenceHint(tr('This looks like an IBAN, not a reference.'))
      else setReferenceHint(null)
    }
  }

  function normalizeReferenceModel(input: string): string {
    const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!raw) return ''
    const letters = /^[A-Z]{2}/.test(raw) ? raw.slice(0, 2) : 'SI'
    const digits = raw.replace(/^[A-Z]{2}/, '').replace(/[^0-9]/g, '').slice(0, 2)
    return digits ? `${letters} ${digits}` : letters
  }

  function handlePaymentDetailsChange(next: string) {
    editedRef.current.paymentDetails = true
    setPaymentDetails(next)
    // If user pasted bank details, try to extract IBAN/reference automatically (only if fields are empty).
    if (!iban.trim()) {
      const extracted = extractFirstValidIban(next)
      if (extracted) setIban(extracted)
      else {
        const derived = extractIbanCandidates(next)
        if (derived.length === 1) setIban(derived[0])
      }
    }
    if (!reference.trim()) {
      const extractedRef = extractReferenceCandidate(next)
      if (extractedRef) applyReferenceInput(extractedRef)
    }
  }

  const handleSupplierInput = (v: string) => {
    editedRef.current.supplier = true
    setSupplier(v)
    if (missingBasicFields.supplier) setMissingBasicFields((prev) => ({ ...prev, supplier: false }))
  }
  const handlePurchaseItemInput = (v: string) => {
    editedRef.current.purchaseItem = true
    setPurchaseItem(v)
    if (missingBasicFields.purchaseItem) setMissingBasicFields((prev) => ({ ...prev, purchaseItem: false }))
  }
  const handleInvoiceNumberInput = (v: string) => {
    editedRef.current.invoiceNumber = true
    setInvoiceNumber(v)
    if (missingBasicFields.invoice) setMissingBasicFields((prev) => ({ ...prev, invoice: false }))
  }
  const handleAmountInput = (v: string) => {
    editedRef.current.amount = true
    setAmountStr(v)
    if (missingBasicFields.amount) setMissingBasicFields((prev) => ({ ...prev, amount: false }))
  }
  const handleCurrencyInput = (v: string) => {
    editedRef.current.currency = true
    setCurrency(v.toUpperCase())
    if (missingBasicFields.currency) setMissingBasicFields((prev) => ({ ...prev, currency: false }))
  }
  const handleDueDateInput = (v: string) => { editedRef.current.dueDate = true; setDueDate(v) }
  const handleCreditorNameInput = (v: string) => { editedRef.current.creditorName = true; setCreditorName(v) }
  const handlePurposeInput = (v: string) => { editedRef.current.purpose = true; setPurpose(v) }

  function isValidIbanChecksum(ibanInput: string): boolean {
    const iban = normalizeIban(ibanInput)
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(iban)) return false
    const expected = IBAN_LENGTHS[iban.slice(0, 2)]
    if (expected && iban.length !== expected) return false
    const rearranged = iban.slice(4) + iban.slice(0, 4)
    let remainder = 0
    for (let i = 0; i < rearranged.length; i++) {
      const ch = rearranged[i]
      const code = ch.charCodeAt(0)
      if (code >= 48 && code <= 57) {
        remainder = (remainder * 10 + (code - 48)) % 97
      } else {
        const val = code - 55
        remainder = (remainder * 100 + val) % 97
      }
    }
    return remainder === 1
  }

  const hasBillData = Boolean(
    useDataActive ||
    supplier ||
    invoiceNumber ||
    amountStr ||
    dueDate ||
    creditorName ||
    iban ||
    reference ||
    purpose ||
    paymentDetails ||
    pendingAttachment
  )

  const resetInvoiceAndItemAutofillForNewAttachment = useCallback(() => {
    // New document => never keep previous document's invoice number / subject.
    // Also reset precedence ranks so OCR/AI for the new file can overwrite.
    editedRef.current.invoiceNumber = false
    editedRef.current.purchaseItem = false
    try { delete (fieldSourceRankRef.current as any)['invoice_number'] } catch {}
    try { delete (fieldSourceRankRef.current as any)['purchase_item'] } catch {}
    setInvoiceNumber('')
    setPurchaseItem('')
    setMissingBasicFields((prev) => ({ ...prev, invoice: false, purchaseItem: false }))
  }, [])

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
    setInvoiceNumber('')
    setAmountStr('')
    setCurrency('')
    setDueDate('')
    setArchiveOnly(archiveOnlyFromBillDraftSelection(DEFAULT_BILL_DRAFT_SELECTION))
    setCreditorName('')
    setIban('')
    setReferenceModel('')
    setReference('')
    setPurpose('')
    setPaymentDetails('')
    setPayerName('')
    setCategory('')
    setMissingBasicFields({ supplier: false, purchaseItem: false, invoice: false, amount: false, currency: false })
    setInboxSourceId(null)
    setLastQR('')
    setCameraVisible(true)
    setTorch('off')
    setDebugStatus('IDLE')
    setDebugQrFound(null)
    setDebugOcrLength(0)
    setDebugAiInfo(null)
    setDebugFileInfo(null)
    setDebugRequestId(null)
    setIbanOptions([])
    setIbanPickerVisible(false)
    editedRef.current = {
      supplier: false,
      purchaseItem: false,
      invoiceNumber: false,
      amount: false,
      currency: false,
      dueDate: false,
      creditorName: false,
      iban: false,
      referenceModel: false,
      reference: false,
      purpose: false,
      paymentDetails: false,
      category: false,
    }
    fieldSourceRankRef.current = {}
  }, [])
  useEffect(() => {
    const payload = route.params?.inboxPrefill
    if (payload && payload.fields) {
      const f = payload.fields as ExtractedFields
      const raw = String((f as any)?.rawText || '')
      const classification = (f as any)?._classification || null
      const clsConf = typeof (classification as any)?.confidence === 'number' ? (classification as any).confidence : null
      const sourceHint = String((f as any)?._source || (f as any)?.mode || '')
      const isQr = /qr/i.test(sourceHint)
      const source: 'QR' | 'OCR' = isQr ? 'QR' : 'OCR'

      // Never auto-archive on prefill. Archiving must be an explicit user action.
      setArchiveOnly(false)

      const cat = (classification as any)?.category
      if (typeof cat === 'string' && cat) setCategory(cat)

      const isInvoice = (classification as any)?.isInvoice
      const billLikeOverride = /(predra\u010dun|predracun|proforma|pro\s*forma|proforma\s*rechnung|\bangebot\b|ponudba|ponuda|\boffer\b|\bquotation\b|\bquote\b|\bestimate\b|devis|preventivo|\bofferta\b|\bp\u0159edra\u010dun\b|\bpr\u00e9facture\b)/i.test(raw)
      if (isInvoice === false && (clsConf == null || clsConf >= 0.7) && !billLikeOverride) {
        Alert.alert(tr('Inbox'), tr('This looks like a non-bill document. Please verify before saving.'))
      } else if (clsConf != null && clsConf < 0.55) {
        Alert.alert(tr('Scan'), tr('AI is not fully confident. Please verify the details.'))
      }
      const supplierName = pickNameCandidate(f.creditor_name, f.supplier)
      if (supplierName) setSupplier(supplierName)
      const cred = pickNameCandidate(f.creditor_name, supplierName)
      if (cred) setCreditorName(cred)
      applyDataToForm(source, { ...f }, raw)
      if (f.payment_details) setPaymentDetails(String(f.payment_details || ''))
      if (f.invoice_number) setInvoiceNumber(String(f.invoice_number || ''))
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
    try {
      setOcrBusyAction('photo')
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
      if (res.canceled) return
      const asset = res.assets?.[0]
      if (!asset?.uri) return

      resetInvoiceAndItemAutofillForNewAttachment()
      const logMeta = {
        originalUri: asset.uri,
        mimeType: asset.mimeType || 'image/jpeg',
        fileName: asset.fileName || 'photo.jpg',
        fileSize: (asset as any)?.fileSize ?? null,
        platform: Platform.OS,
      }
      console.log('[Import] pickImage', logMeta)
      const cached = await ensureLocalReadableFile(asset.uri, asset.fileName || 'photo.jpg', asset.mimeType || 'image/jpeg', { allowBase64Fallback: false })
      console.log('[Import] cached image', { cachedUri: cached.uri, size: cached.size })
      setPendingAttachment({ uri: cached.uri, name: asset.fileName || 'photo.jpg', type: (asset.mimeType || 'image/jpeg') })
      // Try QR decode first (web via ZXing), with up to 3 retries; fallback to OCR
      const decoded = await decodeImageQR(cached.uri, 3)
      if (decoded) {
        const isPaymentQr = handleDecodedText(decoded)
        if (!isPaymentQr) {
          const languageHint = getCurrentLang()
          await extractWithOCR(cached.uri, asset.mimeType || 'image/jpeg', { preferQr: true, allowAi: true, aiMode: 'document', languageHint })
        }
      } else {
        const languageHint = getCurrentLang()
        await extractWithOCR(cached.uri, asset.mimeType || 'image/jpeg', { preferQr: true, allowAi: true, aiMode: 'document', languageHint })
      }
    } catch (e: any) {
      console.warn('[Import] pickImage failed', {
        message: e?.message,
        stack: e?.stack,
        platform: Platform.OS,
      })
      const msg = isDebugBuild() ? (e?.message || String(e)) : tr('Could not read the selected file.')
      Alert.alert(tr('Import failed'), msg)
    }
    finally {
      setOcrBusyAction(null)
    }
  }

  async function pickPdfForOCR() {
    if (!entitlements.canUseOCR) {
      showUpgradeAlert('ocr')
      return
    }
    try {
      setOcrBusyAction('pdf')
      const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
      if (res.canceled) return
      const file = res.assets?.[0]
      if (!file?.uri) return

      resetInvoiceAndItemAutofillForNewAttachment()
      const logMeta = {
        originalUri: file.uri,
        mimeType: file.mimeType || 'application/pdf',
        fileName: file.name || 'document.pdf',
        fileSize: (file as any)?.size ?? null,
        platform: Platform.OS,
      }
      console.log('[Import] pickPdf', logMeta)
      const cached = await ensureLocalReadableFile(file.uri, file.name || 'document.pdf', file.mimeType || 'application/pdf', { allowBase64Fallback: true })
      console.log('[Import] cached pdf', { cachedUri: cached.uri, size: cached.size })
      setPendingAttachment({ uri: cached.uri, name: file.name || 'document.pdf', type: 'application/pdf' })
      const languageHint = getCurrentLang()
      await extractWithOCR(cached.uri, file.mimeType || 'application/pdf', { preferQr: true, allowAi: true, aiMode: 'document', languageHint })
    } catch (e: any) {
      console.warn('[Import] pickPdf failed', {
        message: e?.message,
        stack: e?.stack,
        platform: Platform.OS,
      })
      const msg = isDebugBuild() ? (e?.message || String(e)) : tr('Could not read the selected file.')
      Alert.alert(tr('Import failed'), msg)
    } finally {
      setOcrBusyAction(null)
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

  function handleDecodedText(text: string): boolean {
    const t = (text ?? '').toString()
    setRawText(t || '')
    if (!t) { setFormat('Unknown'); setParsed(null); Alert.alert(tr('QR detected but no text decoded')); return false }
    const epc = parseEPC(t)
    const upn = !epc ? parseUPN(t) : null
    const p = epc || upn
    if (!p) {
      setFormat(tr('QR is not a payment QR.'))
      setParsed(null)
      setOcrError(tr('QR is not a payment QR.'))
      Alert.alert(tr('QR is not a payment QR.'))
      return false
    }
    setDebugFileInfo({ source: 'original', size: null })
    setDebugStatus('DONE')
    setDebugQrFound(true)
    setDebugOcrLength(t.length)
    setDebugAiInfo({ called: false, model: null, tier: null, enabled: null, attempted: null, error: null, mode: null })
    setDebugOcrMode(null)
    setFormat(epc ? 'EPC/SEPA SCT' : (upn ? 'UPN' : 'URL'))
    // Mark missing fields for review (internal flag; no UI changes).
    const missing: string[] = []
    if (!p.creditor_name) missing.push('supplier')
    if (!p.iban) missing.push('iban')
    if (!p.reference) missing.push('reference')
    if (!p.purpose) missing.push('purpose')
    if (!(typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0)) missing.push('amount')
    if (!p.currency) missing.push('currency')
    if (!p.due_date) missing.push('due_date')
    setParsed({ ...p, needsReview: missing.length > 0, missingFields: missing })
    if (missing.length) console.warn('QR missing fields:', missing)
    applyDataToForm('QR', { ...p }, t)

    // QR mapping is deterministic: AI is never used for QR mapping.
    setUseDataActive(true)
    setCameraVisible(false)
    setTorch('off')
    return true
  }

  async function extractWithOCR(uri: string, contentType?: string, opts?: { preferQr?: boolean; allowAi?: boolean; aiMode?: string; languageHint?: string }) {
    if (!entitlements.canUseOCR) {
      showUpgradeAlert('ocr')
      return
    }
    try {
      setOcrError(null)
      setOcrBusy(true)
      setDebugStatus('RUNNING')
      setDebugQrFound(null)
      setDebugAiInfo(null)
      setDebugRequestId(null)
      try {
        const info = await FileSystem.getInfoAsync(uri)
        if (info) setDebugFileInfo({ source: 'original', size: typeof info.size === 'number' ? info.size : null })
      } catch {}
      const primary = await performOCR(uri, { preferQr: Boolean(opts?.preferQr), contentType, allowAi: Boolean(opts?.allowAi), aiMode: opts?.aiMode, languageHint: opts?.languageHint })
      const ocrText = String(primary?.rawText || '')
      const f = primary?.fields || {}
      const summary = String(primary?.summary || '')
      const isEmpty = !ocrText.trim() && !f?.iban && !f?.reference && !(typeof f?.amount === 'number')
      if (isEmpty) {
        const fallback = await performOCR(uri, { preferQr: Boolean(opts?.preferQr), contentType, allowAi: false, aiMode: opts?.aiMode, languageHint: opts?.languageHint })
        const fallbackSummary = String(fallback?.summary || '')
        applyOcr(fallback?.fields || {}, String(fallback?.rawText || ''), fallback?.mode, fallback?.meta)
        // Keep UX non-technical; the draft is already filled and still editable.
        if (fallbackSummary && fallbackSummary !== tr('No fields found')) {
          // Optional: leave silent, but keep summary available via rawText.
        }
      } else {
        applyOcr(f, ocrText, primary?.mode, primary?.meta)
        // Keep UX non-technical; the draft is already filled and still editable.
        if (summary && summary !== tr('No fields found')) {
          // Optional: leave silent, but keep summary available via rawText.
        }
      }
      setDebugStatus('DONE')
      setDebugQrFound(/qr/i.test(String(primary?.mode || '')))
      setDebugOcrLength(String(ocrText || '').length)
      setDebugOcrMode(String(primary?.mode || '') || null)
      setDebugAiInfo({
        called: Boolean(primary?.ai),
        model: primary?.aiModel || null,
        tier: primary?.aiTier || null,
        enabled: primary?.meta?.ai?.enabled ?? null,
        attempted: primary?.meta?.ai?.attempted ?? null,
        error: primary?.meta?.ai?.error ?? null,
        mode: String(primary?.mode || '') || null,
      })
    } catch (e: any) {
      const msg = e?.message || tr('OCR failed')
      const status = (e as any)?.status
      const code = (e as any)?.code
      const requestId = (e as any)?.requestId
      if (requestId) setDebugRequestId(requestId)
      const withRequestId = (base: string) => requestId ? `${base}\n${tr('Request ID')}: ${requestId}` : base
      console.warn('OCR failed:', { status, code, msg })

      if (status === 401 || code === 'auth_required' || /sign in/i.test(msg)) {
        const text = withRequestId(tr('Please sign in again.'))
        setOcrError(text)
        Alert.alert(tr('OCR unavailable'), text)
        setDebugStatus('ERROR')
        return
      }

      const shouldFallback = status === 500 || status === 502 || status === 503 || status === 504 || code === 'timeout' || /timeout/i.test(msg)
      if (shouldFallback) {
        try {
          const fallback = await performOCR(uri, { preferQr: Boolean(opts?.preferQr), contentType, allowAi: false, aiMode: opts?.aiMode, languageHint: opts?.languageHint })
          applyOcr(fallback?.fields || {}, String(fallback?.rawText || ''), fallback?.mode, fallback?.meta)
          setDebugStatus('DONE')
          return
        } catch (fallbackErr: any) {
          const fallbackMsg = withRequestId(tr('OCR failed'))
          setOcrError(fallbackMsg)
          Alert.alert(tr('OCR failed'), fallbackMsg)
          setDebugStatus('ERROR')
          return
        }
      }

      if (code === 'trial_expired') {
        const text = withRequestId(tr('Free trial expired. Choose a plan to continue.'))
        setOcrError(text)
        Alert.alert(tr('OCR unavailable'), text)
        showUpgradeAlert('ocr')
        setDebugStatus('ERROR')
        return
      }

      if (code === 'ocr_not_allowed') {
        const text = withRequestId(tr('OCR not available on your plan.'))
        setOcrError(text)
        Alert.alert(tr('OCR unavailable'), text)
        showUpgradeAlert('ocr')
        setDebugStatus('ERROR')
        return
      }

      if (code === 'ocr_quota_exceeded' || /quota/i.test(msg)) {
        const resetAt = (e as any)?.resetAt || null
        const dateLabel = formatResetDate(resetAt)
        const text = dateLabel
          ? tr('You reached the monthly OCR limit. Continue after {date} or upgrade.', { date: dateLabel })
          : tr('OCR monthly quota exceeded.')
        setOcrError(withRequestId(text))
        Alert.alert(tr('OCR unavailable'), withRequestId(text))
        showUpgradeAlert('ocr')
        setDebugStatus('ERROR')
        return
      }

      if (code === 'pdf_no_text') {
        const text = withRequestId(tr('This PDF has no selectable text (scanned). Please import an image instead.'))
        setOcrError(text)
        Alert.alert(tr('OCR failed'), text)
        setDebugStatus('ERROR')
        return
      }

      if (code === 'file_too_large') {
        const text = withRequestId(tr('File too large for OCR.'))
        setOcrError(text)
        Alert.alert(tr('OCR failed'), text)
        setDebugStatus('ERROR')
        return
      }

      // Default: show the server/user-facing message (not stack traces).
      const text = withRequestId(String(msg || tr('OCR failed')))
      setOcrError(text)
      Alert.alert(tr('OCR failed'), text)
      setDebugStatus('ERROR')
    } finally {
      setOcrBusy(false)
    }
  }

  function applyOcr(f: any, ocrText: string, mode?: string, meta?: any) {
    if (typeof ocrText === 'string' && ocrText.trim()) {
      setRawText(ocrText)
      setFormat(mode ? `OCR (${mode})` : 'OCR')
      setParsed(f)
    }
    if (meta && Array.isArray((meta as any).not_found) && (meta as any).not_found.length) {
      console.warn('OCR not found fields:', { mode, not_found: (meta as any).not_found, scanned: (meta as any).scanned })
    }
    const normalizedMode = String(mode || '').trim().toLowerCase()
    const source: 'QR' | 'OCR' | 'GOOGLE' = /qr/.test(normalizedMode)
      ? 'QR'
      : (/vision/.test(normalizedMode) ? 'GOOGLE' : 'OCR')
    applyDataToForm(source, { ...f }, ocrText)
    // Do not directly overwrite form fields here; mapping happens via applyExtractedPaymentFields with strict precedence.

    setUseDataActive(true)
    setCameraVisible(false)
    setTorch('off')
  }

  async function extractWithOCRBase64(base64: string, contentType?: string, opts?: { preferQr?: boolean; allowAi?: boolean; aiMode?: string; languageHint?: string }) {
    if (!entitlements.canUseOCR) {
      showUpgradeAlert('ocr')
      return
    }
    try {
      setOcrError(null)
      setOcrBusy(true)
      setDebugStatus('RUNNING')
      setDebugQrFound(null)
      setDebugAiInfo(null)
      setDebugFileInfo({ source: 'preview', size: Math.floor(String(base64 || '').length * 0.75) })
      setDebugRequestId(null)
      const primary = await performOCRFromBase64(base64, contentType || 'image/jpeg', { preferQr: Boolean(opts?.preferQr), allowAi: Boolean(opts?.allowAi), aiMode: opts?.aiMode, languageHint: opts?.languageHint })
      const ocrText = String(primary?.rawText || '')
      const f = primary?.fields || {}
      const summary = String(primary?.summary || '')
      const isEmpty = !ocrText.trim() && !f?.iban && !f?.reference && !(typeof f?.amount === 'number')
      if (isEmpty) {
        const fallback = await performOCRFromBase64(base64, contentType || 'image/jpeg', { preferQr: Boolean(opts?.preferQr), allowAi: false, aiMode: opts?.aiMode, languageHint: opts?.languageHint })
        const fallbackSummary = String(fallback?.summary || '')
        applyOcr(fallback?.fields || {}, String(fallback?.rawText || ''), fallback?.mode, fallback?.meta)
        if (fallbackSummary && fallbackSummary !== tr('No fields found')) {
          // Optional: leave silent, but keep summary available via rawText.
        }
      } else {
        applyOcr(f, ocrText, primary?.mode, primary?.meta)
        if (summary && summary !== tr('No fields found')) {
          // Optional: leave silent, but keep summary available via rawText.
        }
      }
      setDebugStatus('DONE')
      setDebugQrFound(/qr/i.test(String(primary?.mode || '')))
      setDebugOcrLength(String(ocrText || '').length)
      setDebugOcrMode(String(primary?.mode || '') || null)
      setDebugAiInfo({
        called: Boolean(primary?.ai),
        model: primary?.aiModel || null,
        tier: primary?.aiTier || null,
        enabled: primary?.meta?.ai?.enabled ?? null,
        attempted: primary?.meta?.ai?.attempted ?? null,
        error: primary?.meta?.ai?.error ?? null,
        mode: String(primary?.mode || '') || null,
      })
    } catch (e: any) {
      const msg = e?.message || tr('OCR failed')
      const status = (e as any)?.status
      const code = (e as any)?.code
      const requestId = (e as any)?.requestId
      if (requestId) setDebugRequestId(requestId)
      const withRequestId = (base: string) => requestId ? `${base}\n${tr('Request ID')}: ${requestId}` : base
      console.warn('OCR failed:', { status, code, msg })

      const shouldFallback = status === 500 || status === 502 || status === 503 || status === 504 || code === 'timeout' || /timeout/i.test(msg)
      if (shouldFallback) {
        try {
          const fallback = await performOCRFromBase64(base64, contentType || 'image/jpeg', { preferQr: Boolean(opts?.preferQr), allowAi: false, aiMode: opts?.aiMode, languageHint: opts?.languageHint })
          applyOcr(fallback?.fields || {}, String(fallback?.rawText || ''), fallback?.mode, fallback?.meta)
          setDebugStatus('DONE')
          return
        } catch {
          const fallbackMsg = withRequestId(tr('OCR failed'))
          setOcrError(fallbackMsg)
          Alert.alert(tr('OCR failed'), fallbackMsg)
          setDebugStatus('ERROR')
          return
        }
      }

      if (status === 401 || code === 'auth_required' || /sign in/i.test(msg)) {
        const text = withRequestId(tr('Please sign in again.'))
        setOcrError(text)
        Alert.alert(tr('OCR unavailable'), text)
        return
      }

      if (code === 'trial_expired') {
        const text = withRequestId(tr('Free trial expired. Choose a plan to continue.'))
        setOcrError(text)
        Alert.alert(tr('OCR unavailable'), text)
        showUpgradeAlert('ocr')
        return
      }

      if (code === 'ocr_not_allowed') {
        const text = withRequestId(tr('OCR not available on your plan.'))
        setOcrError(text)
        Alert.alert(tr('OCR unavailable'), text)
        showUpgradeAlert('ocr')
        return
      }

      if (code === 'ocr_quota_exceeded' || /quota/i.test(msg)) {
        const resetAt = (e as any)?.resetAt || null
        const dateLabel = formatResetDate(resetAt)
        const text = dateLabel
          ? tr('You reached the monthly OCR limit. Continue after {date} or upgrade.', { date: dateLabel })
          : tr('OCR monthly quota exceeded.')
        setOcrError(withRequestId(text))
        Alert.alert(tr('OCR failed'), withRequestId(text))
        showUpgradeAlert('ocr')
        return
      }

      if (code === 'pdf_no_text') {
        const text = withRequestId(tr('This PDF has no selectable text (scanned). Please import an image instead.'))
        setOcrError(text)
        Alert.alert(tr('OCR failed'), text)
        return
      }

      if (code === 'file_too_large') {
        const text = withRequestId(tr('File too large for OCR.'))
        setOcrError(text)
        Alert.alert(tr('OCR failed'), text)
        return
      }

      const text = withRequestId(String(msg || tr('OCR failed')))
      setOcrError(text)
      Alert.alert(tr('OCR failed'), text)
      setDebugStatus('ERROR')
    } finally {
      setOcrBusy(false)
    }
  }

  const handleManualExtract = () => {
    if (!manual.trim()) {
      setMissingManualVisible(true)
      return
    }
    const text = manual.trim()
    if (/\bBCD\b|UPNQR/i.test(text)) {
      handleDecodedText(text)
      return
    }
    void (async () => {
      try {
        setOcrError(null)
        const res = await extractTextWithAI(text)
        applyDataToForm('OCR', res.fields || {}, res.rawText || text)
        setUseDataActive(true)
        setCameraVisible(false)
        setTorch('off')
      } catch (e: any) {
        const msg = e?.message || tr('OCR failed')
        setOcrError(msg)
        Alert.alert(tr('OCR failed'), msg)
      }
    })()
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

  const handleSaveBill = async (overrideArchiveOnly?: boolean, opts?: { showAlert?: boolean }): Promise<boolean> => {
    const showAlert = opts?.showAlert !== false
    const supplierTrimmed = supplier.trim()
    const invoiceTrimmed = invoiceNumber.trim()
    const currencyTrimmed = currency.trim().toUpperCase()
    const amt = Number(String(amountStr).replace(',', '.'))
    const isArchiveOnly = typeof overrideArchiveOnly === 'boolean' ? overrideArchiveOnly : archiveOnly

    const missing = {
      supplier: !supplierTrimmed,
      purchaseItem: !purchaseItem.trim(),
      invoice: !invoiceTrimmed,
      amount: !Number.isFinite(amt) || amt <= 0,
      currency: !currencyTrimmed || currencyTrimmed === 'UNKNOWN',
    }

    if (missing.purchaseItem) {
      setMissingBasicFields((prev) => ({ ...prev, purchaseItem: true }))
      Alert.alert(tr('Missing data'), tr('Please fill all required fields.'))
      return false
    }

    if (!isArchiveOnly) {
      if (missing.supplier || missing.purchaseItem || missing.amount || missing.currency) {
        setMissingBasicFields({
          supplier: missing.supplier,
          purchaseItem: missing.purchaseItem,
          invoice: false,
          amount: missing.amount,
          currency: missing.currency,
        })
        Alert.alert(tr('Missing data'), tr('Please fill all required fields.'))
        return false
      }
      if (!Number.isFinite(amt) || amt <= 0) {
        Alert.alert(tr('Invalid amount'), tr('Provide a numeric amount greater than 0.'))
        return false
      }
    }
    const trimmedDue = dueDate.trim()
    const effectiveDueDate = trimmedDue || new Date().toISOString().slice(0, 10)

    const inv = invoiceNumber.trim()
    const paymentLabel = tr('Payment')
    const defaultPurposeFromInvoice = inv ? `${paymentLabel} ${inv}` : ''
    const purchaseItemTrimmed = purchaseItem.trim()
    const payerForPurpose = payerName.trim()
    const referenceModelTrimmed = normalizeReferenceModel(referenceModel)
    const referenceNumberTrimmed = normalizeReferenceNumber(reference.trim())
    const referenceFull = referenceModelTrimmed
      ? buildReferenceFromModel(referenceModelTrimmed, referenceNumberTrimmed)
      : normalizeReference(referenceNumberTrimmed)

    if (!isArchiveOnly) {
      const effectivePurpose = purpose.trim() || purchaseItemTrimmed || defaultPurposeFromInvoice || (payerForPurpose ? `${paymentLabel} ${payerForPurpose}` : paymentLabel)
      const paymentDetailsTrimmed = paymentDetails.trim()
      if (!creditorName.trim()) {
        Alert.alert(tr('Creditor required'), tr('Enter the creditor/payee name (often the same as the supplier).'))
        return false
      }
      // Payment instructions (to pay): IBAN + reference are mandatory.
      if (!iban.trim()) {
        Alert.alert(tr('IBAN required'), tr('Enter the IBAN for the payment.'))
        return false
      }
      const ibanNorm = normalizeIban(iban)
      if (!isValidIbanChecksum(ibanNorm)) {
        Alert.alert(tr('Invalid IBAN'), tr('IBAN checksum failed. Please double-check it.'))
        return false
      }
      if (!referenceNumberTrimmed) {
        Alert.alert(tr('Reference required'), tr('Enter the payment reference.'))
        return false
      }
      const refNorm = normalizeReference(referenceFull)
      if (looksLikeIban(refNorm) && isValidIbanChecksum(refNorm)) {
        Alert.alert(tr('Invalid reference'), tr('Reference looks like an IBAN. Please move it to the IBAN field.'))
        return false
      }
      if (refNorm === ibanNorm) {
        Alert.alert(tr('Invalid reference'), tr('Reference must not be the same as IBAN.'))
        return false
      }
      if (!effectivePurpose && !paymentDetailsTrimmed) {
        Alert.alert(tr('Purpose required'), tr('Enter the payment purpose/description.'))
        return false
      }
      if (!trimmedDue) {
        Alert.alert(tr('Due date required'), tr('Add a due date so reminders can be scheduled.'))
        return false
      }
      if (!pendingAttachment?.uri) {
        Alert.alert(tr('Attachment required'), tr('Attach a PDF or image of the original bill.'))
        return false
      }
    }
    try {
      setSaving(true)
      let s = supabase

      // Resolve payer/profile scope to a UUID for the database.
      // Prevent sending labels like "personal" into UUID columns.
      let dbSpaceId = s ? await resolveDbSpaceId(s, spaceId, entitlements) : null
      if (s && !dbSpaceId) {
        const fallback = await resolveDbSpaceId(s, 'personal', entitlements)
        if (fallback && isUuidString(fallback)) {
          if (spaceId !== 'personal') {
            try { await spacesCtx.setCurrent('personal') } catch {}
          }
          dbSpaceId = fallback
        }
      }
      if (s && !dbSpaceId) {
        if (isArchiveOnly) {
          s = null
        } else {
          Alert.alert(tr('Save failed'), tr('Active profile is not available. Please try again.'))
          setSaving(false)
          return false
        }
      }

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
            if (dbSpaceId) q = q.eq('space_id', dbSpaceId)
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
            return false
          }
        } catch {}
      }
      let savedId: string | null = null

      if (s) {
        const effectivePurpose = purpose.trim() || purchaseItemTrimmed || defaultPurposeFromInvoice || (payerForPurpose ? `${paymentLabel} ${payerForPurpose}` : paymentLabel)
        const details = paymentDetails.trim()
        const combinedPurpose = details
          ? (effectivePurpose ? `${effectivePurpose}\n\n${tr('Payment details')}:\n${details}` : `${tr('Payment details')}:\n${details}`)
          : effectivePurpose

        const saveSupplier = supplierTrimmed || creditorName.trim() || (pendingAttachment?.name ? String(pendingAttachment.name).replace(/\.[^.]+$/, '') : '') || 'Archived bill'
        const saveCurrency = currencyTrimmed || 'EUR'
        const saveAmount = isArchiveOnly ? (Number.isFinite(amt) && amt > 0 ? amt : 0) : amt
        const desiredStatus: BillStatus = isArchiveOnly ? 'archived' : 'pending'
        const makeArchiveMarkerPurpose = (p: string) => {
          const base = String(p || '').trim()
          return base ? `${ARCHIVE_PURPOSE_MARKER}\n${base}` : ARCHIVE_PURPOSE_MARKER
        }

        const { data, error } = await createBill(s, {
          supplier: saveSupplier,
          amount: saveAmount,
          currency: saveCurrency,
          due_date: effectiveDueDate,
          status: desiredStatus,
          creditor_name: (creditorName.trim() || saveSupplier) || null,
          iban: iban.trim() || null,
          reference: referenceFull || null,
          reference_model: referenceModelTrimmed || null,
          category: category || null,
          purpose: combinedPurpose || null,
          invoice_number: invoiceTrimmed || null,
          space_id: dbSpaceId,
        })
        if (error) {
          const rawMsg = String(error.message || '')
          const looksLikeStatusConstraint = /bills\s+status\s+check|check\s+constraint.*status|violates\s+check\s+constraint/i.test(rawMsg)
          // Backward-compatible archive save: if DB does not support status='archived', store as paid with an internal marker.
          if (isArchiveOnly && looksLikeStatusConstraint) {
            const retry = await createBill(s, {
              supplier: saveSupplier,
              amount: saveAmount,
              currency: saveCurrency,
              due_date: effectiveDueDate,
              status: 'paid',
              creditor_name: (creditorName.trim() || saveSupplier) || null,
              iban: iban.trim() || null,
              reference: referenceFull || null,
              reference_model: referenceModelTrimmed || null,
              category: category || null,
              purpose: makeArchiveMarkerPurpose(combinedPurpose || ''),
              invoice_number: invoiceTrimmed || null,
              space_id: dbSpaceId,
            })
            if (retry.error) {
              Alert.alert(tr('Save failed'), tr('Save failed: unsupported bill status. Please update the app.'))
              setSaving(false)
              return false
            }
            savedId = retry.data?.id || null
          } else {
            const msg = looksLikeStatusConstraint
              ? tr('Save failed: unsupported bill status. Please update the app.')
              : rawMsg
            Alert.alert(tr('Save failed'), msg)
            setSaving(false)
            return false
          }
        }
        if (!savedId) savedId = data?.id || null
      } else {
        const effectivePurpose = purpose.trim() || purchaseItemTrimmed || defaultPurposeFromInvoice || (payerForPurpose ? `${paymentLabel} ${payerForPurpose}` : paymentLabel)
        const details = paymentDetails.trim()
        const combinedPurpose = details
          ? (effectivePurpose ? `${effectivePurpose}\n\n${tr('Payment details')}:\n${details}` : `${tr('Payment details')}:\n${details}`)
          : effectivePurpose

        const saveSupplier = supplierTrimmed || creditorName.trim() || (pendingAttachment?.name ? String(pendingAttachment.name).replace(/\.[^.]+$/, '') : '') || 'Archived bill'
        const saveCurrency = currencyTrimmed || 'EUR'
        const saveAmount = isArchiveOnly ? (Number.isFinite(amt) && amt > 0 ? amt : 0) : amt
        const local = await addLocalBill(spaceId, {
          supplier: saveSupplier,
          amount: saveAmount,
          currency: saveCurrency,
          due_date: effectiveDueDate,
          status: isArchiveOnly ? 'archived' : 'pending',
          creditor_name: (creditorName.trim() || saveSupplier) || null,
          iban: iban.trim() || null,
          reference: referenceFull || null,
          reference_model: referenceModelTrimmed || null,
          category: category || null,
          purpose: combinedPurpose || null,
          invoice_number: invoiceTrimmed || null,
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

      if (showAlert) {
        showSaveNotice(isArchiveOnly ? tr('Saved as archived (already paid)') : (s ? tr('Bill created successfully') : tr('Saved locally (Not synced)')))
      }
      clearExtraction()
      try { (navigation as any)?.navigate?.('Bills', { highlightBillId: savedId }) } catch {}
      return true
    } catch (e: any) {
      Alert.alert(tr('Save error'), e?.message || tr('Unable to save.'))
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleArchiveImmediate = async () => {
    setArchiveOnly(true)
    const ok = await handleSaveBill(true, { showAlert: false })
    if (ok) showSaveNotice(tr('Saved to archive'))
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
        <TabTopBar titleKey="Add bill" />

        {spacesCtx.spaces.length > 1 ? (
          <Surface elevated>
            <SectionHeader title="Profile" />
            <SegmentedControl
              value={spacesCtx.current?.id || spaceId || ''}
              onChange={(id) => { spacesCtx.setCurrent(id) }}
              options={spacesCtx.spaces.map((s) => ({ value: s.id, label: s.name }))}
              activeBgColor={themeColors.primary}
              activeTextColor="#FFFFFF"
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

        {saveNotice ? (
          <InlineInfo tone="success" iconName="checkmark-circle-outline" message={saveNotice} />
        ) : null}

        {!permission?.granted ? (
          <Surface elevated>
            <SectionHeader title={tr('Capture bill')} />
            <Text style={styles.mutedText}>{tr('Scan a QR code or import a bill image/PDF to start a draft.')}</Text>
            <View style={styles.actionRow}>
              <AppButton label={tr('Enable camera')} iconName="camera-outline" onPress={requestPermission} style={styles.addBillActionButton} />
              <AppButton label={(ocrBusy && ocrBusyAction === 'photo') ? tr('Extracting…') : tr('Import photo')} variant="secondary" iconName="image-outline" onPress={pickImage} loading={ocrBusy && ocrBusyAction === 'photo'} style={styles.addBillActionButton} />
              <AppButton label={(ocrBusy && ocrBusyAction === 'pdf') ? tr('Extracting…') : tr('Import PDF')} variant="secondary" iconName="document-text-outline" onPress={pickPdfForOCR} loading={ocrBusy && ocrBusyAction === 'pdf'} style={styles.addBillActionButton} />
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
                <Text style={styles.helperText}>{tr('Align the QR code inside the frame. We will extract IBAN, reference, and amount automatically.')}</Text>
                <View style={styles.cameraActions}>
                  <AppButton
                    label={torch === 'on' ? tr('Torch off') : tr('Torch on')}
                    variant="ghost"
                    iconName={torch === 'on' ? 'flash-off-outline' : 'flash-outline'}
                    onPress={() => setTorch((prev) => (prev === 'on' ? 'off' : 'on'))}
                  />
                  <AppButton
                    label={(ocrBusy && ocrBusyAction === 'photo') ? tr('Extracting…') : tr('Import photo')}
                    variant="outline"
                    iconName="image-outline"
                    onPress={pickImage}
                    loading={ocrBusy && ocrBusyAction === 'photo'}
                    style={styles.addBillActionButton}
                  />
                  <AppButton
                    label={(ocrBusy && ocrBusyAction === 'pdf') ? tr('Extracting…') : tr('Import PDF')}
                    variant="outline"
                    iconName="document-text-outline"
                    onPress={pickPdfForOCR}
                    loading={ocrBusy && ocrBusyAction === 'pdf'}
                    style={styles.addBillActionButton}
                  />
                </View>
              </>
            ) : (
              <View style={styles.capturePlaceholder}>
                <Ionicons name="scan-outline" size={36} color={themeColors.primary} />
                <Text style={styles.captureMessage}>{tr('QR details captured. Review the draft below or scan again if anything looks off.')}</Text>
                <View style={styles.captureActions}>
                  <AppButton
                    label={tr('Scan again')}
                    variant="outline"
                    iconName="scan-outline"
                    onPress={() => {
                      setCameraVisible(true)
                      setLastQR('')
                      setTorch('off')
                    }}
                    style={styles.addBillActionButton}
                  />
                  <AppButton
                    label={(ocrBusy && ocrBusyAction === 'photo') ? tr('Extracting…') : tr('Import photo')}
                    variant="outline"
                    iconName="image-outline"
                    onPress={pickImage}
                    loading={ocrBusy && ocrBusyAction === 'photo'}
                    style={styles.addBillActionButton}
                  />
                  <AppButton
                    label={(ocrBusy && ocrBusyAction === 'pdf') ? tr('Extracting…') : tr('Import PDF')}
                    variant="outline"
                    iconName="document-text-outline"
                    onPress={pickPdfForOCR}
                    loading={ocrBusy && ocrBusyAction === 'pdf'}
                    style={styles.addBillActionButton}
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

        <Surface elevated style={styles.formCard}>
          <SectionHeader title={tr('Bill draft')} actionLabel={tr('Clear')} onActionPress={clearExtraction} />
          <Text style={styles.formIntro}>{tr('Double-check every field before saving.')}</Text>
          {null}

          <View style={styles.formSection}>
            <Text style={styles.formSectionTitle}>{tr('Summary')}</Text>
            <View style={styles.formStack}>
              {pendingAttachment && (
                <View style={styles.attachmentPreviewCompact}>
                  <Text style={styles.mutedText}>{tr('Staged attachment:')} {pendingAttachment.name}</Text>
                  {pendingAttachment.type?.startsWith('image/') && (
                    <Image source={{ uri: pendingAttachment.uri }} style={styles.attachmentImageSmall} />
                  )}
                </View>
              )}
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>
                  {tr('Supplier')}
                  <Text style={styles.requiredStar}> *</Text>
                </Text>
                <AppInput placeholder={tr('Supplier')} value={supplier} onChangeText={handleSupplierInput} style={missingBasicFields.supplier ? styles.inputError : undefined} />
                {missingBasicFields.supplier ? <Text style={styles.fieldErrorText}>{tr('Required field')}</Text> : null}
              </View>
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>
                  {tr('Purchase item')}
                  <Text style={styles.requiredStar}> *</Text>
                </Text>
                <AppInput
                  placeholder={tr('Purchase item')}
                  value={purchaseItem}
                  onChangeText={handlePurchaseItemInput}
                  style={missingBasicFields.purchaseItem ? styles.inputError : undefined}
                />
                {missingBasicFields.purchaseItem ? <Text style={styles.fieldErrorText}>{tr('Required field')}</Text> : null}
              </View>
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>{tr('Category')}</Text>
                <TouchableOpacity
                  activeOpacity={0.88}
                  onPress={() => setCategoryPickerVisible(true)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 12,
                    backgroundColor: 'rgba(148, 163, 184, 0.10)',
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: themeColors.border,
                  }}
                >
                  <Text style={{ color: themeColors.text, fontSize: 13, fontWeight: '700' }}>
                    {category ? getCategoryLabel(category) : tr('Determining category…')}
                  </Text>
                  <Ionicons name="chevron-down-outline" size={18} color={themeColors.muted} />
                </TouchableOpacity>
              </View>
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>
                  {tr('Invoice number')}
                  <Text style={styles.requiredStar}> *</Text>
                </Text>
                <AppInput
                  placeholder={tr('Invoice number')}
                  value={invoiceNumber}
                  onChangeText={handleInvoiceNumberInput}
                  hint={tr('Required for accounting.')}
                  style={missingBasicFields.invoice ? styles.inputError : undefined}
                />
                {missingBasicFields.invoice ? <Text style={styles.fieldErrorText}>{tr('Required field')}</Text> : null}
              </View>
              <View style={styles.formRow}>
                <View style={[styles.flex1, { gap: 6 }]}>
                  <Text style={styles.fieldLabel}>
                    {tr('Amount')}
                    <Text style={styles.requiredStar}> *</Text>
                  </Text>
                  <AppInput placeholder={tr('Amount')} value={amountStr} onChangeText={handleAmountInput} keyboardType="numeric" style={missingBasicFields.amount ? styles.inputError : undefined} />
                  {missingBasicFields.amount ? <Text style={styles.fieldErrorText}>{tr('Required field')}</Text> : null}
                </View>
                <View style={{ gap: 6, width: 90 }}>
                  <Text style={styles.fieldLabel}>{tr('Currency')}</Text>
                  <AppInput placeholder={tr('Currency')} value={currency} onChangeText={handleCurrencyInput} style={missingBasicFields.currency ? styles.inputError : undefined} />
                  {missingBasicFields.currency ? <Text style={styles.fieldErrorText}>{tr('Required field')}</Text> : null}
                </View>
              </View>

              <View style={{ marginTop: themeSpacing.xs, flexDirection: 'row', gap: themeSpacing.xs }}>
                <AppButton
                  label={tr('Archive')}
                  variant="primary"
                  iconName="archive-outline"
                  onPress={handleArchiveImmediate}
                  disabled={saving}
                />
                <AppButton
                  label={ocrBusy ? tr('Extracting…') : tr('To pay')}
                  variant="secondary"
                  iconName="card-outline"
                  onPress={() => {
                    setArchiveOnly(false)
                    if (parsed && /EPC|UPN|URL|qr/i.test(String(format || ''))) {
                      applyExtractedPaymentFields({ ...parsed, rawText }, 'qr')
                    }
                    if (pendingAttachment?.uri) {
                      const languageHint = getCurrentLang()
                      void extractWithOCR(
                        pendingAttachment.uri,
                        pendingAttachment.type || undefined,
                        { preferQr: true, allowAi: true, aiMode: 'document', languageHint },
                      )
                    }
                  }}
                  disabled={ocrBusy}
                />
              </View>

              {!archiveOnly && (
                <View style={{ gap: themeSpacing.xs }}>
                  <Text style={styles.formSectionTitle}>{tr('Dates')}</Text>
                  <View style={styles.formRow}>
                    <View style={[styles.flex1, { gap: 6 }]}>
                      <Text style={styles.fieldLabel}>
                        {tr('Due date')}
                        <Text style={styles.requiredStar}> *</Text>
                      </Text>
                      <AppInput
                        placeholder={tr('Due date (YYYY-MM-DD)')}
                        value={dueDate}
                        onChangeText={handleDueDateInput}
                        hint={tr('Due date (used for reminders and overdue status).')}
                      />
                    </View>
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
              )}
            </View>
          </View>

          {!archiveOnly && (
            <>
              <Divider style={styles.formDivider} />

              <View style={styles.formSection}>
                <Text style={styles.formSectionTitle}>{tr('Payment details')}</Text>
                <View style={styles.formStack}>
                  <View style={{ gap: 6 }}>
                    <Text style={styles.fieldLabel}>
                      {tr('Creditor')}
                      <Text style={styles.requiredStar}> *</Text>
                    </Text>
                    <AppInput placeholder={tr('Creditor')} value={creditorName} onChangeText={handleCreditorNameInput} />
                  </View>
                  <View style={{ gap: 6 }}>
                    <Text style={styles.fieldLabel}>
                      {tr('IBAN')}
                      <Text style={styles.requiredStar}> *</Text>
                    </Text>
                    <AppInput
                      placeholder={tr('IBAN')}
                      value={iban}
                      onChangeText={handleIbanChange}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      keyboardType="default"
                    />
                    {ibanHint ? (
                      <InlineInfo tone="warning" iconName="alert-circle-outline" message={ibanHint} style={styles.formNotice} />
                    ) : null}
                  </View>
                  <View style={{ gap: 6 }}>
                    <Text style={styles.fieldLabel}>
                      {tr('Reference')}
                      <Text style={styles.requiredStar}> *</Text>
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <View style={{ width: 90 }}>
                        <AppInput
                          placeholder={tr('SI 12')}
                          value={referenceModel}
                          onChangeText={handleReferenceModelChange}
                          autoCapitalize="characters"
                          autoCorrect={false}
                          keyboardType="default"
                          maxLength={5}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <AppInput
                          placeholder={tr('Reference number')}
                          value={reference}
                          onChangeText={handleReferenceChange}
                          autoCapitalize="characters"
                          autoCorrect={false}
                          keyboardType="default"
                        />
                      </View>
                    </View>
                    {referenceHint ? (
                      <InlineInfo tone="info" iconName="information-circle-outline" message={referenceHint} style={styles.formNotice} />
                    ) : null}
                  </View>
                  <View style={{ gap: 6 }}>
                    <Text style={styles.fieldLabel}>{tr('Payment details (routing/SWIFT/account)')}</Text>
                    <AppInput
                      placeholder={tr('Paste bank details here if you do not have IBAN/reference.')}
                      value={paymentDetails}
                      onChangeText={handlePaymentDetailsChange}
                      multiline
                    />
                  </View>
                  <View style={{ gap: 6 }}>
                    <Text style={styles.fieldLabel}>
                      {tr('Purpose')}
                      <Text style={styles.requiredStar}> *</Text>
                    </Text>
                    <AppInput placeholder={tr('Purpose')} value={purpose} onChangeText={handlePurposeInput} multiline />
                  </View>
                </View>
              </View>

              <Divider style={styles.formDivider} />
            </>
          )}

          <View style={styles.formSection}>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
              <AppButton
                label={tr('Clear form')}
                variant="ghost"
                iconName="trash-outline"
                onPress={() => {
                  Alert.alert(
                    tr('Clear this draft?'),
                    tr('This will clear all entered fields and remove the staged attachment.'),
                    [
                      { text: tr('Cancel'), style: 'cancel' },
                      {
                        text: tr('Clear'),
                        style: 'destructive',
                        onPress: () => {
                          try { clearExtraction() } catch {}
                          try { setPendingAttachment(null) } catch {}
                        },
                      },
                    ]
                  )
                }}
              />
            </View>
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
                  resetInvoiceAndItemAutofillForNewAttachment()
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
                  resetInvoiceAndItemAutofillForNewAttachment()
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

          {!archiveOnly && (
            <AppButton
              label={saving ? tr('Saving bill for payment…') : tr('Save bill for payment')}
              iconName="save-outline"
              onPress={handleSaveBill}
              loading={saving}
              style={styles.saveButton}
            />
          )}
        </Surface>
      </View>


      <Modal
        visible={ibanPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIbanPickerVisible(false)}
      >
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
          <Surface elevated style={{ width: '100%', maxWidth: 520, alignSelf: 'center' }}>
            <Text style={styles.screenHeaderTitle}>{tr('Choose IBAN')}</Text>
            <Text style={[styles.bodyText, { marginTop: themeSpacing.xs }]}>{tr('Multiple IBANs found — choose one.')}</Text>
            <View style={{ marginTop: themeSpacing.md, gap: themeSpacing.xs }}>
              {ibanOptions.map((candidate) => (
                <AppButton
                  key={candidate}
                  label={candidate}
                  variant="secondary"
                  onPress={() => {
                    editedRef.current.iban = true
                    setIban(candidate)
                    setIbanHint(null)
                    setIbanOptions([])
                    setIbanPickerVisible(false)
                  }}
                />
              ))}
            </View>
            <View style={{ marginTop: themeSpacing.md, alignItems: 'flex-end' }}>
              <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setIbanPickerVisible(false)} />
            </View>
          </Surface>
        </View>
      </Modal>

      <Modal
        visible={categoryPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCategoryPickerVisible(false)}
      >
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
          <Surface elevated style={{ width: '100%', maxWidth: 520, alignSelf: 'center' }}>
            <Text style={styles.screenHeaderTitle}>{tr('Category')}</Text>
            <Text style={[styles.bodyText, { marginTop: themeSpacing.xs }]}>{tr('Select category')}</Text>
            <View style={{ marginTop: themeSpacing.md, gap: themeSpacing.xs }}>
              {CATEGORY_OPTIONS_PICKER.map((opt) => (
                <AppButton
                  key={opt.key}
                  label={tr(opt.labelKey)}
                  variant={category === opt.key ? 'primary' : 'secondary'}
                  onPress={() => {
                    try { editedRef.current.category = true } catch {}
                    setCategory(opt.key)
                    setCategoryPickerVisible(false)
                    const supplierKey = normalizeSupplierKey(String(supplier || creditorName || '').trim())
                    if (supplierKey) void persistCategoryOverride(supplierKey, opt.key)
                  }}
                />
              ))}
            </View>
            <View style={{ marginTop: themeSpacing.md, alignItems: 'flex-end' }}>
              <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setCategoryPickerVisible(false)} />
            </View>
          </Surface>
        </View>
      </Modal>

      <Modal
        visible={missingManualVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMissingManualVisible(false)}
      >
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
          <Surface elevated style={{ width: '100%', maxWidth: 520, alignSelf: 'center' }}>
            <Text style={styles.screenHeaderTitle}>{tr('Missing data')}</Text>
            <Text style={[styles.bodyText, { marginTop: themeSpacing.xs }]}>{tr('Paste QR text to extract payment fields.')}</Text>
            <View style={{ marginTop: themeSpacing.md, alignItems: 'flex-end' }}>
              <AppButton label={tr('OK')} onPress={() => setMissingManualVisible(false)} />
            </View>
          </Surface>
        </View>
      </Modal>
    </Screen>
  )
}

function InboxScreen() {
  const navigation = useNavigation<any>()
  const route = useRoute<any>()
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()
  const supabase = useMemo(() => getSupabase(), [])
  const [items, setItems] = useState<InboxItem[]>([])
  const [filter, setFilter] = useState<'pending' | 'archived' | 'all'>('pending')
  const [busy, setBusy] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)

  // Local inbox is stored per app profile slot (e.g. "personal", "personal2").
  const inboxSpaceKey = spaceId || 'default'
  // Server inbox is scoped by the real space UUID.
  const serverSpaceId = space?.id || null

  const formatResetDate = useCallback((iso: string | null | undefined) => {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      return d.toISOString().slice(0, 10)
    } catch {
      return String(iso)
    }
  }, [])

  const stripHtml = (input: string) => {
    const raw = String(input || '')
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  const guessExtensionFromMime = (mimeType?: string | null): string => {
    const m = String(mimeType || '').toLowerCase()
    if (!m) return ''
    if (m.includes('pdf')) return '.pdf'
    if (m.includes('png')) return '.png'
    if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
    if (m.includes('heic')) return '.heic'
    if (m.includes('tiff') || m.includes('tif')) return '.tif'
    return ''
  }

  const ensureFilenameHasExtension = (name: string, mimeType?: string | null): string => {
    const n = String(name || '').trim() || 'document'
    // If it already ends with ".ext" (2-6 chars), keep it.
    if (/\.[a-z0-9]{2,6}$/i.test(n)) return n
    const ext = guessExtensionFromMime(mimeType)
    return ext ? `${n}${ext}` : n
  }

  const buildInvoiceClassifierText = (item: InboxItem, meta: any, subject?: string | null) => {
    const parts: string[] = []
    if (subject) parts.push(String(subject))
    if (item?.name) parts.push(String(item.name))
    const bodyText = meta?.body_text ? String(meta.body_text) : ''
    const bodyHtml = meta?.body_html ? String(meta.body_html) : ''
    if (bodyText) parts.push(bodyText)
    if (bodyHtml) parts.push(stripHtml(bodyHtml))
    return parts.join('\n').trim()
  }

  const scoreCommercialDocText = (text: string, mimeType?: string | null) => {
    const t = String(text || '').toLowerCase()
    if (!t) return 0
    let score = 0

    // Document-type keywords (invoice/proforma/offer/quote) across common languages.
    if (/(\bra\u010dun\b|\bracun\b|invoice|faktura|rechnung|fattura|factura|facture|nota\s*fiscale)/i.test(t)) score += 3
    if (/(predra\u010dun|predracun|proforma|pro\s*forma|proforma\s*rechnung|\bangebot\b|ponudba|ponuda|\boffer\b|\bquotation\b|\bquote\b|\bestimate\b|devis|preventivo|\bofferta\b|\bpředra\u010dun\b|\bpr\u00e9facture\b)/i.test(t)) score += 3

    // Common invoice/payment signals.
    if (/(\bznesek\b|total|amount|balance\s*due|sum|skupaj|ukupno|totale|gesamt|\bimporte\b)/i.test(t)) score += 1
    if (/(\bddv\b|vat|pdv|\biva\b|mwst)/i.test(t)) score += 1
    if (/(rok\s*pla\S*|due\s*date|pay\s*by|payment\s*due|f\u00e4llig|scadenza|\bech\u00e9ance\b)/i.test(t)) score += 1
    if (/(iban|trr|bank\s*account|\bbic\b|swift)/i.test(t)) score += 1
    if (/(sklic|reference|ref\.?|model|poziv\s*na\s*broj|\bvariabilni\b)/i.test(t)) score += 1
    if (/(\bEUR\b|\bUSD\b|\bGBP\b|€|\$|£)/i.test(t)) score += 1
    if (/(invoice\s*(no|number)|\b\u0161t\.?\s*ra\u010duna\b|ra\u010dun\s*\u0161t|\brechnungs?nr\b|\bfattura\s*n\b|\bfacture\s*n\b|\bfactura\s*n\b)/i.test(t)) score += 1
    if (/(UPNQR|\bBCD\b)/i.test(t)) score += 2

    // Negative signals.
    if (/(unsubscribe|newsletter|marketing|promo|campaign)/i.test(t)) score -= 2
    if (!/\d/.test(t)) score -= 1

    const mime = String(mimeType || '').toLowerCase()
    if (mime.includes('application/pdf')) score += 1
    if (mime.includes('text/csv') || mime.includes('application/csv')) score += 1
    return score
  }

  const scoreWarrantyText = (text: string) => {
    const t = String(text || '').toLowerCase()
    if (!t) return 0
    let score = 0
    if (/(garancij|garancija|garancijski\s*list|jamstvo|warranty|guarantee|garanzia|garantie|gew\u00e4hrleistung)/i.test(t)) score += 4
    if (/(serial|serijska\s*\u0161t|serijski\s*broj|\bs\/n\b|model|artikel|product|izdelek)/i.test(t)) score += 1
    if (/(valid\s*until|expires|expiry|velja\s*do|datum\s*poteka|scadenza|g\u00fcltig\s*bis)/i.test(t)) score += 1
    if (/(months|mesecev|meseci|mes\.|monat|mesi?ec)/i.test(t)) score += 1
    return score
  }

  const classifyInboxDoc = (text: string, mimeType?: string | null) => {
    const billScore = scoreCommercialDocText(text, mimeType)
    const warrantyScore = scoreWarrantyText(text)
    const kind: 'bill' | 'warranty' | 'other' = warrantyScore >= 4 && warrantyScore >= billScore + 1
      ? 'warranty'
      : (billScore >= 3 ? 'bill' : 'other')
    return { kind, billScore, warrantyScore }
  }

  const syncServerInbox = useCallback(async () => {
    if (!supabase) return
    // Email inbox is a Več-only feature; do not sync on other plans.
    if (entitlements.plan !== 'pro') return
    if (!serverSpaceId) return
    try {
      const { data, error } = await supabase
        .from('inbox_items')
        .select('id, space_id, status, received_at, created_at, attachment_bucket, attachment_path, attachment_name, mime_type, meta, subject, sender')
        .eq('space_id', serverSpaceId)
        .order('received_at', { ascending: false })
        .limit(50)

      if (error) return

      const local = await listInbox(inboxSpaceKey)
      const byId = new Map<string, InboxItem>()
      for (const it of local) byId.set(String(it.id), it)

      const newlyAdded: InboxItem[] = []

      for (const row of (data || []) as any[]) {
        const id = String(row.id)
        if (!id) continue

        const status = (String(row.status || 'new') as any)
        const exists = byId.get(id)
        if (exists) {
          if (status && exists.status !== status) {
            await updateInboxItem(inboxSpaceKey, id, { status })
          }
          continue
        }

        const bucket = String(row.attachment_bucket || 'attachments')
        const path = row.attachment_path ? String(row.attachment_path) : ''
        if (!path) continue

        const { data: signed, error: signedErr } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60)
        if (signedErr || !signed?.signedUrl) continue

        const mimeType = row.mime_type ? String(row.mime_type) : undefined
        const name = ensureFilenameHasExtension(String(row.attachment_name || row.subject || 'email-attachment'), mimeType)
        const createdAt = String(row.received_at || row.created_at || new Date().toISOString())

        const meta = row?.meta && typeof row.meta === 'object' ? { ...row.meta } : {}
        if (row?.subject) meta.subject = row.subject
        if (row?.sender) meta.sender = row.sender
        meta.source = 'email'
        const added = await addToInbox({
          spaceId: inboxSpaceKey,
          id,
          uri: signed.signedUrl,
          name,
          mimeType,
          createdAt,
          status: status || 'new',
          meta,
        })

        byId.set(id, added)
        newlyAdded.push(added)
      }

      if (newlyAdded.length && entitlements?.canUseOCR) {
        for (const it of newlyAdded) {
          try {
            const meta = (it as any).meta || {}
            const subject = meta?.subject ? String(meta.subject) : ''
            const classifierText = buildInvoiceClassifierText(it, meta, subject)
            const cls = classifyInboxDoc(classifierText, it.mimeType || null)

            // Only spend OCR/AI on bills/proformas/offers or warranties.
            if (cls.kind === 'other') {
              await updateInboxItem(inboxSpaceKey, it.id, { notes: tr('Not a bill or warranty'), status: it.status || 'new' })
              await scheduleInboxReviewReminder(it.id, it.name, inboxSpaceKey)
              continue
            }

            const sourceUri = (it as any).localPath || it.uri

            if (cls.kind === 'warranty') {
              const { rawText } = await performOCR(sourceUri, { preferQr: false, allowAi: false, languageHint: getCurrentLang(), contentType: it.mimeType, filename: it.name })
              const w = extractWarrantyFieldsFromOcr(typeof rawText === 'string' ? rawText : '')
              const parts: string[] = []
              if (w.itemName) parts.push(`${tr('Item')}: ${w.itemName}`)
              if (w.supplier) parts.push(`${tr('Supplier')}: ${w.supplier}`)
              if (w.purchaseDate) parts.push(`${tr('Purchase date')}: ${w.purchaseDate}`)
              if (w.expiresAt) parts.push(`${tr('Valid until')}: ${w.expiresAt}`)
              if (w.durationMonths) parts.push(`${tr('Duration')}: ${w.durationMonths} ${tr('months')}`)
              const nextNotes = parts.join('\n') || tr('Warranty document')
              await updateInboxItem(inboxSpaceKey, it.id, { extractedFields: { _kind: 'warranty', ...w, rawText }, notes: nextNotes, status: it.status || 'new' })
              await scheduleInboxReviewReminder(it.id, it.name, inboxSpaceKey)
              continue
            }

            // Bills/proformas/offers: run OCR + AI so the bill form is properly prefilled.
            const { fields, summary, rawText, mode, meta: ocrMeta } = await performOCR(sourceUri, { preferQr: true, allowAi: true, aiMode: 'document', languageHint: getCurrentLang(), contentType: it.mimeType, filename: it.name })
            const classification = ocrMeta?.classification || null
            const clsConf = typeof classification?.confidence === 'number' ? classification.confidence : null
            const hasBasicAmount = Boolean(fields && typeof fields.amount === 'number')
            const sourceHint = /qr/i.test(String(mode || '')) ? 'qr' : 'ocr'
            const enriched = fields ? { ...fields, rawText: typeof rawText === 'string' ? rawText : '', _source: sourceHint, mode, _classification: classification } : fields

            const isInvoice = classification?.isInvoice
            const billLikeOverride = /(predra\u010dun|predracun|proforma|pro\s*forma|proforma\s*rechnung|\bangebot\b|ponudba|ponuda|\boffer\b|\bquotation\b|\bquote\b|\bestimate\b|devis|preventivo|\bofferta\b|\bp\u0159edra\u010dun\b|\bpr\u00e9facture\b)/i.test(String(rawText || ''))
              || /(predra\u010dun|predracun|proforma|pro\s*forma|\bangebot\b|ponudba|ponuda|\boffer\b|\bquotation\b|\bquote\b)/i.test(classifierText)

            const treatAsNotInvoice = isInvoice === false && (clsConf == null || clsConf >= 0.7) && !billLikeOverride
            const treatAsInvoice = isInvoice === true || billLikeOverride || (!treatAsNotInvoice && hasBasicAmount)

            let nextStatus: any = it.status || 'new'
            if (treatAsNotInvoice) nextStatus = it.status || 'new'
            else if (treatAsInvoice) nextStatus = (nextStatus === 'archived') ? 'archived' : 'pending'

            const reason = classification?.reason ? String(classification.reason) : ''
            const nextNotes = treatAsNotInvoice ? (reason ? `${tr('Not an invoice')}: ${reason}` : tr('Not an invoice')) : summary

            await updateInboxItem(inboxSpaceKey, it.id, { extractedFields: enriched, notes: nextNotes, status: nextStatus })
            if (nextStatus === 'pending' || nextStatus === 'archived') await cancelInboxReviewReminder(it.id, inboxSpaceKey)
            else await scheduleInboxReviewReminder(it.id, it.name, inboxSpaceKey)
          } catch (e: any) {
            const code = e?.code || null
            if (code === 'ocr_quota_exceeded') {
              const resetAt = e?.resetAt || null
              const dateLabel = formatResetDate(resetAt)
              const text = dateLabel
                ? tr('You reached the monthly OCR limit. Continue after {date} or upgrade.', { date: dateLabel })
                : tr('OCR monthly quota exceeded.')
              await updateInboxItem(inboxSpaceKey, it.id, { notes: text, status: it.status || 'new' })
            }
            // ignore auto-OCR failures; user can retry manually
          }
        }
      }
    } catch {
      // ignore server inbox sync failures; local inbox still works
    }
  }, [supabase, serverSpaceId, inboxSpaceKey, entitlements?.canUseOCR, entitlements.plan])

  const updateServerInboxStatus = useCallback(async (id: string, status: 'new' | 'pending' | 'processed' | 'archived') => {
    if (!supabase || !serverSpaceId) return false
    const { error } = await supabase
      .from('inbox_items')
      .update({ status })
      .eq('id', id)
      .eq('space_id', serverSpaceId)
    return !error
  }, [supabase, serverSpaceId])

  const deleteServerInboxItem = useCallback(async (id: string) => {
    if (!supabase || !serverSpaceId) return false
    const { error } = await supabase
      .from('inbox_items')
      .delete()
      .eq('id', id)
      .eq('space_id', serverSpaceId)
    return !error
  }, [supabase, serverSpaceId])

  const refresh = useCallback(async () => {
    if (spaceLoading || !space) return
    await syncServerInbox()
    const list = await listInbox(inboxSpaceKey)
    setItems(list)
  }, [spaceLoading, space, inboxSpaceKey, syncServerInbox])

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
      const item = await addToInbox({
        spaceId: inboxSpaceKey,
        uri: file.uri,
        name: file.name || 'document',
        mimeType: file.mimeType || undefined,
        meta: { source: 'device' },
      })
      await scheduleInboxReviewReminder(item.id, item.name, inboxSpaceKey)
      await refresh()
      Alert.alert(tr('Inbox'), tr('Added to Inbox.'))
    } catch (e: any) {
      Alert.alert(tr('Import failed'), e?.message || tr('Could not import this file.'))
    } finally {
      setImporting(false)
    }
  }

  async function runOcr(item: InboxItem) {
    if (!entitlements.canUseOCR) {
      showUpgradeAlert('ocr')
      return
    }
    let kind: 'bill' | 'warranty' | 'other' = 'bill'
    try {
      const meta = (item as any).meta || {}
      const subject = meta?.subject ? String(meta.subject) : ''
      const classifierText = buildInvoiceClassifierText(item, meta, subject)
      kind = classifyInboxDoc(classifierText, item.mimeType || null).kind
    } catch {}

    if (kind === 'other') {
      const proceed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          tr('Inbox'),
          tr('This does not look like a bill, pro forma, offer, or warranty. Do you want to scan it anyway?'),
          [
            { text: tr('Cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: tr('Scan anyway'), onPress: () => resolve(true) },
          ],
        )
      })
      if (!proceed) return
      kind = 'bill'
    }
    try {
      setBusy(item.id)
      const sourceUri = (item as any).localPath || item.uri
      if (kind === 'warranty') {
        const { rawText } = await performOCR(sourceUri, { preferQr: false, allowAi: false, languageHint: getCurrentLang(), contentType: item.mimeType, filename: item.name })
        const w = extractWarrantyFieldsFromOcr(typeof rawText === 'string' ? rawText : '')
        const parts: string[] = []
        if (w.itemName) parts.push(`${tr('Item')}: ${w.itemName}`)
        if (w.supplier) parts.push(`${tr('Supplier')}: ${w.supplier}`)
        if (w.purchaseDate) parts.push(`${tr('Purchase date')}: ${w.purchaseDate}`)
        if (w.expiresAt) parts.push(`${tr('Valid until')}: ${w.expiresAt}`)
        if (w.durationMonths) parts.push(`${tr('Duration')}: ${w.durationMonths} ${tr('months')}`)
        const nextNotes = parts.join('\n') || tr('Warranty document')
        await updateInboxItem(inboxSpaceKey, item.id, { extractedFields: { _kind: 'warranty', ...w, rawText }, notes: nextNotes, status: item.status || 'new' })
        await scheduleInboxReviewReminder(item.id, item.name, inboxSpaceKey)
        await refresh()
        Alert.alert(tr('Scan complete'), nextNotes)
      } else {
        const { fields, summary, rawText, mode, meta } = await performOCR(sourceUri, { preferQr: true, allowAi: true, aiMode: 'document', languageHint: getCurrentLang(), contentType: item.mimeType, filename: item.name })

        const classification = meta?.classification || null
        const clsConf = typeof classification?.confidence === 'number' ? classification.confidence : null
        const hasBasicAmount = Boolean(fields && typeof fields.amount === 'number')
        const sourceHint = /qr/i.test(String(mode || '')) ? 'qr' : 'ocr'
        const enriched = fields ? { ...fields, rawText: typeof rawText === 'string' ? rawText : '', _source: sourceHint, mode, _classification: classification } : fields

        const isInvoice = classification?.isInvoice
        const billLikeOverride = /(predra\u010dun|predracun|proforma|pro\s*forma|proforma\s*rechnung|\bangebot\b|ponudba|ponuda|\boffer\b|\bquotation\b|\bquote\b|\bestimate\b|devis|preventivo|\bofferta\b|\bp\u0159edra\u010dun\b|\bpr\u00e9facture\b)/i.test(String(rawText || ''))
          || /(predra\u010dun|predracun|proforma|pro\s*forma|\bangebot\b|ponudba|ponuda|\boffer\b|\bquotation\b|\bquote\b)/i.test(classifierText)

        const treatAsNotInvoice = isInvoice === false && (clsConf == null || clsConf >= 0.7) && !billLikeOverride
        const treatAsInvoice = isInvoice === true || billLikeOverride || (!treatAsNotInvoice && hasBasicAmount)

        let nextStatus: any = 'new'
        if (treatAsNotInvoice) nextStatus = item.status || 'new'
        else if (treatAsInvoice) nextStatus = (item.status === 'archived') ? 'archived' : 'pending'

        const reason = classification?.reason ? String(classification.reason) : ''
        const nextNotes = treatAsNotInvoice ? (reason ? `${tr('Not an invoice')}: ${reason}` : tr('Not an invoice')) : summary

        await updateInboxItem(inboxSpaceKey, item.id, { extractedFields: enriched, notes: nextNotes, status: nextStatus })
        if (nextStatus === 'pending' || nextStatus === 'archived') await cancelInboxReviewReminder(item.id, inboxSpaceKey)
        else await scheduleInboxReviewReminder(item.id, item.name, inboxSpaceKey)
        await refresh()

        try {
          const sourceUri = (item as any).localPath || item.uri
          const cached = await ensureLocalReadableFile(sourceUri, item.name || 'document', item.mimeType, { allowBase64Fallback: true })
          navigation.navigate('Scan', {
            inboxPrefill: {
              id: item.id,
              fields: enriched,
              attachmentPath: cached?.uri || sourceUri,
              mimeType: item.mimeType,
              inboxStatus: item.status,
            },
          })
        } catch {
          Alert.alert(tr('Scan complete'), summary)
        }
      }
    } catch (e: any) {
      const msg = e?.message || tr('Could not read this document.')
      const code = e?.code || null
      if (code === 'trial_expired') {
        Alert.alert(tr('OCR unavailable'), tr('Free trial expired. Choose a plan to continue.'))
        showUpgradeAlert('ocr')
        return
      }
      if (code === 'ocr_not_allowed') {
        Alert.alert(tr('OCR unavailable'), tr('OCR not available on your plan.'))
        showUpgradeAlert('ocr')
        return
      }
      if (code === 'ocr_quota_exceeded') {
        const resetAt = e?.resetAt || null
        const dateLabel = formatResetDate(resetAt)
        const text = dateLabel
          ? tr('You reached the monthly OCR limit. Continue after {date} or upgrade.', { date: dateLabel })
          : tr('OCR monthly quota exceeded.')
        Alert.alert(tr('OCR failed'), text)
        showUpgradeAlert('ocr')
        return
      }
      Alert.alert(tr('Scan failed'), msg)
    } finally {
      setBusy(null)
    }
  }

  async function openItem(item: InboxItem) {
    try {
      const uri = (item as any).localPath || item.uri
      await Linking.openURL(uri)
    } catch {
      Alert.alert(tr('Open failed'), tr('Could not open this file.'))
    }
  }

  async function attachToBill(item: InboxItem) {
    if ((item as any)?.extractedFields?._kind === 'warranty') {
      Alert.alert(tr('Inbox'), tr('This looks like a warranty. Open Warranties.'))
      try { navigation.navigate('Warranties') } catch {}
      return
    }
    if (!item.extractedFields) {
      Alert.alert(tr('Scan first'), tr('Scan the document to prefill the bill.'))
      return
    }
    try {
      setBusy(item.id)
      const sourceUri = (item as any).localPath || item.uri
      const cached = await ensureLocalReadableFile(sourceUri, item.name || 'document', item.mimeType, { allowBase64Fallback: true })
      navigation.navigate('Scan', {
        inboxPrefill: {
          id: item.id,
          fields: item.extractedFields,
          attachmentPath: cached?.uri || sourceUri,
          mimeType: item.mimeType,
          inboxStatus: item.status,
        },
      })
    } finally {
      setBusy(null)
    }
  }

  async function archiveItem(item: InboxItem) {
    if ((item as any)?.meta?.source === 'email') {
      const ok = await updateServerInboxStatus(item.id, 'archived')
      if (!ok) {
        Alert.alert(tr('Archive failed'), tr('Unable to update the email inbox item.'))
        return
      }
    }
    await updateInboxItem(inboxSpaceKey, item.id, { status: 'archived' })
    await cancelInboxReviewReminder(item.id, inboxSpaceKey)
    await refresh()
  }

  async function removeItem(item: InboxItem) {
    Alert.alert(tr('Delete?'), tr('Remove this inbox item permanently?'), [
      { text: tr('Cancel'), style: 'cancel' },
      { text: tr('Delete'), style: 'destructive', onPress: async () => {
        if ((item as any)?.meta?.source === 'email') {
          const ok = await deleteServerInboxItem(item.id)
          if (!ok) {
            Alert.alert(tr('Delete failed'), tr('Unable to delete the email inbox item.'))
            return
          }
        }
        await cancelInboxReviewReminder(item.id, inboxSpaceKey)
        await removeInboxItem(inboxSpaceKey, item.id)
        await refresh()
      } },
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
                <Text>
                  {(item.mimeType || tr('Document'))} • {new Date(item.created_at).toLocaleString()}
                </Text>
                {(item.status === 'pending' || item.status === 'archived') ? (
                  <Text style={styles.mutedText}>{item.status === 'pending' ? tr('Pending') : tr('Archived')}</Text>
                ) : null}
                <Text style={styles.mutedText}>
                  {((item as any)?.meta?.source === 'email') ? tr('From email') : tr('From device')}
                </Text>
                {item.extractedFields && (
                  <View style={{ marginTop: 6 }}>
                    <Text style={{ fontWeight: '600' }}>{tr('Extracted')}</Text>
                    {item.notes ? <Text>{item.notes}</Text> : null}
                  </View>
                )}
                {!item.extractedFields && item.notes ? (
                  <View style={{ marginTop: 6 }}>
                    <Text style={styles.mutedText}>{item.notes}</Text>
                  </View>
                ) : null}
                <View style={styles.inboxActionsRow}>
                  <AppButton
                    label={tr('Open')}
                    variant="secondary"
                    iconName="open-outline"
                    onPress={()=>openItem(item)}
                  />
                  <AppButton
                    label={busy===item.id ? tr('Processing…') : tr('Scan')}
                    variant="secondary"
                    iconName="scan-outline"
                    onPress={()=>runOcr(item)}
                    disabled={busy===item.id}
                  />
                  <AppButton
                    label={tr('Attach to bill')}
                    variant="outline"
                    iconName="link-outline"
                    onPress={()=>attachToBill(item)}
                  />
                  <AppButton
                    label={tr('Archive')}
                    variant="ghost"
                    iconName="archive-outline"
                    onPress={()=>archiveItem(item)}
                  />
                  <AppButton
                    label={tr('Delete')}
                    variant="ghost"
                    iconName="trash-outline"
                    labelStyle={{ color: '#DC2626' }}
                    onPress={()=>removeItem(item)}
                  />
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
  const spacesCtx = useSpacesContext()
  const { snapshot: entitlements } = useEntitlements()
  const { lang } = useLangContext()
  const insets = useSafeAreaInsets()
  const hasLoadedRef = useRef(false)
  const listRef = useRef<FlatList<any> | null>(null)

  const effectiveSpaceId = spaceId || space?.id || 'default'

  const [bills, setBills] = useState<(Bill & { __spaceId?: string })[]>([])
  const [loadingBills, setLoadingBills] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [billsError, setBillsError] = useState<string | null>(null)

  const dayKey = useDayKey()
  const formatDate = useCallback((iso?: string | null) => {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      return d.toISOString().slice(0, 10)
    } catch {
      return String(iso)
    }
  }, [])

  function normalizeReferenceModel(input: string): string {
    const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!raw) return ''
    const letters = /^[A-Z]{2}/.test(raw) ? raw.slice(0, 2) : 'SI'
    const digits = raw.replace(/^[A-Z]{2}/, '').replace(/[^0-9]/g, '').slice(0, 2)
    return digits ? `${letters} ${digits}` : letters
  }

  function normalizeReferenceNumber(input: string): string {
    return String(input || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9\-\/]/g, '')
  }

  function buildReferenceFromModel(model: string, number: string): string {
    const m = String(model || '').replace(/\s+/g, '').toUpperCase()
    const n = normalizeReferenceNumber(number)
    if (!m || !n) return ''
    return `${m}${n}`
  }

  const [filtersExpanded, setFiltersExpanded] = useState(true)
  const [supplierQuery, setSupplierQuery] = useState('')
  const [supplierDropdownOpen, setSupplierDropdownOpen] = useState(false)
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')
  const [dateMode, setDateMode] = useState<'due' | 'invoice' | 'created'>('due')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [statusSelections, setStatusSelections] = useState<{ unpaid: boolean; paid: boolean; archived: boolean }>(() => ({
    unpaid: true,
    paid: true,
    archived: false,
  }))
  const [unpaidOnly, setUnpaidOnly] = useState(false)
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [hasAttachmentsOnly, setHasAttachmentsOnly] = useState(false)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})
  const [warrantyBillIds, setWarrantyBillIds] = useState<Record<string, true>>({})
  const [warranties, setWarranties] = useState<Warranty[]>([])

  const [exportBusy, setExportBusy] = useState(false)
  const [exportBusyLabel, setExportBusyLabel] = useState('')
  const [exportSelectVisible, setExportSelectVisible] = useState(false)
  const [exportSelectedIds, setExportSelectedIds] = useState<Record<string, true>>({})

  const defaultExportScope: ExportPayerScope = spaceId === 'personal2' ? 'payer2' : 'payer1'
  const canUsePayer2 = Number(entitlements?.payerLimit || 1) >= 2

  type BillsProfileScope = 'payer1' | 'payer2' | 'both'
  const defaultBillsScope: BillsProfileScope = spaceId === 'personal2' ? 'payer2' : 'payer1'
  const [profileScope, setProfileScope] = useState<BillsProfileScope>(defaultBillsScope)

  const payerSpaces = useMemo(() => {
    return (spacesCtx.spaces || []).filter((s) => isPayerSpaceId(s.id))
  }, [spacesCtx.spaces])

  const supplierOptions = useMemo(() => {
    const all = (bills || [])
      .map((b) => String(b.supplier || '').trim())
      .filter((v) => v.length > 0)
    const unique = Array.from(new Set(all)).sort((a, b) => a.localeCompare(b))
    const term = supplierQuery.trim().toLowerCase()
    if (!term) return unique.slice(0, 8)
    return unique.filter((name) => name.toLowerCase().includes(term)).slice(0, 8)
  }, [bills, supplierQuery])

  const payerNameForId = useCallback((id: string): string => {
    const sp = payerSpaces.find((s) => s.id === id) || null
    const name = (sp?.name || '').trim()
    return name || tr(payerLabelFromSpaceId(id))
  }, [payerSpaces, tr])

  const canSelectPayer2 = useMemo(() => {
    return canUsePayer2 && payerSpaces.some((s) => s.id === 'personal2')
  }, [canUsePayer2, payerSpaces])

  const selectedPayerIds = useMemo((): string[] => {
    const ids = payerSpaces.map((s) => s.id)
    if (!ids.length) return [spaceId || 'personal']

    const p1 = ids.includes('personal') ? 'personal' : ids[0]
    const p2 = ids.includes('personal2') ? 'personal2' : null

    if (profileScope === 'both') {
      const out = [p1]
      if (p2 && canSelectPayer2) out.push(p2)
      return out
    }
    if (profileScope === 'payer2') {
      if (p2 && canSelectPayer2) return [p2]
      return [p1]
    }
    return [p1]
  }, [canSelectPayer2, payerSpaces, profileScope, spaceId])

  useEffect(() => {
    if (!canSelectPayer2 && profileScope !== 'payer1') setProfileScope('payer1')
  }, [canSelectPayer2, profileScope])

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
  const [installmentReferenceModel, setInstallmentReferenceModel] = useState('')
  const [installmentReferenceNumber, setInstallmentReferenceNumber] = useState('')
  const [installmentPurpose, setInstallmentPurpose] = useState('')
  const [installmentMonths, setInstallmentMonths] = useState('')
  const [installmentEndMonth, setInstallmentEndMonth] = useState('')
  const [installmentSaving, setInstallmentSaving] = useState(false)
  const [installmentUpgradeVisible, setInstallmentUpgradeVisible] = useState(false)
  const [installmentAttempted, setInstallmentAttempted] = useState(false)

  const [toast, setToast] = useState<{ message: string; tone?: 'success' | 'info' | 'danger' } | null>(null)
  const toastTimerRef = useRef<any>(null)
  const showToast = useCallback((message: string, tone: 'success' | 'info' | 'danger' = 'success', durationMs = 2200) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ message, tone })
    toastTimerRef.current = setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, Math.max(800, durationMs))
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  const [dangerConfirm, setDangerConfirm] = useState<{
    title: string
    message: string
    confirmLabel?: string
    onConfirm: () => void | Promise<void>
  } | null>(null)

  const showDangerConfirm = useCallback((title: string, message: string, onConfirm: () => void | Promise<void>, confirmLabel?: string) => {
    setDangerConfirm({ title, message, onConfirm, confirmLabel })
  }, [])

  const [installmentMonthPickerVisible, setInstallmentMonthPickerVisible] = useState(false)
  const [installmentMonthPickerField, setInstallmentMonthPickerField] = useState<'start' | 'end' | null>(null)
  const [installmentMonthPickerValue, setInstallmentMonthPickerValue] = useState(new Date())

  const lastInstallmentEditRef = useRef<'months' | 'end' | null>(null)

  const parseYYYYMM = useCallback((value?: string | null): { y: number; m: number } | null => {
    if (!value) return null
    const v = String(value).trim()
    if (!/^\d{4}-\d{2}$/.test(v)) return null
    const [ys, ms] = v.split('-')
    const y = Number(ys)
    const m = Number(ms)
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null
    return { y, m }
  }, [])

  const diffMonthsInclusive = useCallback((start: string, end: string): number | null => {
    const a = parseYYYYMM(start)
    const b = parseYYYYMM(end)
    if (!a || !b) return null
    const diff = (b.y - a.y) * 12 + (b.m - a.m) + 1
    return diff
  }, [parseYYYYMM])

  const syncInstallmentDerived = useCallback((nextStart: string, nextMonths: string, nextEnd: string) => {
    const startOk = /^\d{4}-\d{2}$/.test(nextStart.trim())
    if (!startOk) return

    const monthsCount = Math.floor(Number(String(nextMonths).trim()))
    const hasMonths = Number.isFinite(monthsCount) && monthsCount >= 1
    const endOk = /^\d{4}-\d{2}$/.test(nextEnd.trim())

    if (lastInstallmentEditRef.current === 'months') {
      if (hasMonths) {
        const computedEnd = addMonthsToYYYYMM(nextStart.trim(), monthsCount - 1)
        if (computedEnd !== nextEnd) setInstallmentEndMonth(computedEnd)
      }
      return
    }

    if (lastInstallmentEditRef.current === 'end') {
      if (endOk) {
        const diff = diffMonthsInclusive(nextStart.trim(), nextEnd.trim())
        if (diff && diff >= 1) {
          const computedMonths = String(diff)
          if (computedMonths !== String(nextMonths || '')) setInstallmentMonths(computedMonths)
        }
      }
      return
    }

    // If the user edits the start month, keep the previously edited "duration" field stable,
    // and recompute the other one.
    if (hasMonths) {
      const computedEnd = addMonthsToYYYYMM(nextStart.trim(), monthsCount - 1)
      if (computedEnd !== nextEnd) setInstallmentEndMonth(computedEnd)
      return
    }
    if (endOk) {
      const diff = diffMonthsInclusive(nextStart.trim(), nextEnd.trim())
      if (diff && diff >= 1) {
        const computedMonths = String(diff)
        if (computedMonths !== String(nextMonths || '')) setInstallmentMonths(computedMonths)
      }
    }
  }, [diffMonthsInclusive])

  const openInstallmentMonthPicker = useCallback((field: 'start' | 'end') => {
    const raw = field === 'start' ? installmentStartMonth : installmentEndMonth
    const parsed = parseYYYYMM(raw)
    const base = parsed ? new Date(parsed.y, parsed.m - 1, 1) : new Date()
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        mode: 'date',
        value: base,
        onChange: (_event, selectedDate) => {
          if (!selectedDate) return
          const ym = monthKeyFromDate(selectedDate)
          if (field === 'start') {
            setInstallmentStartMonth(ym)
            syncInstallmentDerived(ym, installmentMonths, installmentEndMonth)
          } else {
            lastInstallmentEditRef.current = 'end'
            setInstallmentEndMonth(ym)
            syncInstallmentDerived(installmentStartMonth, installmentMonths, ym)
          }
        },
      })
      return
    }
    setInstallmentMonthPickerField(field)
    setInstallmentMonthPickerValue(base)
    setInstallmentMonthPickerVisible(true)
  }, [diffMonthsInclusive, installmentEndMonth, installmentMonths, installmentStartMonth, parseYYYYMM, syncInstallmentDerived])

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

  const today = useMemo(() => {
    void dayKey
    const base = new Date()
    return new Date(base.getFullYear(), base.getMonth(), base.getDate())
  }, [dayKey])

  const getWarrantyStatus = useCallback((w: Warranty): 'active' | 'expiring' | 'expired' | 'no_expiry' => {
    const expires = parseDateValue((w as any)?.expires_at)
    if (!expires) return 'no_expiry'
    const days = Math.floor((expires.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    if (days < 0) return 'expired'
    if (days <= 30) return 'expiring'
    return 'active'
  }, [parseDateValue, today])

  const getBillDate = useCallback((bill: Bill, mode: typeof dateMode): string => {
    if (mode === 'invoice') return (bill as any).invoice_date || bill.created_at
    if (mode === 'created') return bill.created_at
    return bill.due_date
  }, [])

  const formatDisplayDate = useCallback((value?: string | null) => {
    const parsed = parseDateValue(value)
    return parsed ? parsed.toLocaleDateString() : '—'
  }, [parseDateValue])

  const loadBills = useCallback(async (silent = false) => {
    if (spaceLoading || !space) return
    silent ? setRefreshing(true) : setLoadingBills(true)
    try {
      setBillsError(null)
      if (supabase) {
        const ids = (selectedPayerIds || []).filter(Boolean)
        const { data, error } = await listBills(supabase, ids.length > 1 ? ids : (ids[0] || spaceId), entitlements)
        if (error) throw error

        let raw = ((data as any) || []) as any[]
        let annotated: (Bill & { __spaceId?: string })[] = raw.map((b) => {
          const normalized = remapArchivedBillFromDb(b as any)
          const local = localPayerIdFromDbSpaceId(entitlements, (b as any)?.space_id) || ids[0] || spaceId
          return { ...(normalized as any), __spaceId: local }
        })

        if (entitlements.plan === 'pro') {
          const merged: (Bill & { __spaceId?: string })[] = []
          for (const sid of ids) {
            const group = annotated.filter((b) => (b as any).__spaceId === sid) as any as Bill[]
            const ensured = await ensureInstallmentBills({ spaceId: sid, supabase, existingBills: group, horizonMonths: 2 })
            for (const b of ensured || []) merged.push({ ...(b as any), __spaceId: sid })
          }
          annotated = merged
        } else {
          annotated = annotated.filter((b) => !isInstallmentBill(b as any))
        }

        setBills(annotated)
      } else {
        const ids = (selectedPayerIds || []).filter(Boolean)
        const annotated: (Bill & { __spaceId?: string })[] = []
        for (const sid of ids) {
          const locals = await loadLocalBills(sid)
          let group = (((locals as any) || []) as any[]) as Bill[]
          if (entitlements.plan === 'pro') {
            group = await ensureInstallmentBills({ spaceId: sid, supabase: null, existingBills: group, horizonMonths: 2 })
          } else {
            group = group.filter((b) => !isInstallmentBill(b))
          }
          for (const b of group || []) annotated.push({ ...(b as any), __spaceId: sid })
        }
        setBills(annotated)
      }
    } catch (e: any) {
      setBillsError(tr('Bills could not be loaded. Pull to refresh.'))
    } finally {
      hasLoadedRef.current = true
      silent ? setRefreshing(false) : setLoadingBills(false)
    }
  }, [spaceLoading, space, supabase, spaceId, entitlements, selectedPayerIds])

  useEffect(() => {
    if (!hasLoadedRef.current) return
    loadBills(true)
  }, [dayKey, loadBills])

  const loadWarrantyLinks = useCallback(async () => {
    if (spaceLoading || !space) return
    try {
      const ids = (selectedPayerIds || []).filter(Boolean)
      const warranties = supabase
        ? (await listWarranties(supabase, ids.length > 1 ? ids : (ids[0] || spaceId), entitlements)).data
        : ((await Promise.all(ids.map((sid) => loadLocalWarranties(sid))))
          .flat() as any)

      const next: Record<string, true> = {}
      for (const w of warranties || []) {
        const billId = (w as any)?.bill_id
        if (billId) next[String(billId)] = true
      }
      setWarrantyBillIds(next)
      setWarranties((warranties as any) || [])
    } catch {
      setWarrantyBillIds({})
      setWarranties([])
    }
  }, [spaceLoading, space, supabase, spaceId, entitlements, selectedPayerIds])

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
    setInstallmentReferenceModel('')
    setInstallmentReferenceNumber('')
    setInstallmentPurpose('')
    setInstallmentMonths('')
    setInstallmentEndMonth('')
    setInstallmentAttempted(false)
    lastInstallmentEditRef.current = null
    setInstallmentVisible(true)
  }, [])

  const installmentValidation = useMemo(() => {
    const title = installmentTitle.trim()
    const currency = String(installmentCurrency || '').trim()
    const startMonth = installmentStartMonth.trim()
    const endMonth = installmentEndMonth.trim()
    const monthsCount = Math.floor(Number(String(installmentMonths).trim()))
    const day = Math.floor(Number(String(installmentDueDay).trim()))
    const creditor = installmentCreditor.trim()
    const ibanNorm = normalizeIban(installmentIban)
    const model = normalizeReferenceModel(installmentReferenceModel)
    const number = normalizeReferenceNumber(installmentReferenceNumber)
    const purpose = installmentPurpose.trim()

    const titleOk = Boolean(title)
    const amt = Number(String(installmentAmount).replace(',', '.'))
    const amountOk = Number.isFinite(amt) && amt > 0
    const currencyOk = Boolean(currency)
    const startOk = /^\d{4}-\d{2}$/.test(startMonth)
    const endOk = /^\d{4}-\d{2}$/.test(endMonth)
    const monthsOk = Number.isFinite(monthsCount) && monthsCount >= 1
    const dayOk = Number.isFinite(day) && day >= 1 && day <= 31
    const rangeOk = startOk && endOk && compareYYYYMM(endMonth, startMonth) >= 0
    const diff = startOk && endOk ? diffMonthsInclusive(startMonth, endMonth) : null
    const monthsMatchOk = monthsOk && diff != null && diff >= 1 && diff === monthsCount
    const creditorOk = Boolean(creditor)
    const ibanOk = Boolean(ibanNorm) && isValidIbanChecksum(ibanNorm || '')
    const modelOk = Boolean(model)
    const numberOk = Boolean(number)
    const referenceOk = Boolean(model) && Boolean(number) && Boolean(buildReferenceFromModel(model, number))
    const purposeOk = Boolean(purpose)

    const complete =
      titleOk &&
      amountOk &&
      currencyOk &&
      startOk &&
      endOk &&
      monthsOk &&
      dayOk &&
      rangeOk &&
      monthsMatchOk &&
      creditorOk &&
      ibanOk &&
      modelOk &&
      numberOk &&
      referenceOk &&
      purposeOk

    return {
      titleOk,
      amountOk,
      currencyOk,
      startOk,
      endOk,
      monthsOk,
      dayOk,
      rangeOk,
      monthsMatchOk,
      creditorOk,
      ibanOk,
      modelOk,
      numberOk,
      referenceOk,
      purposeOk,
      complete,
    }
  }, [
    diffMonthsInclusive,
    installmentAmount,
    installmentCreditor,
    installmentCurrency,
    installmentDueDay,
    installmentEndMonth,
    installmentIban,
    installmentMonths,
    installmentPurpose,
    installmentReferenceModel,
    installmentReferenceNumber,
    installmentStartMonth,
    installmentTitle,
  ])

  const installmentComplete = installmentValidation.complete

  useEffect(() => {
    const shouldOpen = Boolean((route as any)?.params?.openInstallment)
    if (!shouldOpen) return
    openInstallment()
    navigation.setParams?.({ openInstallment: null })
  }, [route, navigation, openInstallment])

  const warrantyByBillId = useMemo(() => {
    const map = new Map<string, Warranty>()
    for (const w of warranties || []) {
      const billId = (w as any)?.bill_id
      if (billId && !map.has(String(billId))) map.set(String(billId), w)
    }
    return map
  }, [warranties])

  const saveInstallment = useCallback(async () => {
    if (installmentSaving) return

    if (entitlements.plan !== 'pro') {
      setInstallmentUpgradeVisible(true)
      return
    }

    // Require the form to be fully complete before saving.
    setInstallmentAttempted(true)
    if (!installmentComplete) {
      Alert.alert(tr('Required field'), tr('Please fill all required fields.'))
      return
    }

    const title = installmentTitle.trim()
    const amt = Number(String(installmentAmount).replace(',', '.'))
    const currency = String(installmentCurrency || '').trim() || 'EUR'
    const startMonth = installmentStartMonth.trim()
    const endMonth = installmentEndMonth.trim()
    const monthsCount = Math.floor(Number(String(installmentMonths).trim()))
    void monthsCount
    const day = Math.floor(Number(String(installmentDueDay).trim()))

    const creditor = installmentCreditor.trim()
    const iban = normalizeIban(installmentIban) || ''
    const model = normalizeReferenceModel(installmentReferenceModel)
    const number = normalizeReferenceNumber(installmentReferenceNumber)
    const reference = buildReferenceFromModel(model, number)
    const purpose = installmentPurpose.trim()

    try {
      setInstallmentSaving(true)
      await addLocalInstallment(spaceId, {
        title,
        amount: amt,
        currency,
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
      showToast(tr('Installment obligation saved.'), 'success')
    } catch (e: any) {
      Alert.alert(tr('Save failed'), e?.message || tr('Unable to save.'))
    } finally {
      setInstallmentSaving(false)
    }
  }, [
    entitlements.plan,
    installmentComplete,
    installmentAmount,
    installmentCreditor,
    installmentCurrency,
    installmentDueDay,
    installmentIban,
    installmentPurpose,
    installmentReferenceModel,
    installmentReferenceNumber,
    installmentSaving,
    installmentStartMonth,
    installmentTitle,
    installmentMonths,
    installmentEndMonth,
    loadBills,
    navigation,
    spaceId,
  ])

  useEffect(() => {
    const startOk = /^\d{4}-\d{2}$/.test(installmentStartMonth.trim())
    if (!startOk) return
    if (lastInstallmentEditRef.current === 'months') {
      syncInstallmentDerived(installmentStartMonth, installmentMonths, installmentEndMonth)
    }
  }, [installmentEndMonth, installmentMonths, installmentStartMonth, syncInstallmentDerived])

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
            const sid = String((bill as any)?.__spaceId || spaceId || '')
            const list = supabase
              ? await listRemoteAttachments(supabase, 'bills', bill.id, sid)
              : await listLocalAttachments(sid, 'bills', bill.id)
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
    setStatusSelections({ unpaid: true, paid: true, archived: false })
    setUnpaidOnly(false)
    setOverdueOnly(false)
    setHasAttachmentsOnly(false)
    setIncludeArchived(false)
    setDateMode('due')
  }, [])

  const selectedStatusList = useMemo(() => {
    const list: Array<'unpaid' | 'paid' | 'archived'> = []
    if (statusSelections.unpaid) list.push('unpaid')
    if (statusSelections.paid) list.push('paid')
    if (statusSelections.archived) list.push('archived')
    if (list.length) return list
    return ['unpaid', 'paid', 'archived'] as const
  }, [statusSelections.archived, statusSelections.paid, statusSelections.unpaid])

  const statusFilterCompat = useMemo(() => {
    if (selectedStatusList.length === 1) return selectedStatusList[0]
    return 'all'
  }, [selectedStatusList])

  const isStatusIncluded = useCallback((bill: Bill) => {
    for (const s of selectedStatusList) {
      if (s === 'unpaid' && isBillUnpaid(bill.status)) return true
      if (s === 'paid' && bill.status === 'paid') return true
      if (s === 'archived' && bill.status === 'archived') return true
    }
    return false
  }, [selectedStatusList])

  const handleStatusChange = useCallback((value: string) => {
    const next = (value as 'all' | 'paid' | 'unpaid' | 'archived') || 'all'
    if (next === 'unpaid') {
      setStatusSelections({ unpaid: true, paid: false, archived: false })
      setUnpaidOnly(true)
      setIncludeArchived(false)
      return
    }
    if (next === 'paid') {
      setStatusSelections({ unpaid: false, paid: true, archived: false })
      setUnpaidOnly(false)
      setIncludeArchived(false)
      return
    }
    if (next === 'archived') {
      setStatusSelections({ unpaid: false, paid: false, archived: true })
      setUnpaidOnly(false)
      setIncludeArchived(true)
      return
    }
    setStatusSelections({ unpaid: true, paid: true, archived: includeArchived })
    setUnpaidOnly(false)
  }, [includeArchived])

  const handleUnpaidToggle = useCallback((value: boolean) => {
    if (value) {
      setStatusSelections({ unpaid: true, paid: false, archived: false })
      setUnpaidOnly(true)
      setIncludeArchived(false)
    } else {
      setStatusSelections({ unpaid: true, paid: true, archived: includeArchived })
      setUnpaidOnly(false)
    }
  }, [includeArchived])

  useEffect(() => {
    const unpaidOnlyNext = statusSelections.unpaid && !statusSelections.paid && !statusSelections.archived
    if (unpaidOnly !== unpaidOnlyNext) setUnpaidOnly(unpaidOnlyNext)
    if (includeArchived !== statusSelections.archived) setIncludeArchived(statusSelections.archived)
  }, [includeArchived, statusSelections.archived, statusSelections.paid, statusSelections.unpaid, unpaidOnly])

  useEffect(() => {
    const preset = (route as any)?.params?.filterPreset
    if (!preset || typeof preset !== 'object') return

    if (typeof preset.supplierQuery === 'string') setSupplierQuery(preset.supplierQuery)
    if (typeof preset.amountMin === 'string') setAmountMin(preset.amountMin)
    if (typeof preset.amountMax === 'string') setAmountMax(preset.amountMax)
    if (typeof preset.dateMode === 'string') setDateMode(preset.dateMode)
    if (typeof preset.dateFrom === 'string') setDateFrom(preset.dateFrom)
    if (typeof preset.dateTo === 'string') setDateTo(preset.dateTo)
    if (typeof preset.hasAttachmentsOnly === 'boolean') setHasAttachmentsOnly(preset.hasAttachmentsOnly)
    if (typeof preset.includeArchived === 'boolean') setIncludeArchived(preset.includeArchived)
    if (typeof preset.overdueOnly === 'boolean') setOverdueOnly(preset.overdueOnly)

    if (Array.isArray((preset as any).statusList)) {
      const raw = (preset as any).statusList as any[]
      const set = new Set(raw.map((v) => String(v || '').trim()).filter(Boolean))
      const next = {
        unpaid: set.has('unpaid'),
        paid: set.has('paid'),
        archived: set.has('archived'),
      }
      setStatusSelections(next)
      setIncludeArchived(next.archived)
      setUnpaidOnly(next.unpaid && !next.paid && !next.archived)
    } else {
      if (typeof preset.unpaidOnly === 'boolean') handleUnpaidToggle(preset.unpaidOnly)
      if (typeof preset.statusFilter === 'string') handleStatusChange(preset.statusFilter)
    }
    if (typeof preset.filtersExpanded === 'boolean') setFiltersExpanded(preset.filtersExpanded)
    else setFiltersExpanded(false)

    requestAnimationFrame(() => {
      try { listRef.current?.scrollToOffset({ offset: 0, animated: true }) } catch {}
    })

    navigation.setParams?.({ filterPreset: null })
  }, [handleStatusChange, handleUnpaidToggle, navigation, route])

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
      if (supplierTerm && !bill.supplier.toLowerCase().includes(supplierTerm)) return false

      if (minVal !== null && !Number.isNaN(minVal) && bill.amount < minVal) return false
      if (maxVal !== null && !Number.isNaN(maxVal) && bill.amount > maxVal) return false

      if (!isStatusIncluded(bill)) return false
      if (unpaidOnly && !isBillUnpaid(bill.status)) return false

      const dueDate = parseDateValue(bill.due_date)
      const isOverdue = dueDate ? isBillUnpaid(bill.status) && dueDate.getTime() < today.getTime() : false
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
  }, [amountMax, amountMin, attachmentCounts, bills, dateFrom, dateMode, dateTo, getBillDate, hasAttachmentsOnly, overdueOnly, parseDateValue, isStatusIncluded, supplierQuery, today, unpaidOnly, includeArchived])

  const totalCount = bills.length
  const resultsLabel = filteredBills.length === totalCount
    ? tr('{count} bills', { count: totalCount || 0 })
    : tr('{shown} of {total} bills', { shown: filteredBills.length, total: totalCount || 0 })

  const applyFilters = useCallback(() => {
    Keyboard.dismiss()
    if (!filteredBills.length) {
      Alert.alert(tr('No bills match the current filters.'), tr('Adjust your filters or add a new bill.'))
      return
    }
    setFiltersExpanded(false)
    requestAnimationFrame(() => {
      try {
        listRef.current?.scrollToOffset({ offset: 0, animated: true })
      } catch {}
    })
  }, [filteredBills.length, tr])

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
        if (json?.error === 'trial_expired') {
          Alert.alert(t(lang, 'Export'), t(lang, 'Free trial expired. Choose a plan to continue.'))
          showUpgradeAlert('export')
          return null
        }
        Alert.alert(t(lang, 'Export'), t(lang, 'Export is available on Več.'))
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

  async function exportCSVSelection() {
    if (!entitlements.exportsEnabled) {
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }

    if (!filteredBills.length) {
      Alert.alert(tr('No bills match the current filters.'), tr('Adjust your filters or add a new bill.'))
      return
    }

    function csvEscape(v: any) {
      const s = v === null || v === undefined ? '' : String(v)
      return `"${s.replace(/"/g, '""')}"`
    }

    const header = [
      'supplier',
      'creditor_name',
      'invoice_number',
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
      filteredBills.map((b: any) => [
        b.supplier,
        b.creditor_name,
        b.invoice_number,
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

  async function exportAccountingCSVSelection() {
    if (!entitlements.exportsEnabled) {
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }

    if (!filteredBills.length) {
      Alert.alert(tr('No bills match the current filters.'), tr('Adjust your filters or add a new bill.'))
      return
    }

    const missing = filteredBills.filter((b: any) => !String(b?.invoice_number || '').trim())
    if (missing.length) {
      const first = missing[0]
      Alert.alert(
        tr('Missing invoice numbers'),
        tr('{count} bills are missing an invoice number.', { count: missing.length }),
        [
          {
            text: tr('Open first missing bill'),
            onPress: () => {
              try {
                navigation.navigate('Bill Details', { bill: first })
              } catch {}
            },
          },
          { text: tr('Cancel'), style: 'cancel' as const },
        ],
      )
      return
    }

    function csvEscape(v: any) {
      const s = v === null || v === undefined ? '' : String(v)
      return `"${s.replace(/"/g, '""')}"`
    }

    const header = [
      'invoice_number',
      'supplier',
      'amount',
      'currency',
      'due_date',
      'creditor_name',
      'iban',
      'reference',
      'purpose',
      'created_at',
      'space_id',
      'bill_id',
    ]

    const rows = [header].concat(
      filteredBills.map((b: any) => [
        b.invoice_number,
        b.supplier,
        b.amount,
        b.currency,
        b.due_date,
        b.creditor_name,
        b.iban,
        b.reference,
        b.purpose,
        b.created_at,
        b.space_id,
        b.id,
      ]),
    )

    const csv = rows.map((r: any[]) => r.map(csvEscape).join(',')).join('\n')
    const file = `${FileSystem.cacheDirectory}billbox-accounting.csv`
    await FileSystem.writeAsStringAsync(file, csv)
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file)
    else Alert.alert(tr('CSV saved'), file)
  }

  async function exportJSONSelection() {
    if (!entitlements.exportsEnabled) {
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }

    const out: any = {
      exported_at: new Date().toISOString(),
      space_id: effectiveSpaceId,
      filters: {
        dateMode,
        dateFrom,
        dateTo,
        supplierQuery,
        amountMin,
        amountMax,
        statusFilter: statusFilterCompat,
        statusList: selectedStatusList,
        unpaidOnly,
        overdueOnly,
        hasAttachmentsOnly,
        includeArchived,
      },
      bills: [],
    }

    for (const b of filteredBills) {
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
        bill_attachments: (billAttachments || []).map((a: any) => ({ name: a.name, path: a.path, uri: a.uri })),
        warranty: warranty ? {
          id: warranty.id,
          item_name: warranty.item_name,
          supplier: warranty.supplier,
          purchase_date: warranty.purchase_date,
          expires_at: warranty.expires_at,
          bill_id: (warranty as any)?.bill_id,
        } : null,
        warranty_attachments: (warrantyAttachments || []).map((a: any) => ({ name: a.name, path: a.path, uri: a.uri })),
      })
    }

    const file = `${FileSystem.cacheDirectory}billbox-export.json`
    await FileSystem.writeAsStringAsync(file, JSON.stringify(out, null, 2))
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file)
    else Alert.alert(tr('JSON saved'), file)
  }

  async function exportPDFSelection(scope: ExportPayerScope = defaultExportScope) {
    if (!entitlements.exportsEnabled) {
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }
    if (!filteredBills.length) {
      Alert.alert(tr('No bills match the current filters.'), tr('Adjust your filters or add a new bill.'))
      return
    }

    if (!supabase) {
      Alert.alert(t(lang, 'Export'), t(lang, 'Exports require an online account.'))
      return
    }

    const scopePayload = await resolveDbExportScopePayload(supabase!, entitlements, scope)
    if (!scopePayload) {
      Alert.alert(tr('Export'), tr('Selected profile scope is unavailable.'))
      return
    }

    const res = await callExportFunction(
      'export-pdf',
      {
        kind: 'range',
        ...scopePayload,
        filters: {
          start: dateFrom || '1900-01-01',
          end: dateTo || '2999-12-31',
          dateMode,
          supplierQuery,
          amountMin,
          amountMax,
          hasAttachmentsOnly,
          status: statusFilterCompat,
          statusList: selectedStatusList,
          includeArchived,
          overdueOnly,
          unpaidOnly,
        },
      },
      tr('Preparing PDF…')
    )
    if (!res) return
    await downloadAndShare(res.url, res.filename, res.contentType)
  }

  async function exportZIPSelection(scope: ExportPayerScope = defaultExportScope) {
    if (!entitlements.exportsEnabled) {
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }
    if (!filteredBills.length) {
      Alert.alert(tr('No bills match the current filters.'), tr('Adjust the filters to include bills with attachments.'))
      return
    }

    if (!supabase) {
      Alert.alert(t(lang, 'Export'), t(lang, 'Exports require an online account.'))
      return
    }

    const scopePayload = await resolveDbExportScopePayload(supabase!, entitlements, scope)
    if (!scopePayload) {
      Alert.alert(tr('Export'), tr('Selected profile scope is unavailable.'))
      return
    }

    const res = await callExportFunction(
      'export-zip',
      {
        ...scopePayload,
        filters: {
          start: dateFrom || '1900-01-01',
          end: dateTo || '2999-12-31',
          dateMode,
          supplierQuery,
          amountMin,
          amountMax,
          hasAttachmentsOnly,
          status: statusFilterCompat,
          statusList: selectedStatusList,
          includeArchived,
          overdueOnly,
          unpaidOnly,
        },
      },
      tr('Preparing ZIP…')
    )
    if (!res) return
    await downloadAndShare(res.url, res.filename, res.contentType)
  }

  const MAX_EXPORT_BILLS_PER_ZIP = 40

  const openExportSelection = useCallback(() => {
    if (!entitlements.exportsEnabled) {
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }
    if (!filteredBills.length) {
      Alert.alert(tr('No bills match the current filters.'), tr('Adjust your filters or add a new bill.'))
      return
    }
    const next: Record<string, true> = {}
    for (const b of filteredBills) next[b.id] = true
    setExportSelectedIds(next)
    setExportSelectVisible(true)
  }, [entitlements.exportsEnabled, entitlements.status, filteredBills])

  const toggleExportSelection = useCallback((id: string) => {
    setExportSelectedIds((prev) => {
      const next = { ...prev }
      if (next[id]) delete next[id]
      else next[id] = true
      return next
    })
  }, [])

  const selectAllExport = useCallback(() => {
    const next: Record<string, true> = {}
    for (const b of filteredBills) next[b.id] = true
    setExportSelectedIds(next)
  }, [filteredBills])

  const clearAllExport = useCallback(() => {
    setExportSelectedIds({})
  }, [])

  const selectedBillIds = useMemo(() => Object.keys(exportSelectedIds || {}), [exportSelectedIds])
  const selectedBills = useMemo(() => filteredBills.filter((b) => exportSelectedIds[b.id]), [exportSelectedIds, filteredBills])
  const allExportSelected = useMemo(() => filteredBills.length > 0 && selectedBillIds.length === filteredBills.length, [filteredBills.length, selectedBillIds.length])

  const exportAttachmentsZip = useCallback(async (fileType: 'pdf' | 'image' | 'all') => {
    if (!entitlements.exportsEnabled) {
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }
    if (!selectedBillIds.length) {
      Alert.alert(tr('Required field'), tr('Please select at least one bill.'))
      return
    }
    if (!supabase) {
      Alert.alert(t(lang, 'Export'), t(lang, 'Exports require an online account.'))
      return
    }

    const total = selectedBillIds.length
    const parts = Math.ceil(total / MAX_EXPORT_BILLS_PER_ZIP)
    if (parts > 1) {
      showToast(tr('Export will be split into {count} parts.', { count: parts }), 'info')
    }

    for (let i = 0; i < parts; i += 1) {
      const slice = selectedBillIds.slice(i * MAX_EXPORT_BILLS_PER_ZIP, (i + 1) * MAX_EXPORT_BILLS_PER_ZIP)
      const res = await callExportFunction(
        'export-zip',
        {
          billIds: slice,
          filters: {
            dateMode,
            dateFrom,
            dateTo,
            supplierQuery,
            amountMin,
            amountMax,
            hasAttachmentsOnly,
            status: statusFilterCompat,
            statusList: selectedStatusList,
            includeArchived,
            overdueOnly,
            unpaidOnly,
          },
          attachmentTypes: fileType === 'all' ? ['pdf', 'image'] : [fileType],
          exportPart: parts > 1 ? { index: i + 1, count: parts } : null,
        },
        fileType === 'pdf' ? tr('Preparing PDF attachments…') : fileType === 'image' ? tr('Preparing image attachments…') : tr('Preparing attachments…')
      )
      if (!res) return
      await downloadAndShare(res.url, res.filename, res.contentType)
    }
  }, [
    amountMax,
    amountMin,
    dateFrom,
    dateMode,
    dateTo,
    entitlements.exportsEnabled,
    entitlements.status,
    hasAttachmentsOnly,
    selectedBillIds,
    showToast,
    statusFilterCompat,
    selectedStatusList,
    supplierQuery,
    supabase,
    unpaidOnly,
    overdueOnly,
    includeArchived,
  ])

  const exportAttachmentsCsv = useCallback(async () => {
    if (!entitlements.exportsEnabled) {
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }
    if (!selectedBillIds.length) {
      Alert.alert(tr('Required field'), tr('Please select at least one bill.'))
      return
    }

    const rows: any[] = []
    for (const b of selectedBills) {
      let list: any[] = []
      try {
        list = supabase
          ? await listRemoteAttachments(supabase!, 'bills', b.id, (b as any).__spaceId || spaceId)
          : await listLocalAttachments((b as any).__spaceId || spaceId, 'bills', b.id)
      } catch {
        list = []
      }
      for (const a of list || []) {
        rows.push([
          b.id,
          b.supplier,
          b.due_date,
          a.name,
          a.path,
        ])
      }
    }

    if (!rows.length) {
      Alert.alert(tr('Export'), tr('No attachments found for the selected bills.'))
      return
    }

    function csvEscape(v: any) {
      const s = v === null || v === undefined ? '' : String(v)
      return `"${s.replace(/"/g, '""')}"`
    }

    const header = ['bill_id', 'supplier', 'due_date', 'attachment_name', 'attachment_path']
    const csv = [header]
      .concat(rows)
      .map((r: any[]) => r.map(csvEscape).join(','))
      .join('\n')
    const file = `${FileSystem.cacheDirectory}billbox-attachments.csv`
    await FileSystem.writeAsStringAsync(file, csv)
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file)
    else Alert.alert(tr('CSV saved'), file)
  }, [
    entitlements.exportsEnabled,
    entitlements.status,
    selectedBillIds,
    selectedBills,
    showToast,
    spaceId,
    supabase,
  ])

  const openBillAttachmentsForBill = useCallback(async (bill: Bill & { __spaceId?: string }) => {
    try {
      const billSpaceId = (bill as any)?.__spaceId || spaceId
      const list = supabase
        ? await listRemoteAttachments(supabase!, 'bills', bill.id, billSpaceId)
        : await listLocalAttachments(billSpaceId, 'bills', bill.id)
      const atts = (list || []) as AttachmentItem[]

      if (!atts.length) {
        Alert.alert(tr('No attachments'), tr('No attachments found for this bill.'))
        return
      }

      const open = async (att: AttachmentItem) => {
        if (supabase) {
          const url = await getSignedUrl(supabase!, att.path)
          if (url) Linking.openURL(url)
          else Alert.alert(tr('Open failed'), tr('Could not get URL'))
          return
        }
        if (att?.uri) {
          Linking.openURL(att.uri)
          return
        }
        Alert.alert(tr('Offline'), tr('Attachment stored locally. Preview is unavailable.'))
      }

      if (atts.length === 1) {
        await open(atts[0])
        return
      }

      const buttons = atts.slice(0, 6).map((a) => ({
        text: String(a?.name || a?.path || tr('Open')),
        onPress: () => {
          void open(a)
        },
      }))
      buttons.push({ text: tr('Cancel'), style: 'cancel' as const })
      Alert.alert(tr('Open'), undefined, buttons)
    } catch {
      Alert.alert(tr('Open failed'), tr('Unknown error'))
    }
  }, [spaceId, supabase, tr])

  const openSelectedBillAttachments = useCallback(async () => {
    if (!selectedBills.length) {
      Alert.alert(tr('Required field'), tr('Please select at least one bill.'))
      return
    }

    if (selectedBills.length === 1) {
      await openBillAttachmentsForBill(selectedBills[0])
      return
    }

    const buttons = selectedBills.slice(0, 6).map((b) => ({
      text: String(b.supplier || tr('Untitled bill')),
      onPress: () => {
        void openBillAttachmentsForBill(b)
      },
    }))
    buttons.push({ text: tr('Cancel'), style: 'cancel' as const })
    Alert.alert(tr('Select bill to view attachments'), undefined, buttons)
  }, [openBillAttachmentsForBill, selectedBills, tr])

  const chooseExportFormat = useCallback(() => {
    openExportSelection()
  }, [openExportSelection])

  useEffect(() => {
    const shouldOpen = Boolean((route as any)?.params?.openExportChooser)
    if (!shouldOpen) return

    const preset = (route as any)?.params?.exportPreset
    if (preset && typeof preset === 'object') {
      if (typeof preset.dateMode === 'string') setDateMode(preset.dateMode)
      if (typeof preset.dateFrom === 'string') setDateFrom(preset.dateFrom)
      if (typeof preset.dateTo === 'string') setDateTo(preset.dateTo)
      if (typeof preset.supplierQuery === 'string') setSupplierQuery(preset.supplierQuery)
      if (typeof preset.amountMin === 'string') setAmountMin(preset.amountMin)
      if (typeof preset.amountMax === 'string') setAmountMax(preset.amountMax)
      if (typeof preset.hasAttachmentsOnly === 'boolean') setHasAttachmentsOnly(preset.hasAttachmentsOnly)
      if (typeof preset.includeArchived === 'boolean') setIncludeArchived(preset.includeArchived)
      if (typeof preset.overdueOnly === 'boolean') setOverdueOnly(preset.overdueOnly)
      if (Array.isArray((preset as any).statusList)) {
        const raw = (preset as any).statusList as any[]
        const set = new Set(raw.map((v) => String(v || '').trim()).filter(Boolean))
        const next = {
          unpaid: set.has('unpaid'),
          paid: set.has('paid'),
          archived: set.has('archived'),
        }
        setStatusSelections(next)
        setIncludeArchived(next.archived)
        setUnpaidOnly(next.unpaid && !next.paid && !next.archived)
      } else {
        if (typeof preset.unpaidOnly === 'boolean') handleUnpaidToggle(preset.unpaidOnly)
        if (typeof preset.statusFilter === 'string') handleStatusChange(preset.statusFilter)
      }
      setFiltersExpanded(true)
    }

    const timeout = setTimeout(() => {
      openExportSelection()
    }, 200)

    navigation.setParams?.({ openExportChooser: null, exportPreset: null })
    return () => clearTimeout(timeout)
  }, [handleStatusChange, handleUnpaidToggle, navigation, openExportSelection, route])

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

  const [billDuePickerVisible, setBillDuePickerVisible] = useState(false)
  const [billDuePickerValue, setBillDuePickerValue] = useState(new Date())
  const [billDuePickerTarget, setBillDuePickerTarget] = useState<Bill & { __spaceId?: string } | null>(null)

  const openBillDueDatePicker = useCallback((bill: Bill & { __spaceId?: string }) => {
    const current = parseDateValue(bill.due_date) || new Date()
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        mode: 'date',
        value: current,
        onChange: async (_event, selectedDate) => {
          if (!selectedDate) return
          const next = formatDateInput(selectedDate)
          const billSpaceId = String((bill as any)?.__spaceId || spaceId || '')
          await updateBillDueDate(bill, next, billSpaceId)
        },
      })
      return
    }
    setBillDuePickerTarget(bill)
    setBillDuePickerValue(current)
    setBillDuePickerVisible(true)
  }, [formatDateInput, parseDateValue, spaceId])

  const updateBillDueDate = useCallback(async (bill: Bill & { __spaceId?: string }, nextDate: string, billSpaceId: string) => {
    try {
      if (supabase) {
        const { data } = await setBillDueDate(supabase, bill.id, nextDate, billSpaceId)
        if (data) setBills((prev) => prev.map((b) => (b.id === bill.id ? { ...(data as any), __spaceId: (b as any).__spaceId } : b)))
        else setBills((prev) => prev.map((b) => (b.id === bill.id ? { ...b, due_date: nextDate } : b)))
      } else {
        await setLocalBillDueDate(billSpaceId, bill.id, nextDate)
        setBills((prev) => prev.map((b) => (b.id === bill.id ? { ...b, due_date: nextDate } : b)))
      }
      showToast(tr('Due date updated.'), 'success')
    } catch {
      Alert.alert(tr('Update failed'), tr('Unable to update due date.'))
    }
  }, [supabase, tr, showToast])

  const renderBillItem = useCallback(({ item }: { item: Bill & { __spaceId?: string } }) => {
    const dueDate = parseDateValue(item.due_date)
    const trackedDate = getBillDate(item, dateMode)
    const isOverdue = dueDate ? isBillUnpaid(item.status) && dueDate.getTime() < today.getTime() : false
    const statusLabel = item.status === 'archived' ? 'Archived' : isOverdue ? 'Overdue' : item.status === 'paid' ? 'Paid' : 'Unpaid'
    const statusTone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' = item.status === 'archived' ? 'neutral' : isOverdue ? 'warning' : item.status === 'paid' ? 'success' : 'info'
    const attachments = attachmentCounts[item.id] || 0

    const billSpaceId = String((item as any)?.__spaceId || spaceId || '')
    const billSpaceName = payerNameForId(billSpaceId) || (space?.name || tr('Default space'))

    return (
      <Surface
        elevated
        style={[
          styles.billCard,
          item.status === 'paid' && styles.billCardPaid,
          isBillUnpaid(item.status) && !isOverdue && styles.billCardUnpaid,
          isOverdue && styles.billCardOverdue,
          highlightId === item.id && styles.billHighlighted,
        ]}
      >
        <Pressable
          onPress={() => navigation.navigate('Bill Details', { bill: item, spaceIdOverride: billSpaceId })}
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

          {isOverdue && (
            <View style={styles.billMetaRow}>
              <View style={styles.billMetaGroup}>
                <Ionicons name="calendar-clear-outline" size={16} color="#6B7280" />
                <Text style={styles.billMetaSecondary}>{tr('Change due date')}</Text>
              </View>
              <AppButton
                label={tr('Pick date')}
                variant="outline"
                iconName="calendar-outline"
                onPress={() => openBillDueDatePicker(item)}
              />
            </View>
          )}

          <View style={styles.billMetaRow}>
            <View style={styles.billMetaGroup}>
              <Ionicons name="person-circle-outline" size={16} color="#6B7280" />
              <Text style={styles.billMetaSecondary}>{billSpaceName}</Text>
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
  }, [attachmentCounts, dateMode, formatAmount, formatDisplayDate, getBillDate, highlightId, navigation, openBillDueDatePicker, parseDateValue, payerNameForId, relativeDueText, space?.name, spaceId, today, tr, warrantyBillIds])

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
        ref={(ref) => { listRef.current = ref }}
        style={{ flex: 1 }}
        data={loadingBills && bills.length === 0 ? [] : filteredBills}
        keyExtractor={(item) => item.id}
        renderItem={renderBillItem}
        contentContainerStyle={[styles.listContent, { paddingBottom: listBottomPadding }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadBills(true)} />}
        ListHeaderComponent={
          <View style={[styles.pageStack, { paddingBottom: themeSpacing.sm }]}>
            <TabTopBar titleKey="bills" />

            {billsError ? (
              <InlineInfo
                tone="warning"
                iconName="alert-circle-outline"
                message={billsError}
              />
            ) : null}

            {!supabase && (
              <InlineInfo
                tone="warning"
                iconName="cloud-offline-outline"
                message={tr('Cloud sync is disabled. Bills are stored locally until you connect Supabase.')}
              />
            )}

            <Surface elevated padded={false} style={styles.filtersCard}>
              <Pressable style={styles.filtersHeader} onPress={() => setFiltersExpanded((prev) => !prev)} hitSlop={8}>
                <View style={{ flex: 1 }} />
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
                  <View style={{ marginBottom: themeSpacing.sm }}>
                    <Text style={styles.filterLabel}>{tr('Profile scope')}</Text>
                    <SegmentedControl
                      value={profileScope}
                      onChange={(v) => setProfileScope(v as BillsProfileScope)}
                      options={canSelectPayer2
                        ? [
                          { value: 'payer1', label: payerNameForId('personal') },
                          { value: 'payer2', label: payerNameForId('personal2') },
                          { value: 'both', label: `${payerNameForId('personal')} + ${payerNameForId('personal2')}` },
                        ]
                        : [
                          { value: 'payer1', label: payerNameForId('personal') },
                        ]}
                      style={{ marginTop: themeSpacing.xs }}
                    />
                  </View>

                  <SegmentedControl
                    value={dateMode}
                    onChange={(value) => setDateMode(value as typeof dateMode)}
                    options={[
                      { value: 'due', label: tr('Due') },
                      { value: 'invoice', label: tr('Invoice') },
                      { value: 'created', label: tr('Created') },
                    ]}
                  />

                  <View style={{ position: 'relative' }}>
                    <AppInput
                      placeholder={tr('Supplier')}
                      value={supplierQuery}
                      onChangeText={setSupplierQuery}
                    />
                    {supplierOptions.length > 0 && supplierQuery.trim().length > 0 && (
                      <View style={styles.supplierSuggestList}>
                        {supplierOptions.map((name) => (
                          <Pressable
                            key={name}
                            onPress={() => {
                              setSupplierQuery(name)
                              setSupplierDropdownOpen(false)
                            }}
                            style={({ pressed }) => [styles.supplierSuggestItem, pressed ? { backgroundColor: '#EFF6FF' } : null]}
                          >
                            <Text style={styles.supplierSuggestText} numberOfLines={1}>{name}</Text>
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </View>

                  <View style={styles.filterRow}>
                    <AppInput
                      placeholder={tr('Min amount')}
                      keyboardType="numeric"
                      value={amountMin}
                      onChangeText={setAmountMin}
                      style={styles.flex1}
                    />
                    <AppInput
                      placeholder={tr('Max amount')}
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
                        hint={tr('Manual entry optional')}
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
                      <Switch
                        value={includeArchived}
                        onValueChange={(value) => {
                          setIncludeArchived(value)
                          setStatusSelections((prev) => ({ ...prev, archived: value }))
                        }}
                      />
                      <Text style={styles.toggleLabel}>{tr('Include archived')}</Text>
                    </View>
                  </View>

                  <View style={styles.filtersFooter}>
                    <AppButton
                      label={tr('Find')}
                      variant="primary"
                      iconName="search-outline"
                      onPress={applyFilters}
                    />
                    <AppButton
                      label={tr('Clear filters')}
                      variant="ghost"
                      iconName="refresh-outline"
                      onPress={resetFilters}
                    />
                  </View>
                </View>
              )}
            </Surface>

            <View style={{ marginTop: themeSpacing.sm }}>
              <Text style={styles.filterLabel}>{tr('Status')}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                <AppButton
                  label={tr('All')}
                  variant={statusSelections.unpaid && statusSelections.paid && (!includeArchived || statusSelections.archived) ? 'secondary' : 'ghost'}
                  onPress={() => setStatusSelections({ unpaid: true, paid: true, archived: includeArchived })}
                />
                <AppButton
                  label={tr('Unpaid')}
                  variant={statusSelections.unpaid ? 'secondary' : 'ghost'}
                  onPress={() => setStatusSelections((prev) => ({ ...prev, unpaid: !prev.unpaid }))}
                />
                <AppButton
                  label={tr('Paid')}
                  variant={statusSelections.paid ? 'secondary' : 'ghost'}
                  onPress={() => setStatusSelections((prev) => ({ ...prev, paid: !prev.paid }))}
                />
                <AppButton
                  label={tr('Archived')}
                  variant={statusSelections.archived ? 'secondary' : 'ghost'}
                  onPress={() => setStatusSelections((prev) => ({ ...prev, archived: !prev.archived }))}
                />
              </View>
            </View>

            <View style={styles.billsPrimaryActionsRow}>
              <View style={styles.flex1} />
              <AppButton
                label={tr('Export')}
                iconName={entitlements.exportsEnabled ? 'download-outline' : 'sparkles-outline'}
                variant="secondary"
                onPress={chooseExportFormat}
                disabled={exportBusy}
              />
              <AppButton
                label={tr('Add bill')}
                iconName="add-outline"
                variant="secondary"
                onPress={() => navigation.navigate('Scan')}
              />
            </View>

            {exportBusy ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
                <ActivityIndicator size="small" color={themeColors.primary} />
                <Text style={styles.mutedText}>{exportBusyLabel || tr('Preparing export…')}</Text>
              </View>
            ) : null}

            <View style={styles.listMetaRow}>
              <Text style={styles.listMetaText}>{resultsLabel}</Text>
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
              <AppButton label={tr('Cancel')} variant="ghost" onPress={cancelIosPicker} />
              <AppButton label={tr('Use date')} onPress={confirmIosPicker} />
            </View>
          </Surface>
        </View>
      )}

      {isIOS && billDuePickerVisible && billDuePickerTarget && (
        <View style={styles.iosPickerOverlay}>
          <Surface elevated style={styles.iosPickerSheet}>
            <Text style={styles.filterLabel}>{tr('Select date')}</Text>
            <DateTimePicker
              mode="date"
              display="inline"
              value={billDuePickerValue}
              onChange={(_, selected) => {
                if (selected) setBillDuePickerValue(selected)
              }}
            />
            <View style={styles.iosPickerActions}>
              <AppButton label={tr('Cancel')} variant="ghost" onPress={() => { setBillDuePickerVisible(false); setBillDuePickerTarget(null) }} />
              <AppButton
                label={tr('Use date')}
                onPress={async () => {
                  const next = formatDateInput(billDuePickerValue)
                  const billSpaceId = String((billDuePickerTarget as any)?.__spaceId || spaceId || '')
                  setBillDuePickerVisible(false)
                  await updateBillDueDate(billDuePickerTarget, next, billSpaceId)
                  setBillDuePickerTarget(null)
                }}
              />
            </View>
          </Surface>
        </View>
      )}

      <Modal visible={exportSelectVisible} transparent animationType="fade" onRequestClose={() => setExportSelectVisible(false)}>
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
          <Surface elevated style={styles.exportPickerSheet}>
            <View style={styles.exportPickerHeader}>
              <Text style={styles.screenHeaderTitle}>{tr('Select bills to export')}</Text>
              <AppButton label={tr('Close')} variant="ghost" onPress={() => setExportSelectVisible(false)} />
            </View>
            <Text style={styles.mutedText}>{tr('{count} selected', { count: selectedBillIds.length })}</Text>

            <View style={styles.exportPickerActions}>
              <AppButton
                label={allExportSelected ? tr('Deselect all') : tr('Select all')}
                variant="secondary"
                onPress={() => (allExportSelected ? clearAllExport() : selectAllExport())}
              />
              <AppButton label={tr('Clear selection')} variant="ghost" onPress={clearAllExport} />
            </View>

            <View style={styles.exportPickerList}>
              <FlatList
                data={filteredBills}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => {
                  const checked = !!exportSelectedIds[item.id]
                  return (
                    <Pressable
                      onPress={() => toggleExportSelection(item.id)}
                      style={[styles.exportPickerRow, checked && styles.exportPickerRowSelected]}
                    >
                      <Ionicons
                        name={checked ? 'checkbox' : 'square-outline'}
                        size={20}
                        color={checked ? themeColors.primary : themeColors.textMuted}
                      />
                      <View style={styles.exportPickerRowBody}>
                        <Text style={styles.exportPickerRowTitle} numberOfLines={1}>{item.supplier || tr('Untitled bill')}</Text>
                        <Text style={styles.exportPickerRowMeta}>
                          {formatDisplayDate(item.due_date)} • {formatAmount(item.amount, item.currency)}
                        </Text>
                      </View>
                    </Pressable>
                  )
                }}
              />
            </View>

            <Divider style={{ marginTop: themeSpacing.sm, marginBottom: themeSpacing.sm }} />
            <Text style={styles.formSectionTitle}>{tr('View attachments')}</Text>
            <View style={styles.exportPickerActions}>
              <AppButton
                label={tr('View attachments')}
                iconName="open-outline"
                variant="secondary"
                disabled={!selectedBillIds.length}
                onPress={openSelectedBillAttachments}
              />
            </View>
            <Divider style={{ marginTop: themeSpacing.sm, marginBottom: themeSpacing.sm }} />
            <Text style={styles.formSectionTitle}>{tr('Export attachments')}</Text>
            <View style={styles.exportPickerActions}>
              <AppButton
                label={tr('Export PDF attachments')}
                iconName="document-text-outline"
                variant="secondary"
                disabled={!selectedBillIds.length}
                onPress={() => exportAttachmentsZip('pdf')}
              />
              <AppButton
                label={tr('Export image attachments')}
                iconName="image-outline"
                variant="secondary"
                disabled={!selectedBillIds.length}
                onPress={() => exportAttachmentsZip('image')}
              />
              <AppButton
                label={tr('Export attachments CSV')}
                iconName="download-outline"
                variant="secondary"
                disabled={!selectedBillIds.length}
                onPress={() => exportAttachmentsCsv()}
              />
            </View>
          </Surface>
        </View>
      </Modal>

      <Modal visible={installmentVisible} transparent animationType="fade" onRequestClose={() => setInstallmentVisible(false)}>
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
          <Surface elevated padded={false} style={{ width: '100%', maxWidth: 520, alignSelf: 'center', maxHeight: '90%' }}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: themeSpacing.lg }}
              showsVerticalScrollIndicator={false}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeSpacing.sm }}>
                <Text style={styles.screenHeaderTitle}>{tr('Installment obligation')}</Text>
                <AppButton
                  label={tr('Back')}
                  variant="ghost"
                  iconName="chevron-back-outline"
                  onPress={() => setInstallmentVisible(false)}
                />
              </View>

              <Text style={[styles.mutedText, { marginTop: themeSpacing.xs }]}>
                {tr('This creates a monthly bill so it appears in Bills and Pay automatically.')}
              </Text>

              <Divider style={{ marginTop: themeSpacing.sm }} />

              <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
                <View style={{ gap: themeSpacing.xs }}>
                  <Text style={styles.formSectionTitle}>{tr('Supplier')} *</Text>
                  <AppInput
                    placeholder={tr('Supplier')}
                    value={installmentTitle}
                    onChangeText={setInstallmentTitle}
                    style={installmentAttempted && !installmentValidation.titleOk ? styles.inputError : null}
                  />
                </View>

                <View style={{ gap: themeSpacing.xs }}>
                  <View style={[styles.filterRow, { alignItems: 'flex-end' }]}>
                    <Text style={[styles.formSectionTitle, { flex: 1 }]}>{tr('Amount')} *</Text>
                    <Text style={[styles.formSectionTitle, { flex: 1 }]}>{tr('Currency')} *</Text>
                  </View>
                  <View style={styles.filterRow}>
                    <AppInput
                      placeholder={tr('Amount')}
                      keyboardType="numeric"
                      value={installmentAmount}
                      onChangeText={setInstallmentAmount}
                      style={[styles.flex1, installmentAttempted && !installmentValidation.amountOk ? styles.inputError : null]}
                    />
                    <AppInput
                      placeholder={tr('Currency')}
                      value={installmentCurrency}
                      onChangeText={setInstallmentCurrency}
                      style={[styles.flex1, installmentAttempted && !installmentValidation.currencyOk ? styles.inputError : null]}
                    />
                  </View>
                </View>

              <View style={{ gap: themeSpacing.xs }}>
                <Text style={styles.formSectionTitle}>{tr('Start month (YYYY-MM)')} *</Text>
                <View style={styles.filterRow}>
                  <AppInput
                    placeholder="YYYY-MM"
                    value={installmentStartMonth}
                    onChangeText={(v) => {
                      setInstallmentStartMonth(v)
                      syncInstallmentDerived(v, installmentMonths, installmentEndMonth)
                    }}
                    style={[styles.flex1, installmentAttempted && !installmentValidation.startOk ? styles.inputError : null]}
                  />
                  <AppButton
                    label={tr('Pick date')}
                    variant="secondary"
                    iconName="calendar-outline"
                    onPress={() => openInstallmentMonthPicker('start')}
                  />
                </View>
              </View>

              <View style={{ gap: themeSpacing.xs }}>
                <Text style={styles.formSectionTitle}>{tr('Due day (1-31)')} *</Text>
                <AppInput
                  placeholder={tr('Due day (1-31)')}
                  keyboardType="numeric"
                  value={installmentDueDay}
                  onChangeText={setInstallmentDueDay}
                  style={installmentAttempted && !installmentValidation.dayOk ? styles.inputError : null}
                />
              </View>

              <View style={{ gap: themeSpacing.xs }}>
                <Text style={styles.formSectionTitle}>{tr('Number of months')} *</Text>
                <AppInput
                  placeholder={tr('Number of months')}
                  keyboardType="numeric"
                  value={installmentMonths}
                  onChangeText={(v) => {
                    lastInstallmentEditRef.current = 'months'
                    setInstallmentMonths(v)
                    syncInstallmentDerived(installmentStartMonth, v, installmentEndMonth)
                  }}
                  style={installmentAttempted && (!installmentValidation.monthsOk || !installmentValidation.monthsMatchOk) ? styles.inputError : null}
                />
              </View>

              <View style={{ gap: themeSpacing.xs }}>
                <Text style={styles.formSectionTitle}>{tr('End month (YYYY-MM)')} *</Text>
                <View style={styles.filterRow}>
                  <AppInput
                    placeholder="YYYY-MM"
                    value={installmentEndMonth}
                    onChangeText={(v) => {
                      lastInstallmentEditRef.current = 'end'
                      setInstallmentEndMonth(v)
                      syncInstallmentDerived(installmentStartMonth, installmentMonths, v)
                    }}
                    style={[styles.flex1, installmentAttempted && (!installmentValidation.endOk || !installmentValidation.rangeOk || !installmentValidation.monthsMatchOk) ? styles.inputError : null]}
                  />
                  <AppButton
                    label={tr('Pick date')}
                    variant="secondary"
                    iconName="calendar-outline"
                    onPress={() => openInstallmentMonthPicker('end')}
                  />
                </View>
              </View>

              <Text style={styles.mutedText}>{tr('Enter number of months or an end month.')}</Text>

              <Text style={styles.formSectionTitle}>{tr('Payment details')}</Text>
              <Text style={styles.fieldLabel}>{tr('Creditor')} *</Text>
              <AppInput
                placeholder={tr('Creditor')}
                value={installmentCreditor}
                onChangeText={setInstallmentCreditor}
                style={installmentAttempted && !installmentValidation.creditorOk ? styles.inputError : null}
              />
              <Text style={styles.fieldLabel}>{tr('IBAN')} *</Text>
              <AppInput
                placeholder={tr('IBAN')}
                value={installmentIban}
                onChangeText={setInstallmentIban}
                style={installmentAttempted && !installmentValidation.ibanOk ? styles.inputError : null}
              />
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>{tr('Reference')} *</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ width: 90 }}>
                    <AppInput
                      placeholder={tr('SI 12')}
                      value={installmentReferenceModel}
                      onChangeText={setInstallmentReferenceModel}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      keyboardType="default"
                      maxLength={5}
                      style={installmentAttempted && (!installmentValidation.modelOk || !installmentValidation.referenceOk) ? styles.inputError : null}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppInput
                      placeholder={tr('Reference number')}
                      value={installmentReferenceNumber}
                      onChangeText={setInstallmentReferenceNumber}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      keyboardType="default"
                      style={installmentAttempted && (!installmentValidation.numberOk || !installmentValidation.referenceOk) ? styles.inputError : null}
                    />
                  </View>
                </View>
              </View>
              <Text style={styles.fieldLabel}>{tr('Purpose')} *</Text>
              <AppInput
                placeholder={tr('Purpose')}
                value={installmentPurpose}
                onChangeText={setInstallmentPurpose}
                multiline
                style={installmentAttempted && !installmentValidation.purposeOk ? styles.inputError : null}
              />

              <AppButton
                label={installmentSaving ? tr('Saving…') : tr('Save')}
                iconName="save-outline"
                onPress={saveInstallment}
                loading={installmentSaving}
                disabled={!installmentComplete || installmentSaving}
              />
              </View>
            </ScrollView>
          </Surface>
        </View>
      </Modal>

      <Modal
        visible={installmentUpgradeVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setInstallmentUpgradeVisible(false)}
      >
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
          <Surface elevated style={{ width: '100%', maxWidth: 520, alignSelf: 'center' }}>
            <Text style={styles.screenHeaderTitle}>{tr('Upgrade required')}</Text>
            <Text style={[styles.bodyText, { marginTop: themeSpacing.xs }]}>{tr('Installment obligations are available on Več.')}</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
              <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setInstallmentUpgradeVisible(false)} />
              <AppButton
                label={tr('Upgrade')}
                iconName="arrow-up-outline"
                onPress={() => {
                  setInstallmentUpgradeVisible(false)
                  setInstallmentVisible(false)
                  navigation.navigate('Payments', { focusPlan: 'pro' })
                }}
              />
            </View>
          </Surface>
        </View>
      </Modal>

      {isIOS && installmentMonthPickerVisible && (
        <View style={styles.iosPickerOverlay}>
          <Surface elevated style={styles.iosPickerSheet}>
            <Text style={styles.filterLabel}>{tr('Select date')}</Text>
            <DateTimePicker
              mode="date"
              display="inline"
              value={installmentMonthPickerValue}
              onChange={(_, selected) => {
                if (selected) setInstallmentMonthPickerValue(selected)
              }}
            />
            <View style={styles.iosPickerActions}>
              <AppButton
                label={tr('Cancel')}
                variant="ghost"
                onPress={() => {
                  setInstallmentMonthPickerVisible(false)
                  setInstallmentMonthPickerField(null)
                }}
              />
              <AppButton
                label={tr('Use date')}
                onPress={() => {
                  const ym = monthKeyFromDate(installmentMonthPickerValue)
                  const field = installmentMonthPickerField
                  setInstallmentMonthPickerVisible(false)
                  setInstallmentMonthPickerField(null)
                  if (field === 'start') {
                    setInstallmentStartMonth(ym)
                    syncInstallmentDerived(ym, installmentMonths, installmentEndMonth)
                  }
                  if (field === 'end') {
                    lastInstallmentEditRef.current = 'end'
                    setInstallmentEndMonth(ym)
                    syncInstallmentDerived(installmentStartMonth, installmentMonths, ym)
                  }
                }}
              />
            </View>
          </Surface>
        </View>
      )}

      {toast ? (
        <View style={styles.toastWrap} pointerEvents="none">
          <Surface
            elevated
            style={[
              styles.toastCard,
              toast.tone === 'danger'
                ? styles.toastDanger
                : toast.tone === 'info'
                  ? styles.toastInfo
                  : styles.toastSuccess,
            ]}
          >
            <Ionicons
              name={toast.tone === 'danger' ? 'alert-circle' : toast.tone === 'info' ? 'information-circle' : 'checkmark-circle'}
              size={18}
              color={toast.tone === 'danger' ? '#991B1B' : toast.tone === 'info' ? '#1D4ED8' : '#166534'}
            />
            <Text
              style={[
                styles.toastText,
                toast.tone === 'danger'
                  ? styles.toastTextDanger
                  : toast.tone === 'info'
                    ? styles.toastTextInfo
                    : styles.toastTextSuccess,
              ]}
            >
              {toast.message}
            </Text>
          </Surface>
        </View>
      ) : null}
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
    { spaceId: string; spaceName: string; totalUnpaid: number; unpaidCount: number; overdueCount: number; overdueTotal: number; nextDueDate: string | null; nextDueTotal: number }[]
  >([])

  const dayKey = useDayKey()

  const formatDate = useCallback((iso?: string | null) => {
    if (!iso) return '-'
    try {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      return d.toISOString().slice(0, 10)
    } catch {
      return String(iso)
    }
  }, [])

  const [languagePickerVisible, setLanguagePickerVisible] = useState(false)
  const [homeSummarySettingsVisible, setHomeSummarySettingsVisible] = useState(false)
  const [homeSummaryVisibility, setHomeSummaryVisibility] = useState({ totalUnpaid: true, overdue: true, nextDue: true })
  const [creatingPayer2, setCreatingPayer2] = useState(false)
  const [payer2NameDraft, setPayer2NameDraft] = useState('')
  const [upgradeModalVisible, setUpgradeModalVisible] = useState(false)

  const languageOptions = useMemo(() => {
    const opts: Array<{ code: Lang; key: string }> = [
      { code: 'sl', key: 'slovenian' },
      { code: 'en', key: 'english' },
      { code: 'hr', key: 'croatian' },
      { code: 'it', key: 'italian' },
      { code: 'de', key: 'german' },
    ]
    return opts.map((o) => ({ ...o, label: t(lang, o.key) }))
  }, [lang])

  const safeNavigate = useCallback((routeName: string, params?: any) => {
    const requestId = createRequestId('nav')
    if (routeName === 'Warranties') {
      console.info(`[nav] route=Warranties requestId=${requestId}`)
      // Warranties is defined on the parent Stack (tabs are nested inside it).
      try {
        const parent = navigation.getParent?.() || null
        if (parent?.navigate) {
          parent.navigate(routeName, params)
          return
        }
      } catch {}
    }
    // React Navigation can have multiple nested navigators (tabs inside stack).
    // Attempt navigation at the current level, then walk up to parents until the route exists.
    try {
      let nav: any = navigation
      for (let i = 0; i < 6 && nav; i++) {
        const state = nav.getState?.() || nav.getRootState?.() || null
        const routeNames: string[] = Array.isArray(state?.routeNames) ? state.routeNames : []
        if (routeNames.includes(routeName)) {
          nav.navigate(routeName, params)
          return
        }
        nav = nav.getParent?.() || null
      }

      // Last resort: try anyway (will no-op with a warning if truly missing).
      navigation.navigate(routeName, params)
    } catch (e) {
      console.warn(`[nav] failed route=${routeName} requestId=${requestId}`, e)
      Alert.alert(tr('Error'), tr('Open failed'))
    }
  }, [navigation])

  const payerOptions = useMemo(() => {
    const base = spacesCtx.spaces
      .filter((s) => isPayerSpaceId(s.id))
      .map((s) => ({ value: s.id, label: (String(s.name || '').trim() || payerLabelFromSpaceId(s.id)) }))
    if (base.length >= 2) return base
    const second = entitlements.plan === 'pro'
      ? { value: '__create_payer2__', label: 'Profil 2' }
      : { value: '__locked_payer2__', label: 'Profil 2' }
    return base.concat([second])
  }, [entitlements.plan, spacesCtx.spaces])

  const handlePayerChange = useCallback(async (id: string) => {
    if (id === '__locked_payer2__') {
      setUpgradeModalVisible(true)
      return
    }
    if (id === '__create_payer2__') {
      setCreatingPayer2(true)
      setPayer2NameDraft('')
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
    if (trimmed.toLowerCase() === 'profil 2') {
      Alert.alert(tr('Name required'), tr('Please choose a custom name (not "Profil 2").'))
      return
    }
    await spacesCtx.addSpace({
      name: trimmed,
      kind: 'personal',
      plan: spacesCtx.current?.plan || 'free',
    })
    setCreatingPayer2(false)
  }, [payer2NameDraft, spacesCtx])

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
        const todayIso = dayKey

        const next: { spaceId: string; spaceName: string; totalUnpaid: number; unpaidCount: number; overdueCount: number; overdueTotal: number; nextDueDate: string | null; nextDueTotal: number }[] = []

        for (const sp of payerSpaces) {
          const sid = sp.id
          let bills: Bill[] = []
          if (supabase) {
            const { data, error } = await listBills(supabase, sid, entitlements)
            if (error) throw error
            bills = data || []
          } else {
            const locals = await loadLocalBills(sid)
            bills = (locals as any) || []
          }

          let totalUnpaid = 0
          let unpaidCount = 0
          let overdueCount = 0
          let overdueTotal = 0
          let nextDue: string | null = null
          let nextDueTotal = 0

          for (const bill of bills) {
            if (!isBillUnpaid(bill.status)) continue
            const amountRaw = Number((bill as any)?.amount ?? 0)
            const amount = Number.isFinite(amountRaw) ? amountRaw : 0
            unpaidCount += 1
            totalUnpaid += amount
            if (!bill.due_date) continue
            const due = bill.due_date
            if (due < todayIso) {
              overdueCount += 1
              overdueTotal += amount
            } else {
              if (!nextDue || due < nextDue) {
                nextDue = due
                nextDueTotal = amount
              } else if (nextDue && due === nextDue) {
                nextDueTotal += amount
              }
            }
          }

          next.push({
            spaceId: sid,
            spaceName: (sp?.name || '').trim() || payerLabelFromSpaceId(sid),
            totalUnpaid,
            unpaidCount,
            overdueCount,
            overdueTotal,
            nextDueDate: nextDue,
            nextDueTotal,
          })
        }

        setSummaries(next)
      } catch (e) {
        console.warn('Home summary load failed', e)
        setSummaries([])
      }
    })()
  }, [dayKey, loading, spacesCtx.spaces, entitlements])

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
    { label: tr('Add bill'), icon: 'scan-outline', description: tr('Capture QR codes or import documents.'), target: 'Scan' },
    { label: tr('Bills'), icon: 'receipt-outline', description: tr('Review and manage all bills.'), target: 'Bills' },
    { label: tr('Inbox'), icon: 'mail-outline', description: tr('Review received documents.'), target: 'Inbox' },
    { label: tr('Payments'), icon: 'card-outline', description: tr('Plan and schedule payments.'), target: 'Pay' },
    { label: tr('Warranties'), icon: 'shield-checkmark-outline', description: tr('Track product warranties.'), target: 'Warranties' },
    { label: tr('Reports'), icon: 'bar-chart-outline', description: tr('Analytics and totals.'), target: 'Reports' },
    { label: tr('Export'), icon: 'download-outline', description: tr('Export filtered bills (CSV, PDF, ZIP, JSON).'), target: 'Bills', params: { openExportChooser: true } },
  ]

  const activePayerId = String(spacesCtx.current?.id || spaceId || '').trim()
  const activeSummary = (summaries || []).find((s) => s.spaceId === activePayerId) || (summaries || [])[0] || null
  const mask = '•••'
  const totalUnpaidValue = activeSummary
    ? (homeSummaryVisibility.totalUnpaid ? `EUR ${Number(activeSummary.totalUnpaid || 0).toFixed(2)}` : mask)
    : (homeSummaryVisibility.totalUnpaid ? '—' : mask)
  const totalUnpaidSubValue = activeSummary
    ? (homeSummaryVisibility.totalUnpaid ? tr('{count} bills', { count: activeSummary.unpaidCount || 0 }) : mask)
    : (homeSummaryVisibility.totalUnpaid ? '—' : mask)
  const overdueValue = activeSummary
    ? (homeSummaryVisibility.overdue ? `EUR ${Number(activeSummary.overdueTotal || 0).toFixed(2)}` : mask)
    : (homeSummaryVisibility.overdue ? '—' : mask)
  const overdueSubValue = activeSummary
    ? (homeSummaryVisibility.overdue ? tr('{count} bills', { count: activeSummary.overdueCount || 0 }) : mask)
    : (homeSummaryVisibility.overdue ? '—' : mask)
  const nextDueValue = activeSummary
    ? (homeSummaryVisibility.nextDue ? (activeSummary.nextDueDate || tr('None')) : mask)
    : (homeSummaryVisibility.nextDue ? '—' : mask)
  const nextDueSubValue = activeSummary
    ? (homeSummaryVisibility.nextDue
      ? (activeSummary.nextDueDate ? `EUR ${Number(activeSummary.nextDueTotal || 0).toFixed(2)}` : '—')
      : mask)
    : (homeSummaryVisibility.nextDue ? '—' : mask)

  const retentionNotices = useMemo(() => {
    const notices: Array<{ tone: 'info' | 'warning'; message: string }> = []
    const lifecycle = entitlements.lifecycleStatus
    const deleteAt = entitlements.deleteAt
    const exportUntil = entitlements.exportUntil
    const downgradeCleanupAt = entitlements.downgradeCleanupAt

    if (lifecycle === 'grace_period') {
      notices.push({
        tone: 'warning',
        message: tr('Subscription cancelled. Bills remain available until {date}.', { date: formatDate(entitlements.graceUntil) }),
      })
    }

    if (lifecycle === 'export_only') {
      notices.push({
        tone: 'warning',
        message: tr('Export-only access is active until {date}. Export your bills before then.', { date: formatDate(exportUntil) }),
      })
    }

    if (lifecycle === 'downgrade_vec_to_moje') {
      notices.push({
        tone: 'warning',
        message: tr('Attachments of the second profile will be removed on {date}. You can export them or reactivate Več.', { date: formatDate(downgradeCleanupAt) }),
      })
    }

    if (deleteAt) {
      const target = new Date(deleteAt)
      if (!Number.isNaN(target.getTime())) {
        const diffDays = Math.ceil((target.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        if (diffDays <= 7 && diffDays >= 0) {
          notices.push({
            tone: 'warning',
            message: tr('Attachments will be permanently deleted on {date}.', { date: formatDate(deleteAt) }),
          })
        }
      }
    }

    return notices
  }, [entitlements.deleteAt, entitlements.downgradeCleanupAt, entitlements.exportUntil, entitlements.graceUntil, entitlements.lifecycleStatus, formatDate, tr])

  return (
    <Screen>
      <View style={[styles.pageStack, { gap: themeSpacing.sm }]}>
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
                  marginRight: themeSpacing.sm,
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
            </>
          }
        />

        {retentionNotices.map((n, i) => (
          <Surface elevated key={`retention_${i}`}>
            <InlineInfo tone={n.tone} iconName="alert-circle-outline" message={n.message} />
          </Surface>
        ))}

        <Surface elevated padded={false} style={[styles.card, styles.homeHeroCard]}>
          <View style={styles.homeHeroHeaderRow}>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.homeHeroTitle}>Billbox</Text>
            </View>
            <TouchableOpacity
              onPress={() => setHomeSummarySettingsVisible(true)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.border,
                backgroundColor: colors.surface,
              }}
              accessibilityLabel={tr('Home summary settings')}
            >
              <Ionicons name="options-outline" size={18} color={themeColors.primary} />
            </TouchableOpacity>
          </View>

          <View style={styles.homeMetricsRow}>
            <Pressable
              onPress={() => {
                navigation.navigate('Bills', {
                  filterPreset: {
                    supplierQuery: '',
                    amountMin: '',
                    amountMax: '',
                    dateMode: 'due',
                    dateFrom: '',
                    dateTo: '',
                    statusFilter: 'unpaid',
                    unpaidOnly: true,
                    overdueOnly: false,
                    hasAttachmentsOnly: false,
                    includeArchived: false,
                    filtersExpanded: false,
                  },
                })
              }}
              style={({ pressed }) => [styles.homeMetricCard, styles.homeMetricCardUnpaid, pressed && { opacity: 0.92 }]}
              hitSlop={8}
            >
              <Text style={styles.homeMetricValue} numberOfLines={1}>{totalUnpaidValue}</Text>
              <Text style={styles.homeMetricSubValue} numberOfLines={1}>{totalUnpaidSubValue}</Text>
              <Text style={styles.homeMetricLabel}>{tr('Total unpaid')}</Text>
            </Pressable>

            <Pressable
              onPress={() => {
                navigation.navigate('Bills', {
                  filterPreset: {
                    supplierQuery: '',
                    amountMin: '',
                    amountMax: '',
                    dateMode: 'due',
                    dateFrom: '',
                    dateTo: '',
                    statusFilter: 'unpaid',
                    unpaidOnly: true,
                    overdueOnly: true,
                    hasAttachmentsOnly: false,
                    includeArchived: false,
                    filtersExpanded: false,
                  },
                })
              }}
              style={({ pressed }) => [styles.homeMetricCard, styles.homeMetricCardOverdue, pressed && { opacity: 0.92 }]}
              hitSlop={8}
            >
              <Text style={styles.homeMetricValue} numberOfLines={1}>{overdueValue}</Text>
              <Text style={styles.homeMetricSubValue} numberOfLines={1}>{overdueSubValue}</Text>
              <Text style={styles.homeMetricLabel}>{tr('Overdue')}</Text>
            </Pressable>

            <Pressable
              onPress={() => {
                const next = String(activeSummary?.nextDueDate || '').trim()
                const isIso = /^\d{4}-\d{2}-\d{2}$/.test(next)
                navigation.navigate('Bills', {
                  filterPreset: {
                    supplierQuery: '',
                    amountMin: '',
                    amountMax: '',
                    dateMode: 'due',
                    dateFrom: isIso ? next : '',
                    dateTo: isIso ? next : '',
                    statusFilter: 'unpaid',
                    unpaidOnly: true,
                    overdueOnly: false,
                    hasAttachmentsOnly: false,
                    includeArchived: false,
                    filtersExpanded: false,
                  },
                })
              }}
              style={({ pressed }) => [styles.homeMetricCard, styles.homeMetricCardNext, pressed && { opacity: 0.92 }]}
              hitSlop={8}
            >
              <Text style={styles.homeMetricValue} numberOfLines={1}>{nextDueValue}</Text>
              <Text style={styles.homeMetricSubValue} numberOfLines={1}>{nextDueSubValue}</Text>
              <Text style={styles.homeMetricLabel}>{tr('Next due date')}</Text>
            </Pressable>
          </View>

          <View style={{ marginTop: themeSpacing.sm }}>
            <Text style={styles.mutedText}>{tr('Profiles')}</Text>
            <SegmentedControl
              value={spacesCtx.current?.id || spaceId || ''}
              onChange={(id) => { handlePayerChange(id) }}
              options={payerOptions}
              activeBgColor={themeColors.primary}
              activeTextColor="#FFFFFF"
              style={{ marginTop: themeSpacing.xs }}
            />

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

          </View>
        </Surface>
        <View style={styles.gridWrap}>
          {tiles.map((tile) => (
            <Pressable
              key={tile.label}
              onPress={() => {
                const params = (tile as any)?.params
                if (tile.target === 'Warranties') {
                  safeNavigate(tile.target, params)
                  return
                }
                if (tile.target === 'Inbox' && entitlements.plan !== 'pro') {
                  Alert.alert(tr('Inbox'), tr('Email inbox is available on Več.'))
                  showUpgradeAlert('inbox')
                }
                navigation.navigate(tile.target, params)
              }}
              style={({ pressed }) => [styles.statCardPressable, pressed && styles.statCardPressed]}
            >
              <Surface
                elevated
                padded={false}
                style={[
                  styles.statCard,
                  tile.target === 'Scan' && styles.statCardPrimary,
                  (tile.target === 'Scan' || tile.target === 'Bills' || tile.target === 'Pay') && styles.homePrimaryTile,
                  tile.target === 'Scan' && styles.homePrimaryTileScan,
                  tile.target === 'Bills' && styles.homePrimaryTileBills,
                  tile.target === 'Pay' && styles.homePrimaryTilePay,
                ]}
              >
                <View style={[styles.statIconWrap, tile.target === 'Scan' && styles.statIconWrapPrimary]}>
                  <Ionicons
                    name={tile.icon as keyof typeof Ionicons.glyphMap}
                    size={20}
                    color={tile.target === 'Scan' ? '#FFFFFF' : colors.text}
                  />
                </View>
                <Text style={[styles.statLabel, tile.target === 'Scan' && styles.statLabelPrimary]}>{tile.label}</Text>
                <Text style={[styles.statValue, tile.target === 'Scan' && styles.statValuePrimary]} numberOfLines={1}>
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
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: themeSpacing.xs }}>
              <Text style={styles.bodyText}>{tr('Profil 2 is available on')}</Text>
              <Badge label={tr('Več')} tone="info" />
            </View>
            <View style={{ gap: themeSpacing.xs, marginTop: themeSpacing.sm }}>
              {([
                'Two locations/households (2 profiles)',
                'Keep personal and business bills separate',
                'Independent exports and reports',
              ] as const).map((k) => (
                <View key={k} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: themeSpacing.xs }}>
                  <Ionicons name="checkmark-circle-outline" size={18} color={themeColors.primary} />
                  <Text style={[styles.bodyText, { flexShrink: 1 }]}>{tr(k)}</Text>
                </View>
              ))}
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

class WarrantiesErrorBoundary extends React.Component<{ requestId: string; children: React.ReactNode }, { hasError: boolean; error: any }> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error }
  }

  componentDidCatch(error: any, info: any) {
    const { requestId } = this.props
    console.error(`[warranties] route=Warranties requestId=${requestId}`, error, info)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <Text style={styles.mutedText}>{tr('Unknown error')}</Text>
          <Text style={styles.mutedText}>{tr('Request ID')}: {this.props.requestId}</Text>
        </View>
      </Screen>
    )
  }
}

function WarrantiesScreenWithBoundary() {
  const requestIdRef = useRef<string>(createRequestId('warranties'))
  const requestId = requestIdRef.current

  useEffect(() => {
    console.info(`[nav] route=Warranties requestId=${requestId}`)
  }, [requestId])

  return (
    <WarrantiesErrorBoundary requestId={requestId}>
      <WarrantiesScreen />
    </WarrantiesErrorBoundary>
  )
}

function WarrantiesScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const navigation = useNavigation<any>()
  const spacesCtx = useSpacesContext()
  const scrollRef = useRef<ScrollView | null>(null)
  const [items, setItems] = useState<Warranty[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [warrantyQuery, setWarrantyQuery] = useState('')
  const [warrantyItemFilter, setWarrantyItemFilter] = useState('')
  const [warrantySupplierFilter, setWarrantySupplierFilter] = useState('')
  const [warrantyDateMode, setWarrantyDateMode] = useState<'purchase' | 'created'>('purchase')
  const [warrantyDateFrom, setWarrantyDateFrom] = useState('')
  const [warrantyDateTo, setWarrantyDateTo] = useState('')
  const [warrantyStatusFilter, setWarrantyStatusFilter] = useState<'active' | 'expiring' | 'expired'>('active')
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null)
  const [billQuery, setBillQuery] = useState('')
  const [linkedBillOpen, setLinkedBillOpen] = useState(false)
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

  const payerSpaces = useMemo(() => {
    return (spacesCtx.spaces || []).filter((s) => isPayerSpaceId(s.id))
  }, [spacesCtx.spaces])

  const billSpaceIds = useMemo(() => {
    const ids = payerSpaces.map((s) => s.id)
    const p1 = ids.includes('personal') ? 'personal' : (ids[0] || null)
    const p2 = ids.includes('personal2') ? 'personal2' : null
    const canUsePayer2 = Number(entitlements?.payerLimit || 1) >= 2

    if (isPayerSpaceId(spaceId)) {
      if (spaceId === 'personal2' && (!canUsePayer2 || !p2)) return p1 ? [p1] : []
      return [spaceId]
    }
    if (p1) return [p1]
    return spaceId ? [spaceId] : []
  }, [entitlements?.payerLimit, payerSpaces, spaceId])

  const today = useMemo(() => {
    const base = new Date()
    return new Date(base.getFullYear(), base.getMonth(), base.getDate())
  }, [])

  const openWarrantyAttachment = useCallback(async (warranty: Warranty) => {
    try {
      const wid = String((warranty as any)?.id || '').trim()
      if (!wid) return

      const list = supabase
        ? await listRemoteAttachments(supabase!, 'warranties', wid, spaceId)
        : await listLocalAttachments(spaceId, 'warranties', wid)
      const atts = (list || []) as any[]

      if (!atts.length) {
        Alert.alert(tr('No attachments'), tr('Attach a receipt or invoice so you can prove purchase when claiming this warranty.'))
        return
      }

      const open = async (att: any) => {
        if (supabase) {
          const url = await getSignedUrl(supabase!, att.path)
          if (url) Linking.openURL(url)
          else Alert.alert(tr('Open failed'), tr('Could not get URL'))
          return
        }
        if (att?.uri) {
          Linking.openURL(att.uri)
          return
        }
        Alert.alert(tr('Offline'), tr('Attachment stored locally. Preview is unavailable.'))
      }

      if (atts.length === 1) {
        await open(atts[0])
        return
      }

      const buttons = atts.slice(0, 6).map((a) => ({
        text: String(a?.name || a?.path || tr('Open')),
        onPress: () => {
          void open(a)
        },
      }))
      buttons.push({ text: tr('Cancel'), style: 'cancel' as const })
      Alert.alert(tr('Open'), undefined, buttons)
    } catch {
      Alert.alert(tr('Open failed'), tr('Unknown error'))
    }
  }, [spaceId, supabase])

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

  const getWarrantyStatus = useCallback((w: Warranty): 'active' | 'expiring' | 'expired' | 'no_expiry' => {
    const expires = parseDateValue((w as any)?.expires_at)
    if (!expires) return 'no_expiry'
    const days = Math.floor((expires.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    if (days < 0) return 'expired'
    if (days <= 30) return 'expiring'
    return 'active'
  }, [parseDateValue, today])

  const computeDurationMonthsBetween = useCallback(
    (purchaseIso?: string | null, expiresIso?: string | null): string => {
      const purchase = parseDateValue(String(purchaseIso || '').trim())
      const expires = parseDateValue(String(expiresIso || '').trim())
      if (!purchase || !expires) return ''
      let months = (expires.getFullYear() - purchase.getFullYear()) * 12 + (expires.getMonth() - purchase.getMonth())
      if (expires.getDate() < purchase.getDate()) months -= 1
      months = Math.max(0, months)
      return String(months)
    },
    [parseDateValue]
  )

  const scrollToNewWarranty = useCallback(() => {
    try {
      scrollRef.current?.scrollTo({ y: 0, animated: true })
    } catch {}
    setLinkedBillOpen(true)
  }, [])

  const computedExpiresAt = useMemo(() => {
    const monthsRaw = durationMonths.trim()
    if (!monthsRaw) return ''
    const purchase = parseDateValue(purchaseDate.trim())
    if (!purchase) return ''
    const months = parseInt(monthsRaw, 10)
    if (Number.isNaN(months) || months <= 0) return ''
    const nd = new Date(purchase.getFullYear(), purchase.getMonth() + months, purchase.getDate())
    return formatDateInput(nd)
  }, [durationMonths, formatDateInput, parseDateValue, purchaseDate])

  const computedDurationMonths = useMemo(() => {
    const purchase = parseDateValue(purchaseDate.trim())
    const expires = parseDateValue(expiresAt.trim())
    if (!purchase || !expires) return ''
    let months = (expires.getFullYear() - purchase.getFullYear()) * 12 + (expires.getMonth() - purchase.getMonth())
    if (expires.getDate() < purchase.getDate()) months -= 1
    months = Math.max(0, months)
    return String(months)
  }, [expiresAt, parseDateValue, purchaseDate])

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
    const billIds = billSpaceIds.length ? billSpaceIds : (spaceId ? [spaceId] : [])
    if (supabase) {
      const { data } = await listWarranties(supabase, spaceId)
      setItems(data)
      const { data: b } = await listBills(supabase, billIds.length > 1 ? billIds : (billIds[0] || spaceId), entitlements)
      setBills(b || [])
    }
    else {
      const locals = await loadLocalWarranties(spaceId)
      setItems(locals as any)
      const collected: Bill[] = []
      for (const sid of billIds) {
        const bLocals = await loadLocalBills(sid)
        for (const b of (bLocals as any) || []) collected.push(b as any)
      }
      setBills(collected)
    }
  })() }, [supabase, spaceLoading, space, spaceId, billSpaceIds, entitlements])

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
      .sort((a, b) => {
        const aKey = String((a as any)?.created_at || a.due_date || '')
        const bKey = String((b as any)?.created_at || b.due_date || '')
        if (aKey === bKey) return String(b.id).localeCompare(String(a.id))
        return bKey.localeCompare(aKey)
      })
      .slice(0, 25)
  }, [billQuery, bills, linkedBillIds])

  const selectedBill = useMemo(() => {
    if (!selectedBillId) return null
    return (bills || []).find((b) => b.id === selectedBillId) || null
  }, [bills, selectedBillId])

  const filteredWarranties = useMemo(() => {
    const itemTerm = warrantyItemFilter.trim().toLowerCase()
    const supplierTerm = warrantySupplierFilter.trim().toLowerCase()
    const from = parseDateValue(warrantyDateFrom.trim())
    const to = parseDateValue(warrantyDateTo.trim())
    const list = (items || []).filter((w) => {
      const status = getWarrantyStatus(w)
      if (warrantyStatusFilter === 'expired') {
        if (status !== 'expired') return false
      } else if (warrantyStatusFilter === 'expiring') {
        if (status !== 'expiring') return false
      } else {
        if (status !== 'active' && status !== 'no_expiry') return false
      }

      const dateField = warrantyDateMode === 'created' ? (w as any)?.created_at : (w as any)?.purchase_date
      const dateValue = parseDateValue(dateField)
      if (from) {
        if (!dateValue) return false
        if (dateValue.getTime() < from.getTime()) return false
      }
      if (to) {
        if (!dateValue) return false
        if (dateValue.getTime() > to.getTime()) return false
      }

      const itemText = String((w as any)?.item_name || '').toLowerCase()
      const supplierText = String((w as any)?.supplier || '').toLowerCase()

      if (itemTerm && !itemText.includes(itemTerm)) return false
      if (supplierTerm && !supplierText.includes(supplierTerm)) return false

      return true
    })

    return list.sort((a: any, b: any) => {
      const aExp = parseDateValue(a?.expires_at)
      const bExp = parseDateValue(b?.expires_at)
      const aTime = aExp ? aExp.getTime() : Number.POSITIVE_INFINITY
      const bTime = bExp ? bExp.getTime() : Number.POSITIVE_INFINITY
      if (aTime === bTime) return String(a?.item_name || '').localeCompare(String(b?.item_name || ''))
      return aTime - bTime
    })
  }, [
    items,
    parseDateValue,
    today,
    warrantyDateFrom,
    warrantyDateMode,
    warrantyDateTo,
    warrantyItemFilter,
    warrantySupplierFilter,
    warrantyStatusFilter,
    getWarrantyStatus,
  ])

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
      computedExpires = formatDateInput(nd)
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
    setWarrantyStatusFilter('active')
    setPendingAttachment(null)
    Alert.alert(tr('Saved'), supabase ? tr('Warranty saved') : tr('Saved locally (Not synced)'))
  }

  async function del(id: string) {
    Alert.alert(tr('Are you sure? This will also delete attached files.'), tr('Confirm deletion of this warranty and attachments.'), [
      { text: tr('Cancel'), style: 'cancel' },
      { text: tr('Delete'), style: 'destructive', onPress: async () => { await deleteAllAttachmentsForRecord(spaceId, 'warranties', id); if (supabase) { const { error } = await deleteWarranty(supabase!, id, spaceId); if (error) Alert.alert(tr('Error'), error.message) } else { await deleteLocalWarranty(spaceId, id) } setItems(prev=>prev.filter(w=>w.id!==id)) } }
    ])
  }

  async function ocrPendingAttachment(att: { uri: string; name: string; type?: string }) {
    const base = getFunctionsBase()
    if (!base) {
      Alert.alert(tr('OCR unavailable'), tr('Missing EXPO_PUBLIC_FUNCTIONS_BASE'))
      return
    }

    try {
      const fileResp = await fetch(att.uri)
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

      const contentType = blob.type || att.type || 'application/octet-stream'
      const resp = await fetch(`${base}/.netlify/functions/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, ...authHeader },
        body: blob,
      })
      const data = await resp.json()
      if (!resp.ok || !data?.ok) throw new Error(data?.error || `${tr('OCR failed')} (${resp.status})`)

      const f = data.fields || {}
      const rawText = typeof data?.rawText === 'string' ? data.rawText : ''
      const extracted = extractWarrantyFieldsFromOcr(rawText)

      const supplierCandidate = extracted.supplier || f.supplier
      const itemCandidate = extracted.itemName
      const purchaseCandidate = extracted.purchaseDate || f.due_date
      const expiresCandidate = extracted.expiresAt
      const durationCandidate = extracted.durationMonths

      if (!supplier.trim() && supplierCandidate) setSupplier(String(supplierCandidate))
      if (!itemName.trim() && itemCandidate) setItemName(String(itemCandidate))
      if (!purchaseDate.trim() && purchaseCandidate) setPurchaseDate(String(purchaseCandidate))

      if (!expiresAt.trim() && expiresCandidate) {
        setExpiresAt(String(expiresCandidate))
        if (durationMonths.trim()) setDurationMonths('')
      }
      if (!durationMonths.trim() && durationCandidate && !expiresCandidate) {
        setDurationMonths(String(durationCandidate))
        if (expiresAt.trim()) setExpiresAt('')
      }

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

      Alert.alert(tr('OCR extracted'), contentType.includes('pdf') ? tr('Fields prefilling from PDF. Review and press “Save warranty”.') : tr('Fields prefilling from photo. Review and press “Save warranty”.'))
    } catch (e: any) {
      Alert.alert(tr('OCR error'), e?.message || tr('OCR failed'))
    }
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
      const rawText = typeof data?.rawText === 'string' ? data.rawText : ''
      const extracted = extractWarrantyFieldsFromOcr(rawText)

      const supplierCandidate = extracted.supplier || f.supplier
      const itemCandidate = extracted.itemName
      const purchaseCandidate = extracted.purchaseDate || f.due_date
      const expiresCandidate = extracted.expiresAt
      const durationCandidate = extracted.durationMonths

      if (!supplier.trim() && supplierCandidate) setSupplier(String(supplierCandidate))
      if (!itemName.trim() && itemCandidate) setItemName(String(itemCandidate))
      if (!purchaseDate.trim() && purchaseCandidate) setPurchaseDate(String(purchaseCandidate))

      if (!expiresAt.trim() && expiresCandidate) {
        setExpiresAt(String(expiresCandidate))
        if (durationMonths.trim()) setDurationMonths('')
      }
      if (!durationMonths.trim() && durationCandidate && !expiresCandidate) {
        setDurationMonths(String(durationCandidate))
        if (expiresAt.trim()) setExpiresAt('')
      }
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
      const rawText = typeof data?.rawText === 'string' ? data.rawText : ''
      const extracted = extractWarrantyFieldsFromOcr(rawText)

      const supplierCandidate = extracted.supplier || f.supplier
      const itemCandidate = extracted.itemName
      const purchaseCandidate = extracted.purchaseDate || f.due_date
      const expiresCandidate = extracted.expiresAt
      const durationCandidate = extracted.durationMonths

      if (!supplier.trim() && supplierCandidate) setSupplier(String(supplierCandidate))
      if (!itemName.trim() && itemCandidate) setItemName(String(itemCandidate))
      if (!purchaseDate.trim() && purchaseCandidate) setPurchaseDate(String(purchaseCandidate))

      if (!expiresAt.trim() && expiresCandidate) {
        setExpiresAt(String(expiresCandidate))
        if (durationMonths.trim()) setDurationMonths('')
      }
      if (!durationMonths.trim() && durationCandidate && !expiresCandidate) {
        setDurationMonths(String(durationCandidate))
        if (expiresAt.trim()) setExpiresAt('')
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
    <Screen scroll={false}>
      <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: themeLayout.screenPadding }}>
      <View style={styles.pageStack}>
        <TabTopBar titleKey="Warranties" />

        <Surface elevated>
          <SectionHeader title={tr('New warranty')} />
          {spacesCtx.spaces.length > 1 ? (
            <View style={{ marginBottom: themeSpacing.sm }}>
              <Text style={styles.mutedText}>{tr('Profile')}</Text>
              <SegmentedControl
                value={spacesCtx.current?.id || spaceId || ''}
                onChange={(id) => { spacesCtx.setCurrent(id) }}
                options={spacesCtx.spaces.map((s) => ({ value: s.id, label: s.name }))}
                activeBgColor={themeColors.primary}
                activeTextColor="#FFFFFF"
                style={{ marginTop: themeSpacing.xs }}
              />
            </View>
          ) : null}

          <Disclosure
            title={tr('Linked bill (required)')}
            open={linkedBillOpen}
            onOpenChange={setLinkedBillOpen}
            highlightOnOpen
            bodyStyle={{ paddingTop: themeSpacing.sm }}
          >
            <View style={{ gap: themeSpacing.sm }}>
              <Text style={styles.bodyText}>{tr('Warranties must be linked 1:1 to a bill.')}</Text>
              {linkedBillIds.size > 0 ? (
                <Text style={styles.mutedText}>{tr('Bills already linked are hidden from this list.')}</Text>
              ) : null}

              <AppInput
                placeholder={tr('Find bill by supplier')}
                value={billQuery}
                onChangeText={setBillQuery}
                style={{ marginTop: themeSpacing.xs, marginBottom: themeSpacing.xs }}
              />

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
                <InlineInfo tone="warning" iconName="alert-circle-outline" message={tr('Select a linked bill, then press “Save warranty”.')} />
              )}

              <View style={{ gap: themeSpacing.xs }}>
                {selectableBills.length === 0 ? (
                  <Text style={styles.mutedText}>{tr('No available bills to link.')}</Text>
                ) : (
                  selectableBills.map((b) => (
                    <Pressable
                      key={b.id}
                      onPress={() => {
                        setSelectedBillId(b.id)
                        if (!supplier) setSupplier(b.supplier)
                        setLinkedBillOpen(false)
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
            </View>
          </Disclosure>

          <View style={{ height: themeSpacing.sm }} />

          <View style={{ gap: themeSpacing.sm }}>
            <View style={{ flexDirection: 'row', gap: themeSpacing.sm }}>
              <AppInput
                placeholder={tr('Item name')}
                value={itemName}
                onChangeText={setItemName}
                style={{ flex: 1 }}
              />
              <AppInput
                placeholder={tr('Supplier')}
                value={supplier}
                onChangeText={setSupplier}
                style={{ flex: 1 }}
              />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeSpacing.sm }}>
              <View style={{ flexGrow: 1, flexBasis: 160, minWidth: 160, gap: themeSpacing.xs }}>
                <AppInput
                  placeholder="YYYY-MM-DD"
                  value={purchaseDate}
                  onChangeText={setPurchaseDate}
                  hint={tr('Purchase date')}
                />
              </View>

              <View style={{ flexGrow: 1, flexBasis: 160, minWidth: 160, gap: themeSpacing.xs }}>
                <AppInput
                  placeholder="YYYY-MM-DD"
                  value={expiresAt}
                  onChangeText={setExpiresAt}
                  hint={tr('Expires')}
                />
              </View>

              <View style={{ flexGrow: 1, flexBasis: 160, minWidth: 160, gap: themeSpacing.xs }}>
                <AppInput
                  placeholder={tr('Duration (months)')}
                  value={durationMonths}
                  onChangeText={setDurationMonths}
                  keyboardType="numeric"
                />
              </View>
            </View>
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
            <AppButton
              label={tr('Attach image')}
              variant="secondary"
              iconName="image-outline"
              onPress={async ()=>{
          const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 })
          if (res.canceled) return
          const asset = res.assets?.[0]
          if (!asset?.uri) return
          const att = { uri: asset.uri, name: asset.fileName || 'photo.jpg', type: asset.type || 'image/jpeg' }
          setPendingAttachment(att)
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
          const att = { uri: file.uri, name: file.name || 'document.pdf', type: 'application/pdf' }
          setPendingAttachment(att)
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
                <View style={{ marginTop: themeSpacing.xs, flexDirection: 'row', alignItems: 'center', gap: themeSpacing.xs }}>
                  <Ionicons name="document-text-outline" size={18} color={themeColors.primary} />
                  <Text style={styles.bodyText}>{pendingAttachment.name}</Text>
                </View>
              )}
            </View>
          )}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
            <AppButton
              label={tr('Save warranty')}
              iconName="save-outline"
              onPress={addManual}
              style={{ width: '100%' }}
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
                onActionPress={scrollToNewWarranty}
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
                      placeholder={tr('Item name')}
                      value={warrantyItemFilter}
                      onChangeText={setWarrantyItemFilter}
                      style={{ flex: 1 }}
                    />
                    <AppInput
                      placeholder={tr('Supplier')}
                      value={warrantySupplierFilter}
                      onChangeText={setWarrantySupplierFilter}
                      style={{ flex: 1 }}
                    />
                  </View>

                  <View style={{ flexDirection: 'row', gap: themeSpacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
                    <SegmentedControl
                      value={warrantyDateMode}
                      onChange={(v) => setWarrantyDateMode(v as any)}
                      options={[
                        { value: 'purchase', label: tr('Purchase') },
                        { value: 'created', label: tr('Created') },
                      ]}
                      style={{ flex: 1, minWidth: 220 }}
                    />
                    <SegmentedControl
                      value={warrantyStatusFilter}
                      onChange={(v) => setWarrantyStatusFilter(v as any)}
                      options={[
                        { value: 'active', label: tr('Active') },
                        { value: 'expiring', label: tr('Expiring') },
                        { value: 'expired', label: tr('Expired') },
                      ]}
                      style={{ flex: 1, minWidth: 220 }}
                    />
                  </View>

                  <View style={{ flexDirection: 'row', gap: themeSpacing.sm, alignItems: 'center' }}>
                    <AppInput
                      placeholder={tr('Start YYYY-MM-DD')}
                      value={warrantyDateFrom}
                      onChangeText={setWarrantyDateFrom}
                      style={{ flex: 1 }}
                    />
                    <AppInput
                      placeholder={tr('End YYYY-MM-DD')}
                      value={warrantyDateTo}
                      onChangeText={setWarrantyDateTo}
                      style={{ flex: 1 }}
                    />
                  </View>

                  <Text style={styles.mutedText}>
                    {tr('{shown} of {total} warranties', { shown: filteredWarranties.length, total: items.length })}
                  </Text>
                </View>
              }
              ListEmptyComponent={
                <EmptyState
                  title={warrantyStatusFilter === 'expired'
                    ? tr('No expired warranties')
                    : (warrantyStatusFilter === 'expiring' ? tr('No expiring warranties') : tr('No warranties found'))}
                  message={warrantyStatusFilter === 'expired'
                    ? tr('Expired warranties will appear here.')
                    : (warrantyStatusFilter === 'expiring' ? tr('Expiring warranties will appear here.') : tr('Adjust your search or add a new warranty.'))}
                  actionLabel={warrantyStatusFilter === 'expired' ? undefined : tr('Add warranty')}
                  onActionPress={warrantyStatusFilter === 'expired' ? undefined : scrollToNewWarranty}
                  iconName={warrantyStatusFilter === 'expired' ? 'archive-outline' : 'shield-checkmark-outline'}
                />
              }
              renderItem={({ item }) => (
                <Surface elevated style={styles.billRowCard}>
                  <View style={styles.billRowHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle} numberOfLines={1}>
                        {item.item_name}{(item as any)?.unsynced ? ` • ${tr('Not synced')}` : ''}
                      </Text>
                      <Text style={styles.warrantyMetaText}>
                        {(() => {
                          const duration = computeDurationMonthsBetween((item as any)?.purchase_date, (item as any)?.expires_at)
                          return (
                            `${item.supplier || '—'} • ${tr('Purchase')}: ${item.purchase_date || '—'} • ${tr('Expires')}: ${item.expires_at || '—'}` +
                            (duration ? ` • ${tr('Duration (months)')}: ${duration}` : '') +
                            ((item as any)?.bill_id ? ` • ${tr('Linked bill')}` : '')
                          )
                        })()}
                      </Text>
                    </View>
                    {(() => {
                      const status = getWarrantyStatus(item)
                      const label = status === 'expired'
                        ? tr('Expired')
                        : (status === 'expiring' ? tr('Expiring') : (status === 'active' ? tr('Active') : tr('No expiry')))
                      const tone = status === 'expiring'
                        ? 'warning'
                        : (status === 'active' ? 'info' : 'neutral')
                      return <Badge label={label} tone={tone as any} />
                    })()}
                  </View>
                  <View style={styles.billActionsRow}>
                    <AppButton
                      label={tr('Details')}
                      variant="secondary"
                      iconName="information-circle-outline"
                      onPress={()=> navigation.navigate('Warranty Details', { warrantyId: item.id })}
                    />
                    <AppButton
                      label={tr('View attachment')}
                      variant="secondary"
                      iconName="open-outline"
                      onPress={() => openWarrantyAttachment(item)}
                    />
                    <AppButton
                      label={tr('Delete')}
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
      </ScrollView>
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
  const [reminderInfo, setReminderInfo] = useState<string | null>(null)
  const [remindersEnabled, setRemindersEnabledState] = useState<boolean>(true)
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()

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

  useEffect(() => {
    ;(async () => {
      setRemindersEnabledState(await getRemindersEnabled())
    })()
  }, [])

  const formatReminderDateTime = useCallback((date: Date) => {
    try {
      return date.toLocaleString()
    } catch {
      return date.toISOString()
    }
  }, [])

  const buildWarrantyReminderInfo = useCallback((expiresAt?: string | null) => {
    if (!expiresAt) return null
    const parsed = parseDateValue(expiresAt)
    if (!parsed) return null
    const thirtyDays = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() - 30, 9, 0, 0, 0)
    const sevenDays = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() - 7, 9, 0, 0, 0)
    const upcoming = [thirtyDays, sevenDays].filter((d) => d.getTime() > Date.now())
    if (!upcoming.length) return tr('No upcoming reminders.')
    const next = upcoming.sort((a, b) => a.getTime() - b.getTime())[0]
    return tr('Next reminder: {date}', { date: formatReminderDateTime(next) })
  }, [formatReminderDateTime, parseDateValue])

  const computedDurationMonths = useMemo(() => {
    const purchase = parseDateValue(String((warranty as any)?.purchase_date || '').trim())
    const expires = parseDateValue(String((warranty as any)?.expires_at || '').trim())
    if (!purchase || !expires) return ''
    let months = (expires.getFullYear() - purchase.getFullYear()) * 12 + (expires.getMonth() - purchase.getMonth())
    if (expires.getDate() < purchase.getDate()) months -= 1
    months = Math.max(0, months)
    return String(months)
  }, [parseDateValue, (warranty as any)?.expires_at, (warranty as any)?.purchase_date])
  useEffect(() => { (async ()=>{
    if (!warrantyId || spaceLoading || !space) return
    if (supabase) {
      const userId = await getCurrentUserId(supabase!)
      const { data } = await supabase!.from('warranties').select('*').eq('user_id', userId).eq('id', warrantyId).single()
      setWarranty((data as Warranty) || null)
      setAttachments(await listRemoteAttachments(supabase!, 'warranties', warrantyId, spaceId))
      setReminderInfo(buildWarrantyReminderInfo((data as any)?.expires_at || null))

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
      setReminderInfo(buildWarrantyReminderInfo((w as any)?.expires_at || null))

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
          <SectionHeader title={tr('Warranty summary')} />
          <Text style={styles.bodyText}>
            {warranty.supplier || '—'} • {tr('Purchase')}: {warranty.purchase_date || '—'} • {tr('Expires')}: {warranty.expires_at || '—'}{computedDurationMonths ? ` • ${tr('Duration (months)')}: ${computedDurationMonths}` : ''}
          </Text>
        </Surface>

        {(linkedBill || (warranty as any)?.bill_id) ? (
          <Surface elevated>
            <SectionHeader title={tr('Linked bill')} />
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
          {!remindersEnabled ? (
            <InlineInfo
              tone="warning"
              iconName="alert-circle-outline"
              message={tr('Reminders are disabled in Settings.')}
              style={{ marginTop: themeSpacing.xs }}
            />
          ) : null}
          {reminderInfo ? (
            <InlineInfo
              tone="info"
              iconName="time-outline"
              message={reminderInfo}
              style={{ marginTop: themeSpacing.xs }}
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
                setReminderInfo(buildWarrantyReminderInfo(warranty.expires_at))
                Alert.alert(tr('Reminders'), tr('Scheduled default warranty reminders.'))
              }}
            />
            <AppButton
              label={tr('Cancel reminders')}
              variant="ghost"
              iconName="notifications-off-outline"
              onPress={async ()=>{
                await cancelWarrantyReminders(warranty.id, spaceId)
                setReminderInfo(null)
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
  const [dateMode, setDateMode] = useState<'due' | 'invoice' | 'created'>('due')
  const [groupBy, setGroupBy] = useState<'month' | 'year'>('month')
  const [statusSelections, setStatusSelections] = useState<{ unpaid: boolean; paid: boolean; archived: boolean }>(() => ({
    unpaid: true,
    paid: true,
    archived: false,
  }))
  const [supplierQuery, setSupplierQuery] = useState('')
  const [amountMin, setAmountMin] = useState('')
  const [amountMax, setAmountMax] = useState('')
  const [exportBusy, setExportBusy] = useState(false)
  const [exportBusyLabel, setExportBusyLabel] = useState<string>('')
  const [exportUpsellVisible, setExportUpsellVisible] = useState(false)
  const [iosPickerVisible, setIosPickerVisible] = useState(false)
  const [iosPickerField, setIosPickerField] = useState<'start' | 'end' | null>(null)
  const [iosPickerValue, setIosPickerValue] = useState(new Date())
  const [reportsChartSize, setReportsChartSize] = useState({ width: 0, height: 180 })
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()

  const isPro = entitlements.plan === 'pro'

  const [reportsView, setReportsView] = useState<'table' | 'chart'>(() => (isPro ? 'chart' : 'table'))
  useEffect(() => {
    if (!isPro && reportsView === 'chart') setReportsView('table')
  }, [isPro, reportsView])

  useEffect(() => {
    if (!isPro && statusSelections.archived) {
      setStatusSelections((prev) => ({ ...prev, archived: false }))
    }
  }, [isPro, statusSelections.archived])

  const onSelectReportsView = useCallback((next: 'table' | 'chart') => {
    if (next === 'chart' && !isPro) {
      Alert.alert(tr('Reports'), tr('Chart is available on Več.'))
      showUpgradeAlert('reports')
      return
    }
    setReportsView(next)
  }, [isPro])
  const analyticsBlocked =
    entitlements.plan === 'free' ||
    entitlements.status === 'trial_expired' ||
    entitlements.lifecycleStatus === 'grace_period' ||
    entitlements.lifecycleStatus === 'export_only' ||
    entitlements.lifecycleStatus === 'deleted' ||
    entitlements.lifecycleStatus === 'cancelled_all'

  const analyticsBlockMessage = useMemo(() => {
    if (entitlements.status === 'trial_expired') return tr('Free trial expired. Choose a plan to continue.')
    if (entitlements.lifecycleStatus === 'grace_period') {
      return tr('Subscription cancelled. Bills remain available until {date}.', { date: String(entitlements.graceUntil || '') })
    }
    if (entitlements.lifecycleStatus === 'export_only') return tr('Export-only access is active. Other premium features are disabled.')
    if (entitlements.lifecycleStatus === 'deleted') return tr('Account is marked as deleted. Premium features are disabled.')
    return tr('Analytics are available on Moje and Več.')
  }, [entitlements.graceUntil, entitlements.lifecycleStatus, entitlements.status])

  const analyticsUpgradeTarget: PlanId = entitlements.rawPlan === 'pro' ? 'pro' : 'basic'

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

  const selectedStatusList = useMemo(() => {
    const list: Array<'unpaid' | 'paid' | 'archived'> = []
    if (statusSelections.unpaid) list.push('unpaid')
    if (statusSelections.paid) list.push('paid')
    if (statusSelections.archived && isPro) list.push('archived')
    if (list.length) return list
    return isPro ? (['unpaid', 'paid', 'archived'] as const) : (['unpaid', 'paid'] as const)
  }, [isPro, statusSelections.archived, statusSelections.paid, statusSelections.unpaid])

  const isStatusIncluded = useCallback((bill: Bill) => {
    for (const s of selectedStatusList) {
      if (s === 'unpaid' && isBillUnpaid(bill.status)) return true
      if (s === 'paid' && bill.status === 'paid') return true
      if (s === 'archived' && bill.status === 'archived') return true
    }
    return false
  }, [selectedStatusList])

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
      if (supabase) {
        if (ids.length > 1) {
          const { data } = await listBills(supabase, ids, entitlements)
          for (const b of ((data as any) || []) as any[]) {
            const local = localPayerIdFromDbSpaceId(entitlements, (b as any)?.space_id) || ids[0]
            next.push({ ...(b as any), __spaceId: local })
          }
        } else {
          const sid = ids[0]
          const { data } = await listBills(supabase, sid, entitlements)
          for (const b of ((data as any) || []) as any[]) next.push({ ...(b as any), __spaceId: sid })
        }
      } else {
        for (const sid of ids) {
          const locals = await loadLocalBills(sid)
          for (const b of (((locals as any) || []) as any[])) next.push({ ...(b as any), __spaceId: sid })
        }
      }
      setBills(next)
    } finally {
      setLoadingReports(false)
    }
  })() }, [supabase, spaceLoading, space, selectedPayerIds, entitlements])

  const filtered = useMemo(() => {
    const supplierTerm = supplierQuery.trim().toLowerCase()
    const minVal = amountMin ? Number(String(amountMin).replace(',', '.')) : null
    const maxVal = amountMax ? Number(String(amountMax).replace(',', '.')) : null
    const allowAdvanced = isPro

    return (bills || []).filter((b) => {
      const d = getBillDateForMode(b, allowAdvanced ? dateMode : 'due')
      if (!d) return false
      if (d < range.start || d > range.end) return false

      if (!isStatusIncluded(b)) return false

      if (supplierTerm && !String(b.supplier || '').toLowerCase().includes(supplierTerm)) return false

      if (allowAdvanced) {
        if (minVal !== null && !Number.isNaN(minVal) && b.amount < minVal) return false
        if (maxVal !== null && !Number.isNaN(maxVal) && b.amount > maxVal) return false
      }

      return true
    })
  }, [amountMax, amountMin, bills, dateMode, isPro, isStatusIncluded, range.end, range.start, supplierQuery])

  const supplierOptions = useMemo(() => {
    const all = (bills || [])
      .map((b) => String(b.supplier || '').trim())
      .filter((v) => v.length > 0)
    const unique = Array.from(new Set(all)).sort((a, b) => a.localeCompare(b))
    const term = supplierQuery.trim().toLowerCase()
    if (!term) return unique.slice(0, 10)
    return unique.filter((name) => name.toLowerCase().includes(term)).slice(0, 10)
  }, [bills, supplierQuery])

  const totals = useMemo(() => {
    const totalBillsInRange = filtered.length
    const totalAmountEur = filtered.reduce((sum, b) => sum + (b.currency === 'EUR' ? b.amount : 0), 0)
    const unpaidTotalEur = filtered.reduce((sum, b) => {
      if (!isBillUnpaid(b.status)) return sum
      return sum + (b.currency === 'EUR' ? b.amount : 0)
    }, 0)
    return { totalBillsInRange, totalAmountEur, unpaidTotalEur }
  }, [filtered])

  const series = useMemo(() => {
    const keyFn = groupBy === 'year' ? yyyyKey : yyyymmKey
    const modeForDate = isPro ? dateMode : 'due'
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
  }, [dateMode, filtered, groupBy, isPro])

  const reportPalette = ['#2563EB', '#F97316', '#10B981', '#A855F7', '#0EA5E9', '#E11D48']

  const seriesByStatus = useMemo(() => {
    const keyFn = groupBy === 'year' ? yyyyKey : yyyymmKey
    const modeForDate = isPro ? dateMode : 'due'
    const grouped: Record<string, Record<string, number>> = {}
    const statuses = selectedStatusList
    for (const b of filtered) {
      const iso = getBillDateForMode(b, modeForDate)
      const key = keyFn(iso) || '—'
      const statusKey = isBillUnpaid(b.status) ? 'unpaid' : b.status === 'paid' ? 'paid' : b.status === 'archived' ? 'archived' : null
      if (!statusKey || !statuses.includes(statusKey)) continue
      grouped[key] = grouped[key] || {}
      grouped[key][statusKey] = (grouped[key][statusKey] || 0) + (b.currency === 'EUR' ? b.amount : 0)
    }
    const keys = Object.keys(grouped).sort()
    const series = statuses.map((status) => {
      const points = keys.map((k) => ({ key: k, value: grouped[k]?.[status] || 0 }))
      return { status, points }
    })
    const max = series.reduce((m, s) => Math.max(m, ...(s.points.map((p) => p.value))), 0)
    return { keys, series, max }
  }, [dateMode, filtered, getBillDateForMode, groupBy, isPro, selectedStatusList])

  const tableRows = useMemo(() => {
    const modeForDate = isPro ? dateMode : 'due'
    return [...filtered]
      .sort((a, b) => {
        const ad = getBillDateForMode(a, modeForDate)
        const bd = getBillDateForMode(b, modeForDate)
        return String(ad).localeCompare(String(bd))
      })
      .map((b) => ({
        id: b.id,
        supplier: String(b.supplier || '').trim() || tr('Unknown'),
        date: getBillDateForMode(b, modeForDate),
        amount: b.currency === 'EUR' ? `EUR ${b.amount.toFixed(2)}` : `${b.amount.toFixed(2)} ${b.currency || ''}`,
      }))
  }, [dateMode, filtered, getBillDateForMode, isPro, tr])

  const lineSeries = useMemo(() => {
    if (isPro && selectedStatusList.length > 1) {
      return seriesByStatus.series.map((s, idx) => ({
        id: s.status,
        label: s.status === 'unpaid' ? tr('Unpaid') : s.status === 'paid' ? tr('Paid') : tr('Archived'),
        color: reportPalette[idx % reportPalette.length],
        points: s.points,
      }))
    }
    return [{ id: 'total', label: tr('Total'), color: themeColors.primary, points: series.points }]
  }, [isPro, reportPalette, selectedStatusList.length, series.points, seriesByStatus.series, tr])

  const lineMax = useMemo(() => {
    return lineSeries.reduce((m, s) => Math.max(m, ...(s.points.map((p) => p.value))), 0)
  }, [lineSeries])

  const linePoints = useMemo(() => {
    const width = Math.max(0, reportsChartSize.width - 24)
    const height = Math.max(0, reportsChartSize.height - 24)
    const count = lineSeries[0]?.points.length || 0
    if (!count || width <= 0 || height <= 0) return []
    const max = lineMax || 1
    return lineSeries.map((seriesItem) => {
      const points = seriesItem.points.map((p, idx) => {
        const x = 12 + (count === 1 ? width / 2 : (idx / (count - 1)) * width)
        const y = 12 + (max > 0 ? (1 - p.value / max) * height : height)
        return { ...p, x, y }
      })
      return { id: seriesItem.id, label: seriesItem.label, color: seriesItem.color, points }
    })
  }, [lineMax, lineSeries, reportsChartSize.height, reportsChartSize.width])

  const showBasicInsights = useCallback(() => {
    if (!filtered.length) {
      Alert.alert(tr('Reports'), tr('No bills in this range.'))
      return
    }

    const supplierTotals: Record<string, number> = {}
    let maxBill: Bill | null = null

    for (const b of filtered) {
      const supplier = String((b as any)?.supplier || '').trim() || tr('Unknown')
      supplierTotals[supplier] = (supplierTotals[supplier] || 0) + (b.currency === 'EUR' ? b.amount : 0)
      if (!maxBill || (b.currency === 'EUR' ? b.amount : 0) > ((maxBill.currency === 'EUR' ? maxBill.amount : 0) || 0)) {
        maxBill = b
      }
    }

    const topSuppliers = Object.entries(supplierTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, amt]) => `${name}: EUR ${amt.toFixed(2)}`)

    const lines = [
      `${tr('Bills in range')}: ${filtered.length}`,
      topSuppliers.length ? `${tr('Supplier')}:\n${topSuppliers.join('\n')}` : '',
      maxBill ? `${tr('Total amount (EUR)')}: EUR ${(filtered.reduce((sum, b) => sum + (b.currency === 'EUR' ? b.amount : 0), 0)).toFixed(2)}` : '',
    ].filter(Boolean)

    Alert.alert(tr('Reports'), lines.join('\n\n'))
  }, [filtered, tr])

  const reportPayload = useMemo(() => {
    const isAdvanced = isPro
    return {
      generated_at: new Date().toISOString(),
      plan: entitlements.plan,
      profiles: selectedPayerIds.map((id) => ({ id, label: payerLabelFromSpaceId(id) })),
      filters: {
        start: range.start,
        end: range.end,
        status: selectedStatusList,
        analytics_mode: isAdvanced ? 'advanced' : 'basic',
        date_mode: isAdvanced ? dateMode : 'due',
        group_by: groupBy,
        supplier_query: supplierQuery,
        amount_min: isAdvanced ? amountMin : '',
        amount_max: isAdvanced ? amountMax : '',
      },
      totals,
      series: series.points,
    }
  }, [amountMax, amountMin, dateMode, entitlements.plan, groupBy, isPro, range.end, range.start, selectedPayerIds, series.points, selectedStatusList, supplierQuery, totals])

  const onExportPress = useCallback(() => {
    if (!entitlements.exportsEnabled) {
      setExportUpsellVisible(true)
      if (entitlements.status === 'trial_expired') {
        Alert.alert(tr('Export'), tr('Free trial expired. Choose a plan to continue.'))
      } else {
        Alert.alert(tr('Export'), tr('Export is available on Več.'))
      }
      showUpgradeAlert('export')
      return
    }

    Alert.alert(tr('Export'), tr('Export PDF report'), [
      { text: tr('Export PDF report'), onPress: exportReportPDF },
      { text: tr('Cancel'), style: 'cancel' },
    ])
  }, [entitlements.exportsEnabled])

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
      zip.file('series.csv', seriesRows.map((r) => r.map(csvEscape).join(',')).join('\n'))
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
      const chartSvg = (() => {
        const points = series.points
        if (!points.length) return ''
        const w = 520
        const h = 220
        const padL = 40
        const padB = 28
        const padT = 12
        const padR = 12
        const plotW = w - padL - padR
        const plotH = h - padT - padB
        const max = series.max || 1
        const barW = plotW / points.length
        const bars = points.map((p, i) => {
          const valH = Math.max(2, (p.value / max) * plotH)
          const x = padL + i * barW + 6
          const y = padT + (plotH - valH)
          const bw = Math.max(6, barW - 12)
          const color = reportPalette[i % reportPalette.length]
          return `<rect x="${x}" y="${y}" width="${bw}" height="${valH}" rx="4" fill="${color}" />`
        }).join('')
        const xLabels = points.map((p, i) => {
          const x = padL + i * barW + barW / 2
          return `<text x="${x}" y="${h - 8}" text-anchor="middle" font-size="10" fill="#64748b">${p.key}</text>`
        }).join('')
        return `
          <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="${w}" height="${h}" fill="#fff" />
            <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${h - padB}" stroke="#CBD5F5" />
            <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="#CBD5F5" />
            <line x1="${padL}" y1="${padT + plotH * 0.5}" x2="${w - padR}" y2="${padT + plotH * 0.5}" stroke="#E2E8F0" />
            <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="#E2E8F0" />
            <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" font-size="10" fill="#64748b">EUR ${max.toFixed(0)}</text>
            <text x="${padL - 6}" y="${padT + plotH * 0.5 + 4}" text-anchor="end" font-size="10" fill="#64748b">EUR ${(max * 0.5).toFixed(0)}</text>
            <text x="${padL - 6}" y="${h - padB + 4}" text-anchor="end" font-size="10" fill="#64748b">EUR 0</text>
            ${bars}
            ${xLabels}
          </svg>
        `
      })()
      const lineSvg = (() => {
        const seriesItems = lineSeries
        const count = seriesItems[0]?.points.length || 0
        if (!count) return ''
        const w = 520
        const h = 220
        const padL = 40
        const padB = 28
        const padT = 12
        const padR = 12
        const plotW = w - padL - padR
        const plotH = h - padT - padB
        const max = lineMax || 1
        const xLabels = seriesItems[0].points.map((p, i) => {
          const x = padL + i * (plotW / Math.max(1, count - 1))
          return `<text x="${x}" y="${h - 8}" text-anchor="middle" font-size="10" fill="#64748b">${p.key}</text>`
        }).join('')
        const lines = seriesItems.map((s) => {
          const points = s.points.map((p, i) => {
            const x = padL + i * (plotW / Math.max(1, count - 1))
            const y = padT + (max > 0 ? (1 - p.value / max) * plotH : plotH)
            return `${x},${y}`
          }).join(' ')
          const dots = s.points.map((p, i) => {
            const x = padL + i * (plotW / Math.max(1, count - 1))
            const y = padT + (max > 0 ? (1 - p.value / max) * plotH : plotH)
            return `<circle cx="${x}" cy="${y}" r="3" fill="${s.color}" />`
          }).join('')
          return `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${points}" />${dots}`
        }).join('')
        return `
          <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="${w}" height="${h}" fill="#fff" />
            <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${h - padB}" stroke="#CBD5F5" />
            <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="#CBD5F5" />
            <line x1="${padL}" y1="${padT + plotH * 0.5}" x2="${w - padR}" y2="${padT + plotH * 0.5}" stroke="#E2E8F0" />
            <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="#E2E8F0" />
            <text x="${padL - 6}" y="${padT + 4}" text-anchor="end" font-size="10" fill="#64748b">EUR ${max.toFixed(0)}</text>
            <text x="${padL - 6}" y="${padT + plotH * 0.5 + 4}" text-anchor="end" font-size="10" fill="#64748b">EUR ${(max * 0.5).toFixed(0)}</text>
            <text x="${padL - 6}" y="${h - padB + 4}" text-anchor="end" font-size="10" fill="#64748b">EUR 0</text>
            ${lines}
            ${xLabels}
          </svg>
        `
      })()
      const tableHtml = tableRows.map((r) => `
        <tr>
          <td>${r.supplier}</td>
          <td>${r.date || '—'}</td>
          <td style="text-align:right;">${r.amount}</td>
        </tr>
      `).join('')
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
              ${chartSvg || `<div class="k">${tr('No bills in this range.')}</div>`}
              ${lineSvg ? `<div style="margin-top:12px;">${lineSvg}</div>` : ''}
            </div>
            <div class="card">
              <div class="k" style="margin-bottom:8px;">${tr('Table')}</div>
              ${tableHtml
                ? `<table><thead><tr><th>${tr('Supplier')}</th><th>${tr('Due')}</th><th style=\"text-align:right;\">${tr('Amount (EUR)')}</th></tr></thead><tbody>${tableHtml}</tbody></table>`
                : `<div class="k">${tr('No bills in this range.')}</div>`
              }
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

  if (analyticsBlocked) {
    return (
      <Screen>
        <View style={styles.pageStack}>
          <TabTopBar titleKey="Reports" />
          <Surface elevated>
            <InlineInfo tone="warning" iconName="alert-circle-outline" message={analyticsBlockMessage} />
            <View style={{ marginTop: themeSpacing.sm }}>
              <AppButton
                label={analyticsUpgradeTarget === 'pro' ? tr('Upgrade to Več') : tr('Upgrade to Moje')}
                variant="secondary"
                iconName="arrow-up-circle-outline"
                onPress={() => navigation.navigate('Payments', { focusPlan: analyticsUpgradeTarget, reason: 'reports' })}
              />
            </View>
          </Surface>
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
          {!isPro ? (
            <InlineInfo
              tone="info"
              iconName="sparkles-outline"
              message={tr('Basic analytics is available on Moje and Več. Upgrade to Več for advanced analytics.')}
            />
          ) : null}
          <View style={styles.filtersBody}>
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
              {isPro ? (
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
                <AppButton
                  label={tr('All')}
                  variant={selectedStatusList.length === (isPro ? 3 : 2) ? 'secondary' : 'ghost'}
                  onPress={() => setStatusSelections({ unpaid: true, paid: true, archived: isPro })}
                />
                <AppButton
                  label={tr('Unpaid')}
                  variant={statusSelections.unpaid ? 'secondary' : 'ghost'}
                  onPress={() => setStatusSelections((prev) => ({ ...prev, unpaid: !prev.unpaid }))}
                />
                <AppButton
                  label={tr('Paid')}
                  variant={statusSelections.paid ? 'secondary' : 'ghost'}
                  onPress={() => setStatusSelections((prev) => ({ ...prev, paid: !prev.paid }))}
                />
                {isPro ? (
                  <AppButton
                    label={tr('Archived')}
                    variant={statusSelections.archived ? 'secondary' : 'ghost'}
                    onPress={() => setStatusSelections((prev) => ({ ...prev, archived: !prev.archived }))}
                  />
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

            <View style={{ marginTop: themeSpacing.sm, gap: themeSpacing.sm }}>
              <View>
                <Text style={styles.filterLabel}>{tr('Supplier')}</Text>
                <View style={{ marginTop: themeSpacing.xs, position: 'relative', zIndex: 10 }}>
                  <AppInput
                    placeholder={tr('Supplier')}
                    value={supplierQuery}
                    onChangeText={setSupplierQuery}
                    onFocus={() => setSupplierDropdownOpen(true)}
                    onBlur={() => setTimeout(() => setSupplierDropdownOpen(false), 120)}
                  />
                  {supplierDropdownOpen && supplierOptions.length > 0 ? (
                    <View style={[styles.supplierSuggestList, { top: 46, maxHeight: 220 }]}>
                      <ScrollView keyboardShouldPersistTaps="handled">
                        {supplierOptions.map((name) => (
                          <Pressable
                            key={name}
                            onPress={() => setSupplierQuery(name)}
                            style={({ pressed }) => [styles.supplierSuggestItem, pressed ? { backgroundColor: '#EFF6FF' } : null]}
                          >
                            <Text style={styles.supplierSuggestText} numberOfLines={1}>{name}</Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                    </View>
                  ) : null}
                </View>
              </View>

              {isPro ? (
                <View style={styles.filterRow}>
                  <AppInput placeholder={tr('Min amount')} keyboardType="numeric" value={amountMin} onChangeText={setAmountMin} style={styles.flex1} />
                  <AppInput placeholder={tr('Max amount')} keyboardType="numeric" value={amountMax} onChangeText={setAmountMax} style={styles.flex1} />
                </View>
              ) : null}
            </View>
          </View>
        </Surface>

        <Pressable onPress={showBasicInsights} hitSlop={8}>
          <Surface elevated>
            <SectionHeader title={tr('Totals in range')} />
            <View style={{ marginTop: themeSpacing.sm, gap: themeSpacing.xs }}>
              <Text style={styles.reportStatLabel}>
                {tr('Bills in range')}: <Text style={styles.reportStatValue}>{totals.totalBillsInRange}</Text>
              </Text>
              <Text style={styles.reportStatLabel}>
                {tr('Total amount (EUR)')}: <Text style={styles.reportStatValue}>EUR {totals.totalAmountEur.toFixed(2)}</Text>
              </Text>
              <Text style={styles.reportStatLabel}>
                {tr('Unpaid total (EUR)')}: <Text style={styles.reportStatValue}>EUR {totals.unpaidTotalEur.toFixed(2)}</Text>
              </Text>
            </View>
          </Surface>
        </Pressable>

        <Surface elevated>
          <SectionHeader title={groupBy === 'year' ? tr('Yearly spend') : tr('Monthly spend')} />
          <View style={styles.reportViewToggleRow}>
            <AppButton
              label={tr('Table')}
              variant={reportsView === 'table' ? 'secondary' : 'ghost'}
              onPress={() => onSelectReportsView('table')}
            />
            <AppButton
              label={tr('Chart')}
              variant={reportsView === 'chart' ? 'secondary' : 'ghost'}
              iconName={!isPro ? 'lock-closed-outline' : undefined}
              onPress={() => onSelectReportsView('chart')}
            />
          </View>

          {reportsView === 'chart' ? (
            <View style={{ paddingVertical: themeSpacing.sm, gap: themeSpacing.sm }}>
              {series.points.length === 0 ? (
                <Text style={styles.mutedText}>{tr('No bills in this range.')}</Text>
              ) : (
                <>
                  <View style={styles.reportChartCard}>
                    <Text style={styles.reportChartTitle}>{tr('Bar chart')}</Text>
                    <View style={styles.reportChartFrame}>
                      <View style={styles.reportAxisRow}>
                        <View style={styles.reportYAxis}>
                          <Text style={styles.reportYAxisLabel}>EUR {series.max.toFixed(0)}</Text>
                          <Text style={styles.reportYAxisLabel}>EUR {(series.max * 0.5).toFixed(0)}</Text>
                          <Text style={styles.reportYAxisLabel}>EUR 0</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <View style={{ height: 140 }}>
                            <View style={[styles.reportGridLine, { top: 0 }]} />
                            <View style={[styles.reportGridLine, { top: 70 }]} />
                            <View style={[styles.reportGridLine, { bottom: 0 }]} />
                            <View style={styles.reportBarsRow}>
                              {series.points.map((p, idx) => (
                                <View key={p.key} style={styles.reportBarItem}>
                                  <View style={styles.reportBarTrack}>
                                    <View
                                      style={[
                                        styles.reportBarFill,
                                        {
                                          height: `${Math.max(0, Math.min(100, p.pct))}%`,
                                          backgroundColor: reportPalette[idx % reportPalette.length],
                                        },
                                      ]}
                                    />
                                  </View>
                                  <Text style={styles.reportBarLabel}>{p.key}</Text>
                                </View>
                              ))}
                            </View>
                          </View>
                          <View style={styles.reportXAxis} />
                        </View>
                      </View>
                    </View>
                  </View>

                  <View style={styles.reportChartCard}>
                    <Text style={styles.reportChartTitle}>{tr('Line chart')}</Text>
                    {linePoints.length > 1 ? (
                      <View style={styles.reportLegendRow}>
                        {linePoints.map((s) => (
                          <View key={s.id} style={styles.reportLegendItem}>
                            <View style={[styles.reportLegendSwatch, { backgroundColor: s.color }]} />
                            <Text style={styles.reportLegendLabel}>{s.label}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    <View style={styles.reportChartFrame}>
                      <View style={styles.reportAxisRow}>
                        <View style={[styles.reportYAxis, { height: 160 }]}>
                          <Text style={styles.reportYAxisLabel}>EUR {lineMax.toFixed(0)}</Text>
                          <Text style={styles.reportYAxisLabel}>EUR {(lineMax * 0.5).toFixed(0)}</Text>
                          <Text style={styles.reportYAxisLabel}>EUR 0</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <View
                            style={styles.reportLineChart}
                            onLayout={(e) => {
                              const { width, height } = e.nativeEvent.layout
                              if (width && height && (width !== reportsChartSize.width || height !== reportsChartSize.height)) {
                                setReportsChartSize({ width, height })
                              }
                            }}
                          >
                            <View style={[styles.reportGridLine, { top: 8 }]} />
                            <View style={[styles.reportGridLine, { top: 80 }]} />
                            <View style={[styles.reportGridLine, { bottom: 8 }]} />
                            {linePoints.map((seriesItem) => (
                              <React.Fragment key={seriesItem.id}>
                                {seriesItem.points.map((p, idx) => {
                                  const next = seriesItem.points[idx + 1]
                                  return (
                                    <React.Fragment key={`${seriesItem.id}-${p.key}`}>
                                      {next ? (
                                        <View
                                          style={[
                                            styles.reportLineSegment,
                                            { left: p.x, top: p.y, width: Math.max(2, next.x - p.x), backgroundColor: seriesItem.color },
                                          ]}
                                        />
                                      ) : null}
                                      <View style={[styles.reportLineDot, { left: p.x - 4, top: p.y - 4, backgroundColor: seriesItem.color }]} />
                                    </React.Fragment>
                                  )
                                })}
                              </React.Fragment>
                            ))}
                          </View>
                          <View style={styles.reportXAxis} />
                        </View>
                      </View>
                    </View>
                  </View>
                </>
              )}
            </View>
          ) : (
            <View style={{ paddingVertical: themeSpacing.sm }}>
              {tableRows.length === 0 ? (
                <Text style={styles.mutedText}>{tr('No bills in this range.')}</Text>
              ) : (
                <View style={{ gap: 10 }}>
                  <View style={styles.reportTableHeaderRow}>
                    <Text style={[styles.mutedText, { flex: 1 }]}>{tr('Supplier')}</Text>
                    <Text style={[styles.mutedText, { width: 96 }]}>{tr('Due')}</Text>
                    <Text style={[styles.mutedText, { width: 110, textAlign: 'right' }]}>{tr('Amount (EUR)')}</Text>
                  </View>
                  {tableRows.map((row) => (
                    <View key={row.id} style={styles.reportTableRow}>
                      <Text style={[styles.bodyText, { flex: 1 }]} numberOfLines={1}>{row.supplier}</Text>
                      <Text style={[styles.mutedText, { width: 96 }]}>{row.date || '—'}</Text>
                      <Text style={[styles.bodyText, { width: 110, textAlign: 'right', fontWeight: '700' }]}>{row.amount}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Report exports')} />
          <Text style={styles.mutedText}>{tr('Export this report as PDF.')}</Text>
          {exportBusy ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
              <ActivityIndicator size="small" color={themeColors.primary} />
              <Text style={styles.mutedText}>{exportBusyLabel || tr('Preparing export…')}</Text>
            </View>
          ) : null}
          <View style={{ marginTop: themeSpacing.sm }}>
            <AppButton
              label={tr('Export report')}
              variant="primary"
              iconName={entitlements.exportsEnabled ? 'cloud-download-outline' : 'sparkles-outline'}
              onPress={onExportPress}
              disabled={exportBusy}
            />
          </View>
          {!entitlements.exportsEnabled && exportUpsellVisible ? (
            <View style={{ marginTop: themeSpacing.sm }}>
              <InlineInfo
                tone="info"
                iconName="sparkles-outline"
                message={tr('Report exports are available on Več (PDF).')}
              />
            </View>
          ) : null}
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

function ExportsScreen() {
  const route = useRoute<any>()
  const supabase = useMemo(() => getSupabase(), [])
  const navigation = useNavigation<any>()
  const lang = useLang()
  const [exportBusy, setExportBusy] = useState(false)
  const [exportBusyLabel, setExportBusyLabel] = useState('')
  const [bills, setBills] = useState<Bill[]>([])
  const [warranties, setWarranties] = useState<Warranty[]>([])
  const [exportScope, setExportScope] = useState<ExportPayerScope>('payer1')
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

  const canUsePayer2 = Number(entitlements?.payerLimit || 1) >= 2
    && isUuidString((entitlements as any)?.spaceId2)

  useEffect(() => {
    if (!canUsePayer2 && exportScope !== 'payer1') setExportScope('payer1')
  }, [canUsePayer2, exportScope])

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

    const localIds = localPayerIdsForExportScope(exportScope)
    const localParam: any = localIds.length > 1 ? localIds : localIds[0]

    if (supabase) {
      const { data: b } = await listBills(supabase, localParam, entitlements)
      setBills((b as any) || [])
      const { data: w } = await listWarranties(supabase, localParam, entitlements)
      setWarranties((w as any) || [])
    } else {
      const mergedBills: any[] = []
      const mergedWarranties: any[] = []
      for (const sid of localIds) {
        const locals = await loadLocalBills(sid)
        for (const b of ((locals as any) || []) as any[]) mergedBills.push(b)
        const wLocals = await loadLocalWarranties(sid)
        for (const w of ((wLocals as any) || []) as any[]) mergedWarranties.push(w)
      }
      // De-dupe by id to avoid accidental duplicates.
      const uniqBills = Array.from(new Map(mergedBills.map((b) => [String(b?.id || ''), b])).values()).filter(Boolean)
      const uniqWarranties = Array.from(new Map(mergedWarranties.map((w) => [String(w?.id || ''), w])).values()).filter(Boolean)
      setBills(uniqBills as any)
      setWarranties(uniqWarranties as any)
    }
  })() }, [entitlements, exportScope, spaceLoading, space, spaceId, supabase])

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

        if (status !== 'all') {
          if (status === 'unpaid') {
            if (!isBillUnpaid(b.status)) return false
          } else {
            if (b.status !== status) return false
          }
        }

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
        if (json?.error === 'trial_expired') {
          Alert.alert(t(lang, 'Export'), t(lang, 'Free trial expired. Choose a plan to continue.'))
          showUpgradeAlert('export')
          return null
        }
        Alert.alert(t(lang, 'Export'), t(lang, 'Export is available on Več.'))
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
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
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
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }

    function csvEscape(v: any) {
      const s = v === null || v === undefined ? '' : String(v)
      return `"${s.replace(/"/g, '""')}"`
    }

    const base = getFunctionsBase()
    const s = getSupabase()
    const scopePayload = s ? await resolveDbExportScopePayload(s, entitlements, exportScope) : null

    // Prefer server-side export only when status is not filtering
    if (status === 'all' && base && s && scopePayload) {
      try {
        const { data } = await s.auth.getSession()
        const token = data?.session?.access_token
        if (token) {
          const resp = await fetch(`${base}/.netlify/functions/export-csv`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ from: range.start, to: range.end, dateField: 'due_date', ...scopePayload }),
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
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }
    const scopePayload = supabase ? await resolveDbExportScopePayload(supabase!, entitlements, exportScope) : null
    if (supabase && !scopePayload) {
      Alert.alert(tr('Export'), tr('Selected profile scope is unavailable.'))
      return
    }
    const res = await callExportFunction(
      'export-pdf',
      {
        kind: 'range',
        ...scopePayload,
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
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }
    const scopePayload = supabase ? await resolveDbExportScopePayload(supabase!, entitlements, exportScope) : null
    if (supabase && !scopePayload) {
      Alert.alert(tr('Export'), tr('Selected profile scope is unavailable.'))
      return
    }
    const res = await callExportFunction(
      'export-pdf',
      {
        kind: 'single',
        ...scopePayload,
        billId: bill.id,
      },
      tr('Preparing PDF…')
    )
    if (!res) return
    await downloadAndShare(res.url, res.filename, res.contentType)
  }

  async function exportAttachmentsZip() {
    if (!entitlements.exportsEnabled) {
      Alert.alert(tr('Export'), entitlements.status === 'trial_expired' ? tr('Free trial expired. Choose a plan to continue.') : tr('Export is available on Več.'))
      showUpgradeAlert('export')
      return
    }
    if (!filtered.length) {
      Alert.alert(tr('No bills match the current filters.'), tr('Adjust the filters to include bills with attachments.'))
      return
    }
    const scopePayload = supabase ? await resolveDbExportScopePayload(supabase!, entitlements, exportScope) : null
    if (supabase && !scopePayload) {
      Alert.alert(tr('Export'), tr('Selected profile scope is unavailable.'))
      return
    }
    const res = await callExportFunction(
      'export-zip',
      {
        ...scopePayload,
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

  const chooseExportFormat = useCallback(() => {
    Alert.alert(tr('Export'), undefined, [
      { text: tr('Export CSV'), onPress: () => { void exportCSV() } },
      { text: tr('Export PDF report'), onPress: () => { void exportPDFRange() } },
      { text: tr('Export attachments'), onPress: () => { void exportAttachmentsZip() } },
      { text: tr('Export JSON (backup)'), onPress: () => { void exportJSONRange() } },
      { text: tr('Cancel'), style: 'cancel' as const },
    ])
  }, [exportAttachmentsZip, exportCSV, exportJSONRange, exportPDFRange])

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
              <View style={{ marginTop: themeSpacing.sm }}>
                <Text style={styles.filterLabel}>{tr('Profile scope')}</Text>
                <SegmentedControl
                  value={exportScope}
                  onChange={(v) => setExportScope(v as any)}
                  options={canUsePayer2
                    ? [
                      { value: 'payer1', label: 'Profil 1' },
                      { value: 'payer2', label: 'Profil 2' },
                      { value: 'both', label: 'Profil 1 + Profil 2' },
                    ]
                    : [
                      { value: 'payer1', label: 'Profil 1' },
                    ]}
                  style={{ marginTop: themeSpacing.xs }}
                />
                <Text style={styles.helperText}>{tr('Exports are scoped to the selected profile scope and the filters above.')}</Text>
              </View>
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
            <AppButton label={tr('Export')} variant="secondary" iconName="cloud-download-outline" onPress={chooseExportFormat} disabled={exportBusy} />
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
                    <AppButton
                      label={tr('Open bill')}
                      variant="ghost"
                      iconName="open-outline"
                      onPress={() => navigation.navigate('Bill Details', { bill: item })}
                    />
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

function ExportsRedirectScreen() {
  const navigation = useNavigation<any>()
  const route = useRoute<any>()

  useEffect(() => {
    const start = (route as any)?.params?.start
    const end = (route as any)?.params?.end
    const preset = (start || end)
      ? {
        dateMode: 'due',
        dateFrom: typeof start === 'string' ? start : '',
        dateTo: typeof end === 'string' ? end : '',
      }
      : null

    navigation.navigate('Bills', {
      openExportChooser: true,
      exportPreset: preset,
    })
  }, [navigation, route])

  return (
    <Screen scroll={false}>
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={themeColors.primary} />
        <Text style={styles.mutedText}>{tr('Opening export…')}</Text>
      </View>
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
  const [qrPayload, setQrPayload] = useState<string | null>(null)
  const [qrBill, setQrBill] = useState<Bill | null>(null)
  const [qrDataUri, setQrDataUri] = useState<string | null>(null)
  const [qrBusy, setQrBusy] = useState(false)
  const [qrThumbs, setQrThumbs] = useState<Record<string, string>>({})
  const qrThumbInFlight = useRef<Record<string, boolean>>({})
  const [bankConfigVisible, setBankConfigVisible] = useState(false)
  const [debtorName, setDebtorName] = useState('')
  const [debtorIban, setDebtorIban] = useState('')
  const [debtorBic, setDebtorBic] = useState('')
  const [debtorStreet, setDebtorStreet] = useState('')
  const [debtorPostalCode, setDebtorPostalCode] = useState('')
  const [debtorCity, setDebtorCity] = useState('')
  const [debtorCountry, setDebtorCountry] = useState('')
  const [permissionExplained, setPermissionExplained] = useState(false)
  const { space, spaceId, loading: spaceLoading } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()
  const spacesCtx = useSpacesContext()

  const dayKey = useDayKey()
  const [planBucket, setPlanBucket] = useState<'today' | 'week' | 'month'>('today')

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
  const payerSpaces = useMemo(() => {
    return (spacesCtx.spaces || []).filter((s) => isPayerSpaceId(s.id))
  }, [spacesCtx.spaces])

  const billSpaceIds = useMemo(() => {
    const ids = payerSpaces.map((s) => s.id)
    const p1 = ids.includes('personal') ? 'personal' : (ids[0] || null)
    const p2 = ids.includes('personal2') ? 'personal2' : null
    const canUsePayer2 = Number(entitlements?.payerLimit || 1) >= 2

    if (isPayerSpaceId(spaceId)) {
      if (spaceId === 'personal2' && (!canUsePayer2 || !p2)) return p1 ? [p1] : []
      return [spaceId]
    }
    if (p1) return [p1]
    return spaceId ? [spaceId] : []
  }, [entitlements?.payerLimit, payerSpaces, spaceId])

  useEffect(() => {
    ;(async () => {
      const sid = spaceId || 'default'
      try {
        const raw = await AsyncStorage.getItem(`billbox.pay.debtor.${sid}`)
        if (!raw) return
        const parsed = JSON.parse(raw)
        if (parsed?.name) setDebtorName(String(parsed.name))
        if (parsed?.iban) setDebtorIban(String(parsed.iban))
        if (parsed?.bic) setDebtorBic(String(parsed.bic))
        if (parsed?.street) setDebtorStreet(String(parsed.street))
        if (parsed?.postalCode) setDebtorPostalCode(String(parsed.postalCode))
        if (parsed?.city) setDebtorCity(String(parsed.city))
        if (parsed?.country) setDebtorCountry(String(parsed.country))
      } catch {}
    })()
  }, [spaceId])

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
    const ids = billSpaceIds.length ? billSpaceIds : (spaceId ? [spaceId] : [])
    if (supabase) {
      const { data } = await listBills(supabase, ids.length > 1 ? ids : (ids[0] || spaceId), entitlements)
      let next = (data || []) as Bill[]
      if (entitlements.plan === 'pro') {
        const merged: Bill[] = []
        for (const sid of ids) {
          const group = next.filter((b) => (b as any)?.space_id === sid || (b as any)?.__spaceId === sid)
          const ensured = await ensureInstallmentBills({ spaceId: sid, supabase, existingBills: group, horizonMonths: 2 })
          for (const b of ensured || []) merged.push(b as any)
        }
        next = merged.length ? merged : next
      } else {
        next = next.filter((b) => !isInstallmentBill(b))
      }
      setItems(next)
    } else {
      const collected: Bill[] = []
      for (const sid of ids) {
        const locals = await loadLocalBills(sid)
        for (const b of (locals as any) || []) collected.push(b as any)
      }
      let next = collected as Bill[]
      if (entitlements.plan === 'pro') {
        const merged: Bill[] = []
        for (const sid of ids) {
          const group = next.filter((b) => (b as any)?.__spaceId === sid)
          const ensured = await ensureInstallmentBills({ spaceId: sid, supabase: null, existingBills: group, horizonMonths: 2 })
          for (const b of ensured || []) merged.push(b as any)
        }
        next = merged.length ? merged : next
      } else {
        next = next.filter((b) => !isInstallmentBill(b))
      }
      setItems(next)
    }
  })() }, [dayKey, supabase, permissionExplained, spaceLoading, space, spaceId, entitlements, billSpaceIds])
  const upcoming = items.filter(b=> b.status==='unpaid').sort((a,b)=> (a.pay_date||a.due_date).localeCompare(b.pay_date||b.due_date))
  const today = dayKey
  const thisWeekEnd = useMemo(() => {
    const base = parseDateValue(dayKey) || new Date()
    const out = new Date(base.getTime() + 7 * 24 * 3600 * 1000)
    return formatDateInput(out)
  }, [dayKey, formatDateInput, parseDateValue])
  const monthEnd = useMemo(() => {
    const base = parseDateValue(dayKey) || new Date()
    const out = new Date(base.getTime() + 30 * 24 * 3600 * 1000)
    return formatDateInput(out)
  }, [dayKey, formatDateInput, parseDateValue])
  const groups = {
    today: upcoming.filter(b=> (b.pay_date||b.due_date)===today),
    thisWeek: upcoming.filter(b=> (b.pay_date||b.due_date)>today && (b.pay_date||b.due_date)<=thisWeekEnd),
    inMonth: upcoming.filter(b=> (b.pay_date||b.due_date)>thisWeekEnd && (b.pay_date||b.due_date)<=monthEnd),
  }

  const planList = useMemo(() => {
    if (planBucket === 'today') return groups.today
    if (planBucket === 'week') return groups.thisWeek
    return groups.inMonth
  }, [groups.inMonth, groups.thisWeek, groups.today, planBucket])

  const planCurrency = useMemo(() => {
    const first = planList.find((b) => !!b?.currency)?.currency
    return first || 'EUR'
  }, [planList])

  const planTotal = useMemo(() => {
    return planList.reduce((sum, b) => sum + Number(b?.amount || 0), 0)
  }, [planList])

  const formatMoney = useCallback((value: number, currency: string) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(value)
    } catch {
      return `${Number(value || 0).toFixed(2)} ${currency || 'EUR'}`
    }
  }, [])

  async function makeQrDataUri(payload: string, opts: { width: number; margin?: number }) {
    const QRCode = (await import('qrcode')) as any
    const uri = await QRCode.toDataURL(payload, { width: opts.width, margin: opts.margin ?? 1 })
    return String(uri)
  }

  function buildPaymentCopyParts(bill: Bill) {
    const creditor = String(bill.creditor_name || bill.supplier || '').trim()
    const iban = String(normalizeIban(bill.iban || '') || bill.iban || '').trim()
    const reference = String([bill.reference_model, bill.reference].filter(Boolean).join(' ').trim())
    const purpose = String(bill.purpose || '').trim()
    const amountNum = Number(bill.amount || 0)
    const currency = String(bill.currency || '').toUpperCase()
    const amount = Number.isFinite(amountNum) ? amountNum.toFixed(2) : ''

    const all = [
      creditor ? `${tr('Supplier')}: ${creditor}` : '',
      iban ? `IBAN: ${iban}` : '',
      amount ? `${tr('Amount')}: ${amount} ${currency || ''}`.trim() : '',
      reference ? `${tr('Reference')}: ${reference}` : '',
      purpose ? `${tr('Purpose')}: ${purpose}` : '',
    ].filter(Boolean).join('\n')

    return { creditor, iban, reference, purpose, amount, currency, all }
  }

  async function copyTextOrWarn(text: string, warnKey: string) {
    const v = String(text || '').trim()
    if (!v) {
      Alert.alert(tr('Error'), tr(warnKey))
      return
    }
    try {
      await Clipboard.setStringAsync(v)
      Alert.alert(tr('Copied'))
    } catch {
      Alert.alert(tr('Error'), tr('Could not copy.'))
    }
  }

  const escapeXml = useCallback((input: string) => {
    return String(input || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }, [])

  function normalizeBic(input: string): string {
    const v = String(input || '').replace(/\s+/g, '').toUpperCase()
    return v
  }

  function buildPain001Xml(args: {
    msgId: string
    createdAtIso: string
    executionDate: string
    debtorName: string
    debtorIban: string
    debtorBic?: string
    debtorStreet?: string
    debtorPostalCode?: string
    debtorCity?: string
    debtorCountry?: string
    bills: Bill[]
  }): string {
    const txs = args.bills
    const ctrlSum = txs.reduce((sum, b) => sum + Number(b.amount || 0), 0)
    const nb = txs.length

    const debtorNm = escapeXml(args.debtorName)
    const debtorIbanNorm = normalizeIban(args.debtorIban) || ''
    const debtorBicNorm = args.debtorBic ? normalizeBic(args.debtorBic) : ''

    const street = String(args.debtorStreet || '').trim()
    const postalCode = String(args.debtorPostalCode || '').trim()
    const city = String(args.debtorCity || '').trim()
    const country = String(args.debtorCountry || '').trim().toUpperCase()
    const hasPostal = !!(street || postalCode || city || country)
    const postalXml = hasPostal
      ? (
        `        <PstlAdr>\n` +
        (street ? `          <AdrLine>${escapeXml(street.slice(0, 70))}</AdrLine>\n` : '') +
        (postalCode ? `          <PstCd>${escapeXml(postalCode.slice(0, 16))}</PstCd>\n` : '') +
        (city ? `          <TwnNm>${escapeXml(city.slice(0, 35))}</TwnNm>\n` : '') +
        (country && /^[A-Z]{2}$/.test(country) ? `          <Ctry>${escapeXml(country)}</Ctry>\n` : '') +
        `        </PstlAdr>\n`
      )
      : ''

    const header = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n` +
      `  <CstmrCdtTrfInitn>\n` +
      `    <GrpHdr>\n` +
      `      <MsgId>${escapeXml(args.msgId)}</MsgId>\n` +
      `      <CreDtTm>${escapeXml(args.createdAtIso)}</CreDtTm>\n` +
      `      <NbOfTxs>${nb}</NbOfTxs>\n` +
      `      <CtrlSum>${ctrlSum.toFixed(2)}</CtrlSum>\n` +
      `      <InitgPty>\n` +
      `        <Nm>${debtorNm}</Nm>\n` +
      (postalXml ? postalXml : '') +
      `      </InitgPty>\n` +
      `    </GrpHdr>\n`

    const pmtInf = `    <PmtInf>\n` +
      `      <PmtInfId>${escapeXml(args.msgId)}-P1</PmtInfId>\n` +
      `      <PmtMtd>TRF</PmtMtd>\n` +
      `      <NbOfTxs>${nb}</NbOfTxs>\n` +
      `      <CtrlSum>${ctrlSum.toFixed(2)}</CtrlSum>\n` +
      `      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>\n` +
      `      <ReqdExctnDt>${escapeXml(args.executionDate)}</ReqdExctnDt>\n` +
      `      <Dbtr>\n` +
      `        <Nm>${debtorNm}</Nm>\n` +
      (postalXml ? postalXml : '') +
      `      </Dbtr>\n` +
      `      <DbtrAcct><Id><IBAN>${escapeXml(debtorIbanNorm)}</IBAN></Id></DbtrAcct>\n` +
      (debtorBicNorm ? `      <DbtrAgt><FinInstnId><BIC>${escapeXml(debtorBicNorm)}</BIC></FinInstnId></DbtrAgt>\n` : '') +
      `      <ChrgBr>SLEV</ChrgBr>\n`

    const txXml = txs.map((b) => {
      const creditor = escapeXml(String(b.creditor_name || b.supplier || ''))
      const creditorIban = escapeXml(String(normalizeIban(b.iban || '') || ''))
      const endToEnd = escapeXml(String(b.invoice_number || b.id).slice(0, 35))
      const ref = String([b.reference_model, b.reference].filter(Boolean).join(' ').trim())
      const memoRaw = String(ref || b.purpose || b.supplier || '').trim()
      const memo = escapeXml(memoRaw.slice(0, 140))
      return (
        `      <CdtTrfTxInf>\n` +
        `        <PmtId><EndToEndId>${endToEnd || 'NOTPROVIDED'}</EndToEndId></PmtId>\n` +
        `        <Amt><InstdAmt Ccy="EUR">${Number(b.amount || 0).toFixed(2)}</InstdAmt></Amt>\n` +
        `        <Cdtr><Nm>${creditor || 'UNKNOWN'}</Nm></Cdtr>\n` +
        `        <CdtrAcct><Id><IBAN>${creditorIban}</IBAN></Id></CdtrAcct>\n` +
        (memo ? `        <RmtInf><Ustrd>${memo}</Ustrd></RmtInf>\n` : '') +
        `      </CdtTrfTxInf>\n`
      )
    }).join('')

    const footer = `    </PmtInf>\n` +
      `  </CstmrCdtTrfInitn>\n` +
      `</Document>\n`

    return header + pmtInf + txXml + footer
  }

  const saveDebtorConfig = useCallback(async () => {
    const sid = spaceId || 'default'
    const name = String(debtorName || '').trim()
    const ibanNorm = normalizeIban(debtorIban || '')
    const bicNorm = debtorBic ? normalizeBic(debtorBic) : ''

    const street = String(debtorStreet || '').trim()
    const postalCode = String(debtorPostalCode || '').trim()
    const city = String(debtorCity || '').trim()
    const country = String(debtorCountry || '').trim().toUpperCase()
    const country2 = country && /^[A-Z]{2}$/.test(country) ? country : ''

    if (!name || !ibanNorm || !isValidIbanChecksum(ibanNorm)) {
      Alert.alert(tr('Missing bank details'), tr('Please set your IBAN (and BIC if required by your bank).'))
      return
    }
    try {
      await AsyncStorage.setItem(
        `billbox.pay.debtor.${sid}`,
        JSON.stringify({ name, iban: ibanNorm, bic: bicNorm, street, postalCode, city, country: country2 })
      )
      setDebtorName(name)
      setDebtorIban(ibanNorm)
      setDebtorBic(bicNorm)
      setDebtorStreet(street)
      setDebtorPostalCode(postalCode)
      setDebtorCity(city)
      setDebtorCountry(country2)
      setBankConfigVisible(false)
      Alert.alert(tr('Saved'))
    } catch {
      Alert.alert(tr('Unable to save.'))
    }
  }, [debtorBic, debtorCity, debtorCountry, debtorIban, debtorName, debtorPostalCode, debtorStreet, spaceId])

  const exportSepaXmlSelected = useCallback(async () => {
    const picked = upcoming.filter((b) => selected[b.id])
    if (!picked.length) {
      Alert.alert(tr('Select bills'), tr('Select one or more bills.'))
      return
    }

    const name = String(debtorName || '').trim()
    const ibanNorm = normalizeIban(debtorIban || '')
    const bicNorm = debtorBic ? normalizeBic(debtorBic) : ''

    const street = String(debtorStreet || '').trim()
    const postalCode = String(debtorPostalCode || '').trim()
    const city = String(debtorCity || '').trim()
    const country = String(debtorCountry || '').trim().toUpperCase()
    const country2 = country && /^[A-Z]{2}$/.test(country) ? country : ''

    if (!name || !ibanNorm || !isValidIbanChecksum(ibanNorm)) {
      Alert.alert(tr('Missing bank details'), tr('Please set your IBAN (and BIC if required by your bank).'))
      setBankConfigVisible(true)
      return
    }

    const nonEur = picked.find((b) => String(b.currency || '').toUpperCase() !== 'EUR')
    if (nonEur) {
      Alert.alert(tr('Export SEPA XML'), tr('Only EUR bills can be exported.'))
      return
    }
    const missingIban = picked.find((b) => !normalizeIban(b.iban || '') || !isValidIbanChecksum(String(normalizeIban(b.iban || '') || '')))
    if (missingIban) {
      Alert.alert(tr('Export SEPA XML'), tr('Some selected bills are missing IBAN.'))
      return
    }

    try {
      const now = new Date()
      const msgId = `BILLBOX-${now.toISOString().replace(/[-:.TZ]/g, '')}`
      const createdAtIso = now.toISOString().slice(0, 19)
      const xml = buildPain001Xml({
        msgId,
        createdAtIso,
        executionDate: String(planningDate || new Date().toISOString().slice(0, 10)),
        debtorName: name,
        debtorIban: ibanNorm,
        debtorBic: bicNorm || undefined,
        debtorStreet: street,
        debtorPostalCode: postalCode,
        debtorCity: city,
        debtorCountry: country2,
        bills: picked,
      })

      const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || ''
      const file = `${baseDir}billbox_sepa_${Date.now()}.xml`
      await FileSystem.writeAsStringAsync(file, xml, { encoding: FileSystem.EncodingType.UTF8 })

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file, { mimeType: 'application/xml', dialogTitle: tr('Share export') })
      } else {
        Alert.alert(tr('Saved'), file)
      }
    } catch (e: any) {
      Alert.alert(tr('Export failed'), e?.message || tr('Unable to export'))
    } finally {
      setPayActionVisible(false)
    }
  }, [buildPain001Xml, debtorBic, debtorCity, debtorCountry, debtorIban, debtorName, debtorPostalCode, debtorStreet, planningDate, selected, upcoming])

  const exportCsvSelected = useCallback(async () => {
    const picked = upcoming.filter((b) => selected[b.id])
    if (!picked.length) {
      Alert.alert(tr('Select bills'), tr('Select one or more bills.'))
      return
    }
    try {
      const header = ['supplier', 'amount', 'currency', 'iban', 'reference', 'purpose', 'due_date', 'pay_date']
      const rows = picked.map((b) => {
        const supplier = String(b.supplier || '').replace(/\s+/g, ' ').trim()
        const amount = Number(b.amount || 0)
        const currency = String(b.currency || '').toUpperCase()
        const iban = String(normalizeIban(b.iban || '') || b.iban || '').trim()
        const reference = String([b.reference_model, b.reference].filter(Boolean).join(' ').trim())
        const purpose = String(b.purpose || '').replace(/\s+/g, ' ').trim()
        const due = String(b.due_date || '')
        const pay = String((b as any).pay_date || '')
        const cols = [
          supplier,
          Number.isFinite(amount) ? amount.toFixed(2) : '',
          currency,
          iban,
          reference,
          purpose,
          due,
          pay,
        ]
        return cols.map((v) => {
          const s = String(v ?? '')
          if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
          return s
        }).join(',')
      })
      const csv = [header.join(','), ...rows].join('\n') + '\n'

      const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || ''
      const file = `${baseDir}billbox_payments_${Date.now()}.csv`
      await FileSystem.writeAsStringAsync(file, csv, { encoding: FileSystem.EncodingType.UTF8 })

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file, { mimeType: 'text/csv', dialogTitle: tr('Share export') })
      } else {
        Alert.alert(tr('Saved'), file)
      }
    } catch (e: any) {
      Alert.alert(tr('Export failed'), e?.message || tr('Unable to export'))
    } finally {
      setPayActionVisible(false)
    }
  }, [selected, upcoming])

  useEffect(() => {
    let cancelled = false
    const first = upcoming.slice(0, 12)
    if (!first.length) return

    ;(async () => {
      for (const b of first) {
        if (cancelled) return
        if (qrThumbs[b.id]) continue
        if (qrThumbInFlight.current[b.id]) continue
        const payload = buildPaymentQrPayload(b)
        if (!payload) continue
        qrThumbInFlight.current[b.id] = true
        try {
          const uri = await makeQrDataUri(payload, { width: 96, margin: 1 })
          if (cancelled) return
          setQrThumbs((prev) => (prev[b.id] ? prev : { ...prev, [b.id]: uri }))
        } catch {
        } finally {
          qrThumbInFlight.current[b.id] = false
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [qrThumbs, upcoming])

  function buildPaymentQrPayload(bill: Bill): string | null {
    const iban = normalizeIban(bill.iban || '')
    if (!iban) return null
    const amount = Number(bill.amount || 0)
    if (!amount || Number.isNaN(amount)) return null
    const currency = String(bill.currency || 'EUR').toUpperCase()
    if (currency !== 'EUR') return null
    const creditor = String(bill.creditor_name || bill.supplier || '').trim()
    if (!creditor) return null
    const reference = String([bill.reference_model, bill.reference].filter(Boolean).join(' ').trim())
    const purpose = String(bill.purpose || '').trim()
    const remittance = (reference || purpose).slice(0, 140)
    const info = reference && purpose ? purpose.slice(0, 140) : ''
    const lines = [
      'BCD',
      '002',
      '1',
      'SCT',
      '',
      creditor.slice(0, 70),
      iban,
      `EUR${amount.toFixed(2)}`,
      '',
      remittance,
      info,
    ]
    return lines.join('\n')
  }

  function openPaymentQr(bill: Bill) {
    const payload = buildPaymentQrPayload(bill)
    if (!payload) {
      const currency = String(bill.currency || 'EUR').toUpperCase()
      if (currency !== 'EUR') {
        Alert.alert(tr('QR unavailable'), tr('QR supports EUR only.'))
        return
      }
      Alert.alert(tr('QR unavailable'), tr('Missing IBAN or amount.'))
      return
    }
    setQrBill(bill)
    setQrPayload(payload)
    setQrDataUri(null)
    setQrBusy(true)

    ;(async () => {
      try {
        const uri = await makeQrDataUri(payload, { width: 240, margin: 1 })
        setQrDataUri(uri)
      } catch (e) {
        Alert.alert(tr('QR unavailable'), tr('Could not generate QR.'))
        setQrPayload(null)
        setQrBill(null)
        setQrDataUri(null)
      } finally {
        setQrBusy(false)
      }
    })()
  }

  async function shareQrForCurrent() {
    if (!qrDataUri || !qrBill) return
    const match = String(qrDataUri).match(/^data:image\/png;base64,(.+)$/)
    if (!match) {
      Alert.alert(tr('Error'), tr('QR unavailable'))
      return
    }
    try {
      const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || ''
      const file = `${baseDir}billbox_qr_${qrBill.id}_${Date.now()}.png`
      await FileSystem.writeAsStringAsync(file, match[1], { encoding: FileSystem.EncodingType.Base64 })
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file, { mimeType: 'image/png', dialogTitle: tr('Share QR') })
      } else {
        Alert.alert(tr('Saved'), file)
      }
    } catch (e: any) {
      Alert.alert(tr('Error'), e?.message || tr('QR unavailable'))
    }
  }

  async function saveQrForCurrent() {
    if (!qrDataUri || !qrBill) return
    const match = String(qrDataUri).match(/^data:image\/png;base64,(.+)$/)
    if (!match) {
      Alert.alert(tr('Error'), tr('QR unavailable'))
      return
    }
    try {
      const MediaLibrary = await import('expo-media-library')
      const perm = await MediaLibrary.requestPermissionsAsync()
      if (!perm?.granted) {
        Alert.alert(tr('Permission required'), tr('Please allow photo library access to save QR.'))
        return
      }
      const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || ''
      const file = `${baseDir}billbox_qr_${qrBill.id}_${Date.now()}.png`
      await FileSystem.writeAsStringAsync(file, match[1], { encoding: FileSystem.EncodingType.Base64 })
      await MediaLibrary.createAssetAsync(file)
      Alert.alert(tr('Saved'))
    } catch (e: any) {
      Alert.alert(tr('Error'), e?.message || tr('Unable to save.'))
    }
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
  function Chip({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'warning' }) {
    const bg = tone === 'warning' ? '#FEF3C7' : themeColors.primarySoft
    const fg = tone === 'warning' ? '#92400E' : themeColors.primary
    return (
      <View style={{ backgroundColor: bg, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
        <Text style={{ color: fg, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
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
        <TabTopBar titleKey="Payments" />

        <Surface elevated padded={false} style={styles.paySectionCard}>
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
              renderItem={({ item })=> {
                const dueDate = parseDateValue(item.due_date)
                const todayDate = parseDateValue(today)
                const isOverdue = dueDate && todayDate ? dueDate.getTime() < todayDate.getTime() : false
                const canQr = !!buildPaymentQrPayload(item)
                const parts = buildPaymentCopyParts(item)
                return (
                <Surface elevated style={styles.billRowCard}>
                  <View style={styles.billRowHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>{item.supplier}</Text>
                      <Text style={styles.payBillMeta}>
                        {item.currency} {item.amount.toFixed(2)} • {tr('Due')}: <Text style={isOverdue ? styles.payDueOverdue : styles.payDueText}>{item.due_date}</Text>
                        {(item as any).pay_date ? ` • ${tr('Planned')}: ${(item as any).pay_date}` : ''}
                      </Text>
                    </View>
                    <View style={styles.payAmountWrap}>
                      <Text style={styles.payAmountText}>{formatMoney(item.amount, item.currency)}</Text>
                      <Text style={styles.payAmountCaption}>{tr('To pay')}</Text>
                    </View>

                    <Pressable
                      onPress={() => {
                        if (!canQr) {
                          const currency = String(item.currency || 'EUR').toUpperCase()
                          if (currency !== 'EUR') Alert.alert(tr('QR unavailable'), tr('QR supports EUR only.'))
                          else Alert.alert(tr('QR unavailable'), tr('Missing IBAN or amount.'))
                          return
                        }
                        openPaymentQr(item)
                      }}
                      style={({ pressed }) => [styles.payQrThumbWrap, pressed ? { opacity: 0.92 } : null]}
                      hitSlop={6}
                    >
                      {canQr && qrThumbs[item.id] ? (
                        <Image source={{ uri: qrThumbs[item.id] }} style={styles.payQrThumb} />
                      ) : (
                        <View style={styles.payQrThumbPlaceholder}>
                          <Ionicons name="qr-code-outline" size={18} color={themeColors.textMuted} />
                        </View>
                      )}
                    </Pressable>

                    <Pressable onPress={()=>toggleSel(item.id)}>
                      <Ionicons
                        name={selected[item.id] ? 'checkbox-outline' : 'square-outline'}
                        size={20}
                        color={themeColors.primary}
                      />
                    </Pressable>
                  </View>
                  <View style={styles.billActionsRow}>
                    <Chip
                      text={(item as any).pay_date ? `${tr('Planned')}: ${(item as any).pay_date}` : (new Date(item.due_date).getTime()-Date.now())/(24*3600*1000) < 1 ? tr('Due today') : tr('Upcoming')}
                      tone={isOverdue ? 'warning' : 'neutral'}
                    />
                    <AppButton
                      label={tr('Pay (copy details)')}
                      variant="primary"
                      iconName="copy-outline"
                      onPress={() => copyTextOrWarn(parts.all, 'Nothing to copy.')}
                    />
                    <View style={styles.payCopyMiniRow}>
                      <Pressable style={styles.payCopyMiniBtn} onPress={() => copyTextOrWarn(parts.reference, 'Reference not found.') }>
                        <Text style={styles.payCopyMiniText}>{tr('Reference')}</Text>
                      </Pressable>
                      <Pressable style={styles.payCopyMiniBtn} onPress={() => copyTextOrWarn(parts.iban, 'IBAN not found.') }>
                        <Text style={styles.payCopyMiniText}>IBAN</Text>
                      </Pressable>
                      <Pressable
                        style={styles.payCopyMiniBtn}
                        onPress={() => copyTextOrWarn(parts.amount ? `${parts.amount} ${parts.currency || ''}`.trim() : '', 'Amount not found.')}
                      >
                        <Text style={styles.payCopyMiniText}>{tr('Amount')}</Text>
                      </Pressable>
                      <Pressable style={styles.payCopyMiniBtn} onPress={() => copyTextOrWarn(parts.all, 'Nothing to copy.') }>
                        <Text style={styles.payCopyMiniText}>{tr('All')}</Text>
                      </Pressable>
                    </View>
                    <AppButton
                      label={tr('Show QR')}
                      variant="secondary"
                      iconName="qr-code-outline"
                      onPress={()=>openPaymentQr(item)}
                    />
                    <AppButton
                      label={tr('Mark as paid')}
                      variant="primary"
                      iconName="checkmark-circle-outline"
                      style={{ backgroundColor: '#16A34A', borderColor: '#16A34A' }}
                      onPress={()=>markPaid(item, today)}
                    />
                  </View>
                  <View style={styles.payAdjustRow}>
                    <AppButton label={tr('+1d')} variant="ghost" iconName="time-outline" onPress={()=>postponeBill(item, 1)} />
                    <AppButton label={tr('+2d')} variant="ghost" iconName="time-outline" onPress={()=>postponeBill(item, 2)} />
                    <AppButton label={tr('+7d')} variant="ghost" iconName="time-outline" onPress={()=>postponeBill(item, 7)} />
                  </View>
                  <View style={styles.payDueRow}>
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
              )}}
            />
          )}
        </Surface>

        <Surface elevated padded={false} style={styles.paySectionCard}>
          <SectionHeader title={tr('Payment plan overview')} />
          <View style={styles.payUrgencyTabsRow}>
            <Pressable
              onPress={() => setPlanBucket('today')}
              style={({ pressed }) => [
                styles.payUrgencyTab,
                planBucket === 'today' ? styles.payUrgencyTabActiveToday : null,
                pressed ? styles.payUrgencyTabPressed : null,
              ]}
            >
              <Text style={[styles.payUrgencyTabText, planBucket === 'today' ? styles.payUrgencyTabTextActive : null]}>{tr('Today')}</Text>
            </Pressable>

            <Pressable
              onPress={() => setPlanBucket('week')}
              style={({ pressed }) => [
                styles.payUrgencyTab,
                planBucket === 'week' ? styles.payUrgencyTabActiveWeek : null,
                pressed ? styles.payUrgencyTabPressed : null,
              ]}
            >
              <Text style={[styles.payUrgencyTabText, planBucket === 'week' ? styles.payUrgencyTabTextActive : null]}>{tr('This week')}</Text>
            </Pressable>

            <Pressable
              onPress={() => setPlanBucket('month')}
              style={({ pressed }) => [
                styles.payUrgencyTab,
                planBucket === 'month' ? styles.payUrgencyTabActiveMonth : null,
                pressed ? styles.payUrgencyTabPressed : null,
              ]}
            >
              <Text style={[styles.payUrgencyTabText, planBucket === 'month' ? styles.payUrgencyTabTextActive : null]}>{tr('In 1 month')}</Text>
            </Pressable>
          </View>

          <View style={styles.payUrgencySummaryRow}>
            <Text style={styles.bodyText}>
              {tr('{count} bills', { count: planList.length })}
            </Text>
            <Text style={styles.bodyText}>
              {formatMoney(planTotal, planCurrency)}
            </Text>
          </View>
        </Surface>
      </View>

      <Modal visible={payActionVisible} transparent animationType="fade" onRequestClose={() => setPayActionVisible(false)}>
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}> 
          <Surface elevated style={styles.iosPickerSheet}>
            <SectionHeader title={tr('Pay')} />
            <Text style={styles.bodyText}>{tr('Choose what to do with the selected bills:')}</Text>
            <View style={{ gap: themeSpacing.sm, marginTop: themeSpacing.sm }}>
              {upcoming.filter((b) => selected[b.id]).length >= 3 ? (
                <AppButton label={tr('Export SEPA XML')} iconName="download-outline" onPress={exportSepaXmlSelected} />
              ) : null}
              <AppButton label={tr('Export CSV')} variant="secondary" iconName="download-outline" onPress={exportCsvSelected} />
              <AppButton label={tr('Bank details')} variant="secondary" iconName="settings-outline" onPress={() => setBankConfigVisible(true)} />
              <AppButton label={tr('Pay selected')} iconName="card-outline" onPress={paySelected} />
              <AppButton label={tr('Reschedule selected')} variant="secondary" iconName="calendar-outline" onPress={rescheduleSelected} />
              <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setPayActionVisible(false)} />
            </View>
          </Surface>
        </View>
      </Modal>

      <Modal visible={bankConfigVisible} transparent animationType="fade" onRequestClose={() => setBankConfigVisible(false)}>
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
          <Surface elevated style={styles.iosPickerSheet}>
            <SectionHeader title={tr('Bank details')} />
            <Text style={styles.mutedText}>{tr('Used for SEPA XML export into your bank / e-banking.')}</Text>
            <View style={{ gap: themeSpacing.sm }}>
              <AppInput placeholder={tr('Account holder name')} value={debtorName} onChangeText={setDebtorName} />
              <AppInput placeholder={tr('Your IBAN')} value={debtorIban} onChangeText={setDebtorIban} autoCapitalize="characters" />
              <AppInput placeholder={tr('Your BIC (optional)')} value={debtorBic} onChangeText={setDebtorBic} autoCapitalize="characters" />
              <AppInput placeholder={tr('Street')} value={debtorStreet} onChangeText={setDebtorStreet} />
              <View style={{ flexDirection: 'row', gap: themeLayout.gap }}>
                <AppInput placeholder={tr('Postal code')} value={debtorPostalCode} onChangeText={setDebtorPostalCode} style={{ flex: 1 }} />
                <AppInput placeholder={tr('City')} value={debtorCity} onChangeText={setDebtorCity} style={{ flex: 1 }} />
              </View>
              <AppInput
                placeholder={tr('Country (2-letter)')}
                value={debtorCountry}
                onChangeText={(v) => setDebtorCountry(String(v || '').toUpperCase())}
                autoCapitalize="characters"
              />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
              <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setBankConfigVisible(false)} />
              <AppButton label={tr('Save')} onPress={saveDebtorConfig} />
            </View>
          </Surface>
        </View>
      </Modal>

      <Modal visible={!!qrPayload} transparent animationType="fade" onRequestClose={() => { setQrPayload(null); setQrBill(null) }}>
        <View style={[styles.iosPickerOverlay, { justifyContent: 'center' }]}>
          <Surface elevated style={styles.qrModalCard}>
            <SectionHeader title={tr('Payment QR')} />
            {qrBill ? (
              <Text style={styles.bodyText}>{qrBill.supplier} • {formatMoney(qrBill.amount, qrBill.currency)}</Text>
            ) : null}
            {qrBusy ? (
              <View style={{ alignItems: 'center', justifyContent: 'center', height: 240 }}>
                <ActivityIndicator size="large" color={themeColors.primary} />
              </View>
            ) : qrDataUri ? (
              <Image source={{ uri: qrDataUri }} style={styles.qrImage} />
            ) : null}
            <Text style={styles.mutedText}>{tr('Generated from bill payment fields.')}</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
              {qrDataUri ? (
                <>
                  <AppButton label={tr('Save QR')} variant="secondary" iconName="download-outline" onPress={saveQrForCurrent} />
                  <AppButton label={tr('Share QR')} variant="secondary" iconName="share-outline" onPress={shareQrForCurrent} />
                </>
              ) : null}
              <AppButton label={tr('Close')} variant="ghost" onPress={() => { setQrPayload(null); setQrBill(null); setQrDataUri(null) }} />
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
      Alert.alert(tr('Purchases unavailable'), tr('Purchases are available only in the store build.'))
      return
    }
    const productId = resolveProductId(plan, interval)
    if (!productId) {
      Alert.alert(tr('Payments not configured'), tr('Product ID is missing in environment variables.'))
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
        setStatus(tr('Subscription updated. Thank you!'))
      } else {
        Alert.alert(tr('Verification failed'), tr('We could not verify your purchase. Please try again later.'))
      }
    } catch (e) {
      Alert.alert(tr('Purchase error'), tr('Something went wrong while processing the purchase.'))
    } finally {
      setBusy(false)
    }
  }

  function PlanIcon({ plan }: { plan: PlanId }) {
    const color = themeColors.primary
    const size = 16
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
        'Unlimited bills + warranties',
        'Two locations/households (2 profiles)',
        'Installment obligations (credits/leasing)',
        'Import bills from email',
        'AI assistant (GPT chat)',
        'Reminders & notifications',
        '100 OCR / month',
        'Export (CSV / PDF / ZIP / JSON)',
        'Advanced analytics',
      ]
    }
    if (plan === 'basic') {
      return [
        'Unlimited bills + warranties',
        '1 profile',
        'Reminders & notifications',
        '50 OCR / month',
        'Basic analytics',
      ]
    }
    return [
      '10 bills / month',
      '1 profile',
      'Reminders & notifications',
      '3 OCR / month',
      'Basic analytics',
    ]
  }

  const focusPlan: PlanId | null = useMemo(() => {
    const raw = route?.params?.focusPlan
    return raw === 'basic' || raw === 'pro' ? raw : null
  }, [route?.params?.focusPlan])

  const formatDate = useCallback((iso?: string | null) => {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      return d.toISOString().slice(0, 10)
    } catch {
      return String(iso)
    }
  }, [])

  const statusNotice = useMemo(() => {
    if (entitlements.status === 'trial_active') {
      return t(lang, 'Free trial is active until {date}.', { date: formatDate(entitlements.trialEndsAt) })
    }
    if (entitlements.status === 'trial_expired') {
      return t(lang, 'Free trial expired. Choose a plan to continue.')
    }
    if (entitlements.status === 'payment_failed') {
      return t(lang, 'Payment failed. Premium features are disabled until payment is completed.')
    }
    if (entitlements.status === 'subscription_cancelled') {
      return t(lang, 'Subscription cancelled. Premium features are disabled.')
    }

    switch (entitlements.lifecycleStatus) {
      case 'grace_period':
        return t(lang, 'Subscription cancelled. Bills remain available until {date}.', { date: formatDate(entitlements.graceUntil) })
      case 'export_only':
        return t(lang, 'Export-only access is active until {date}. Export your bills before then.', { date: formatDate(entitlements.exportUntil) })
      case 'downgrade_vec_to_moje':
        return t(lang, 'Attachments of the second profile will be removed on {date}. You can export them or reactivate Več.', { date: formatDate(entitlements.downgradeCleanupAt) })
      case 'deleted':
        return t(lang, 'Account is marked as deleted. Premium features are disabled.')
      default:
        return ''
    }
  }, [entitlements.downgradeCleanupAt, entitlements.exportUntil, entitlements.graceUntil, entitlements.lifecycleStatus, entitlements.status, entitlements.trialEndsAt, formatDate, lang])

  return (
    <Screen>
      <View style={styles.pageStack}>
        <TabTopBar titleKey="Subscription plans" />

        {statusNotice ? (
          <Surface elevated>
            <InlineInfo tone={entitlements.status === 'trial_active' ? 'info' : 'warning'} iconName="alert-circle-outline" message={statusNotice} />
          </Surface>
        ) : null}

        {(['basic', 'pro'] as PlanId[]).map((plan) => {
          const active = entitlements.plan === plan
          const suggested = focusPlan === plan
          return (
            <Surface
              key={plan}
              elevated
              style={[styles.planRow, (active || suggested) && styles.planRowActive]}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
                  <PlanIcon plan={plan} />
                  <Text style={styles.planRowTitle}>{tr(planLabel(plan))}</Text>
                </View>
                {active ? <Badge label="Active" tone="success" /> : null}
              </View>

              <Text style={[styles.planRowItem, { marginTop: themeSpacing.xs }]}>{planPrice(plan)}</Text>

              <View style={{ marginTop: themeSpacing.sm, gap: 6 }}>
                {planFeatures(plan).map((k) => (
                  <View key={k} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: themeSpacing.xs }}>
                    <Ionicons name="checkmark-circle-outline" size={18} color={themeColors.primary} />
                    <Text style={[styles.planRowItem, { flexShrink: 1, color: themeColors.text }]}>{tr(k)}</Text>
                  </View>
                ))}
              </View>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
                <AppButton
                  label={tr('Monthly')}
                  variant="outline"
                  iconName="card-outline"
                  onPress={() => handleSubscribe(plan, 'monthly')}
                  disabled={busy}
                />
                <AppButton
                  label={tr('Yearly')}
                  variant="primary"
                  iconName="card-outline"
                  onPress={() => handleSubscribe(plan, 'yearly')}
                  disabled={busy}
                />
              </View>

              <Text style={[styles.mutedText, { marginTop: themeSpacing.sm }]}>
                {t(lang, 'OCR helps extract data from photos/PDFs. Limits reset monthly.')}
              </Text>
            </Surface>
          )
        })}

        {busy && (
          <Surface elevated>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator />
              <Text style={styles.mutedText}>{t(lang, 'Processing payment…')}</Text>
            </View>
          </Surface>
        )}

        {status ? (
          <Surface elevated>
            <Text style={styles.bodyText}>{status}</Text>
          </Surface>
        ) : null}
      </View>
    </Screen>
  )
}

const Tab = createBottomTabNavigator()
const Stack = createNativeStackNavigator()

function isDefaultProfileName(name: string | null | undefined, n: 1 | 2): boolean {
  const raw = String(name || '').trim()
  if (!raw) return true
  const normalized = raw.replace(/\s+/g, ' ').trim().toLowerCase()
  if (n === 1) return normalized === 'profil 1' || normalized === 'profile 1'
  return normalized === 'profil 2' || normalized === 'profile 2'
}

function ProfileRenameGate() {
  const insets = useSafeAreaInsets()
  const spacesCtx = useSpacesContext()
  const { snapshot: entitlements } = useEntitlements()
  const [targetId, setTargetId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (spacesCtx.loading) return
    const p1 = spacesCtx.spaces.find((s) => s.id === 'personal') || null
    const p2 = spacesCtx.spaces.find((s) => s.id === 'personal2') || null

    const needs1 = !!p1 && isDefaultProfileName(p1.name, 1)
    const needs2 = entitlements.plan === 'pro' && !!p2 && isDefaultProfileName(p2.name, 2)

    const nextTarget = needs1 ? 'personal' : (needs2 ? 'personal2' : null)
    setTargetId((prev) => (prev === nextTarget ? prev : nextTarget))
  }, [entitlements.plan, spacesCtx.loading, spacesCtx.spaces])

  useEffect(() => {
    if (!targetId) return
    setDraft('')
  }, [targetId])

  const save = useCallback(async () => {
    if (!targetId) return
    const trimmed = draft.trim()
    if (!trimmed) {
      Alert.alert(tr('Name required'), targetId === 'personal2' ? tr('Please enter a name for Profil 2.') : tr('Please enter a name for Profil 1.'))
      return
    }
    await spacesCtx.rename(targetId, trimmed)
    try {
      await AsyncStorage.setItem(targetId === 'personal2' ? 'billbox.onboarding.payer2Named' : 'billbox.onboarding.payer1Named', '1')
    } catch {}
    setTargetId(null)
  }, [draft, spacesCtx, targetId])

  if (!targetId) return null

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => { /* required */ }}>
      <View style={[styles.iosPickerOverlay, { justifyContent: 'center', paddingBottom: Math.max(insets.bottom, themeLayout.screenPadding) }]}>
        <Surface elevated style={{ width: '100%', maxWidth: 520, alignSelf: 'center' }}>
          <SectionHeader title={tr('Name required')} />
          <Text style={styles.bodyText}>
            {targetId === 'personal2' ? tr('Please name Profil 2 to continue.') : tr('Please name Profil 1 to continue.')}
          </Text>
          <AppInput
            placeholder={targetId === 'personal2' ? tr('Profil 2 name') : tr('Profil 1 name')}
            value={draft}
            onChangeText={setDraft}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap }}>
            <AppButton label={tr('Save')} iconName="checkmark-outline" onPress={save} />
          </View>
        </Surface>
      </View>
    </Modal>
  )
}

function MainTabs() {
  const insets = useSafeAreaInsets()
  const bottomInset = Math.max(insets.bottom, 0)
  // Ensure icons/labels are never clipped by system navigation bars.
  // Keep a generous minimum padding on Android where insets can be reported as 0.
  const bottomPadding = Math.max(bottomInset, 6)
  const barHeight = 56 + bottomPadding
  const { lang } = useLangContext()

  return (
    <>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: themeColors.primary,
          tabBarInactiveTintColor: '#94A3B8',
          tabBarLabel: route.name === 'Scan'
            ? t(lang, 'Add bill')
            : t(
              lang,
              (
                {
                  Home: 'home',
                  Scan: 'scan',
                  Bills: 'bills',
                  Pay: 'Payments',
                  Settings: 'settings',
                } as any
              )[route.name] || route.name
            ),
          tabBarStyle: {
            borderTopColor: 'transparent',
            borderTopWidth: 0,
            backgroundColor: themeColors.surface,
            paddingTop: 4,
            paddingBottom: bottomPadding,
            height: barHeight,
          },
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: '600',
            marginTop: 0,
            marginBottom: 0,
          },
          tabBarItemStyle: {
            paddingVertical: 4,
          },
          tabBarIconStyle: {
            marginTop: 0,
          },
          tabBarIcon: ({ color, focused }) => {
            const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
              Home: 'home-outline',
              Scan: 'add-circle-outline',
              Bills: 'document-text-outline',
              Pay: 'card-outline',
              Settings: 'menu-outline',
            }

            const iconName = icons[route.name] ?? 'ellipse-outline'
            const iconSize = route.name === 'Scan' ? 26 : 24
            return (
              <Ionicons name={iconName} size={iconSize} color={color} />
            )
          },
        })}
      >
        <Tab.Screen name="Home" component={HomeScreen} />
        <Tab.Screen name="Scan" component={ScanBillScreen} />
        <Tab.Screen name="Bills" component={BillsListScreen} />
        <Tab.Screen name="Pay" component={PayScreen} />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
      <ProfileRenameGate />
    </>
  )
}

function SettingsScreen() {
  const supabase = useMemo(() => getSupabase(), [])
  const navigation = useNavigation<any>()
  const { lang, setLang } = useLangContext()
  const insets = useSafeAreaInsets()
  function changeLang(l: Lang) { setLang(l) }
  const [languageModalVisible, setLanguageModalVisible] = useState(false)
  const [remindersEnabled, setRemindersEnabledState] = useState<boolean>(true)
  useEffect(() => {
    ;(async () => {
      setRemindersEnabledState(await getRemindersEnabled())
    })()
  }, [])
  const spacesCtx = useSpacesContext()
  const { space } = useActiveSpace()
  const { snapshot: entitlements } = useEntitlements()
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameVisible, setRenameVisible] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<null | { id: string; displayName: string; slotLabel: string }>(null)
  const [removeVisible, setRemoveVisible] = useState(false)
  const [creatingPayer2, setCreatingPayer2] = useState(false)
  const [payer2NameDraft, setPayer2NameDraft] = useState('')
  const [inboxLoading, setInboxLoading] = useState(false)
  const [inboxAddress, setInboxAddress] = useState<string | null>(null)
  const [inboxConfigured, setInboxConfigured] = useState(false)
  const [inboxError, setInboxError] = useState<string | null>(null)

  const languageOptions = useMemo(() => {
    const opts: Array<{ code: Lang; key: string }> = [
      { code: 'de', key: 'german' },
      { code: 'en', key: 'english' },
      { code: 'hr', key: 'croatian' },
      { code: 'it', key: 'italian' },
      { code: 'sl', key: 'slovenian' },
    ]
    return opts
      .map((o) => ({ ...o, label: t(lang, o.key) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [lang])

  // Rendered as compact chips below; keep calculation removed to avoid awkward spacing.

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
  const loadInboxAlias = useCallback(async () => {
    if (!supabase || !space) return
    try {
      setInboxLoading(true)
      setInboxError(null)
      const base = getFunctionsBase()
      if (!base) {
        setInboxConfigured(false)
        setInboxAddress(null)
        return
      }
      const { data } = await supabase.auth.getSession()
      const token = data?.session?.access_token
      if (!token) return

      const resp = await fetch(`${base}/.netlify/functions/inbox-alias?spaceId=${encodeURIComponent(space.id)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await resp.json().catch(() => null as any)
      if (!resp.ok || !json?.ok) {
        setInboxConfigured(false)
        setInboxAddress(null)
        setInboxError(tr('Inbox address not configured.'))
        return
      }
      const addr = typeof json.address === 'string' ? json.address : null
      setInboxAddress(addr)
      setInboxConfigured(Boolean(json.configured && addr))
    } catch {
      setInboxError(tr('Inbox address not configured.'))
      setInboxConfigured(false)
      setInboxAddress(null)
    } finally {
      setInboxLoading(false)
    }
  }, [space, supabase])

  useEffect(() => {
    loadInboxAlias()
  }, [loadInboxAlias])

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
          <SectionHeader title={tr('Profiles')} />

          {(() => {
            const p1 = spacesCtx.spaces.find((s) => s.id === 'personal') || null
            const p2 = spacesCtx.spaces.find((s) => s.id === 'personal2') || null
            const p1Active = spacesCtx.current?.id === 'personal'
            const p2Active = spacesCtx.current?.id === 'personal2'
            const p1Slot = payerLabelFromSpaceId('personal')
            const p2Slot = payerLabelFromSpaceId('personal2')
            const p2Locked = entitlements.plan !== 'pro'

            if (!p1) return null

            return (
              <View style={{ borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 6, padding: themeSpacing.xs }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeSpacing.sm }}>
                  <Text style={{ fontWeight: '600' }}>{p1Slot}</Text>
                  {p1Active ? <Badge label={tr('Active')} tone="success" /> : null}
                </View>
                <Pressable
                  onPress={() => {
                    if (p1Active) return
                    spacesCtx.setCurrent(p1.id)
                  }}
                  style={({ pressed }) => [
                    { marginTop: 2, opacity: pressed && !p1Active ? 0.85 : 1 },
                  ]}
                  hitSlop={8}
                >
                  <Text style={[styles.bodyText, { fontWeight: '800' }]}>{p1.name || '—'}</Text>
                </Pressable>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                  <AppButton
                    label={tr('Rename')}
                    variant="secondary"
                    iconName="create-outline"
                    onPress={() => {
                      setRenameTarget(p1.id)
                      setRenameDraft(p1.name || '')
                      setRenameVisible(true)
                    }}
                  />
                </View>

                <View style={{ marginTop: themeSpacing.sm, paddingTop: themeSpacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: themeColors.border }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeSpacing.sm }}>
                    <Text style={{ fontWeight: '600' }}>{p2Slot}</Text>
                    {p2Active ? <Badge label={tr('Active')} tone="success" /> : null}
                  </View>

                  {!p2 ? (
                    <View style={{ marginTop: 4 }}>
                      <Text style={styles.mutedText}>{p2Locked ? tr('Locked (Več only)') : tr('Not created yet')}</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                        {p2Locked ? (
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
                  ) : (
                    <View style={{ marginTop: 4 }}>
                      <Pressable
                        onPress={() => {
                          if (p2Active) return
                          spacesCtx.setCurrent(p2.id)
                        }}
                        style={({ pressed }) => [
                          { opacity: pressed && !p2Active ? 0.85 : 1 },
                        ]}
                        hitSlop={8}
                      >
                        <Text style={[styles.bodyText, { fontWeight: '800' }]}>{p2.name || '—'}</Text>
                      </Pressable>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                        <AppButton
                          label={tr('Rename')}
                          variant="secondary"
                          iconName="create-outline"
                          onPress={() => {
                            setRenameTarget(p2.id)
                            setRenameDraft(p2.name || '')
                            setRenameVisible(true)
                          }}
                        />
                        <AppButton
                          label={tr('Remove')}
                          variant="ghost"
                          iconName="trash-outline"
                          onPress={() => {
                            setRemoveTarget({ id: p2.id, displayName: p2.name || p2Slot, slotLabel: p2Slot })
                            setRemoveVisible(true)
                          }}
                        />
                      </View>
                    </View>
                  )}
                </View>
              </View>
            )
          })()}
        </Surface>

        <Pressable
          onPress={() => {
            if (IS_EXPO_GO) {
              Alert.alert(tr('Subscription'), tr('Purchases are disabled in Expo Go preview. Use a store/dev build to manage plans.'))
              return
            }
            navigation.navigate('Payments')
          }}
          style={({ pressed }) => pressed ? { opacity: 0.96 } : null}
        >
          <Surface elevated>
            <SectionHeader title={tr('Subscription')} />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
              <Text style={styles.bodyText}>{tr('Active')}: {tr(planLabel(entitlements.plan))}</Text>
              <Badge label={tr(planLabel(entitlements.plan))} tone="success" />
            </View>
            {entitlements.plan !== 'pro' ? (
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
            ) : null}
          </Surface>
        </Pressable>

        <Pressable onPress={() => navigation.navigate('Inbox')} style={({ pressed }) => pressed ? { opacity: 0.96 } : null}>
          <Surface elevated>
            <SectionHeader title={tr('Email inbox')} />
            {inboxLoading ? (
              <Text style={styles.mutedText}>{tr('Loading inbox…')}</Text>
            ) : inboxConfigured && inboxAddress ? (
              <View style={{ gap: themeSpacing.xs }}>
                <Text style={styles.bodyText}>{tr('Your BillBox inbox')}</Text>
                <Text style={styles.mutedText}>{inboxAddress}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
                  <AppButton
                    label={tr('Copy address')}
                    variant="secondary"
                    iconName="copy-outline"
                    onPress={async () => {
                      if (!inboxAddress) return
                      try {
                        await Clipboard.setStringAsync(inboxAddress)
                        Alert.alert(tr('Copied'))
                      } catch {
                        Alert.alert(tr('Error'), tr('Could not copy.'))
                      }
                    }}
                  />
                </View>
              </View>
            ) : (
              <Text style={styles.mutedText}>{inboxError || tr('Inbox address not configured.')}</Text>
            )}
          </Surface>
        </Pressable>

        <Surface elevated>
          <SectionHeader title={tr('Language')} />
          <Pressable
            onPress={() => setLanguageModalVisible(true)}
            style={[
              styles.dateButton,
              { marginTop: themeSpacing.xs, justifyContent: 'space-between' },
            ]}
            hitSlop={8}
          >
            <Text style={[styles.dateButtonText, { fontWeight: '800' }]}>
              {(languageOptions.find((o) => o.code === lang)?.label) || String(lang)}
            </Text>
            <Ionicons name="chevron-down" size={16} color={themeColors.textMuted} />
          </Pressable>
        </Surface>

        <Modal
          visible={languageModalVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setLanguageModalVisible(false)}
        >
          <View style={[styles.iosPickerOverlay, { paddingBottom: Math.max(insets.bottom, themeLayout.screenPadding) }]}>
            <Surface elevated style={styles.iosPickerSheet}>
              <SectionHeader title={tr('Language')} />
              <Text style={styles.bodyText}>{tr('Choose language')}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm }}>
                {languageOptions.map((o) => (
                  <AppButton
                    key={o.code}
                    label={o.label + (lang === o.code ? ' ✓' : '')}
                    variant={lang === o.code ? 'primary' : 'secondary'}
                    labelStyle={{ fontWeight: lang === o.code ? '900' : '700' }}
                    onPress={() => {
                      changeLang(o.code)
                      setLanguageModalVisible(false)
                    }}
                  />
                ))}
              </View>
              <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
                <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setLanguageModalVisible(false)} />
              </View>
            </Surface>
          </View>
        </Modal>

        <Surface elevated>
          <SectionHeader title={tr('Reminders & notifications')} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.xs }}>
            <AppButton
              label={remindersEnabled ? tr('Cancel reminders') : tr('Enable reminders')}
              variant="outline"
              iconName="notifications-outline"
              style={
                remindersEnabled
                  ? { backgroundColor: '#DCFCE7', borderColor: '#86EFAC' }
                  : { backgroundColor: '#E5E7EB', borderColor: '#CBD5E1' }
              }
              onPress={async ()=>{
                if (remindersEnabled) {
                  await setRemindersEnabled(false)
                  await cancelAllReminders()
                  try { await Notifications.setBadgeCountAsync(0) } catch {}
                  setRemindersEnabledState(false)
                  return
                }

                await ensureNotificationConfig()
                const ok = await requestPermissionIfNeeded()
                if (!ok) {
                  try { await Linking.openSettings() } catch {}
                  return
                }
                await setRemindersEnabled(true)
                setRemindersEnabledState(true)
              }}
            />
          </View>
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Legal')} />
          <AppButton
            label={tr('Open legal pages')}
            variant="secondary"
            iconName="document-text-outline"
            onPress={() => Linking.openURL(`${PUBLIC_SITE_URL}/legal`)}
          />
        </Surface>

        <Surface elevated>
          <SectionHeader title={tr('Diagnostics')} />
          <Text style={styles.bodyText}>{tr('App version:')} {diagnostics.appVersion}</Text>
          <Text style={styles.bodyText}>{tr('Website:')} {diagnostics.website}</Text>
          <Text style={styles.bodyText}>{tr('Info email:')} {diagnostics.infoEmail}</Text>
        </Surface>

        <Modal visible={removeVisible} transparent animationType="fade" onRequestClose={() => setRemoveVisible(false)}>
          <View style={[styles.iosPickerOverlay, { paddingBottom: Math.max(insets.bottom, themeLayout.screenPadding) }]}>
            <Surface elevated style={styles.iosPickerSheet}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons name="warning-outline" size={20} color="#c53030" />
                <Text style={styles.screenHeaderTitle}>{tr('Remove')}</Text>
              </View>
              <View style={{ marginTop: themeSpacing.sm }}>
                <InlineInfo
                  tone="danger"
                  iconName="alert-circle-outline"
                  message={tr('This will delete all bills, warranties, reminders, and attachments for {displayName}.\n\nThis cannot be undone.', { displayName: removeTarget?.displayName || '' })}
                />
              </View>
              <View style={{ flexDirection: 'row', gap: themeLayout.gap, marginTop: themeSpacing.md }}>
                <AppButton label={tr('Cancel')} variant="ghost" onPress={() => setRemoveVisible(false)} />
                <AppButton
                  label={tr('Remove')}
                  iconName="trash-outline"
                  variant="secondary"
                  style={{ backgroundColor: '#FEE2E2', borderColor: '#FCA5A5' }}
                  labelStyle={{ color: '#991B1B' }}
                  onPress={async () => {
                    const target = removeTarget
                    setRemoveVisible(false)
                    setRemoveTarget(null)
                    if (!target) return
                    try {
                      await spacesCtx.remove(target.id)
                    } catch {
                      Alert.alert(tr('Error'), tr('Unable to save.'))
                    }
                  }}
                />
              </View>
            </Surface>
          </View>
        </Modal>

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
              <SectionHeader title={tr('Create Profil 2')} />
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
            Alert.alert(tr('Choose profile'), tr('Import this file into which profile?'), buttons)
          })
          if (!targetSpaceId) return
        }

        const fileInfoLog = {
          originalUri: targetUri,
          mimeType,
          fileName,
          platform: Platform.OS,
        }
        console.log('[Import] share/open-with', fileInfoLog)
        const cached = await ensureLocalReadableFile(targetUri, fileName, mimeType, { allowBase64Fallback: true })
        console.log('[Import] share cached', { cachedUri: cached.uri, size: cached.size })

        const item = await addToInbox({ spaceId: targetSpaceId, uri: cached.uri, name: fileName, mimeType })
        await scheduleInboxReviewReminder(item.id, item.name, targetSpaceId)

        // Več: attempt OCR automatically for better "email/attachment import" flow.
        if (entitlements.plan === 'pro' && entitlements.canUseOCR) {
          try {
            const sourceUri = (item as any).localPath || item.uri
            const { fields, summary } = await performOCR(sourceUri, { preferQr: false })
            const looksLikeBill = !!(fields && typeof fields.amount === 'number' && (fields.iban || fields.reference || fields.creditor_name || fields.supplier || (fields as any).invoice_number))
            await updateInboxItem(targetSpaceId, item.id, { extractedFields: fields, notes: summary, status: looksLikeBill ? 'pending' : 'new' })
            if (looksLikeBill) await cancelInboxReviewReminder(item.id, targetSpaceId)
          } catch {
            // Keep reminder; user can open Inbox and run OCR manually.
          }
        }

        Alert.alert(tr('Inbox'), tr('{name} added to Inbox.', { name: item.name })) 
        setTimeout(() => {
          navRef.current?.navigate('Inbox', { highlight: item.id })
        }, 250)
      } catch (e: any) {
        console.warn('[Import] share failed', { message: e?.message, stack: e?.stack, platform: Platform.OS })
        const msg = isDebugBuild() ? (e?.message || String(e)) : tr('Could not import this file.')
        Alert.alert(tr('Import failed'), msg)
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
              <Stack.Screen name="Warranties" component={WarrantiesScreenWithBoundary} options={{ headerShown: coerceBool(false) }} />
              <Stack.Screen name="Reports" component={ReportsScreen} options={{ headerShown: coerceBool(false) }} />
              <Stack.Screen name="Exports" component={ExportsRedirectScreen} options={{ headerShown: coerceBool(false) }} />
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
        { identifier: 'SNOOZE_1', buttonTitle: tr('Send in 1 day'), options: { isDestructive: false, isAuthenticationRequired: false } },
        { identifier: 'SNOOZE_3', buttonTitle: tr('Send in 3 days'), options: { isDestructive: false, isAuthenticationRequired: false } },
        { identifier: 'SNOOZE_7', buttonTitle: tr('Send in 7 days'), options: { isDestructive: false, isAuthenticationRequired: false } },
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
    payUrgencyTabsRow: {
      flexDirection: 'row',
      gap: themeSpacing.xs,
      paddingHorizontal: themeSpacing.sm,
      paddingTop: themeSpacing.sm,
      paddingBottom: themeSpacing.xs,
    },
    payUrgencyTab: {
      flex: 1,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 10,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#E5E7EB',
      backgroundColor: '#F9FAFB',
    },
    // Active styles only change color (no layout/behavior changes).
    payUrgencyTabActiveToday: {
      backgroundColor: '#EF4444',
      borderColor: '#B91C1C',
    },
    payUrgencyTabActiveWeek: {
      backgroundColor: '#F97316',
      borderColor: '#EA580C',
    },
    payUrgencyTabActiveMonth: {
      backgroundColor: '#F59E0B',
      borderColor: '#D97706',
    },
    payUrgencyTabPressed: {
      opacity: 0.92,
    },
    payUrgencyTabText: {
      fontSize: 12,
      fontWeight: '700',
      color: '#1F2937',
    },
    payUrgencyTabTextActive: {
      color: '#FFFFFF',
    },
    payUrgencySummaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: themeSpacing.sm,
      paddingBottom: themeSpacing.sm,
    },
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
  tabTopBarLogo: { width: 24, height: 24, marginRight: themeSpacing.xs },
  tabTopBarTitle: { fontSize: 18, fontWeight: '700', color: themeColors.primary, flexShrink: 1 },
  tabTopBarBackButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: themeColors.primarySoft,
    backgroundColor: themeColors.surface,
  },

  fieldLabel: { fontSize: 12, fontWeight: '700', color: themeColors.textMuted },
  requiredStar: { color: '#DC2626', fontWeight: '900' },

  screenHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: themeSpacing.sm, gap: themeLayout.gap },
  screenHeaderText: { flexShrink: 1, gap: 2 },
  screenHeaderTitle: { fontSize: 18, fontWeight: '700', color: themeColors.text },
  screenHeaderSubtitle: { fontSize: 12, color: themeColors.textMuted },
  screenHeaderTrailing: { marginLeft: 'auto' },
  primaryBtn: { backgroundColor: themeColors.primary, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '600' },
  secondaryBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: themeColors.primarySoft },
  secondaryBtnActive: { backgroundColor: themeColors.primary },
  secondaryBtnText: { color: themeColors.primary, fontWeight: '600' },
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
  inboxHeroIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: themeColors.primarySoft, alignItems: 'center', justifyContent: 'center' },
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
  filtersFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap },
  listMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: themeLayout.gap },
  listMetaText: { fontSize: 13, fontWeight: '600', color: '#111827' },
  listMetaSecondary: { fontSize: 12, color: '#6B7280' },
  listWrapper: { flex: 1 },
  emptyListContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: themeSpacing.lg, paddingBottom: themeSpacing.xxl + themeSpacing.xl },
  emptyStateWrapper: { marginTop: themeSpacing.lg },
  billsPrimaryActionsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: themeLayout.gap },
  billCard: { marginBottom: themeSpacing.sm, borderRadius: 12, padding: themeLayout.cardPadding, backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border },
  billCardUnpaid: { borderColor: themeColors.primarySoft },
  billCardPaid: { borderColor: 'rgba(34, 197, 94, 0.5)' },
  billCardOverdue: { borderColor: 'rgba(217, 119, 6, 0.65)' },
  billHighlighted: { borderColor: themeColors.primary, borderWidth: 2 },
  billCardPressable: { flex: 1, gap: themeSpacing.sm },
  billCardPressed: { opacity: 0.86 },
  billHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: themeLayout.gap },
  billSupplier: { fontSize: 16, fontWeight: '700', color: '#111827', flex: 1 },
  billAmount: { fontSize: 16, fontWeight: '800', color: themeColors.primary },
  billMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: themeSpacing.sm },
  billMetaGroup: { flexDirection: 'row', alignItems: 'center', gap: themeSpacing.xs },
  billMetaText: { fontSize: 13, color: '#374151' },
  billMetaSecondary: { fontSize: 12, color: '#6B7280' },
  warrantyMetaText: { fontSize: 12, color: '#4B5563' },
  attachmentPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: themeColors.primarySoft },
  attachmentText: { fontSize: 12, color: themeColors.primary },
  fab: { position: 'absolute', right: themeSpacing.xl, bottom: isIOS ? themeSpacing.xl : themeSpacing.xxl + themeSpacing.lg },
  iosPickerOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(15, 23, 42, 0.35)', justifyContent: 'flex-end', padding: themeLayout.screenPadding },
  iosPickerSheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: themeSpacing.lg, gap: themeSpacing.md },
  iosPickerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap },
  exportPickerSheet: { width: '100%', maxWidth: 520, alignSelf: 'center', maxHeight: '90%', padding: themeSpacing.lg },
  exportPickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: themeLayout.gap },
  exportPickerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm },
  exportPickerList: { marginTop: themeSpacing.sm, maxHeight: 320 },
  exportPickerRow: { flexDirection: 'row', alignItems: 'center', gap: themeSpacing.sm, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border, backgroundColor: '#FFFFFF', marginBottom: themeSpacing.xs },
  exportPickerRowSelected: { borderColor: themeColors.primarySoft, backgroundColor: '#F0F7FF' },
  exportPickerRowBody: { flex: 1 },
  exportPickerRowTitle: { fontSize: 14, fontWeight: '700', color: '#111827' },
  exportPickerRowMeta: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  toastWrap: { position: 'absolute', left: themeLayout.screenPadding, right: themeLayout.screenPadding, bottom: themeSpacing.xl, zIndex: 999 },
  toastCard: { flexDirection: 'row', alignItems: 'center', gap: themeSpacing.sm, padding: themeSpacing.sm, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  toastSuccess: { backgroundColor: '#ECFDF5', borderColor: '#BBF7D0' },
  toastInfo: { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' },
  toastDanger: { backgroundColor: '#FEF2F2', borderColor: '#FECACA' },
  toastText: { fontSize: 13, fontWeight: '700' },
  toastTextSuccess: { color: '#166534' },
  toastTextInfo: { color: '#1D4ED8' },
  toastTextDanger: { color: '#991B1B' },
  billRowCard: { marginBottom: themeSpacing.sm },
  billRowHighlighted: { borderWidth: 1, borderColor: '#22C55E' },
  billRowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: themeLayout.gap, flexWrap: 'wrap' },
  billActionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: themeSpacing.xs, marginTop: themeSpacing.xs },
  payAdjustRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  payDueRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  payBillMeta: { fontSize: 13, color: '#374151' },
  payDueText: { fontWeight: '700', color: '#DC2626' },
  payDueOverdue: { fontWeight: '700', color: '#B91C1C' },
  payAmountWrap: { alignItems: 'flex-end', gap: 2 },
  payAmountText: { fontSize: 15, fontWeight: '800', color: themeColors.primary },
  payAmountCaption: { fontSize: 11, color: '#6B7280' },
  payQrThumbWrap: { width: 44, height: 44, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border },
  payQrThumb: { width: 44, height: 44 },
  payQrThumbPlaceholder: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  payCopyMiniRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  payCopyMiniBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: '#F1F5F9', borderWidth: StyleSheet.hairlineWidth, borderColor: '#E2E8F0' },
  payCopyMiniText: { fontSize: 12, fontWeight: '700', color: '#334155' },
  qrModalCard: { width: '100%', maxWidth: 420, alignSelf: 'center', padding: themeSpacing.lg, gap: themeSpacing.sm },
  qrImage: { width: 240, height: 240, alignSelf: 'center', borderRadius: 12, backgroundColor: '#FFFFFF' },
  reportStatLabel: { fontSize: 13, color: '#4B5563' },
  reportStatValue: { fontSize: 15, fontWeight: '700', color: themeColors.text },
  reportViewToggleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm },
  reportTableHeaderRow: { flexDirection: 'row', alignItems: 'center', paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: themeColors.border },
  reportTableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: themeColors.border },
  reportChartCard: { padding: themeSpacing.sm, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border, backgroundColor: '#FFFFFF' },
  reportChartTitle: { fontSize: 12, fontWeight: '700', color: '#334155', marginBottom: themeSpacing.sm },
  reportLegendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: themeSpacing.sm, marginBottom: themeSpacing.sm },
  reportLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reportLegendSwatch: { width: 10, height: 10, borderRadius: 5 },
  reportLegendLabel: { fontSize: 11, color: '#475569' },
  reportBarsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: themeSpacing.xs },
  reportBarItem: { flex: 1, alignItems: 'center', gap: 6 },
  reportBarTrack: { width: '100%', height: 140, borderRadius: 8, backgroundColor: '#F1F5F9', overflow: 'hidden', justifyContent: 'flex-end' },
  reportBarFill: { width: '100%', backgroundColor: themeColors.primary, borderRadius: 8 },
  reportBarLabel: { fontSize: 11, color: '#64748B' },
  reportChartFrame: { borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border, borderRadius: 12, padding: 10, backgroundColor: '#FFFFFF' },
  reportAxisRow: { flexDirection: 'row', alignItems: 'flex-end', gap: themeSpacing.sm },
  reportYAxis: { width: 42, alignItems: 'flex-end', justifyContent: 'space-between', height: 140 },
  reportYAxisLabel: { fontSize: 10, color: '#64748B' },
  reportXAxis: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#CBD5F5', marginTop: 6 },
  reportGridLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: '#E2E8F0' },
  reportLineChart: { height: 160, borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border, borderRadius: 12, backgroundColor: '#FFFFFF' },
  reportLineSegment: { position: 'absolute', height: 2, backgroundColor: themeColors.primary, borderRadius: 2 },
  reportLineDot: { position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: themeColors.primary },
  reportLineChart: { height: 160, borderRadius: 12, backgroundColor: '#F8FAFC', borderWidth: StyleSheet.hairlineWidth, borderColor: '#E2E8F0' },
  reportLineSegment: { position: 'absolute', height: 2, backgroundColor: '#1D4ED8' },
  reportLineDot: { position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: '#1D4ED8' },
  reportTableRowCard: { padding: themeSpacing.sm, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border, backgroundColor: '#FFFFFF' },
  reportRowTitle: { fontSize: 13, fontWeight: '700', color: '#111827' },
  reportRowBarTrack: { height: 8, borderRadius: 999, backgroundColor: '#E5E7EB', overflow: 'hidden', marginTop: 8 },
  reportRowBarFill: { height: '100%', backgroundColor: themeColors.primary },
  reportRowValue: { marginTop: 6, fontSize: 12, color: '#475569', textAlign: 'right' },

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
  addBillActionButton: { minHeight: 52, paddingHorizontal: 18 },
  formCard: { gap: themeSpacing.sm },
  formIntro: { fontSize: 13, color: themeColors.textMuted },
  formNotice: { alignSelf: 'stretch' },
  formSection: { gap: themeSpacing.sm },
  formSectionTitle: { fontSize: 13, fontWeight: '600', color: themeColors.textMuted, textTransform: 'uppercase' },
  formStack: { gap: themeSpacing.sm },
  formRow: { flexDirection: 'row', gap: themeLayout.gap },
  flex1: { flex: 1 },
  currencyInput: { width: 96 },
  inputError: { borderColor: themeColors.danger },
  fieldErrorText: { fontSize: 11, color: themeColors.danger },
  datePickerContainer: { marginTop: themeSpacing.sm, gap: themeLayout.gap },
  datePickerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: themeLayout.gap },
  formDivider: { marginVertical: themeSpacing.sm },
  attachmentButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap },
  saveButton: { marginTop: themeSpacing.md },
  supplierSuggestList: {
    position: 'absolute',
    top: 46,
    left: 0,
    right: 0,
    zIndex: 20,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: themeColors.border,
    borderRadius: 12,
    overflow: 'hidden',
  },
  supplierSuggestItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: themeColors.border,
  },
  supplierSuggestText: { fontSize: 13, color: themeColors.text, fontWeight: '600' },
  attachmentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: themeLayout.gap, marginTop: themeSpacing.sm },
  attachmentCard: { padding: 0 },
  attachmentCardContent: { padding: themeLayout.cardPadding, paddingBottom: themeSpacing.xs },
  attachmentFileName: { marginTop: themeSpacing.xs, fontSize: 14, fontWeight: '700', color: '#111827' },
  attachmentPreview: { marginTop: themeSpacing.sm, gap: themeLayout.gap },
  attachmentImage: { width: 160, height: 120, borderRadius: 12 },
  attachmentPreviewCompact: { gap: themeSpacing.xs },
  attachmentImageSmall: { width: 96, height: 72, borderRadius: 8 },
  codeBlock: { marginTop: themeSpacing.xs, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 12, color: '#374151' },
  debugOverlay: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    padding: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(15, 23, 42, 0.88)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    zIndex: 50,
  },
  debugTitle: { fontSize: 11, fontWeight: '700', color: '#FFFFFF', marginBottom: 4 },
  debugLine: { fontSize: 10, color: '#E5E7EB' },

  // Home tiles
  gridWrap: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  statCardPressable: { width: '48%', height: 112, marginBottom: themeSpacing.md },
  statCardPressed: { opacity: 0.9 },
  homeSummaryCard: { padding: themeSpacing.sm },
  homeHeroCard: { padding: themeSpacing.md, backgroundColor: themeColors.primarySoft, borderColor: '#BFDBFE' },
  homeHeroHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: themeLayout.gap },
  homeHeroTitle: { fontSize: 22, fontWeight: '800', color: themeColors.primary },
  homeHeroSubtitle: { fontSize: 12, color: themeColors.textMuted },
  homeMetricsRow: { marginTop: themeSpacing.md, flexDirection: 'row', gap: themeSpacing.sm },
  homeMetricCard: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border, borderRadius: 12, paddingVertical: themeSpacing.sm, paddingHorizontal: themeSpacing.sm, backgroundColor: '#FFFFFF' },
  homeMetricCardUnpaid: { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' },
  homeMetricCardOverdue: { backgroundColor: '#FEF2F2', borderColor: '#FECACA' },
  homeMetricCardNext: { backgroundColor: '#ECFDF5', borderColor: '#BBF7D0' },
  homeMetricValue: { fontSize: 16, fontWeight: '800', color: themeColors.text },
  homeMetricSubValue: { marginTop: 2, fontSize: 11, color: '#475569', fontWeight: '600' },
  homeMetricLabel: { marginTop: 4, fontSize: 11, color: themeColors.textMuted },
  statCard: {
    paddingVertical: themeSpacing.xs,
    paddingHorizontal: themeSpacing.sm,
    gap: themeSpacing.xs,
    flex: 1,
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: themeColors.border,
  },
  statCardPrimary: { borderWidth: 1, borderColor: themeColors.primary },
  homePrimaryTile: { borderWidth: 1, borderColor: themeColors.border, backgroundColor: '#FFFFFF' },
  homePrimaryTileScan: { backgroundColor: themeColors.primary, borderColor: themeColors.primary },
  homePrimaryTileBills: { backgroundColor: '#FFFFFF', borderColor: themeColors.border },
  homePrimaryTilePay: { backgroundColor: '#FFFFFF', borderColor: themeColors.border },
  statIconWrap: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: themeColors.border, alignItems: 'center', justifyContent: 'center' },
  statIconWrapPrimary: { backgroundColor: 'rgba(255, 255, 255, 0.18)', borderColor: 'rgba(255, 255, 255, 0.5)' },
  statLabel: { fontSize: 13, fontWeight: '700', color: themeColors.text },
  statLabelPrimary: { color: '#FFFFFF' },
  statValue: { fontSize: 11, color: themeColors.textMuted },
  statValuePrimary: { color: 'rgba(255, 255, 255, 0.9)' },

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
