import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

// ---------------------------------------------------------------------------
// Mock data — replace with API calls once the backend is connected.
// ---------------------------------------------------------------------------

const CLASSES = [
  { id: "CS-101", name: "Intro to Programming", room: "LT-3", time: "09:00 – 09:45" },
  { id: "CS-205", name: "Data Structures", room: "Lab 2", time: "10:00 – 10:45" },
  { id: "AI-310", name: "Computer Vision", room: "LT-1", time: "11:00 – 11:45" },
];

const STUDENT_NAMES = [
  "Aisha Rahman", "Benjamin Tan", "Chloe Lim", "Daniel Wong", "Emily Chen",
  "Farhan Ismail", "Grace Ng", "Hafiz Abdullah", "Isabelle Lee", "Jason Ong",
  "Kavya Menon", "Lucas Teo", "Mei Ling Goh", "Nurul Huda", "Oliver Yap",
  "Priya Nair", "Qi Hao Lau", "Rachel Koh", "Syafiq Hamzah", "Tiffany Chua",
  "Umar Farouk", "Vanessa Low", "Wei Jie Chong", "Xin Yi Tan", "Yusuf Ahmad",
  "Zara Hussein", "Arjun Pillai", "Bella Foo", "Cheng Hui Sim", "Dinesh Kumar",
];

// Deterministic pseudo-random so mock data is stable across re-renders.
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function buildRoster(classIndex) {
  const rand = seeded(classIndex * 97 + 13);
  const absentTarget = 6 - classIndex * 2; // CS-101: 6 absent, CS-205: 4, AI-310: 2
  const absentIdx = new Set();
  while (absentIdx.size < absentTarget) {
    absentIdx.add(Math.floor(rand() * STUDENT_NAMES.length));
  }
  return STUDENT_NAMES.map((name, i) => {
    const present = !absentIdx.has(i);
    // Most arrive 08:52–09:03; a few stragglers up to 09:12.
    const late = rand() < 0.15;
    const offset = late ? 4 + Math.floor(rand() * 9) : -8 + Math.floor(rand() * 11);
    const total = 9 * 60 + offset;
    const hh = String(Math.floor(total / 60)).padStart(2, "0");
    const mm = String(total % 60).padStart(2, "0");
    return {
      id: `${CLASSES[classIndex].id}-${String(i + 1).padStart(3, "0")}`,
      name,
      status: present ? "Present" : "Absent",
      arrival: present ? `${hh}:${mm}` : null,
      late: present && late,
    };
  });
}

function buildAttention(classIndex) {
  const rand = seeded(classIndex * 31 + 7);
  const points = [];
  // Typical lecture curve: warm-up, peak, mid-session dip, slight recovery.
  for (let m = 0; m <= 45; m += 3) {
    const base =
      70 +
      18 * Math.sin((m / 45) * Math.PI * 0.9) -
      (m > 25 && m < 36 ? 12 : 0) +
      classIndex * 2;
    const noise = (rand() - 0.5) * 10;
    const score = Math.max(0, Math.min(100, Math.round(base + noise)));
    points.push({ time: `09:${String(m).padStart(2, "0")}`, attention: score });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Small presentational components
// ---------------------------------------------------------------------------

function Sidebar({ selectedClass, onSelect, onExport }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-slate-200 bg-white md:flex">
      <div className="flex items-center gap-2 border-b border-slate-200 px-6 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
          DS
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900">Dual-State</p>
          <p className="text-xs text-slate-500">Attendance Analytics</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <p className="px-3 pb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          My Classes
        </p>
        <ul className="space-y-1">
          {CLASSES.map((c) => {
            const active = c.id === selectedClass;
            return (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors ${
                    active
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <span className="block text-sm font-semibold">{c.id}</span>
                  <span className={`block text-xs ${active ? "text-indigo-500" : "text-slate-500"}`}>
                    {c.name}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="space-y-2 border-t border-slate-200 p-4">
        <button
          onClick={() => onExport("csv")}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
        >
          <DownloadIcon /> Export CSV
        </button>
        <button
          onClick={() => onExport("pdf")}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <DownloadIcon /> Export Report
        </button>
      </div>
    </aside>
  );
}

function MobileClassPicker({ selectedClass, onSelect, onExport }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 md:hidden">
      <select
        value={selectedClass}
        onChange={(e) => onSelect(e.target.value)}
        className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
      >
        {CLASSES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id} — {c.name}
          </option>
        ))}
      </select>
      <button
        onClick={() => onExport("csv")}
        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
      >
        Export
      </button>
    </div>
  );
}

function StatCard({ label, children, footnote }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <div className="mt-2">{children}</div>
      {footnote && <p className="mt-2 text-xs text-slate-400">{footnote}</p>}
    </div>
  );
}

function StatusBadge({ status, late }) {
  if (status === "Absent") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/20">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> Absent
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Present
      </span>
      {late && (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
          Late
        </span>
      )}
    </span>
  );
}

function AttentionTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-md">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="font-semibold text-slate-900">
        {payload[0].value}
        <span className="ml-1 font-normal text-slate-500">attention</span>
      </p>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.69L6.28 8.47a.75.75 0 0 0-1.06 1.06l4.25 4.25a.75.75 0 0 0 1.06 0l4.25-4.25a.75.75 0 1 0-1.06-1.06l-2.97 2.97V2.75Z" />
      <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

export default function TeacherDashboard() {
  const [selectedClass, setSelectedClass] = useState("CS-101");
  const [filter, setFilter] = useState("All");

  const classIndex = CLASSES.findIndex((c) => c.id === selectedClass);
  const classInfo = CLASSES[classIndex];

  const roster = useMemo(() => buildRoster(classIndex), [classIndex]);
  const attention = useMemo(() => buildAttention(classIndex), [classIndex]);

  const presentCount = roster.filter((s) => s.status === "Present").length;
  const lateCount = roster.filter((s) => s.late).length;
  const avgAttention = Math.round(
    attention.reduce((sum, p) => sum + p.attention, 0) / attention.length
  );

  const visibleRoster =
    filter === "All" ? roster : roster.filter((s) => s.status === filter);

  const handleExport = (format) => {
    if (format !== "csv") {
      // TODO: wire to backend report endpoint
      console.log(`Export ${format} requested for ${selectedClass}`);
      return;
    }
    const rows = [
      ["Student ID", "Student Name", "Status", "Arrival Time"],
      ...roster.map((s) => [s.id, s.name, s.status, s.arrival ?? ""]),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedClass}-attendance.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <Sidebar
        selectedClass={selectedClass}
        onSelect={setSelectedClass}
        onExport={handleExport}
      />

      <main className="md:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <MobileClassPicker
            selectedClass={selectedClass}
            onSelect={setSelectedClass}
            onExport={handleExport}
          />

          {/* Header */}
          <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-indigo-600">{classInfo.id}</p>
              <h1 className="text-2xl font-semibold tracking-tight">{classInfo.name}</h1>
              <p className="mt-1 text-sm text-slate-500">
                {classInfo.room} · Today, {classInfo.time}
              </p>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
              </span>
              Live session
            </span>
          </header>

          {/* Top row: metrics */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label="Total Present"
              footnote={`${roster.length - presentCount} absent · ${lateCount} late`}
            >
              <p className="text-3xl font-semibold">
                {presentCount}
                <span className="text-lg font-normal text-slate-400">/{roster.length}</span>
              </p>
              <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100">
                <div
                  className="h-1.5 rounded-full bg-indigo-600"
                  style={{ width: `${(presentCount / roster.length) * 100}%` }}
                />
              </div>
            </StatCard>

            <StatCard label="Average Class Attention" footnote="Mean across session so far">
              <p className="text-3xl font-semibold">{avgAttention}%</p>
              <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100">
                <div
                  className="h-1.5 rounded-full bg-indigo-600"
                  style={{ width: `${avgAttention}%` }}
                />
              </div>
            </StatCard>

            <StatCard label="System Status" footnote="Camera feed · 30 fps · last sync 2s ago">
              <p className="flex items-center gap-2 text-lg font-semibold text-emerald-700">
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
                    clipRule="evenodd"
                  />
                </svg>
                Pose Analytics Active
              </p>
              <p className="mt-2 text-sm text-slate-500">Face recognition: online</p>
            </StatCard>
          </section>

          {/* Middle row: attention chart */}
          <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold">Attention Score</h2>
                <p className="text-sm text-slate-500">Class-wide engagement, sampled every 3 minutes</p>
              </div>
              <p className="text-xs text-slate-400">Dashed line = session average</p>
            </div>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={attention} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke="#f1f5f9" vertical={false} />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 12, fill: "#64748b" }}
                    tickLine={false}
                    axisLine={{ stroke: "#e2e8f0" }}
                    interval={2}
                  />
                  <YAxis
                    domain={[0, 100]}
                    ticks={[0, 25, 50, 75, 100]}
                    tick={{ fontSize: 12, fill: "#64748b" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <ReferenceLine y={avgAttention} stroke="#94a3b8" strokeDasharray="4 4" />
                  <Tooltip
                    content={<AttentionTooltip />}
                    cursor={{ stroke: "#cbd5e1", strokeWidth: 1 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="attention"
                    stroke="#4f46e5"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 5, stroke: "#fff", strokeWidth: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Bottom row: roster table */}
          <section className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <h2 className="text-base font-semibold">Attendance Roster</h2>
              <div className="inline-flex rounded-lg bg-slate-100 p-1 text-sm">
                {["All", "Present", "Absent"].map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`rounded-md px-3 py-1 font-medium transition-colors ${
                      filter === f ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <div className="max-h-[28rem] overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-3">Student Name</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Arrival Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRoster.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-5 py-3">
                        <p className="font-medium text-slate-900">{s.name}</p>
                        <p className="text-xs text-slate-400">{s.id}</p>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3">
                        <StatusBadge status={s.status} late={s.late} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 tabular-nums text-slate-600">
                        {s.arrival ?? <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
