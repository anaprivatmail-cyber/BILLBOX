import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

import { getCurrentLang, t } from './i18n'

export type PlanId = 'free' | 'basic' | 'pro'

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
  payerLimit: 1,
  canUseOCR: true, // app separately limits OCR usage if desired
  exportsEnabled: false,
  spaceId: null,
  spaceId2: null,
}

const Ctx = React.createContext<EntitlementsContextValue | undefined>(undefined)

function snapshotForPlan(plan: PlanId): EntitlementsSnapshot {
  if (plan === 'pro') {
    return { plan, payerLimit: 2, canUseOCR: true, exportsEnabled: true, spaceId: null, spaceId2: null }
  }
  if (plan === 'basic') {
    return { plan, payerLimit: 1, canUseOCR: true, exportsEnabled: false, spaceId: null, spaceId2: null }
  }
  return { ...DEFAULT, plan: 'free' }
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
    const raw = (process.env.EXPO_PUBLIC_FUNCTIONS_BASE as string | undefined) || ''
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
      const plan = (String(e.plan || 'free').trim() as PlanId)
      const normalizedPlan: PlanId = plan === 'basic' || plan === 'pro' || plan === 'free' ? plan : 'free'
      const payerLimit = typeof e.payerLimit === 'number' ? e.payerLimit : normalizedPlan === 'pro' ? 2 : 1
      const exportsEnabled = normalizedPlan === 'pro' ? Boolean(e.exportsEnabled) : false
      const spaceId = typeof e.spaceId === 'string' ? e.spaceId.trim() : ''
      const spaceId2 = typeof e.spaceId2 === 'string' ? e.spaceId2.trim() : ''

      // Free includes OCR (limited), so canUseOCR stays true.
      return {
        plan: normalizedPlan,
        payerLimit,
        canUseOCR: true,
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
          payerLimit: typeof parsed.payerLimit === 'number' ? parsed.payerLimit : parsed.plan === 'pro' ? 2 : 1,
          canUseOCR: true,
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
