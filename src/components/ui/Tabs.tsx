 

type TabItem = { key: string; label: string }

export function Tabs({ items, value, onChange }: { items: TabItem[]; value: string; onChange: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={`rounded-full px-3.5 py-2 text-sm border transition-colors ${
            value === it.key
              ? 'bg-brand-50 border-brand-300 text-brand-800 font-medium'
              : 'bg-white border-neutral-300 text-neutral-700 hover:bg-neutral-100'
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
