import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
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
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Students whose first "Present" log is later than class start + this are marked late.
const LATE_GRACE_MINUTES = 5;

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

// One roster row per student: latest log decides status, first Present log is arrival.
// Expects logs sorted by timestamp ascending.
function buildRoster(logs, startMinutes) {
  const byStudent = new Map();
  for (const log of logs) {
    const entry = byStudent.get(log.student_name) ?? {
      id: log.student_name,
      name: log.student_name,
      firstPresent: null,
      latest: null,
    };
    if (log.status === "Present" && !entry.firstPresent && log.date) {
      entry.firstPresent = log.date;
    }
    entry.latest = log;
    byStudent.set(log.student_name, entry);
  }

  return [...byStudent.values()]
    .map((e) => {
      const present = e.latest.status === "Present";
      const arrivalMinutes = e.firstPresent
        ? e.firstPresent.getHours() * 60 + e.firstPresent.getMinutes()
        : null;
      return {
        id: e.id,
        name: e.name,
        status: present ? "Present" : "Absent",
        arrival: present ? formatTime(e.firstPresent) : null,
        lastSeen: formatTime(e.latest.date),
        late:
          present &&
          startMinutes !== null &&
          arrivalMinutes !== null &&
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

function ActiveDot({ active }) {
  if (!active) return <span className="h-2 w-2 rounded-full bg-slate-300" />;
  return (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
    </span>
  );
}

function Sidebar({ classes, classesStatus, selectedClass, onSelect, onExport, now }) {
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

        {classesStatus === "loading" && (
          <ul className="space-y-1" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="space-y-2 rounded-lg px-3 py-3">
                <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
                <div className="h-2.5 w-32 animate-pulse rounded bg-slate-100" />
              </li>
            ))}
          </ul>
        )}

        {classesStatus === "error" && (
          <p className="px-3 text-sm text-red-600">Couldn't load classes.</p>
        )}

        {classesStatus === "ready" && classes.length === 0 && (
          <p className="px-3 text-sm text-slate-500">
            No classes yet. Start the engine with a <code>--class-id</code> to
            create one.
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
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{c.id}</span>
                    {live && (
                      <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                        Active
                      </span>
                    )}
                  </span>
                  <span
                    className={`block truncate text-xs ${active ? "text-indigo-500" : "text-slate-500"}`}
                  >
                    {c.name}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
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

      <div className="space-y-2 border-t border-slate-200 p-4">
        <button
          onClick={() => onExport("csv")}
          disabled={!selectedClass}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <DownloadIcon /> Export CSV
        </button>
        <button
          onClick={() => onExport("pdf")}
          disabled={!selectedClass}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <DownloadIcon /> Export Report
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
        className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 disabled:text-slate-400"
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
        onClick={() => onExport("csv")}
        disabled={!selectedClass}
        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        Export
      </button>
    </div>
  );
}

function NoClassSelected({ classesStatus, error }) {
  const content = {
    loading: { title: "Loading classes…", body: null },
    error: {
      title: "Couldn't load classes",
      body: `Firestore returned ${error?.code ?? "an error"}. Check that your security rules allow reading the classes collection.`,
    },
    ready: {
      title: "No classes yet",
      body: "Classes appear here automatically once the engine starts with a class ID:",
    },
  }[classesStatus];

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold">{content.title}</h1>
        {content.body && (
          <p className="mt-2 text-sm text-slate-500">{content.body}</p>
        )}
        {classesStatus === "ready" && (
          <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 text-left text-xs text-slate-100">
            python dual_state_engine.py --class-id AI-101 --class-name "Introduction to AI"
          </pre>
        )}
      </div>
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

  const loading = feed.classId !== classId;
  const logs = useMemo(() => (loading ? [] : feed.logs), [loading, feed.logs]);
  const error = loading ? null : feed.error;

  const roster = useMemo(
    () => buildRoster(logs, classStartMinutes(classInfo)),
    [logs, classInfo],
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

  const handleExport = (format) => {
    if (!classId) return;
    if (format !== "csv") {
      // TODO: wire to backend report endpoint
      console.log(`Export ${format} requested for ${classId}`);
      return;
    }
    const escape = (v) => `"${String(v).replaceAll('"', '""')}"`;
    const rows = [
      ["Student Name", "Status", "Arrival Time", "Last Seen"],
      ...roster.map((s) => [s.name, s.status, s.arrival ?? "", s.lastSeen ?? ""]),
    ];
    const csv = rows.map((r) => r.map(escape).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${classId}-attendance.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const classMeta = classInfo
    ? [
        classInfo.room,
        classInfo.startTime && `Starts ${classInfo.startTime}`,
        `Engine started ${formatLastActive(classInfo.lastActive, now)}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
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
            />
          ) : (
            <>
              {/* Header */}
              <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-indigo-600">
                    {classInfo.id}
                  </p>
                  <h1 className="text-2xl font-semibold tracking-tight">
                    {classInfo.name}
                  </h1>
                  <p
                    className="mt-1 text-sm text-slate-500"
                    title={classInfo.lastActive?.toLocaleString()}
                  >
                    {classMeta}
                  </p>
                </div>
                {isActive(classInfo, now) && (
                  <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
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
                    <span className="text-lg font-normal text-slate-400">
                      /{roster.length}
                    </span>
                  </p>
                  <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100">
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
                  <div className="mt-3 h-1.5 w-full rounded-full bg-slate-100">
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
                  <p className="mt-2 text-sm text-slate-500">
                    {loading ? "Connecting…" : `${logs.length} logs received`}
                  </p>
                </StatCard>
              </section>

              {/* Middle row: attention chart */}
              <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold">Attention Score</h2>
                    <p className="text-sm text-slate-500">
                      Class-wide engagement, averaged per minute
                    </p>
                  </div>
                  <p className="text-xs text-slate-400">
                    Dashed line = session average
                  </p>
                </div>
                <div className="h-72 w-full">
                  {attention.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-slate-400">
                      {loading ? "Loading attention data…" : "No attention data yet"}
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={attention}
                        margin={{ top: 8, right: 16, bottom: 0, left: -8 }}
                      >
                        <CartesianGrid stroke="#f1f5f9" vertical={false} />
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 12, fill: "#64748b" }}
                          tickLine={false}
                          axisLine={{ stroke: "#e2e8f0" }}
                          interval="preserveStartEnd"
                          minTickGap={24}
                        />
                        <YAxis
                          domain={[0, 100]}
                          ticks={[0, 25, 50, 75, 100]}
                          tick={{ fontSize: 12, fill: "#64748b" }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <ReferenceLine
                          y={avgAttention}
                          stroke="#94a3b8"
                          strokeDasharray="4 4"
                        />
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
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
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
                          filter === f
                            ? "bg-white text-slate-900 shadow-sm"
                            : "text-slate-500 hover:text-slate-700"
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
                      {visibleRoster.length === 0 && (
                        <tr>
                          <td
                            colSpan={3}
                            className="px-5 py-10 text-center text-slate-400"
                          >
                            {loading ? "Loading roster…" : "No students to show"}
                          </td>
                        </tr>
                      )}
                      {visibleRoster.map((s) => (
                        <tr key={s.id} className="hover:bg-slate-50">
                          <td className="whitespace-nowrap px-5 py-3">
                            <p className="font-medium text-slate-900">{s.name}</p>
                            <p className="text-xs text-slate-400">
                              Last seen {s.lastSeen ?? "—"}
                            </p>
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
            </>
          )}
        </div>
      </main>
    </div>
  );
}
