import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { Alert } from 'react-native'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ENABLE_IAP } from './env'

export type PlanId = 'free' | 'basic' | 'pro'

export type EntitlementsSnapshot = {
  // NOTE: App.tsx expects these exact fields.
  plan: PlanId
  payerLimit: number
  exportsEnabled: boolean
  canUseOCR: boolean
  ocrQuotaMonthly: number | null
  aiTier: 'none' | 'medium' | 'highest'
}

type UpgradePlan = Exclude<PlanId, 'free'>

let upgradeHandler: ((plan: UpgradePlan) => void) | null = null

export function setUpgradeHandler(handler: ((plan: UpgradePlan) => void) | null) {
  upgradeHandler = handler
}

type EntitlementsContextValue = {
  snapshot: EntitlementsSnapshot
  refresh: () => Promise<void>
}

const EntitlementsContext = createContext<EntitlementsContextValue | null>(null)

const LS_ENTITLEMENTS = 'billbox.mobile.entitlements'

function normalizePlan(raw: unknown): PlanId {
  const v = String(raw || '').toLowerCase()
  if (v === 'pro') return 'pro'
  if (v === 'basic') return 'basic'
  return 'free'
}

function snapshotFromPlan(plan: PlanId, overrides?: Partial<EntitlementsSnapshot>): EntitlementsSnapshot {
  const base: EntitlementsSnapshot = {
    plan,
    payerLimit: plan === 'pro' ? 2 : 1,
    exportsEnabled: plan === 'pro',
    // Free plan has limited OCR; enforcement happens server-side by quota.
    canUseOCR: true,
    ocrQuotaMonthly: plan === 'pro' ? 300 : plan === 'basic' ? 100 : 3,
    aiTier: plan === 'pro' ? 'highest' : plan === 'basic' ? 'medium' : 'none',
  }
  return { ...base, ...(overrides || {}) }
}

export function EntitlementsProvider({
  children,
  supabase,
}: {
  children: React.ReactNode
  supabase?: SupabaseClient | null
}) {
  const [snapshot, setSnapshot] = useState<EntitlementsSnapshot>(() => {
    // Keep app usable even without IAP/dev builds; server still enforces quotas.
    const base = snapshotFromPlan('free', { canUseOCR: !ENABLE_IAP ? true : true })
    return base
  })

  const refresh = useCallback(async () => {
    try {
      if (!supabase) {
        setSnapshot(snapshotFromPlan('free', { canUseOCR: !ENABLE_IAP ? true : true }))
        return
      }

      const { data: auth } = await supabase.auth.getUser().catch(() => ({ data: null as any }))
      const userId = auth?.user?.id
      if (!userId) {
        setSnapshot(snapshotFromPlan('free', { canUseOCR: !ENABLE_IAP ? true : true }))
        return
      }

      const { data, error } = await supabase
        .from('entitlements')
        .select('plan,payer_limit,exports_enabled,ocr_quota_monthly,status,active_until,updated_at')
        .eq('user_id', userId)
        .order('active_until', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()

      if (error) {
        setSnapshot(snapshotFromPlan('free'))
        return
      }

      const status = String((data as any)?.status || 'active').toLowerCase()
      const plan = status === 'active' ? normalizePlan((data as any)?.plan) : 'free'
      const payerLimit = typeof (data as any)?.payer_limit === 'number' ? (data as any).payer_limit : (plan === 'pro' ? 2 : 1)
      const ocrQuotaMonthly = typeof (data as any)?.ocr_quota_monthly === 'number'
        ? (data as any).ocr_quota_monthly
        : (plan === 'pro' ? 300 : plan === 'basic' ? 100 : 3)

      // Spec: exports are Pro-only.
      const exportsEnabled = plan === 'pro'

      const next = snapshotFromPlan(plan, {
        payerLimit,
        exportsEnabled,
        ocrQuotaMonthly,
      })
      setSnapshot(next)
    } catch {
      setSnapshot(snapshotFromPlan('free'))
    }
  }, [supabase])

  const value = useMemo<EntitlementsContextValue>(() => ({ snapshot, refresh }), [snapshot, refresh])

  return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>
}

export function useEntitlements(): EntitlementsContextValue {
  const ctx = useContext(EntitlementsContext)
  if (!ctx) {
    return {
      snapshot: snapshotFromPlan('free', { canUseOCR: !ENABLE_IAP ? true : true }),
      refresh: async () => {
        // no-op
      },
    }
  }
  return ctx
}

export function showUpgradeAlert(feature: string) {
  const title = 'Upgrade required'
  const body =
    feature === 'ocr'
      ? 'You’ve reached your OCR quota. Upgrade to Basic or Pro for a higher monthly quota.'
      : feature === 'exports' || feature === 'export'
        ? 'Exports are locked on Free and Basic. Upgrade to Pro to enable CSV, PDF, ZIP, and JSON exports.'
        : feature === 'space_limit' || feature === 'payer2' || feature === 'space'
          ? 'Adding a second payer is available on Pro. Upgrade to Pro to unlock Payer 2.'
          : 'This feature requires an upgrade.'

  Alert.alert(title, body, [
    { text: 'Not now', style: 'cancel' },
    {
      text: 'Upgrade to Basic',
      onPress: () => {
        upgradeHandler?.('basic')
      },
    },
    {
      text: 'Upgrade to Pro',
      onPress: () => {
        upgradeHandler?.('pro')
      },
    },
  ])
}
