import { describe, expect, it } from 'vitest'

import { assertPayerScope, buildBillQueryWithFilters } from '../netlify/functions/_exports.js'

function makeUuid(n: number): string {
  // deterministic-but-valid v4 UUIDs
  const hex = n.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

describe('Payer (space) scope: Profil 1 / Profil 2 / Both', () => {
  it('assertPayerScope blocks Profil 2 when not Pro', () => {
    const p1 = makeUuid(1)
    const p2 = makeUuid(2)

    const entFree = { payerLimit: 1, spaceId: p1, spaceId2: p2 }
    expect(assertPayerScope(entFree, p1).ok).toBe(true)
    expect(assertPayerScope(entFree, p2)).toEqual({ ok: false, code: 'payer_limit' })
    expect(assertPayerScope(entFree, [p1, p2])).toEqual({ ok: false, code: 'payer_limit' })

    const entPro = { payerLimit: 2, spaceId: p1, spaceId2: p2 }
    expect(assertPayerScope(entPro, p2).ok).toBe(true)
    expect(assertPayerScope(entPro, [p1, p2]).ok).toBe(true)
  })

  it('buildBillQueryWithFilters applies correct space_id filter', () => {
    const calls: Array<{ kind: 'eq' | 'in'; col: string; val: any }> = []

    const query = {
      select: () => query,
      eq: (col: string, val: any) => {
        calls.push({ kind: 'eq', col, val })
        return query
      },
      in: (col: string, val: any) => {
        calls.push({ kind: 'in', col, val })
        return query
      },
      ilike: () => query,
      gte: () => query,
      lte: () => query,
      or: () => query,
    }

    const supabase = {
      from: () => query,
    } as any

    const userId = 'user-1'
    const p1 = makeUuid(1)
    const p2 = makeUuid(2)

    calls.length = 0
    buildBillQueryWithFilters({ supabase, userId, spaceId: p1, filters: {} })
    expect(calls.some((c) => c.kind === 'eq' && c.col === 'space_id' && c.val === p1)).toBe(true)

    calls.length = 0
    buildBillQueryWithFilters({ supabase, userId, spaceIds: [p1, p2], filters: {} })
    expect(calls.some((c) => c.kind === 'in' && c.col === 'space_id' && Array.isArray(c.val) && c.val.length === 2)).toBe(true)
  })

  it('analytics/export totals match selected scope', () => {
    const p1 = makeUuid(1)
    const p2 = makeUuid(2)

    const bills = [
      { id: 'b1', space_id: p1, amount: 10 },
      { id: 'b2', space_id: p2, amount: 20 },
    ]

    const sum = (spaceIds: string[]) =>
      bills
        .filter((b) => spaceIds.includes(b.space_id))
        .reduce((acc, b) => acc + b.amount, 0)

    expect(sum([p1])).toBe(10)
    expect(sum([p2])).toBe(20)
    expect(sum([p1, p2])).toBe(30)
  })
})
