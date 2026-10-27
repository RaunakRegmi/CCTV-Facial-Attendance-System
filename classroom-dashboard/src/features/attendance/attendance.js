import { useEffect, useState } from "react";

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
function toClass(data) {
  return {
    id: data.id,
    name: data.class_name || data.id,
    room: data.room ?? null,
    startTime: data.start_time ?? null,
    lastActive: data.last_active_startup ? new Date(data.last_active_startup) : null,
    heartbeat: data.last_heartbeat ? new Date(data.last_heartbeat) : null,
    shutdown: data.last_shutdown ? new Date(data.last_shutdown) : null,
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


export { toClass, isActive, formatTime, formatLastActive, classStartMinutes, sessionStartFor, buildRoster, buildAttention, formatDate, formatDateTime, csvCell, downloadCsv, safeFilePart, useNow, SESSION_FALLBACK_HOURS, EMPTY };
