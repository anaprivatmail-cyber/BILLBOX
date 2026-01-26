import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

import { getCurrentLang, t } from './i18n'
import { PUBLIC_SITE_URL } from './env'

export type PlanId = 'free' | 'basic' | 'pro'

export type SubscriptionStatus =
  | 'trial_active'
  | 'trial_expired'
  | 'active_basic'
  | 'active_pro'
  | 'active_moje'
  | 'active_vec'
  | 'downgrade_vec_to_moje'
  | 'cancelled_all'
  | 'payment_failed'
  | 'subscription_cancelled'
  | 'grace_period'
  | 'export_only'
  | 'deleted'
  | 'active'
  | 'free'

export type LifecycleStatus =
  | 'active_vec'
  | 'active_moje'
  | 'downgrade_vec_to_moje'
  | 'cancelled_all'
  | 'grace_period'
  | 'export_only'
  | 'deleted'

export type UpgradeReason =
  | 'reports'
  | 'ocr'
  | 'export'
  | 'space_limit'
  | 'business_space'
  | 'bills_limit'
  | 'email_import'
  | 'profile2'
  | 'installments'

export type EntitlementsSnapshot = {
  plan: PlanId
  rawPlan: PlanId
  status: SubscriptionStatus
  lifecycleStatus: LifecycleStatus
  trialEndsAt: string | null
  graceUntil: string | null
  exportUntil: string | null
  deleteAt: string | null
  downgradeCleanupAt: string | null
  exportOnly: boolean
  payerLimit: number
  canUseOCR: boolean
  exportsEnabled: boolean
  // UUID scope(s) for remote storage.
  // Must never be the local labels like "personal" / "personal2".
  spaceId: string | null
  spaceId2: string | null
}

type EntitlementsContextValue = {
  snapshot: EntitlementsSnapshot
  refresh: () => Promise<void>
  setPlan: (plan: PlanId) => Promise<void>
  setNavigation: (nav: { navigate: (route: string, params?: any) => void } | null) => void
}

const LS_PLAN = 'billbox.entitlements.plan'
const LS_SNAPSHOT = 'billbox.entitlements.snapshot'

const DEFAULT: EntitlementsSnapshot = {
  plan: 'free',
  rawPlan: 'free',
  status: 'free',
  lifecycleStatus: 'active_moje',
  trialEndsAt: null,
  graceUntil: null,
  exportUntil: null,
  deleteAt: null,
  downgradeCleanupAt: null,
  exportOnly: false,
  payerLimit: 1,
  canUseOCR: true, // app separately limits OCR usage if desired
  exportsEnabled: false,
  spaceId: null,
  spaceId2: null,
}

function resolveLifecycleStatus(plan: PlanId, status: SubscriptionStatus): LifecycleStatus {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'export_only') return 'export_only'
  if (normalized === 'grace_period') return 'grace_period'
  if (normalized === 'deleted') return 'deleted'
  if (normalized === 'downgrade_vec_to_moje') return 'downgrade_vec_to_moje'
  if (normalized === 'cancelled_all') return 'cancelled_all'
  if (normalized === 'active_vec') return 'active_vec'
  if (normalized === 'active_moje') return 'active_moje'
  return plan === 'pro' ? 'active_vec' : 'active_moje'
}

const Ctx = React.createContext<EntitlementsContextValue | undefined>(undefined)

function snapshotForPlan(plan: PlanId): EntitlementsSnapshot {
  if (plan === 'pro') {
    return { ...DEFAULT, plan, rawPlan: plan, status: 'active_pro', lifecycleStatus: 'active_vec', payerLimit: 2, canUseOCR: true, exportsEnabled: true, spaceId: null, spaceId2: null }
  }
  if (plan === 'basic') {
    return { ...DEFAULT, plan, rawPlan: plan, status: 'active_basic', lifecycleStatus: 'active_moje', payerLimit: 1, canUseOCR: true, exportsEnabled: false, spaceId: null, spaceId2: null }
  }
  return { ...DEFAULT, plan: 'free', rawPlan: 'free', status: 'free' }
}

let navigationRef: { navigate: (route: string, params?: any) => void } | null = null

type UpgradePromptPayload = {
  reason: UpgradeReason
  targetPlan: PlanId
}

