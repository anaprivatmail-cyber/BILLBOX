 

type TabItem = { key: string; label: string }

export function Tabs({ items, value, onChange }: { items: TabItem[]; value: string; onChange: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={`rounded-full px-3 py-1 text-xs sm:text-sm border ${
            value === it.key ? 'bg-brand-50 border-brand-200 text-brand-700' : 'bg-white border-neutral-300 text-neutral-700 hover:bg-neutral-100'
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
