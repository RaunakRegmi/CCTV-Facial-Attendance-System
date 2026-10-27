import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
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
import AdminPanel from "./AdminPanel";
import { db } from "./firebase";
import { CHART_COLORS, useTheme } from "./theme";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Students whose first "Present" log is later than class start + this are marked late.
const LATE_GRACE_MINUTES = 5;

// Session window for a class with no last_active_startup (engine never started it).
const SESSION_FALLBACK_HOURS = 24;

// Stable empty array so memoized values don't recompute while loading
const EMPTY = [];

// The engine writes last_heartbeat every 60s; a class is "Active" if the latest
// heartbeat is newer than this. Allows two missed syncs before the badge drops.
const HEARTBEAT_STALE_MINUTES = 3;

// ---------------------------------------------------------------------------
// Firestore docs -> dashboard data
// ---------------------------------------------------------------------------

// classes/{id}: { class_id, class_name, last_active_startup, last_heartbeat,
//                 last_shutdown?, room?, start_time? }
function toClass(doc) {
  const data = doc.data({ serverTimestamps: "estimate" });
  return {
    id: doc.id,
    name: data.class_name || doc.id,
    room: data.room ?? null,
    startTime: data.start_time ?? null,
    lastActive: data.last_active_startup?.toDate?.() ?? null,
    heartbeat: data.last_heartbeat?.toDate?.() ?? null,
    shutdown: data.last_shutdown?.toDate?.() ?? null,
  };
}

// Active = recent heartbeat and no graceful shutdown since it. A crashed engine
// never writes last_shutdown, so it drops out once the heartbeat goes stale.
function isActive(cls, now) {
  if (!cls?.heartbeat) return false;
  if (cls.shutdown && cls.shutdown >= cls.heartbeat) return false;
  return now - cls.heartbeat.getTime() < HEARTBEAT_STALE_MINUTES * 60_000;
}