let upgradePromptRef: ((payload: UpgradePromptPayload) => void) | null = null

export function setUpgradeNavigation(nav: { navigate: (route: string, params?: any) => void } | null) {
  navigationRef = nav
}

export function setUpgradePrompt(fn: ((payload: UpgradePromptPayload) => void) | null) {
  upgradePromptRef = fn
}

export function showUpgradeAlert(reason: UpgradeReason) {
  const targetPlan: PlanId =
    reason === 'reports' ||
    reason === 'export' ||
    reason === 'space_limit' ||
    reason === 'business_space' ||
    reason === 'email_import' ||
    reason === 'profile2' ||
    reason === 'installments'
      ? 'pro'
      : 'basic'

  if (upgradePromptRef) {
    try {
      upgradePromptRef({ reason, targetPlan })
      return
    } catch {
      // Fall through to native alert.
    }
  }

  const lang = getCurrentLang()
  const message = t(lang, 'upgrade_required_message')

  Alert.alert(t(lang, 'Upgrade required'), message, [
    { text: t(lang, 'Not now'), style: 'cancel' },
    {
      text: t(lang, 'Upgrade'),
      onPress: () => {
        try {
          navigationRef?.navigate('Payments', { focusPlan: targetPlan, reason })
        } catch {}
      },
    },
  ])
}

export function useEntitlements(): { snapshot: EntitlementsSnapshot; refresh: () => Promise<void> } {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error('EntitlementsProvider missing')
  return { snapshot: ctx.snapshot, refresh: ctx.refresh }
}

