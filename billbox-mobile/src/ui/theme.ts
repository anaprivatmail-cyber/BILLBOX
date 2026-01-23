import React from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

export type ThemeMode = 'light' | 'dark'

export const lightColors = {
  background: '#F8FAFC',
  surface: '#FFFFFF',
  text: '#0F172A',
  textMuted: '#64748B',
  border: '#E2E8F0',
  primary: '#1D4ED8',
  primarySoft: '#DBEAFE',
  danger: '#DC2626',
  warning: '#D97706',
  success: '#16A34A',
}

export const darkColors = {
  background: '#0B1220',
  surface: '#111A2E',
  text: '#E5E7EB',
  textMuted: '#94A3B8',
  border: 'rgba(148, 163, 184, 0.35)',
  primary: '#3B82F6',
  primarySoft: 'rgba(59, 130, 246, 0.20)',
  danger: '#F87171',
  warning: '#FBBF24',
  success: '#34D399',
}

export type ThemeColors = typeof lightColors

const LS_THEME_MODE = 'billbox.theme.mode'

export async function loadThemeMode(): Promise<ThemeMode> {
  try {
    const raw = await AsyncStorage.getItem(LS_THEME_MODE)
    const val = (raw || '').trim() as ThemeMode
    if (val === 'dark' || val === 'light') return val
  } catch {}
  return 'light'
}

export async function saveThemeMode(mode: ThemeMode): Promise<void> {
  try {
    await AsyncStorage.setItem(LS_THEME_MODE, mode)
  } catch {}
}

function colorsForMode(mode: ThemeMode): ThemeColors {
  return mode === 'dark' ? darkColors : lightColors
}

const ThemeContext = React.createContext<{
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  colors: ThemeColors
} | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = React.useState<ThemeMode>('light')
  React.useEffect(() => {
    ;(async () => {
      setModeState(await loadThemeMode())
    })()
  }, [])

  const setMode = React.useCallback((next: ThemeMode) => {
    setModeState(next)
    saveThemeMode(next)
  }, [])

  const value = React.useMemo(() => {
    const c = colorsForMode(mode)
    return { mode, setMode, colors: c }
  }, [mode, setMode])

  return React.createElement(ThemeContext.Provider, { value }, children)
}

export function useTheme() {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) throw new Error('ThemeProvider missing')
  return ctx
}

export function useThemeColors(): ThemeColors {
  return useTheme().colors
}

// Back-compat: existing imports expect `colors`.
// This remains light by default; components should prefer `useThemeColors()`.
export const colors: ThemeColors = lightColors

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 28,
  xxl: 40,
}

export const layout = {
  screenPadding: 18,
  cardPadding: 16,
  radius: 18,
  gap: 12,
}
