import { ACCENTS, TONES, cardClass, labelClass } from "./styles";

// Flat semantic status badge: tone is one of success | warning | danger | neutral
export function Badge({ tone = "neutral", dot = false, children }) {
  const style = TONES[tone] ?? TONES.neutral;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-0.5 text-xs font-semibold ${style.badge}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />}
      {children}
    </span>
  );
}

// Page title block: crimson eyebrow, dark heading, muted description, actions on the right
export function PageHeading({ eyebrow, title, description, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-5">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-wider text-red-700">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-slate-600">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      )}
    </div>
  );
}

// White KPI card with a thin top accent strip (crimson | amber | emerald | slate)
export function KpiCard({ label, accent = "crimson", footnote, children }) {
  return (
    <div
      className={`${cardClass} border-t-2 ${ACCENTS[accent] ?? ACCENTS.crimson} p-5`}
    >
      <p className={labelClass}>{label}</p>
      <div className="mt-2">{children}</div>
      {footnote && (
        <p className="mt-2 text-xs text-slate-500 tabular-nums">{footnote}</p>
      )}
    </div>
  );
}
