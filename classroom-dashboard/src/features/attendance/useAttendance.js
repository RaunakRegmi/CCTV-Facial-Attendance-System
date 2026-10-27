import { useEffect, useMemo, useState } from 'react';
import { api, poll, loadLogs } from '../../shared/api';
import { toClass, useNow, sessionStartFor, buildRoster, classStartMinutes, buildAttention, formatTime, formatDateTime, formatDate, downloadCsv, safeFilePart, formatLastActive, SESSION_FALLBACK_HOURS, EMPTY } from './attendance';

export function useAttendance() {
  const now = useNow();
  const [selectedClass, setSelectedClass] = useState(null);
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState("");
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

  useEffect(() => poll(
    signal => api('/classes', { signal }),
    data => setClassesFeed({ status: 'ready', classes: data.map(toClass).sort((a, b) => a.id.localeCompare(b.id)), error: null }),
    error => setClassesFeed({ status: 'error', classes: [], error }),
  ), [refreshKey]);

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

  useEffect(() => {
    if (!classId) return undefined;
    return poll(
      signal => Promise.all([
        loadLogs(classId, signal),
        api(`/students?class_id=${encodeURIComponent(classId)}`, { signal }),
      ]),
      ([logs, students]) => {
        setFeed({ classId, logs, error: null });
        setStudentsFeed({ classId, students });
      },
      error => {
        setFeed({ classId, logs: [], error });
        setStudentsFeed({ classId, students: [] });
      },
    );
  }, [classId, refreshKey]);

  const loading = classesFeed.status === "loading" ||
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
    roster.filter(s => (filter === "All" || (filter === "Late" ? s.late : s.status === filter)) && `${s.name} ${s.id}`.toLowerCase().includes(search.toLowerCase()));

  // Both cover the current session only.
  // "report": every attendance log row; "roster": one row per enrolled student
  const handleExport = (kind) => {
    setNotice("");
    if (!classId) return;
    if (error) { setNotice("Data is unavailable. Retry before exporting."); return; }
    if (loading) {
      setNotice(`Still loading ${classId}'s attendance data. Try again in a moment.`);
      return;
    }
    // A roster with nobody detected yet is still useful (everyone Absent)
    if (kind === "report" ? logs.length === 0 : roster.length === 0) {
      setNotice(
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

  return { now, classes, classesFeed, classInfo, classId, setSelectedClass, filter, setFilter, search, setSearch,
    loading, error, roster, visibleRoster, attention, presentCount, lateCount, avgAttention, lastSync,
    logs, classMeta, handleExport, notice, refresh: () => setRefreshKey(key => key + 1) };
}
