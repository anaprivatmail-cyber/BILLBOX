import React, { useMemo, useState } from 'react'
import {
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { layout, spacing, useThemeColors } from './theme'
import { getCurrentLang, t } from '../i18n'

function tr(key: string): string {
  try {
    return t(getCurrentLang(), key)
  } catch {
    return key
  }
}

export function Screen({
  children,
  scroll = true,
  style,
}: {
  children: React.ReactNode
  scroll?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const insets = useSafeAreaInsets()
  const colors = useThemeColors()

  if (!scroll) {
    return (
      <SafeAreaView style={[{ flex: 1, backgroundColor: colors.background }, style]}>
        <View
          style={{
            flex: 1,
            padding: layout.screenPadding,
            paddingBottom: Math.max(insets.bottom, layout.screenPadding),
            position: 'relative',
          }}
        >
          {children}
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={[{ flex: 1, backgroundColor: colors.background }, style]}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          padding: layout.screenPadding,
          paddingBottom: Math.max(insets.bottom, layout.screenPadding),
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexGrow: 1, position: 'relative' }}>{children}</View>
      </ScrollView>
    </SafeAreaView>
  )
}

export function Surface({
  children,
  style,
  elevated = false,
  padded = true,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  elevated?: boolean
  padded?: boolean
}) {
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View
      style={[
        styles.surface,
        elevated && styles.surfaceElevated,
        padded && { padding: layout.cardPadding },
        style,
      ]}
    >
      {children}
    </View>
  )
}

export function SectionHeader({ title }: { title: string }) {
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return <Text style={styles.sectionTitle}>{tr(title)}</Text>
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline'

export function AppButton({
  label,
  onPress,
  iconName,
  disabled,
  variant = 'primary',
  style,
}: {
  label: string
  onPress?: () => void
  iconName?: keyof typeof Ionicons.glyphMap
  disabled?: boolean
  variant?: ButtonVariant
  style?: StyleProp<ViewStyle>
}) {
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const palette = useMemo(() => {
    if (variant === 'ghost') return { bg: 'transparent', border: 'transparent', text: colors.primary }
    if (variant === 'outline') return { bg: 'transparent', border: colors.border, text: colors.text }
    if (variant === 'secondary') return { bg: colors.primarySoft, border: colors.primarySoft, text: colors.text }
    return { bg: colors.primary, border: colors.primary, text: '#FFFFFF' }
  }, [variant])

  return (
    <TouchableOpacity
      onPress={disabled ? undefined : onPress}
      activeOpacity={0.85}
      style={[
        styles.button,
        { backgroundColor: palette.bg, borderColor: palette.border, opacity: disabled ? 0.6 : 1 },
        style,
      ]}
    >
      {iconName ? <Ionicons name={iconName} size={16} color={palette.text} /> : null}
      <Text style={[styles.buttonLabel, { color: palette.text }]}>{tr(label)}</Text>
    </TouchableOpacity>
  )
}

export function AppInput({ style, ...props }: TextInputProps) {
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const placeholder = typeof props.placeholder === 'string' ? tr(props.placeholder) : props.placeholder
  return <TextInput {...props} placeholder={placeholder} style={[styles.input, style]} placeholderTextColor={colors.textMuted} />
}

type SegmentedOption = { value: string; label: string }

export function SegmentedControl({
  value,
  onChange,
  options,
  style,
}: {
  value: string
  onChange: (value: string) => void
  options: SegmentedOption[]
  style?: StyleProp<ViewStyle>
}) {
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={[styles.segment, style]}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <TouchableOpacity
            key={opt.value}
            style={[styles.segmentItem, active && styles.segmentItemActive]}
            onPress={() => onChange(opt.value)}
          >
            <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]} numberOfLines={1}>
              {tr(opt.label)}
            </Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'info' | 'success' | 'warning' }) {
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const bg = tone === 'info' ? '#DBEAFE' : tone === 'success' ? '#DCFCE7' : tone === 'warning' ? '#FEF3C7' : '#E2E8F0'
  const fg = tone === 'info' ? '#1D4ED8' : tone === 'success' ? '#166534' : tone === 'warning' ? '#92400E' : '#334155'
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeLabel, { color: fg }]}>{tr(label)}</Text>
    </View>
  )
}

export function EmptyState({
  title,
  message,
  actionLabel,
  onActionPress,
  iconName,
}: {
  title: string
  message: string
  actionLabel?: string
  onActionPress?: () => void
  iconName?: keyof typeof Ionicons.glyphMap
}) {
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.emptyWrap}>
      {iconName ? (
        <View style={styles.emptyIcon}>
          <Ionicons name={iconName} size={22} color={colors.primary} />
        </View>
      ) : null}
      <Text style={styles.emptyTitle}>{tr(title)}</Text>
      <Text style={styles.emptyMessage}>{tr(message)}</Text>
      {actionLabel && onActionPress ? (
        <View style={{ marginTop: spacing.sm }}>
          <AppButton label={actionLabel} variant="secondary" onPress={onActionPress} />
        </View>
      ) : null}
    </View>
  )
}

export function InlineInfo({
  tone,
  message,
  iconName,
}: {
  tone: 'info' | 'warning' | 'danger' | 'success'
  message: string
  iconName?: keyof typeof Ionicons.glyphMap
}) {
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const bg = tone === 'info' ? '#EFF6FF' : tone === 'warning' ? '#FFFBEB' : tone === 'danger' ? '#FEF2F2' : '#F0FDF4'
  const fg = tone === 'info' ? '#1D4ED8' : tone === 'warning' ? '#92400E' : tone === 'danger' ? '#991B1B' : '#166534'
  return (
    <View style={[styles.inlineInfo, { backgroundColor: bg }]}> 
      {iconName ? <Ionicons name={iconName} size={16} color={fg} /> : null}
      <Text style={[styles.inlineInfoText, { color: fg }]}>{tr(message)}</Text>
    </View>
  )
}

export function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.disclosureWrap}>
      <TouchableOpacity onPress={() => setOpen((v) => !v)} style={styles.disclosureHeader}>
        <Text style={styles.disclosureTitle}>{tr(title)}</Text>
        <Ionicons name={open ? 'chevron-up-outline' : 'chevron-down-outline'} size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {open ? <View style={styles.disclosureBody}>{children}</View> : null}
    </View>
  )
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return <View style={[styles.divider, style]} />
}

function makeStyles(colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
  surface: {
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  surfaceElevated: {
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.xs,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  buttonLabel: {
    fontWeight: '700',
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  segment: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentItemActive: {
    backgroundColor: colors.primarySoft,
  },
  segmentLabel: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: '700',
  },
  segmentLabelActive: {
    color: colors.primary,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  badgeLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  emptyIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.text,
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  emptyMessage: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
  },
  inlineInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  inlineInfoText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  disclosureWrap: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    marginTop: spacing.xs,
  },
  disclosureHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  disclosureTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.text,
  },
  disclosureBody: {
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  })
}
