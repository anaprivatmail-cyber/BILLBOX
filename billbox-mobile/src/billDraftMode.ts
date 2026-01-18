export type BillDraftSelection = 'archive' | 'pay'

export const DEFAULT_BILL_DRAFT_SELECTION: BillDraftSelection = 'archive'

export function archiveOnlyFromBillDraftSelection(selection: BillDraftSelection): boolean {
  return selection === 'archive'
}

export function billDraftSelectionFromArchiveOnly(archiveOnly: boolean): BillDraftSelection {
  return archiveOnly ? 'archive' : 'pay'
}

export function shouldMapPaymentFields(archiveOnly: boolean): boolean {
  return !archiveOnly
}
