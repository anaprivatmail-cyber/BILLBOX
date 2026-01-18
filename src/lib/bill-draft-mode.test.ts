import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BILL_DRAFT_SELECTION,
  archiveOnlyFromBillDraftSelection,
  billDraftSelectionFromArchiveOnly,
  shouldMapPaymentFields,
} from '../../billbox-mobile/src/billDraftMode'

describe('Bill draft mode (archive-first, payment-optional)', () => {
  it('defaults to archive mode', () => {
    expect(DEFAULT_BILL_DRAFT_SELECTION).toBe('archive')
    expect(archiveOnlyFromBillDraftSelection(DEFAULT_BILL_DRAFT_SELECTION)).toBe(true)
  })

  it('maps selection <-> archiveOnly', () => {
    expect(billDraftSelectionFromArchiveOnly(true)).toBe('archive')
    expect(billDraftSelectionFromArchiveOnly(false)).toBe('pay')
    expect(archiveOnlyFromBillDraftSelection('archive')).toBe(true)
    expect(archiveOnlyFromBillDraftSelection('pay')).toBe(false)
  })

  it('gates payment-field mapping based on archiveOnly', () => {
    expect(shouldMapPaymentFields(true)).toBe(false)
    expect(shouldMapPaymentFields(false)).toBe(true)
  })
})
