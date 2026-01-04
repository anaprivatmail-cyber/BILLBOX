import { ENABLE_PUSH_NOTIFICATIONS } from './env'

// Minimal no-op implementation used for builds where notifications
// are disabled or not required for current testing.

export async function ensureNotificationConfig(): Promise<void> {
  return
}

export async function requestPermissionIfNeeded(): Promise<boolean> {
  return ENABLE_PUSH_NOTIFICATIONS
}

export async function scheduleBillReminders(): Promise<void> {
  return
}

export async function cancelBillReminders(): Promise<void> {
  return
}

export async function snoozeBillReminder(): Promise<void> {
  return
}

export async function scheduleGroupedPaymentReminder(): Promise<void> {
  return
}

export async function scheduleWarrantyReminders(): Promise<void> {
  return
}

export async function cancelWarrantyReminders(): Promise<void> {
  return
}
