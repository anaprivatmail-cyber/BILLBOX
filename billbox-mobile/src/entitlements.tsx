import React, { createContext, useContext, useMemo, useState } from 'react'
import { Alert } from 'react-native'
import { ENABLE_IAP } from './env'

export type PlanId = 'free' | 'basic' | 'pro'

export type EntitlementsSnapshot = {
  planId: PlanId
  canUseOCR: boolean
}

type EntitlementsContextValue = {
  snapshot: EntitlementsSnapshot
  refresh: () => Promise<void>
}

const EntitlementsContext = createContext<EntitlementsContextValue | null>(null)

export function EntitlementsProvider({ children }: { children: React.ReactNode }) {
  const [snapshot] = useState<EntitlementsSnapshot>(() => {
    // Default for internal/test builds: if IAP is disabled, allow OCR.
    return {
      planId: 'free',
      canUseOCR: !ENABLE_IAP,
    }
  })

  const value = useMemo<EntitlementsContextValue>(
    () => ({
      snapshot,
      refresh: async () => {},
    }),
    [snapshot]
  )

  return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>
}

export function useEntitlements(): EntitlementsContextValue {
  const ctx = useContext(EntitlementsContext)
  if (!ctx) {
    return {
      snapshot: { planId: 'free', canUseOCR: !ENABLE_IAP },
      refresh: async () => {},
    }
  }
  return ctx
}

export function showUpgradeAlert(feature: string) {
  Alert.alert('Upgrade required', `This feature (${feature}) requires an upgrade in the store build.`)
}
