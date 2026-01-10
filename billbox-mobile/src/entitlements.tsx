import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

export type PlanId = 'free' | 'basic' | 'pro'

export type EntitlementsSnapshot = {
  plan: PlanId
  payerLimit: number
  canUseOCR: boolean
  exportsEnabled: boolean
}

type EntitlementsContextValue = {
  snapshot: EntitlementsSnapshot
  refresh: () => Promise<void>
  setPlan: (plan: PlanId) => Promise<void>
  setNavigation: (nav: { navigate: (route: string, params?: any) => void } | null) => void
}

const LS_PLAN = 'billbox.entitlements.plan'

const DEFAULT: EntitlementsSnapshot = {
  plan: 'free',
  payerLimit: 1,
  canUseOCR: true, // app separately limits OCR usage if desired
  exportsEnabled: false,
}

const Ctx = React.createContext<EntitlementsContextValue | undefined>(undefined)

function snapshotForPlan(plan: PlanId): EntitlementsSnapshot {
  if (plan === 'pro') {
    return { plan, payerLimit: 2, canUseOCR: true, exportsEnabled: true }
  }
  if (plan === 'basic') {
    return { plan, payerLimit: 1, canUseOCR: true, exportsEnabled: true }
  }
  return { ...DEFAULT, plan: 'free' }
}

let navigationRef: { navigate: (route: string, params?: any) => void } | null = null

export function setUpgradeNavigation(nav: { navigate: (route: string, params?: any) => void } | null) {
  navigationRef = nav
}

export function showUpgradeAlert(reason: 'ocr' | 'export' | 'space_limit' | 'business_space' | 'bills_limit') {
  // NOTE: if you want a single exact Slovenian sentence everywhere, tell me the sentence and I'll replace it here.
  const baseMessage = 'This feature is available on a paid plan. Please upgrade to continue.'
  const details =
    reason === 'ocr'
      ? 'OCR is locked on Free.'
      : reason === 'export'
        ? 'Exports are locked on Free.'
        : reason === 'space_limit'
          ? 'You reached the payer limit for your plan.'
          : reason === 'business_space'
            ? 'Business payer is available on Pro.'
            : 'This limit is locked on Free.'

  Alert.alert('Upgrade required', `${baseMessage}\n\n${details}`, [
    { text: 'Not now', style: 'cancel' },
    {
      text: 'Upgrade',
      onPress: () => {
        try {
          navigationRef?.navigate('Payments')
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
}: {
  children: React.ReactNode
  supabase: any
}) {
  const [snapshot, setSnapshot] = useState<EntitlementsSnapshot>(DEFAULT)

  const refresh = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(LS_PLAN)
      const plan = (raw || '').trim() as PlanId
      if (plan === 'basic' || plan === 'pro' || plan === 'free') {
        setSnapshot(snapshotForPlan(plan))
      } else {
        setSnapshot(DEFAULT)
      }
    } catch {
      setSnapshot(DEFAULT)
    }
  }, [])

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