function formatTime(date, withSeconds = false) {
  if (!date) return null;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (!withSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(date.getSeconds()).padStart(2, "0")}`;
}

// "just now" / "12 min ago" / "3 h ago" (same day) / "Yesterday 09:01" / "Mon 20 Oct"
function formatLastActive(date, now) {
  if (!date) return "Never started";
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return `${Math.floor(minutes / 60)} h ago`;
  if (sameDay(date, yesterday)) return `Yesterday ${formatTime(date)}`;
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// Optional `start_time: "09:00"` on the class doc -> minutes since midnight (540).
// null means no schedule, so nobody is marked late.
function classStartMinutes(cls) {
  const match = /^(\d{1,2}):(\d{2})/.exec(cls?.startTime ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// The current session starts at the engine's last startup for this class. A class
// the engine has never started falls back to a rolling window.
function sessionStartFor(cls, now) {
  return cls?.lastActive ?? new Date(now - SESSION_FALLBACK_HOURS * 3_600_000);
}

// One row per enrolled student: Present if they have a Present log this session,
// otherwise Absent. Logged names that match no enrolled student (e.g. the engine
// fell back to local photos) are appended so their attendance isn't hidden.
// Expects session-scoped logs sorted by timestamp ascending.
function buildRoster(enrolled, logs, startMinutes) {
  const rows = [];
  const byLabel = new Map(); // engine's student_name label -> row
  for (const s of enrolled) {
    const row = {
      id: s.id,
      name: (s.full_name || "").trim() || s.id,
      enrolled: true,
      firstPresent: null,
      latest: null,
    };
    rows.push(row);
    byLabel.set(row.name, row);
    // The engine labels students who share a full_name as "Name (student_id)"
    byLabel.set(`${row.name} (${s.student_id ?? s.id})`, row);
  }

  for (const log of logs) {
    let row = byLabel.get(log.student_name);
    if (!row) {
      row = {
        id: `log:${log.student_name}`,
        name: log.student_name,
        enrolled: false,
        firstPresent: null,
        latest: null,
      };
      rows.push(row);
      byLabel.set(log.student_name, row);
    }
    if (log.status === "Present" && !row.firstPresent && log.date) {
      row.firstPresent = log.date;
    }
    row.latest = log;
  }

  return rows
    .map((r) => {
      const present = r.firstPresent !== null;
      const arrivalMinutes = present
        ? r.firstPresent.getHours() * 60 + r.firstPresent.getMinutes()
        : null;
      return {
        id: r.id,
        name: r.name,
        enrolled: r.enrolled,
        status: present ? "Present" : "Absent",
        arrival: present ? formatTime(r.firstPresent) : null,
        lastSeen: r.latest ? formatTime(r.latest.date) : null,
        late:
          present &&
          startMinutes !== null &&
          arrivalMinutes > startMinutes + LATE_GRACE_MINUTES,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Class-wide attention per minute: mean attention_score of Present logs in that minute.
function buildAttention(logs) {
  const buckets = new Map();
  for (const log of logs) {
    if (log.status !== "Present" || !log.date) continue;
    if (typeof log.attention_score !== "number") continue;
    const key = formatTime(log.date);
    const b = buckets.get(key) ?? { sum: 0, count: 0 };
    b.sum += log.attention_score;
    b.count += 1;
    buckets.set(key, b);
  }
  return [...buckets.entries()].map(([time, b]) => ({
    time,
    attention: Math.round(b.sum / b.count),
  }));
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, "0");

// Local date, e.g. "2026-10-27"
function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// Local date-time, e.g. "2026-10-27 09:01:00"
function formatDateTime(date) {
  return date ? `${formatDate(date)} ${formatTime(date, true)}` : "";
}

function csvCell(value) {
  let s = value == null ? "" : String(value);
  // Spreadsheets execute cells starting with = + - @ as formulas
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

function downloadCsv(filename, rows) {
  // BOM so Excel reads UTF-8 names (accents, non-Latin scripts) correctly
  const csv = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Class IDs are user-entered; keep filenames portable
const safeFilePart = (s) => s.replace(/[^\w.-]+/g, "_");

// Re-render periodically so "12 min ago" labels stay current and a stale
// heartbeat's Active badge drops within ~15s of crossing the threshold.
function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------------------
// Small presentational components
// ---------------------------------------------------------------------------

const VIEWS = [
  { id: "dashboard", label: "Live Dashboard" },
  { id: "admin", label: "Admin Panel" },
];

function ViewTabs({ view, onChange }) {
  return (
    <div
      role="tablist"
      className="inline-flex rounded-lg bg-white dark:bg-gray-800 p-1 text-sm ring-1 ring-slate-200 dark:ring-gray-700"
    >
      {VIEWS.map((v) => {
        const selected = v.id === view;
        return (
          <button
            key={v.id}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(v.id)}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
              selected
                ? "bg-slate-100 dark:bg-gray-700 text-slate-900 dark:text-white shadow-sm"
                : "text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200"
            }`}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

function ThemeToggle({ isDarkMode, onToggle }) {
  const label = isDarkMode ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white text-slate-500 ring-1 ring-slate-200 transition-colors hover:text-slate-900 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700 dark:hover:text-white"
    >
      {isDarkMode ? (
        // Sun: shown in dark mode, switches to light
        <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M10 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2ZM10 15a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 15ZM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM15.657 5.404a.75.75 0 1 0-1.06-1.06l-1.061 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM6.464 14.596a.75.75 0 1 0-1.06-1.06l-1.06 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM18 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 18 10ZM5 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 5 10ZM14.596 15.657a.75.75 0 0 0 1.06-1.06l-1.06-1.061a.75.75 0 1 0-1.06 1.06l1.06 1.06ZM5.404 6.464a.75.75 0 0 0 1.06-1.06l-1.06-1.06a.75.75 0 1 0-1.061 1.06l1.06 1.06Z" />
        </svg>
      ) : (
        // Moon: shown in light mode, switches to dark
        <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z"
            clipRule="evenodd"
          />
        </svg>
      )}
    </button>
  );
}

