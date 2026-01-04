import React from 'react'
import {
  ActivityIndicator,
  Pressable,
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
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors, layout, spacing } from './theme'

export function Screen({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <SafeAreaView style={[styles.screen, style]}>
      {children}
    </SafeAreaView>
  )
}

export function Surface({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.surface, style]}>{children}</View>
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
  variant?: ButtonVariant
  style?: StyleProp<ViewStyle>
}) {
  const isDisabled = disabled || loading
  const buttonStyle = [
    styles.button,
    variant === 'primary' ? styles.buttonPrimary : null,
    variant === 'secondary' ? styles.buttonSecondary : null,
    variant === 'ghost' ? styles.buttonGhost : null,
    variant === 'danger' ? styles.buttonDanger : null,
    isDisabled ? styles.buttonDisabled : null,
    style,
  ]

  const labelStyle: StyleProp<TextStyle> = [
    styles.buttonLabel,
    variant === 'ghost' ? styles.buttonLabelGhost : null,
    variant === 'secondary' ? styles.buttonLabelSecondary : null,
    variant === 'danger' ? styles.buttonLabelDanger : null,
  ]

  return (
    <Pressable accessibilityRole="button" style={buttonStyle} onPress={() => !isDisabled && onPress()}>
      {loading ? <ActivityIndicator color={variant === 'ghost' ? colors.primary : '#fff'} /> : null}
      {!loading && iconName ? (
        <Ionicons
          name={iconName}
          size={18}
          color={variant === 'ghost' ? colors.primary : '#fff'}
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

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'danger' }) {
  const bg = tone === 'success' ? '#dcfce7' : tone === 'danger' ? '#fee2e2' : '#e2e8f0'
  const fg = tone === 'success' ? colors.success : tone === 'danger' ? colors.danger : colors.mutedText
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}> 
      <Text style={[styles.badgeText, { color: fg }]}>{label}</Text>
    </View>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {description ? <Text style={styles.emptyDescription}>{description}</Text> : null}
    </View>
  )
}

export function InlineInfo({ text }: { text: string }) {
  return (
    <View style={styles.inlineInfo}>
      <Ionicons name="information-circle-outline" size={16} color={colors.mutedText} style={{ marginRight: 8 }} />
      <Text style={styles.inlineInfoText}>{text}</Text>
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

export function Divider() {
  return <View style={styles.divider} />
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  surface: {
    backgroundColor: colors.surface,
    borderRadius: layout.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
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
    backgroundColor: '#334155',
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
    color: '#fff',
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
    backgroundColor: '#e0f2fe',
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
})
