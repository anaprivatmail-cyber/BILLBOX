import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

export default function Button({ variant = 'secondary', className = '', ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>> & { variant?: Variant }) {
  const base = 'btn'
  const map: Record<Variant, string> = {
    primary: 'btn-primary',
    secondary: 'btn-secondary',
    danger: 'btn-danger',
    ghost: 'bg-transparent text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100',
  }
  const cls = `${base} ${map[variant]} ${className}`.trim()
  return <button {...props} className={cls} />
}
