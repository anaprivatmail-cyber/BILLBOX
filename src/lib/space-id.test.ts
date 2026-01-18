import { describe, expect, it } from 'vitest'

import { assertPayerScope } from '../../netlify/functions/_exports.js'

describe('payer scope (space_id) validation', () => {
  it('rejects labels like "personal" / "personal2" as invalid scope', () => {
    const ent = {
      payerLimit: 2,
      spaceId: '00000000-0000-4000-8000-000000000001',
      spaceId2: '00000000-0000-4000-8000-000000000002',
    }
    expect(assertPayerScope(ent, 'personal')).toEqual({ ok: false, code: 'invalid_space' })
    expect(assertPayerScope(ent, 'personal2')).toEqual({ ok: false, code: 'invalid_space' })
  })

  it('allows payer UUID(s) depending on payerLimit', () => {
    const p1 = '00000000-0000-4000-8000-000000000001'
    const p2 = '00000000-0000-4000-8000-000000000002'

    expect(assertPayerScope({ payerLimit: 1, spaceId: p1, spaceId2: p2 }, p1).ok).toBe(true)
    expect(assertPayerScope({ payerLimit: 1, spaceId: p1, spaceId2: p2 }, p2)).toEqual({ ok: false, code: 'payer_limit' })
    expect(assertPayerScope({ payerLimit: 2, spaceId: p1, spaceId2: p2 }, [p1, p2]).ok).toBe(true)
  })
})
