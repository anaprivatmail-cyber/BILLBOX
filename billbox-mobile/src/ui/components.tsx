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
  // SafeAreaView already accounts for the top inset; keep extra padding minimal.
  const topPad = 4
  const bottomPad = Math.max(4, Math.min(8, insets.bottom))

  if (!scroll) {
    return (
      <SafeAreaView edges={['top']} style={[{ flex: 1, backgroundColor: colors.background }, style]}>
        <View
          style={{
            flex: 1,
            paddingHorizontal: layout.screenPadding,
            paddingTop: topPad,
            paddingBottom: bottomPad,
            position: 'relative',
          }}
        >
          {children}
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView edges={['top']} style={[{ flex: 1, backgroundColor: colors.background }, style]}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: layout.screenPadding,
          paddingTop: topPad,
          paddingBottom: bottomPad,
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
        variant === 'primary' && !disabled ? styles.buttonPrimaryShadow : null,
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
  return (
    <TextInput
      {...props}
      placeholder={placeholder}
      style={[styles.input, style]}
      placeholderTextColor={colors.textMuted}
      selectionColor={colors.primary}
    />
  )
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
  title,
  message,
  iconName,
  translate = true,
  style,
}: {
  tone: 'info' | 'warning' | 'danger' | 'success'
  title?: string
  message: string
  iconName?: keyof typeof Ionicons.glyphMap
  translate?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const bg = tone === 'info' ? '#EFF6FF' : tone === 'warning' ? '#FFFBEB' : tone === 'danger' ? '#FEF2F2' : '#F0FDF4'
  const fg = tone === 'info' ? '#1D4ED8' : tone === 'warning' ? '#92400E' : tone === 'danger' ? '#991B1B' : '#166534'
  const border = tone === 'info' ? '#BFDBFE' : tone === 'warning' ? '#FDE68A' : tone === 'danger' ? '#FECACA' : '#BBF7D0'
  const text = translate ? tr(message) : message
  return (
    <View style={[styles.inlineInfo, { backgroundColor: bg, borderColor: border }, style]}>
      <View style={[styles.inlineInfoAccent, { backgroundColor: fg }]} />
      {iconName ? (
        <View style={[styles.inlineInfoIconWrap, { borderColor: border }]}>
          <Ionicons name={iconName} size={16} color={fg} />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        {title ? <Text style={[styles.inlineInfoTitle, { color: fg }]}>{translate ? tr(title) : title}</Text> : null}
        <Text style={[styles.inlineInfoText, { color: fg }]}>{text}</Text>
      </View>
    </View>
  )
}

export function Disclosure({
  title,
  children,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  highlightOnOpen = false,
  style,
  bodyStyle,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  highlightOnOpen?: boolean
  style?: StyleProp<ViewStyle>
  bodyStyle?: StyleProp<ViewStyle>
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const colors = useThemeColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (value: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(value)
    onOpenChange?.(value)
  }

  return (
    <View
      style={[
        styles.disclosureWrap,
        style,
        highlightOnOpen && open ? { borderColor: colors.primary } : null,
      ]}
    >
      <TouchableOpacity onPress={() => setOpen(!open)} style={styles.disclosureHeader}>
        <Text style={styles.disclosureTitle}>{tr(title)}</Text>
        <Ionicons name={open ? 'chevron-up-outline' : 'chevron-down-outline'} size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {open ? <View style={[styles.disclosureBody, bodyStyle]}>{children}</View> : null}
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
    inlineInfo: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
    },
    inlineInfoAccent: {
      width: 4,
      borderRadius: 999,
      alignSelf: 'stretch',
      opacity: 0.9,
    },
    inlineInfoIconWrap: {
      width: 28,
      height: 28,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      backgroundColor: '#FFFFFFAA',
    },
    inlineInfoTitle: {
      fontSize: 12,
      fontWeight: '800',
    },
    inlineInfoText: {
      fontSize: 12,
      fontWeight: '600',
      lineHeight: 16,
    },
    surface: {
      backgroundColor: colors.surface,
      borderRadius: layout.radius,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOpacity: 0.04,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 6 },
      elevation: 1,
    },
    surfaceElevated: {
      shadowColor: '#000',
      shadowOpacity: 0.10,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 10 },
      elevation: 4,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '800',
      letterSpacing: 0.2,
      color: colors.text,
      marginBottom: spacing.sm,
    },
    button: {
      minHeight: 46,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: 14,
      borderWidth: 1,
    },
    buttonPrimaryShadow: {
      shadowColor: colors.primary,
      shadowOpacity: 0.20,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 8 },
      elevation: 3,
    },
    buttonLabel: {
      fontWeight: '800',
      fontSize: 15,
      letterSpacing: 0.15,
    },
    input: {
      minHeight: 46,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      paddingVertical: 12,
      paddingHorizontal: 14,
      backgroundColor: colors.surface,
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    segment: {
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
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
