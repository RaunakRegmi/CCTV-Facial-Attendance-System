// Shared Tailwind class strings for the institutional white & crimson theme.
// Kept as full literal strings so Tailwind's content scanner picks them up.

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700";

// Primary action: solid college crimson
export const btnPrimary = `inline-flex items-center justify-center gap-2 rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

// Secondary action: white outline
export const btnSecondary = `inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-xs transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

// Compact variants for dense surfaces (cards, table rows)
export const btnPrimarySm = `inline-flex items-center justify-center gap-1.5 rounded-md bg-red-700 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
export const btnSecondarySm = `inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

// Text inputs and selects
export const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 shadow-xs focus:border-red-700 focus:outline-none focus:ring-1 focus:ring-red-700 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";
export const selectClass =
  "rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-xs focus:border-red-700 focus:outline-none focus:ring-1 focus:ring-red-700 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400";

// White card surface
export const cardClass = "rounded-md border border-slate-200 bg-white shadow-xs";

// Uppercase muted label used for KPI captions and section eyebrows
export const labelClass =
  "text-xs font-semibold uppercase tracking-wider text-slate-500";

// Semantic badge tones (high contrast on white)
export const TONES = {
  success: { badge: "border-emerald-200 bg-emerald-50 text-emerald-800", dot: "bg-emerald-600" },
  warning: { badge: "border-amber-200 bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  danger: { badge: "border-red-200 bg-red-50 text-red-800", dot: "bg-red-700" },
  neutral: { badge: "border-slate-200 bg-slate-100 text-slate-700", dot: "bg-slate-400" },
};

// KPI card top accent strip
export const ACCENTS = {
  crimson: "border-t-red-700",
  amber: "border-t-amber-500",
  emerald: "border-t-emerald-600",
  slate: "border-t-slate-700",
};
