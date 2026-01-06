import React from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, layout, spacing } from './theme'

const BRAND_ICON = require('../../assets/logo/logo-icon.png')

export function Screen({
  children,
  style,
  scroll = true,
  contentContainerStyle,
  title,
  right,
  padded = true,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  scroll?: boolean
  contentContainerStyle?: StyleProp<ViewStyle>
  title?: string
  right?: React.ReactNode
  padded?: boolean
}) {
  const insets = useSafeAreaInsets()
  const padX = padded ? layout.screenPadding : 0
  const padTop = padded ? spacing.lg : 0
  // Extra room for tab bar + floating action button.
  const padBottom = (padded ? spacing.lg : 0) + Math.max(insets.bottom, spacing.lg) + 84

  return (
    <SafeAreaView style={[styles.screen, style]}>
      {title ? (
        <View style={[styles.appHeader, { paddingHorizontal: padX }]}>
          <View style={styles.appHeaderLeft}>
            <Image source={BRAND_ICON} style={styles.appHeaderLogo} resizeMode="contain" accessibilityLabel="BillBox" />
            <Text style={styles.appHeaderTitle} numberOfLines={1}>
              {title}
            </Text>
          </View>
          {right ? <View style={styles.appHeaderRight}>{right}</View> : null}
        </View>
      ) : null}
      {scroll ? (
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingHorizontal: padX,
              paddingTop: title ? spacing.sm : padTop,
              paddingBottom: padBottom,
            },
            contentContainerStyle,
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View
          style={[
            { flex: 1, paddingHorizontal: padX, paddingTop: title ? spacing.sm : padTop, paddingBottom: padBottom },
            contentContainerStyle as any,
          ]}
        >
          {children}
        </View>
      )}
    </SafeAreaView>
  )
}

export function Surface({
  children,
  style,
  padded = true,
  elevated = false,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  padded?: boolean
  elevated?: boolean
}) {
  return (
    <View
      style={[
        styles.surface,
        padded ? styles.surfacePadded : null,
        elevated ? styles.surfaceElevated : null,
        style,
      ]}
    >
      {children}
    </View>
  )
}

export function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionHeaderTitle}>{title}</Text>
      {right ? <View style={styles.sectionHeaderRight}>{right}</View> : null}
    </View>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonVariantCompat = ButtonVariant | 'outline'

export function AppButton({
  label,
  onPress,
  iconName,
  loading,
  disabled,
  variant = 'primary',
  style,
}: {
  label: string
  onPress: () => void | Promise<void>
  iconName?: keyof typeof Ionicons.glyphMap
  loading?: boolean
  disabled?: boolean
  variant?: ButtonVariantCompat
  style?: StyleProp<ViewStyle>
}) {
  const isDisabled = disabled || loading
  const resolvedVariant: ButtonVariant = variant === 'outline' ? 'ghost' : variant
  const buttonStyle = [
    styles.button,
    resolvedVariant === 'primary' ? styles.buttonPrimary : null,
    resolvedVariant === 'secondary' ? styles.buttonSecondary : null,
    resolvedVariant === 'ghost' ? styles.buttonGhost : null,
    resolvedVariant === 'danger' ? styles.buttonDanger : null,
    isDisabled ? styles.buttonDisabled : null,
    style,
  ]

  const labelStyle: StyleProp<TextStyle> = [
    styles.buttonLabel,
    resolvedVariant === 'ghost' ? styles.buttonLabelGhost : null,
    resolvedVariant === 'secondary' ? styles.buttonLabelSecondary : null,
    resolvedVariant === 'danger' ? styles.buttonLabelDanger : null,
  ]

  return (
    <Pressable accessibilityRole="button" style={buttonStyle} onPress={() => !isDisabled && onPress()}>
      {loading ? <ActivityIndicator color={resolvedVariant === 'ghost' ? colors.primary : '#fff'} /> : null}
      {!loading && iconName ? (
        <Ionicons
          name={iconName}
          size={18}
          color={resolvedVariant === 'ghost' ? colors.primary : '#fff'}
          style={{ marginRight: 8 }}
        />
      ) : null}
      <Text style={labelStyle}>{label}</Text>
    </Pressable>
  )
}