export function EntitlementsProvider({
  children,
  supabase,
}: {
  children: React.ReactNode
  supabase: any
}) {
  const [snapshot, setSnapshot] = useState<EntitlementsSnapshot>(DEFAULT)

  const resolveFunctionsBase = useCallback((): string | null => {
    const raw = (process.env.EXPO_PUBLIC_FUNCTIONS_BASE as string | undefined) || PUBLIC_SITE_URL
    const base = typeof raw === 'string' ? raw.trim() : ''
    return base ? base.replace(/\/$/, '') : null
  }, [])

  const loadFromBackend = useCallback(async (): Promise<EntitlementsSnapshot | null> => {
    const base = resolveFunctionsBase()
    const s = supabase
    if (!base || !s) return null
    try {
      const sess = await s.auth.getSession()
      const token = sess?.data?.session?.access_token
      if (!token) return null

      const resp = await fetch(`${base}/.netlify/functions/entitlements`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await resp.json().catch(() => null)
      if (!resp.ok || !data?.ok || !data?.entitlements) return null

      const e = data.entitlements
      const rawPlan = (String(e.rawPlan || e.plan || 'free').trim() as PlanId)
      const plan = (String(e.plan || 'free').trim() as PlanId)
      const normalizedPlan: PlanId = plan === 'basic' || plan === 'pro' || plan === 'free' ? plan : 'free'
      const normalizedRaw: PlanId = rawPlan === 'basic' || rawPlan === 'pro' || rawPlan === 'free' ? rawPlan : 'free'
      const status = String(e.status || 'active').trim().toLowerCase() as SubscriptionStatus
      const payerLimit = typeof e.payerLimit === 'number' ? e.payerLimit : normalizedPlan === 'pro' ? 2 : 1
      const exportsEnabled = Boolean(e.exportsEnabled)
      const canUseOCR = typeof e.canUseOcr === 'boolean' ? e.canUseOcr : true
      const spaceId = typeof e.spaceId === 'string' ? e.spaceId.trim() : ''
      const spaceId2 = typeof e.spaceId2 === 'string' ? e.spaceId2.trim() : ''
      const trialEndsAt = typeof e.trialEndsAt === 'string' ? e.trialEndsAt : (typeof e.trial_ends_at === 'string' ? e.trial_ends_at : null)
      const graceUntil = typeof e.graceUntil === 'string' ? e.graceUntil : (typeof e.grace_until === 'string' ? e.grace_until : null)
      const exportOnly = Boolean(e.exportOnly)
      const exportUntil = typeof e.exportUntil === 'string' ? e.exportUntil : (typeof e.export_until === 'string' ? e.export_until : null)
      const deleteAt = typeof e.deleteAt === 'string' ? e.deleteAt : (typeof e.delete_at === 'string' ? e.delete_at : null)
      const downgradeCleanupAt = typeof e.downgradeCleanupAt === 'string' ? e.downgradeCleanupAt : (typeof e.downgrade_cleanup_at === 'string' ? e.downgrade_cleanup_at : null)
      const lifecycleStatus = (typeof e.lifecycleStatus === 'string'
        ? e.lifecycleStatus
        : resolveLifecycleStatus(normalizedPlan, status)) as LifecycleStatus

      return {
        plan: normalizedPlan,
        rawPlan: normalizedRaw,
        status,
        lifecycleStatus,
        trialEndsAt,
        graceUntil,
        exportUntil,
        deleteAt,
        downgradeCleanupAt,
        exportOnly,
        payerLimit,
        canUseOCR,
        exportsEnabled,
        spaceId: spaceId || null,
        spaceId2: spaceId2 || null,
      }
    } catch {
      return null
    }
  }, [resolveFunctionsBase, supabase])

  const refresh = useCallback(async () => {
    try {
      const fromBackend = await loadFromBackend()
      if (fromBackend) {
        try {
          await AsyncStorage.setItem(LS_PLAN, fromBackend.plan)
          await AsyncStorage.setItem(LS_SNAPSHOT, JSON.stringify(fromBackend))
        } catch {}
        setSnapshot(fromBackend)
        return
      }

      const rawSnap = await AsyncStorage.getItem(LS_SNAPSHOT)
      const parsed = rawSnap ? JSON.parse(rawSnap) : null
      if (parsed && typeof parsed === 'object' && (parsed.plan === 'basic' || parsed.plan === 'pro' || parsed.plan === 'free')) {
        setSnapshot({
          plan: parsed.plan,
          rawPlan: (parsed.rawPlan === 'basic' || parsed.rawPlan === 'pro' || parsed.rawPlan === 'free') ? parsed.rawPlan : parsed.plan,
          status: typeof parsed.status === 'string' ? parsed.status : 'active',
          lifecycleStatus: typeof parsed.lifecycleStatus === 'string'
            ? parsed.lifecycleStatus
            : resolveLifecycleStatus(parsed.plan, typeof parsed.status === 'string' ? parsed.status : 'active'),
          trialEndsAt: typeof parsed.trialEndsAt === 'string' ? parsed.trialEndsAt : null,
          graceUntil: typeof parsed.graceUntil === 'string' ? parsed.graceUntil : null,
          exportUntil: typeof parsed.exportUntil === 'string' ? parsed.exportUntil : null,
          deleteAt: typeof parsed.deleteAt === 'string' ? parsed.deleteAt : null,
          downgradeCleanupAt: typeof parsed.downgradeCleanupAt === 'string' ? parsed.downgradeCleanupAt : null,
          exportOnly: Boolean(parsed.exportOnly),
          payerLimit: typeof parsed.payerLimit === 'number' ? parsed.payerLimit : parsed.plan === 'pro' ? 2 : 1,
          canUseOCR: typeof parsed.canUseOCR === 'boolean' ? parsed.canUseOCR : true,
          exportsEnabled: Boolean(parsed.exportsEnabled),
          spaceId: typeof parsed.spaceId === 'string' ? parsed.spaceId : null,
          spaceId2: typeof parsed.spaceId2 === 'string' ? parsed.spaceId2 : null,
        })
        return
      }

      const rawPlan = await AsyncStorage.getItem(LS_PLAN)
      const plan = (rawPlan || '').trim() as PlanId
      setSnapshot(plan === 'basic' || plan === 'pro' || plan === 'free' ? snapshotForPlan(plan) : DEFAULT)
    } catch {
      setSnapshot(DEFAULT)
    }
  }, [loadFromBackend])

  const setPlan = useCallback(async (plan: PlanId) => {
    try {
      await AsyncStorage.setItem(LS_PLAN, plan)
    } catch {}
    setSnapshot(snapshotForPlan(plan))
  }, [])

  const setNavigation = useCallback((nav: { navigate: (route: string, params?: any) => void } | null) => {
    setUpgradeNavigation(nav)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const value = useMemo(() => ({ snapshot, refresh, setPlan, setNavigation }), [snapshot, refresh, setPlan, setNavigation])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
