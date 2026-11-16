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
import { CHART_COLORS } from "./theme";
import { Badge, KpiCard, PageHeading } from "./ui";
import {
  btnPrimary,
  btnSecondary,
  cardClass,
  labelClass,
  selectClass,
} from "./styles";
import ExamProctorDashboard from "./ExamProctorDashboard";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Log statuses that mean "recognized on camera". The engine stamps a student's logs
// "Late" when it first saw them more than 15 minutes into the session (see
// LATE_AFTER_MINUTES in backend/attendly_engine.py), otherwise "Present".
const DETECTED = new Set(["Present", "Late"]);

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

// The current session starts at the engine's last startup for this class. A class
// the engine has never started falls back to a rolling window.
function sessionStartFor(cls, now) {
  return cls?.lastActive ?? new Date(now - SESSION_FALLBACK_HOURS * 3_600_000);
}

// One row per enrolled student: Present or Late (as the engine stamped their first
// log this session), or Absent if they weren't recognized this session. Logged names that match no enrolled student (e.g. the engine
// fell back to local photos) are appended so their attendance isn't hidden.
// Expects session-scoped logs sorted by timestamp ascending.
function buildRoster(enrolled, logs) {
  const rows = [];
  const byLabel = new Map(); // engine's student_name label -> row
  for (const s of enrolled) {
    const row = {
      id: s.id,
      name: (s.full_name || "").trim() || s.id,
      enrolled: true,
      firstSeen: null,
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
        firstSeen: null,
        latest: null,
      };
      rows.push(row);
      byLabel.set(log.student_name, row);
    }
    if (DETECTED.has(log.status) && !row.firstSeen && log.date) {
      row.firstSeen = log;
    }
    row.latest = log;
  }

  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      enrolled: r.enrolled,
      status: r.firstSeen ? r.firstSeen.status : "Absent",
      arrival: r.firstSeen ? formatTime(r.firstSeen.date) : null,
      lastSeen: r.latest ? formatTime(r.latest.date) : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Class-wide attention per minute: mean attention_score of detected logs in that minute.
