import type { PropsWithChildren } from 'react'

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger'

export default function Badge({ children, variant = 'default' }: PropsWithChildren<{ variant?: BadgeVariant }>) {
  const map: Record<BadgeVariant, string> = {
    default: 'bg-neutral-100 text-neutral-700 border border-neutral-200',
    success: 'bg-green-100 text-green-700 border border-green-200',
    warning: 'bg-amber-100 text-amber-700 border border-amber-200',
    danger: 'bg-red-100 text-red-700 border border-red-200',
  }
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs ${map[variant]}`}>{children}</span>
}