function ActiveDot({ active }) {
  if (!active) return <span className="h-2 w-2 rounded-full bg-slate-300 dark:bg-gray-600" />;
  return (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
    </span>
  );
}

function Sidebar({ classes, classesStatus, selectedClass, onSelect, onExport, now }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 md:flex">
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-gray-700 px-6 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
          DS
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-white">Dual-State</p>
          <p className="text-xs text-slate-500 dark:text-gray-400">Attendance Analytics</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <p className="px-3 pb-2 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-gray-500">
          My Classes
        </p>

        {classesStatus === "loading" && (
          <ul className="space-y-1" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="space-y-2 rounded-lg px-3 py-3">
                <div className="h-3 w-24 animate-pulse rounded bg-slate-100 dark:bg-gray-700" />
                <div className="h-2.5 w-32 animate-pulse rounded bg-slate-100 dark:bg-gray-700" />
              </li>
            ))}
          </ul>
        )}

        {classesStatus === "error" && (
          <p className="px-3 text-sm text-red-600 dark:text-red-400">Couldn't load classes.</p>
        )}

        {classesStatus === "ready" && classes.length === 0 && (
          <p className="px-3 text-sm text-slate-500 dark:text-gray-400">
            No classes yet. Create one in the Admin Panel.
          </p>
        )}

        <ul className="space-y-1">
          {classes.map((c) => {
            const active = c.id === selectedClass;
            const live = isActive(c, now);
            return (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors ${
                    active
                      ? "bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-200"
                      : "text-slate-700 dark:text-gray-300 hover:bg-slate-50 dark:hover:bg-gray-700/50"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{c.id}</span>
                    {live && (
                      <span className="rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-600/20 dark:ring-emerald-500/30">
                        Active
                      </span>
                    )}
                  </span>
                  <span
                    className={`block truncate text-xs ${active ? "text-indigo-500 dark:text-indigo-300" : "text-slate-500 dark:text-gray-400"}`}
                  >
                    {c.name}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-gray-500">
                    <ActiveDot active={live} />
                    <span title={c.lastActive?.toLocaleString()}>
                      Started {formatLastActive(c.lastActive, now)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="space-y-2 border-t border-slate-200 dark:border-gray-700 p-4">
        <button
          onClick={() => onExport("report")}
          disabled={!selectedClass}
          title="Every attendance log for this class: timestamp, student, status, attention"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <DownloadIcon /> Export Report
        </button>
        <button
          onClick={() => onExport("roster")}
          title="One row per student: status, arrival time, last seen"
          disabled={!selectedClass}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-gray-300 hover:bg-slate-50 dark:hover:bg-gray-700/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <DownloadIcon /> Export Roster
        </button>
      </div>
    </aside>
  );
}

function MobileClassPicker({ classes, classesStatus, selectedClass, onSelect, onExport, now }) {
  const placeholder =
    classesStatus === "loading"
      ? "Loading classes…"
      : classesStatus === "error"
        ? "Couldn't load classes"
        : "No classes yet";
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 md:hidden">
      <select
        value={selectedClass ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={classes.length === 0}
        className="flex-1 rounded-lg border border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-slate-800 dark:text-gray-100 disabled:text-slate-400 dark:disabled:text-gray-500"
      >
        {classes.length === 0 && <option value="">{placeholder}</option>}
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {isActive(c, now) ? "● " : ""}
            {c.id} — {c.name} · {formatLastActive(c.lastActive, now)}
          </option>
        ))}
      </select>
      <button
        onClick={() => onExport("report")}
        disabled={!selectedClass}
        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        Export Report
      </button>
    </div>
  );
}

function NoClassSelected({ classesStatus, error, onOpenAdmin }) {
  const content = {
    loading: { title: "Loading classes…", body: null },
    error: {
      title: "Couldn't load classes",
      body: `Firestore returned ${error?.code ?? "an error"}. Check that your security rules allow reading the classes collection.`,
    },
    ready: {
      title: "No classes yet",
      body: "Create a class in the Admin Panel, or start the engine with a class ID:",
    },
  }[classesStatus];

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md rounded-xl border border-dashed border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold">{content.title}</h1>
        {content.body && (
          <p className="mt-2 text-sm text-slate-500 dark:text-gray-400">{content.body}</p>
        )}
        {classesStatus === "ready" && (
          <>
            <button
              onClick={onOpenAdmin}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
            >
              Open Admin Panel
            </button>
            <pre className="mt-4 overflow-x-auto rounded-lg bg-gray-950 px-4 py-3 text-left text-xs text-gray-100">
              python dual_state_engine.py --class-id AI-101 --class-name "Introduction to AI"
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, children, footnote }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500 dark:text-gray-400">{label}</p>
      <div className="mt-2">{children}</div>
      {footnote && <p className="mt-2 text-xs text-slate-400 dark:text-gray-500">{footnote}</p>}
    </div>
  );
}

function StatusBadge({ status, late }) {
  if (status === "Absent") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 dark:bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:text-red-300 ring-1 ring-inset ring-red-600/20 dark:ring-red-500/30">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> Absent
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-600/20 dark:ring-emerald-500/30">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Present
      </span>
      {late && (
        <span className="rounded-full bg-amber-50 dark:bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-600/20 dark:ring-amber-500/30">
          Late
        </span>
      )}
    </span>
  );
}

function AttentionTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm shadow-md">
      <p className="text-xs text-slate-500 dark:text-gray-400">{label}</p>
      <p className="font-semibold text-slate-900 dark:text-white">
        {payload[0].value}
        <span className="ml-1 font-normal text-slate-500 dark:text-gray-400">attention</span>
      </p>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.69L6.28 8.47a.75.75 0 0 0-1.06 1.06l4.25 4.25a.75.75 0 0 0 1.06 0l4.25-4.25a.75.75 0 1 0-1.06-1.06l-2.97 2.97V2.75Z" />
      <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

export default function TeacherDashboard() {
  const now = useNow();
  const [isDarkMode, setIsDarkMode] = useTheme();
  const chart = CHART_COLORS[isDarkMode ? "dark" : "light"];
  const [view, setView] = useState("dashboard");
  const [selectedClass, setSelectedClass] = useState(null);
  const [filter, setFilter] = useState("All");
  const [classesFeed, setClassesFeed] = useState({
    status: "loading",
    classes: [],
    error: null,
  });
  // Tagged with the class it came from, so a switch shows "loading" instead of
  // the previous class's logs until the new listener delivers its first snapshot.
  const [feed, setFeed] = useState({ classId: null, logs: [], error: null });
  // Same tagging for the class's enrolled students
  const [studentsFeed, setStudentsFeed] = useState({
    classId: null,
    students: [],
  });

  // Real-time listener on the classes collection (docs created by the engine on startup).
  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "classes"),
      (snapshot) => {
        const classes = snapshot.docs
          .map(toClass)
          .sort((a, b) => a.id.localeCompare(b.id));
        setClassesFeed({ status: "ready", classes, error: null });
      },
      (err) => {
        console.error("classes listener failed:", err);
        setClassesFeed({ status: "error", classes: [], error: err });
      },
    );
    return unsubscribe;
  }, []);

  const { classes } = classesFeed;
  // Until the user picks one (or if their pick is deleted), show the most recently started class.
  const mostRecent = classes.reduce(
    (best, c) =>
      !best || (c.lastActive ?? 0) > (best.lastActive ?? 0) ? c : best,
    null,
  );
  const classInfo =
    classes.find((c) => c.id === selectedClass) ?? mostRecent ?? null;
  const classId = classInfo?.id ?? null;

  // Real-time listener on classes/{classId}/attendance_logs, oldest first.
  // Re-runs on class switch; the cleanup unsubscribes from the previous class.
  useEffect(() => {
    if (!classId) return undefined;
    const q = query(
      collection(db, "classes", classId, "attendance_logs"),
      orderBy("timestamp", "asc"),
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setFeed({
          classId,
          error: null,
          logs: snapshot.docs.map((doc) => {
            // "estimate" fills pending serverTimestamp() writes instead of returning null
            const data = doc.data({ serverTimestamps: "estimate" });
            return {
              id: doc.id,
              ...data,
              date: data.timestamp?.toDate?.() ?? null,
            };
          }),
        });
      },
      (err) => {
        console.error(`classes/${classId}/attendance_logs listener failed:`, err);
        setFeed({ classId, logs: [], error: err });
      },
    );
    return unsubscribe;
  }, [classId]);

  // Real-time listener on students enrolled in this class (the roster's source of truth).
  useEffect(() => {
    if (!classId) return undefined;
    const q = query(
      collection(db, "students"),
      where("enrolled_classes", "array-contains", classId),
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setStudentsFeed({
          classId,
          students: snapshot.docs.map((d) => ({ id: d.id, ...d.data() })),
        });
      },
      (err) => {
        // Roster still shows logged students; enrolled absentees just won't appear
        console.error("students listener failed:", err);
        setStudentsFeed({ classId, students: [] });
      },
    );
    return unsubscribe;
  }, [classId]);

  const loading =
    feed.classId !== classId || studentsFeed.classId !== classId;
  const allLogs = useMemo(
    () => (loading ? [] : feed.logs),
    [loading, feed.logs],
  );
  const error = loading ? null : feed.error;

  // Everything below (roster, metrics, chart, exports) covers the current session only
  const sessionStartMs = sessionStartFor(classInfo, now).getTime();
  const logs = useMemo(
    () => allLogs.filter((l) => l.date && l.date.getTime() >= sessionStartMs),
    [allLogs, sessionStartMs],
  );
  const enrolled = loading ? EMPTY : studentsFeed.students;

  const roster = useMemo(
    () => buildRoster(enrolled, logs, classStartMinutes(classInfo)),
    [enrolled, logs, classInfo],
  );
  const attention = useMemo(() => buildAttention(logs), [logs]);

  const presentCount = roster.filter((s) => s.status === "Present").length;
  const lateCount = roster.filter((s) => s.late).length;
  const presentLogs = logs.filter(
    (l) => l.status === "Present" && typeof l.attention_score === "number",
  );
  const avgAttention = presentLogs.length
    ? Math.round(
        presentLogs.reduce((sum, l) => sum + l.attention_score, 0) /
          presentLogs.length,
      )
    : 0;
  const lastSync = logs.length ? formatTime(logs[logs.length - 1].date, true) : null;

  const visibleRoster =
    filter === "All" ? roster : roster.filter((s) => s.status === filter);

  // Both cover the current session only.
  // "report": every attendance log row; "roster": one row per enrolled student
  const handleExport = (kind) => {
    if (!classId) return;
    if (loading) {
      window.alert(`Still loading ${classId}'s attendance data. Try again in a moment.`);
      return;
    }
    // A roster with nobody detected yet is still useful (everyone Absent)
    if (kind === "report" ? logs.length === 0 : roster.length === 0) {
      window.alert(
        kind === "report"
          ? `No attendance data to export for ${classId}'s current session yet.`
          : `No students are enrolled in ${classId} yet.`,
      );
      return;
    }

    const stamp = `${safeFilePart(classId)}_${formatDate(new Date(sessionStartMs))}`;
    if (kind === "report") {
      downloadCsv(`Attendance_Report_${stamp}.csv`, [
        ["Timestamp", "Student Name", "Status", "Attention Score (%)"],
        ...logs.map((l) => [
          formatDateTime(l.date),
          l.student_name ?? "",
          l.status ?? "",
          typeof l.attention_score === "number" ? l.attention_score : "",
        ]),
      ]);
    } else {
      downloadCsv(`Attendance_Roster_${stamp}.csv`, [
        ["Student Name", "Status", "Arrival Time", "Last Seen"],
        ...roster.map((s) => [s.name, s.status, s.arrival ?? "", s.lastSeen ?? ""]),
      ]);
    }
  };

  const classMeta = classInfo
    ? [
        classInfo.room,
        classInfo.startTime && `Starts ${classInfo.startTime}`,
        classInfo.lastActive
          ? `Session started ${formatLastActive(classInfo.lastActive, now)}`
          : `No session yet · showing last ${SESSION_FALLBACK_HOURS} h`,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  // Top-right controls, shared by both views
  const headerActions = (
    <div className="flex items-center gap-2">
      <ViewTabs view={view} onChange={setView} />
      <ThemeToggle
        isDarkMode={isDarkMode}
        onToggle={() => setIsDarkMode((d) => !d)}
      />
    </div>
  );

  if (view === "admin") {
    return (
      <AdminPanel
        classes={classes}
        classesStatus={classesFeed.status}
        actions={headerActions}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-900 font-sans transition-colors duration-200 text-slate-900 dark:text-white">
      <Sidebar
        classes={classes}
        classesStatus={classesFeed.status}
        selectedClass={classId}
        onSelect={setSelectedClass}
        onExport={handleExport}
        now={now}
      />

      <main className="md:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div className="mb-6 flex justify-end">{headerActions}</div>

          <MobileClassPicker
            classes={classes}
            classesStatus={classesFeed.status}
            selectedClass={classId}
            onSelect={setSelectedClass}
            onExport={handleExport}
            now={now}
          />

          {!classInfo ? (
            <NoClassSelected
              classesStatus={classesFeed.status}
              error={classesFeed.error}
              onOpenAdmin={() => setView("admin")}
            />
          ) : (
            <>
              {/* Header */}
              <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
                    {classInfo.id}
                  </p>
                  <h1 className="text-2xl font-semibold tracking-tight">
                    {classInfo.name}
                  </h1>
                  <p
                    className="mt-1 text-sm text-slate-500 dark:text-gray-400"
                    title={classInfo.lastActive?.toLocaleString()}
                  >
                    {classMeta}
                  </p>
                </div>
                {isActive(classInfo, now) && (
                  <span className="inline-flex items-center gap-2 rounded-full bg-white dark:bg-gray-800 px-3 py-1 text-xs font-medium text-slate-700 dark:text-gray-300 ring-1 ring-slate-200 dark:ring-gray-700">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                    </span>
                    Live session
                  </span>
                )}
              </header>

              {/* Top row: metrics */}
              <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatCard
                  label="Total Present"
                  footnote={`${roster.length - presentCount} absent · ${lateCount} late`}
                >
                  <p className="text-3xl font-semibold">
                    {presentCount}
                    <span className="text-lg font-normal text-slate-400 dark:text-gray-500">
                      /{roster.length}
                    </span>
                  </p>
                  <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100 dark:bg-gray-700">
                    <div
                      className="h-1.5 rounded-full bg-indigo-600"
                      style={{
                        width: `${roster.length ? (presentCount / roster.length) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </StatCard>

                <StatCard
                  label="Average Class Attention"
                  footnote="Mean across session so far"
                >
                  <p className="text-3xl font-semibold">{avgAttention}%</p>
                  <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100 dark:bg-gray-700">
                    <div
                      className="h-1.5 rounded-full bg-indigo-600"
                      style={{ width: `${avgAttention}%` }}
                    />
                  </div>
                </StatCard>

                <StatCard
                  label="System Status"
                  footnote={
                    error
                      ? error.code ?? "Listener error"
                      : `Firestore live · last log ${lastSync ?? "—"}`
                  }
                >
                  {error ? (
                    <p className="flex items-center gap-2 text-lg font-semibold text-red-600 dark:text-red-400">
                      <svg
                        className="h-5 w-5"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Connection Lost
                    </p>
                  ) : (
                    <p className="flex items-center gap-2 text-lg font-semibold text-emerald-700 dark:text-emerald-400">
                      <svg
                        className="h-5 w-5"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Pose Analytics Active
                    </p>
                  )}
                  <p className="mt-2 text-sm text-slate-500 dark:text-gray-400">
                    {loading ? "Connecting…" : `${logs.length} logs received`}
                  </p>
                </StatCard>
              </section>

              {/* Middle row: attention chart */}
              <section className="mt-6 rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold">Attention Score</h2>
                    <p className="text-sm text-slate-500 dark:text-gray-400">
                      Class-wide engagement, averaged per minute
                    </p>
                  </div>
                  <p className="text-xs text-slate-400 dark:text-gray-500">
                    Dashed line = session average
                  </p>
                </div>
                <div className="h-72 w-full">
                  {attention.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-slate-400 dark:text-gray-500">
                      {loading ? "Loading attention data…" : "No attention data yet"}
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={attention}
                        margin={{ top: 8, right: 16, bottom: 0, left: -8 }}
                      >
                        <CartesianGrid stroke={chart.grid} vertical={false} />
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 12, fill: chart.tick }}
                          tickLine={false}
                          axisLine={{ stroke: chart.axis }}
                          interval="preserveStartEnd"
                          minTickGap={24}
                        />
                        <YAxis
                          domain={[0, 100]}
                          ticks={[0, 25, 50, 75, 100]}
                          tick={{ fontSize: 12, fill: chart.tick }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <ReferenceLine
                          y={avgAttention}
                          stroke={chart.reference}
                          strokeDasharray="4 4"
                        />
                        <Tooltip
                          content={<AttentionTooltip />}
                          cursor={{ stroke: chart.cursor, strokeWidth: 1 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="attention"
                          stroke={chart.line}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 5, stroke: chart.dotRing, strokeWidth: 2 }}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </section>

              {/* Bottom row: roster table */}
              <section className="mt-6 rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-gray-700 px-5 py-4">
                  <h2 className="text-base font-semibold">Attendance Roster</h2>
                  <div className="inline-flex rounded-lg bg-slate-100 dark:bg-gray-700 p-1 text-sm">
                    {["All", "Present", "Absent"].map((f) => (
                      <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={`rounded-md px-3 py-1 font-medium transition-colors ${
                          filter === f
                            ? "bg-white dark:bg-gray-800 text-slate-900 dark:text-white shadow-sm"
                            : "text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200"
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="max-h-[28rem] overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400">
                      <tr>
                        <th className="px-5 py-3">Student Name</th>
                        <th className="px-5 py-3">Status</th>
                        <th className="px-5 py-3">Arrival Time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-gray-700/60">
                      {visibleRoster.length === 0 && (
                        <tr>
                          <td
                            colSpan={3}
                            className="px-5 py-10 text-center text-slate-400 dark:text-gray-500"
                          >
                            {loading
                              ? "Loading roster…"
                              : roster.length === 0
                                ? "No students enrolled in this class yet. Add them in the Admin Panel."
                                : "No students to show"}
                          </td>
                        </tr>
                      )}
                      {visibleRoster.map((s) => (
                        <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-gray-700/50">
                          <td className="whitespace-nowrap px-5 py-3">
                            <p className="font-medium text-slate-900 dark:text-white">{s.name}</p>
                            <p className="text-xs text-slate-400 dark:text-gray-500">
                              {s.lastSeen
                                ? `Last seen ${s.lastSeen}`
                                : "Not detected this session"}
                              {!s.enrolled && " · not enrolled"}
                            </p>
                          </td>
                          <td className="whitespace-nowrap px-5 py-3">
                            <StatusBadge status={s.status} late={s.late} />
                          </td>
                          <td className="whitespace-nowrap px-5 py-3 tabular-nums text-slate-700 dark:text-gray-300">
                            {s.arrival ?? <span className="text-slate-300 dark:text-gray-600">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
