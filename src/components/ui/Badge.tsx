import type { PropsWithChildren } from 'react'

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger'

export default function Badge({ children, variant = 'default' }: PropsWithChildren<{ variant?: BadgeVariant }>) {
  const map: Record<BadgeVariant, string> = {
    default: 'bg-neutral-800 text-neutral-300',
    success: 'bg-green-700/50 text-green-300',
    warning: 'bg-amber-700/50 text-amber-300',
    danger: 'bg-red-700/50 text-red-300',
  }
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs ${map[variant]}`}>{children}</span>
}