export function AppInput({
  label,
  value,
  onChangeText,
  placeholder,
  multiline,
  keyboardType,
  style,
  inputProps,
}: {
  label?: string
  value: string
  onChangeText: (next: string) => void
  placeholder?: string
  multiline?: boolean
  keyboardType?: TextInputProps['keyboardType']
  style?: StyleProp<ViewStyle>
  inputProps?: Omit<TextInputProps, 'value' | 'onChangeText'>
}) {
  return (
    <View style={style}>
      {label ? <Text style={styles.inputLabel}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        multiline={multiline}
        keyboardType={keyboardType}
        style={[styles.input, multiline ? styles.inputMultiline : null]}
        placeholderTextColor={colors.mutedText}
        {...inputProps}
      />
    </View>
  )
}

export function SegmentedControl({
  options,
  value,
  onChange,
  style,
}: {
  options: Array<{ label: string; value: string }>
  value: string
  onChange: (value: string) => void
  style?: StyleProp<ViewStyle>
}) {
  return (
    <View style={[styles.segmented, style]}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={[styles.segmentedItem, active ? styles.segmentedItemActive : null]}
          >
            <Text style={[styles.segmentedLabel, active ? styles.segmentedLabelActive : null]}>{opt.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string
  tone?: 'neutral' | 'success' | 'danger' | 'info'
}) {
  const bg =
    tone === 'success'
      ? '#dcfce7'
      : tone === 'danger'
        ? '#fee2e2'
        : tone === 'info'
          ? colors.primarySoft
          : '#e2e8f0'
  const fg =
    tone === 'success'
      ? colors.success
      : tone === 'danger'
        ? colors.danger
        : tone === 'info'
          ? colors.primary
          : colors.mutedText
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}> 
      <Text style={[styles.badgeText, { color: fg }]}>{label}</Text>
    </View>
  )
}

export function EmptyState({
  title,
  description,
  message,
  iconName,
  actionLabel,
  onActionPress,
}: {
  title: string
  description?: string
  message?: string
  iconName?: keyof typeof Ionicons.glyphMap
  actionLabel?: string
  onActionPress?: () => void
}) {
  return (
    <View style={styles.empty}>
      {iconName ? (
        <View style={styles.emptyIcon}>
          <Ionicons name={iconName} size={22} color={colors.primary} />
        </View>
      ) : null}
      <Text style={styles.emptyTitle}>{title}</Text>
      {description || message ? (
        <Text style={styles.emptyDescription}>{description || message}</Text>
      ) : null}
      {actionLabel && onActionPress ? (
        <View style={{ marginTop: spacing.sm }}>
          <AppButton label={actionLabel} iconName="add-outline" onPress={onActionPress} />
        </View>
      ) : null}
    </View>
  )
}

export function InlineInfo({
  text,
  message,
  tone = 'info',
  iconName = 'information-circle-outline',
  style,
}: {
  text?: string
  message?: string
  tone?: 'info' | 'warning' | 'danger' | 'success' | 'neutral'
  iconName?: keyof typeof Ionicons.glyphMap
  style?: StyleProp<ViewStyle>
}) {
  const body = message ?? text ?? ''
  const fg =
    tone === 'danger'
      ? colors.danger
      : tone === 'success'
        ? colors.success
        : tone === 'warning'
          ? colors.primary
          : colors.mutedText
  const bg = tone === 'info' ? colors.primarySoft : 'transparent'
  return (
    <View style={[styles.inlineInfo, { backgroundColor: bg }, style]}>
      <Ionicons name={iconName} size={16} color={fg} style={{ marginRight: 8 }} />
      <Text style={styles.inlineInfoText}>{body}</Text>
    </View>
  )
}

export function Disclosure({
  title,
  description,
  onPress,
}: {
  title: string
  description?: string
  onPress: () => void
}) {
  return (
    <Pressable onPress={onPress} style={styles.disclosure}>
      <View style={{ flex: 1 }}>
        <Text style={styles.disclosureTitle}>{title}</Text>
        {description ? <Text style={styles.disclosureDescription}>{description}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.mutedText} />
    </Pressable>
  )
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
  },
  surface: {
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    borderWidth: 1,
    borderColor: colors.border,
  },
  surfacePadded: {
    padding: spacing.md,
  },
  surfaceElevated: {
    // Intentionally minimal: avoid introducing new shadow tokens.
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  sectionHeaderTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  sectionHeaderRight: {
    marginLeft: spacing.sm,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  buttonPrimary: {
    backgroundColor: colors.primary,
  },
  buttonSecondary: {
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonDanger: {
    backgroundColor: colors.danger,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonLabel: {
    color: '#fff',
    fontWeight: '700',
  },
  buttonLabelGhost: {
    color: colors.primary,
  },
  buttonLabelSecondary: {
    color: colors.primary,
  },
  buttonLabelDanger: {
    color: '#fff',
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.mutedText,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputMultiline: {
    minHeight: 110,
    textAlignVertical: 'top',
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderRadius: 12,
    padding: 4,
  },
  segmentedItem: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
  },
  segmentedItemActive: {
    backgroundColor: colors.surface,
  },
  segmentedLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.mutedText,
  },
  segmentedLabelActive: {
    color: colors.text,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  empty: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
    marginBottom: spacing.sm,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  emptyDescription: {
    marginTop: 6,
    fontSize: 13,
    color: colors.mutedText,
    textAlign: 'center',
  },
  inlineInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  inlineInfoText: {
    flex: 1,
    color: colors.mutedText,
    fontSize: 12,
  },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  disclosureTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  disclosureDescription: {
    marginTop: 4,
    fontSize: 12,
    color: colors.mutedText,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
  },

  appHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  appHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
    minWidth: 0,
  },
  appHeaderLogo: {
    width: 26,
    height: 26,
  },
  appHeaderTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text,
  },
  appHeaderRight: {
    marginLeft: spacing.sm,
  },
})