function buildAttention(logs) {
  const buckets = new Map();
  for (const log of logs) {
    if (!DETECTED.has(log.status) || !log.date) continue;
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
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
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
  { id: "proctor", label: "Exam Proctor" },
  { id: "admin", label: "Student Roster" },
];

const PORTAL_TITLE = "Academic Analytics & Exam Proctoring Portal";
const PRODUCT_NAME = "Attendly";

// Crest shown until public/college-logo.png exists (or if it fails to load)
function FallbackCrest() {
  return (
    <svg
      className="h-10 w-10 shrink-0"
      viewBox="0 0 40 40"
      role="img"
      aria-label="College crest"
    >
      <path
        d="M20 3 6 8v11c0 8.6 5.9 15.4 14 18 8.1-2.6 14-9.4 14-18V8L20 3Z"
        fill="#B91C1C"
      />
      <path
        d="m20 12-9 4 9 4 9-4-9-4Zm-5.5 6.6v4.1c0 1.6 2.5 3.3 5.5 3.3s5.5-1.7 5.5-3.3v-4.1L20 21l-5.5-2.4Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

function CollegeLogo() {
  const [failed, setFailed] = useState(false);
  if (failed) return <FallbackCrest />;
  return (
    <img
      src="/college-logo.png"
      alt="College Logo"
      className="h-12 w-auto shrink-0 object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function PortalHeader({ view, onChange, now }) {
  const today = new Date(now).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return (
    <header className="border-b border-t-4 border-slate-200 border-t-red-700 bg-white">
      <div className="flex items-center justify-between gap-4 px-4 pt-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <CollegeLogo />
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 border-l border-slate-200 pl-3 text-sm font-semibold tracking-tight text-slate-900 sm:text-base">
            <span>{PORTAL_TITLE}</span>
            <span className="font-bold text-red-700">{PRODUCT_NAME}</span>
          </p>
        </div>
        <p className="hidden shrink-0 text-xs font-medium text-slate-600 lg:block">
          {today}
        </p>
      </div>

      <nav aria-label="Portal sections" className="mt-2 px-4 sm:px-6 lg:px-8">
        <div role="tablist" className="flex gap-6 overflow-x-auto">
          {VIEWS.map((v) => {
            const selected = v.id === view;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onChange(v.id)}
                className={`whitespace-nowrap border-b-2 px-1 pb-2.5 pt-1 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 ${
                  selected
                    ? "border-red-700 font-semibold text-red-700"
                    : "border-transparent font-medium text-slate-600 hover:border-slate-300 hover:text-slate-900"
                }`}
              >
                {v.label}
              </button>
            );
          })}
        </div>
      </nav>
    </header>
  );
}

function ActiveDot({ active }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${active ? "bg-emerald-600" : "bg-slate-300"}`}
    />
  );
}

function Sidebar({ classes, classesStatus, selectedClass, onSelect, now }) {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white md:sticky md:top-0 md:flex md:h-screen md:flex-col md:self-start">
      <div className="border-b border-slate-200 px-5 py-4">
        <p className={labelClass}>My Classes</p>
      </div>

      <nav className="flex-1 overflow-y-auto py-2" aria-label="Classes">
        {classesStatus === "loading" && (
          <ul className="space-y-1" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="space-y-2 px-5 py-3">
                <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
                <div className="h-2.5 w-32 animate-pulse rounded bg-slate-100" />
              </li>
            ))}
          </ul>
        )}

        {classesStatus === "error" && (
          <p className="px-5 py-2 text-sm text-red-700">
            Couldn't load classes.
          </p>
        )}

        {classesStatus === "ready" && classes.length === 0 && (
          <p className="px-5 py-2 text-sm text-slate-600">
            No classes yet. Create one under Student Roster.
          </p>
        )}

        <ul>
          {classes.map((c) => {
            const active = c.id === selectedClass;
            const live = isActive(c, now);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  aria-current={active ? "true" : undefined}
                  className={`block w-full border-l-2 px-5 py-3 text-left transition-colors ${
                    active
                      ? "border-red-700 bg-red-50"
                      : "border-transparent hover:bg-slate-50"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span
                      className={`text-sm font-semibold ${active ? "text-red-800" : "text-slate-900"}`}
                    >
                      {c.id}
                    </span>
                    {live && (
                      <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-800">
                        Active
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-slate-600">
                    {c.name}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500 tabular-nums">
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
    </aside>
  );
}

function MobileClassPicker({
  classes,
  classesStatus,
  selectedClass,
  onSelect,
  now,
}) {
  const placeholder =
    classesStatus === "loading"
      ? "Loading classes…"
      : classesStatus === "error"
        ? "Couldn't load classes"
        : "No classes yet";
  return (
    <div className="mb-6 md:hidden">
      <label className={`${labelClass} mb-1.5 block`} htmlFor="mobile-class">
        Class
      </label>
      <select
        id="mobile-class"
        value={selectedClass ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={classes.length === 0}
        className={`${selectClass} w-full`}
      >
        {classes.length === 0 && <option value="">{placeholder}</option>}
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {isActive(c, now) ? "● " : ""}
            {c.id} — {c.name} · {formatLastActive(c.lastActive, now)}
          </option>
        ))}
      </select>
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
      body: "Create a class under Student Roster, or start the engine with a class ID:",
    },
  }[classesStatus];

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className={`${cardClass} max-w-md p-8 text-center`}>
        <h1 className="text-lg font-semibold text-slate-900">
          {content.title}
        </h1>
        {content.body && (
          <p className="mt-2 text-sm text-slate-600">{content.body}</p>
        )}
        {classesStatus === "ready" && (
          <>
            <button
              type="button"
              onClick={onOpenAdmin}
              className={`${btnPrimary} mt-4`}
            >
              Open Student Roster
            </button>
            <pre className="mt-4 overflow-x-auto rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-left font-mono text-xs text-slate-800">
              python attendly_engine.py --class-id AI-101 --class-name
              "Introduction to AI"
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

// Attendance status -> semantic badge tone
const STATUS_TONES = {
  Present: "success",
  Late: "warning",
  Absent: "danger",
};

function StatusBadge({ status }) {
  return (
    <Badge tone={STATUS_TONES[status] ?? "success"} dot>
      {status}
    </Badge>
  );
}

function AttentionTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm">
      <p className="text-xs text-slate-500 tabular-nums">{label}</p>
      <p className="font-semibold text-slate-900 tabular-nums">
        {payload[0].value}
        <span className="ml-1 font-normal text-slate-600">attention</span>
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
  const chart = CHART_COLORS;
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
        console.error(
          `classes/${classId}/attendance_logs listener failed:`,
          err,
        );
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

  const loading = feed.classId !== classId || studentsFeed.classId !== classId;
  const allLogs = useMemo(
    () => (loading ? [] : feed.logs),
    [loading, feed.logs],
  );
  const error = loading ? null : feed.error;

  // Everything below (roster, metrics, chart, exports) covers the current session only
  const logs = useMemo(() => {
    const sessionStartMs = sessionStartFor(classInfo, now).getTime();
    return allLogs.filter((l) => l.date && l.date.getTime() >= sessionStartMs);
  }, [allLogs, classInfo, now]);
  const enrolled = loading ? EMPTY : studentsFeed.students;

  const roster = useMemo(() => buildRoster(enrolled, logs), [enrolled, logs]);
  const attention = useMemo(() => buildAttention(logs), [logs]);

  // Late students still attended, so they count towards Total Present
  const presentCount = roster.filter((s) => s.status !== "Absent").length;
  const lateCount = roster.filter((s) => s.status === "Late").length;
  const presentLogs = logs.filter(
    (l) => DETECTED.has(l.status) && typeof l.attention_score === "number",
  );
  const avgAttention = presentLogs.length
    ? Math.round(
        presentLogs.reduce((sum, l) => sum + l.attention_score, 0) /
          presentLogs.length,
      )
    : 0;
  const lastSync = logs.length
    ? formatTime(logs[logs.length - 1].date, true)
    : null;

  const visibleRoster =
    filter === "All" ? roster : roster.filter((s) => s.status === filter);

  // Both cover the current session only.
  // "report": every attendance log row; "roster": one row per enrolled student
  const handleExport = (kind) => {
    if (!classId) return;
    if (loading) {
      window.alert(
        `Still loading ${classId}'s attendance data. Try again in a moment.`,
      );
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

    const stamp = `${safeFilePart(classId)}_${formatDate(sessionStartFor(classInfo, now))}`;
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
        ...roster.map((s) => [
          s.name,
          s.status,
          s.arrival ?? "",
          s.lastSeen ?? "",
        ]),
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

  let page;
  if (view === "admin") {
    page = <AdminPanel classes={classes} classesStatus={classesFeed.status} />;
  } else if (view === "proctor") {
    page = <ExamProctorDashboard />;
  } else {
    page = (
      <div className="md:flex">
        <Sidebar
          classes={classes}
          classesStatus={classesFeed.status}
          selectedClass={classId}
          onSelect={setSelectedClass}
          now={now}
        />

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <MobileClassPicker
              classes={classes}
              classesStatus={classesFeed.status}
              selectedClass={classId}
              onSelect={setSelectedClass}
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
                <PageHeading
                  eyebrow={classInfo.id}
                  title={classInfo.name}
                  description={
                    <span title={classInfo.lastActive?.toLocaleString()}>
                      {classMeta}
                    </span>
                  }
                >
                  {isActive(classInfo, now) && (
                    <span className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-800">
                      <span className="h-2 w-2 rounded-full bg-red-700" />
                      Live session
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleExport("roster")}
                    disabled={!classId}
                    title="One row per student: status, arrival time, last seen"
                    className={btnSecondary}
                  >
                    <DownloadIcon /> Export Roster (CSV)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExport("report")}
                    disabled={!classId}
                    title="Every attendance log for this class: timestamp, student, status, attention"
                    className={btnPrimary}
                  >
                    <DownloadIcon /> Export Report (CSV)
                  </button>
                </PageHeading>

                {/* Top row: metrics */}
                <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <KpiCard
                    label="Total Present"
                    footnote={`${roster.length - presentCount} absent · ${lateCount} late`}
                  >
                    <p className="text-3xl font-bold text-slate-900 tabular-nums">
                      {presentCount}
                      <span className="text-lg font-medium text-slate-400">
                        /{roster.length}
                      </span>
                    </p>
                    <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100">
                      <div
                        className="h-1.5 rounded-full bg-emerald-600"
                        style={{
                          width: `${roster.length ? (presentCount / roster.length) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </KpiCard>

                  <KpiCard
                    label="Average Class Attention"
                    footnote="Mean across session so far"
                  >
                    <p className="text-3xl font-bold text-slate-900 tabular-nums">
                      {avgAttention}%
                    </p>
                    <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100">
                      <div
                        className="h-1.5 rounded-full bg-slate-700"
                        style={{ width: `${avgAttention}%` }}
                      />
                    </div>
                  </KpiCard>

                  <KpiCard
                    label="System Status"
                    accent={error ? "crimson" : "emerald"}
                    footnote={
                      error
                        ? (error.code ?? "Listener error")
                        : `Firestore live · last log ${lastSync ?? "—"}`
                    }
                  >
                    {error ? (
                      <p className="flex items-center gap-2 text-lg font-semibold text-red-700">
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
                      <p className="flex items-center gap-2 text-lg font-semibold text-emerald-700">
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
                    <p className="mt-2 text-sm text-slate-600 tabular-nums">
                      {loading ? "Connecting…" : `${logs.length} logs received`}
                    </p>
                  </KpiCard>
                </section>

                {/* Middle row: attention chart */}
                <section className={`${cardClass} mt-6`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-5 py-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900">
                        Attention Score
                      </h2>
                      <p className="text-sm text-slate-600">
                        Class-wide engagement, averaged per minute
                      </p>
                    </div>
                    <p className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="w-5 border-t-2 border-dashed border-slate-700" />
                      Session average
                    </p>
                  </div>
                  <div className="h-72 w-full p-5">
                    {attention.length === 0 ? (
                      <div className="flex h-full items-center justify-center text-sm text-slate-500">
                        {loading
                          ? "Loading attention data…"
                          : "No attention data yet"}
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
                            activeDot={{
                              r: 5,
                              fill: chart.line,
                              stroke: chart.dotRing,
                              strokeWidth: 2,
                            }}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </section>

                {/* Bottom row: roster table */}
                <section className={`${cardClass} mt-6 overflow-hidden`}>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
                    <h2 className="text-base font-semibold text-slate-900">
                      Attendance Roster
                    </h2>
                    <div
                      role="group"
                      aria-label="Filter by status"
                      className="inline-flex overflow-hidden rounded-md border border-slate-300 bg-white text-sm shadow-xs"
                    >
                      {["All", "Present", "Late", "Absent"].map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setFilter(f)}
                          aria-pressed={filter === f}
                          className={`border-l border-slate-300 px-3 py-1.5 transition-colors first:border-l-0 ${
                            filter === f
                              ? "bg-red-50 font-semibold text-red-800"
                              : "font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                          }`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="max-h-[28rem] overflow-auto">
                    <table className="min-w-full text-sm">
                      <thead className="sticky top-0 bg-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">
                        <tr>
                          <th className="border-b border-slate-200 px-5 py-3">
                            Student Name
                          </th>
                          <th className="border-b border-slate-200 px-5 py-3">
                            Status
                          </th>
                          <th className="border-b border-slate-200 px-5 py-3">
                            Arrival Time
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {visibleRoster.length === 0 && (
                          <tr>
                            <td
                              colSpan={3}
                              className="px-5 py-10 text-center text-slate-500"
                            >
                              {loading
                                ? "Loading roster…"
                                : roster.length === 0
                                  ? "No students enrolled in this class yet. Add them under Student Roster."
                                  : "No students to show"}
                            </td>
                          </tr>
                        )}
                        {visibleRoster.map((s) => (
                          <tr key={s.id} className="hover:bg-slate-50">
                            <td className="whitespace-nowrap px-5 py-3">
                              <p className="font-medium text-slate-900">
                                {s.name}
                              </p>
                              <p className="text-xs text-slate-500 tabular-nums">
                                {s.lastSeen
                                  ? `Last seen ${s.lastSeen}`
                                  : "Not detected this session"}
                                {!s.enrolled && " · not enrolled"}
                              </p>
                            </td>
                            <td className="whitespace-nowrap px-5 py-3">
                              <StatusBadge status={s.status} />
                            </td>
                            <td className="whitespace-nowrap px-5 py-3 tabular-nums text-slate-700">
                              {s.arrival ?? (
                                <span className="text-slate-400">—</span>
                              )}
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

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <PortalHeader view={view} onChange={setView} now={now} />
      {page}
    </div>
  );
}
