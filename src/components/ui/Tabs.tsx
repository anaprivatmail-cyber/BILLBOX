 

type TabItem = { key: string; label: string }

export function Tabs({ items, value, onChange }: { items: TabItem[]; value: string; onChange: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={`rounded-full px-3 py-1 text-xs sm:text-sm border ${
            value === it.key ? 'bg-neutral-800 border-neutral-700 text-neutral-100' : 'bg-neutral-900/60 border-neutral-800 text-neutral-300 hover:text-neutral-100'
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
