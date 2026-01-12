import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Notifications from 'expo-notifications'

// Keep behaviour predictable for local notifications.
export async function ensureNotificationConfig(): Promise<void> {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data: any = (notification as any)?.request?.content?.data || {}
        const playSound = !!data?.playSound
        return {
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
          shouldPlaySound: playSound,
        shouldSetBadge: false,
        }
      },
    })
  } catch {}
}

export async function requestPermissionIfNeeded(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync()
    if (current.granted) return true
    const req = await Notifications.requestPermissionsAsync()
    return !!req.granted
  } catch {
    return false
  }
}

function billKey(billId: string, spaceId: string | null | undefined) {
  return `billbox.reminders.bill.${spaceId || 'default'}.${billId}`
}

function warrantyKey(warrantyId: string, spaceId: string | null | undefined) {
  return `billbox.reminders.warranty.${spaceId || 'default'}.${warrantyId}`
}

function inboxKey(inboxId: string, spaceId: string | null | undefined) {
  return `billbox.reminders.inbox.${spaceId || 'default'}.${inboxId}`
}

async function saveIds(storageKey: string, ids: string[]) {
  try {
    await AsyncStorage.setItem(storageKey, JSON.stringify(ids))
  } catch {}
}

async function loadIds(storageKey: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey)
    const parsed = raw ? (JSON.parse(raw) as string[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function cancelIds(storageKey: string) {
  const ids = await loadIds(storageKey)
  for (const id of ids) {
    try {
      await Notifications.cancelScheduledNotificationAsync(id)
    } catch {}
  }
  await saveIds(storageKey, [])
}

function isoToDate(iso: string): Date | null {
  try {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

export async function scheduleBillReminders(bill: any, daysBefore = [3, 1, 0], spaceId?: string | null): Promise<void> {
  if (!bill?.id || !bill?.due_date) return
  const ok = await requestPermissionIfNeeded()
  if (!ok) return

  const due = isoToDate(String(bill.due_date))
  if (!due) return

  const storageKey = billKey(String(bill.id), spaceId)
  await cancelIds(storageKey)

  const ids: string[] = []
  for (const days of daysBefore) {
    const when = new Date(due.getTime() - days * 24 * 3600 * 1000)
    if (when.getTime() <= Date.now()) continue
    try {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Bill reminder',
          body: `${bill.supplier || 'Bill'} is due ${bill.due_date}.`,
          data: { bill_id: bill.id, space_id: spaceId || null },
          categoryIdentifier: 'bill',
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when },
      })
      ids.push(id)
    } catch {}
  }

  await saveIds(storageKey, ids)
}

export async function scheduleGroupedPaymentReminder(dateISO: string, count: number, spaceId?: string | null): Promise<void> {
  const ok = await requestPermissionIfNeeded()
  if (!ok) return

  const when = isoToDate(dateISO)
  if (!when) return
  if (when.getTime() <= Date.now()) return

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Payment plan',
        body: `You planned payments for ${count} bill(s) on ${dateISO}.`,
        data: { space_id: spaceId || null },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when },
    })
  } catch {}
}

export async function snoozeBillReminder(bill: any, days: number, spaceId?: string | null): Promise<void> {
  if (!bill?.id) return
  const ok = await requestPermissionIfNeeded()
  if (!ok) return

  const storageKey = billKey(String(bill.id), spaceId)
  await cancelIds(storageKey)

  const when = new Date(Date.now() + days * 24 * 3600 * 1000)
  try {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Bill snoozed',
        body: `${bill.supplier || 'Bill'} reminder snoozed for ${days} day(s).`,
        data: { bill_id: bill.id, space_id: spaceId || null },
        categoryIdentifier: 'bill',
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when },
    })
    await saveIds(storageKey, [id])
  } catch {}
}

export async function cancelBillReminders(billId: string, spaceId?: string | null): Promise<void> {
  await cancelIds(billKey(billId, spaceId))
}

export async function scheduleWarrantyReminders(warranty: any, daysBefore = [30, 7, 1], spaceId?: string | null): Promise<void> {
  if (!warranty?.id || !warranty?.expires_at) return
  const ok = await requestPermissionIfNeeded()
  if (!ok) return

  const expires = isoToDate(String(warranty.expires_at))
  if (!expires) return

  const storageKey = warrantyKey(String(warranty.id), spaceId)
  await cancelIds(storageKey)

  const ids: string[] = []
  for (const days of daysBefore) {
    const when = new Date(expires.getTime() - days * 24 * 3600 * 1000)
    if (when.getTime() <= Date.now()) continue
    try {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Warranty reminder',
          body: `${warranty.item_name || 'Warranty'} expires ${warranty.expires_at}.`,
          data: { warranty_id: warranty.id, space_id: spaceId || null },
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when },
      })
      ids.push(id)
    } catch {}
  }

  await saveIds(storageKey, ids)
}

export async function cancelWarrantyReminders(warrantyId: string, spaceId?: string | null): Promise<void> {
  await cancelIds(warrantyKey(warrantyId, spaceId))
}

export async function scheduleInboxReviewReminder(inboxId: string, name: string, spaceId?: string | null): Promise<void> {
  if (!inboxId) return
  const ok = await requestPermissionIfNeeded()
  if (!ok) return

  const storageKey = inboxKey(String(inboxId), spaceId)
  await cancelIds(storageKey)

  try {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Inbox review',
        body: `${name || 'Document'} needs review. If it is not a bill, delete or archive it.`,
        data: { inbox_id: inboxId, space_id: spaceId || null, playSound: true },
        categoryIdentifier: 'inbox',
      },
      // Repeating time interval. OS limitations apply; this is best-effort.
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 6 * 60 * 60, repeats: true },
    })
    await saveIds(storageKey, [id])
  } catch {
    await saveIds(storageKey, [])
  }
}

export async function cancelInboxReviewReminder(inboxId: string, spaceId?: string | null): Promise<void> {
  await cancelIds(inboxKey(String(inboxId), spaceId))
}
