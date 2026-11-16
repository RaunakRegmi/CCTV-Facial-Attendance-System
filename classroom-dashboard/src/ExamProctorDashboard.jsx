import { useEffect, useState, useMemo } from "react";
import { collection, query, orderBy, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import { Badge, KpiCard, PageHeading } from "./ui";
import {
  btnPrimary,
  btnPrimarySm,
  btnSecondary,
  btnSecondarySm,
  cardClass,
  labelClass,
  selectClass,
} from "./styles";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

export default function ExamProctorDashboard() {
  const [violations, setViolations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedExam, setSelectedExam] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [activeAlert, setActiveAlert] = useState(null);
  const [updatingId, setUpdatingId] = useState(null);
  const [updateError, setUpdateError] = useState(null);

  // Real-time Firestore listener for exam_violations
  useEffect(() => {
    const q = query(
      collection(db, "exam_violations"),
      orderBy("timestamp", "desc"),
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const items = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        setViolations(items);
        setLoading(false);
      },
      (error) => {
        console.error("Firestore listener error:", error);
        setLoading(false);
      },
    );

    return () => unsubscribe();
  }, []);

  // Close the inspection modal with ESC
  useEffect(() => {
    if (!activeAlert) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") setActiveAlert(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeAlert]);

  // Extract unique Exam IDs for the filter dropdown
  const examIds = useMemo(() => {
    const ids = new Set(violations.map((v) => v.exam_id).filter(Boolean));
    return ["ALL", ...Array.from(ids)];
  }, [violations]);

  // Filtered alert list
  const filteredViolations = useMemo(() => {
    return violations.filter((item) => {
      const matchesExam =
        selectedExam === "ALL" || item.exam_id === selectedExam;
      const matchesStatus =
        statusFilter === "ALL" || item.status === statusFilter;
      return matchesExam && matchesStatus;
    });
  }, [violations, selectedExam, statusFilter]);

  // Summary metrics
  const stats = useMemo(() => {
    const total = filteredViolations.length;
    const unreviewed = filteredViolations.filter(
      (v) => v.status === "Unreviewed",
    ).length;
    // "Contraband: Mobile Phone / Chit Paper / Smartwatch / Earbuds" from proctor_engine.py
    const phones = filteredViolations.filter((v) => {
      const type = v.violation_type?.toLowerCase() ?? "";
      return type.startsWith("contraband") || type.includes("phone");
    }).length;
    const gaze = filteredViolations.filter((v) =>
      v.violation_type?.toLowerCase().includes("gaze"),
    ).length;
    return { total, unreviewed, phones, gaze };
  }, [filteredViolations]);

  // Send status update through FastAPI write proxy
  const handleUpdateStatus = async (violationId, newStatus) => {
    setUpdatingId(violationId);
    setUpdateError(null);
    try {
      const res = await fetch(
        `${API_URL}/api/exams/violations/${violationId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus }),
        },
      );
      if (!res.ok) throw new Error("Failed to update status");

      if (activeAlert && activeAlert.id === violationId) {
        setActiveAlert((prev) => ({ ...prev, status: newStatus }));
      }
    } catch (err) {
      console.error("Status update error:", err);
      setUpdateError(
        err instanceof TypeError
          ? `Can't reach the API at ${API_URL}. Is it running?`
          : `Couldn't mark the alert as ${newStatus}. Please try again.`,
      );
    } finally {
      setUpdatingId(null);
    }
  };

  const formatTime = (isoString) => {
    if (!isoString) return "—";
    const date = new Date(isoString);
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  // Review status -> badge tone. A dismissed alert means the student was cleared.
  const statusTone = (status) => {
    switch (status) {
      case "Confirmed":
        return "danger";
      case "Dismissed":
        return "success";
      default:
        return "warning";
    }
  };

  // Contraband is a crimson alert; gaze / head-turn is an attention warning
  const violationTone = (type) => {
    const t = type?.toLowerCase() ?? "";
    if (t.startsWith("contraband") || t.includes("phone")) return "danger";
    if (t.includes("gaze")) return "warning";
    return "neutral";
  };

  const isUnreviewed = (item) => !item.status || item.status === "Unreviewed";

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeading
        eyebrow="Examination Integrity"
        title="Exam Proctor Monitor"
        description="Real-time AI anomaly feed with annotated frame evidence for invigilator review."
      >
        <span className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-800">
          <span className="h-2 w-2 rounded-full bg-red-700" />
          Live feed
        </span>
      </PageHeading>

      {/* Filters */}
      <div className={`${cardClass} mb-6 flex flex-wrap items-end gap-4 px-5 py-4`}>
        <label className="block">
          <span className={`${labelClass} mb-1.5 block`}>Exam session</span>
          <select
            value={selectedExam}
            onChange={(e) => setSelectedExam(e.target.value)}
            className={`${selectClass} min-w-[12rem]`}
          >
            {examIds.map((id) => (
              <option key={id} value={id}>
                {id === "ALL" ? "All Exam Sessions" : id}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className={`${labelClass} mb-1.5 block`}>Review status</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className={`${selectClass} min-w-[10rem]`}
          >
            <option value="ALL">All Statuses</option>
            <option value="Unreviewed">Unreviewed</option>
            <option value="Confirmed">Confirmed</option>
            <option value="Dismissed">Dismissed</option>
          </select>
        </label>

        <p className="ml-auto text-sm text-slate-600 tabular-nums">
          Showing {filteredViolations.length} of {violations.length} alerts
        </p>
      </div>

      {updateError && (
        <div
          role="alert"
          className="mb-6 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-800"
        >
          <span>{updateError}</span>
          <button
            type="button"
            onClick={() => setUpdateError(null)}
            className="text-xs font-semibold text-red-700 underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* KPI summary */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Total Flags" accent="slate">
          <p className="text-3xl font-bold text-slate-900 tabular-nums">
            {stats.total}
          </p>
        </KpiCard>
        <KpiCard label="Pending Review" accent="amber">
          <p className="text-3xl font-bold text-slate-900 tabular-nums">
            {stats.unreviewed}
          </p>
        </KpiCard>
        <KpiCard label="Device Detections" accent="crimson">
          <p className="text-3xl font-bold text-slate-900 tabular-nums">
            {stats.phones}
          </p>
        </KpiCard>
        <KpiCard label="Gaze Anomalies" accent="amber">
          <p className="text-3xl font-bold text-slate-900 tabular-nums">
            {stats.gaze}
          </p>
        </KpiCard>
      </div>

      {/* Violations feed */}
      {loading ? (
        <div className={`${cardClass} p-12 text-center text-sm text-slate-500`}>
          Connecting to live proctoring stream…
        </div>
      ) : filteredViolations.length === 0 ? (
        <div className={`${cardClass} p-12 text-center`}>
          <p className="font-semibold text-slate-900">No anomalies recorded</p>
          <p className="mt-1 text-sm text-slate-600">
            Alerts from proctor_engine.py will appear here automatically.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredViolations.map((item) => (
            <article
              key={item.id}
              className={`${cardClass} flex flex-col overflow-hidden transition-shadow hover:shadow-sm ${
                isUnreviewed(item) ? "border-l-4 border-l-red-700" : ""
              }`}
            >
              {/* Evidence thumbnail */}
              <button
                type="button"
                onClick={() => setActiveAlert(item)}
                className="group relative aspect-video w-full overflow-hidden border-b border-slate-200 bg-slate-100 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-red-700"
                aria-label={`Inspect evidence for ${item.student_name || "Unidentified Student"}`}
              >
                {item.evidence_snapshot ? (
                  <img
                    src={item.evidence_snapshot}
                    alt={item.violation_type}
                    className="h-full w-full object-cover transition-opacity group-hover:opacity-90"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-slate-500">
                    No Snapshot Available
                  </div>
                )}
                <span className="absolute bottom-2 right-2 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 shadow-xs">
                  Inspect Frame
                </span>
              </button>

              {/* Alert metadata */}
              <div className="flex flex-1 flex-col justify-between gap-4 p-4">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-slate-500 tabular-nums">
                      {item.exam_id} · {formatTime(item.timestamp)}
                    </span>
                    <Badge tone={statusTone(item.status)}>
                      {item.status || "Unreviewed"}
                    </Badge>
                  </div>

                  <p className="mt-3 truncate text-sm font-semibold text-slate-900">
                    {item.student_name || "Unidentified Student"}
                  </p>
                  <p className="text-xs text-slate-500 tabular-nums">
                    ID {item.student_id || "—"}
                  </p>

                  <div className="mt-3">
                    <Badge tone={violationTone(item.violation_type)} dot>
                      {item.violation_type}
                    </Badge>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs text-slate-600">
                    {item.details}
                  </p>
                </div>

                {/* Quick review actions */}
                <div className="flex items-center justify-between gap-2 border-t border-slate-200 pt-3">
                  <span className="text-xs text-slate-600">
                    Confidence{" "}
                    <span className="font-semibold text-slate-900 tabular-nums">
                      {Math.round((item.confidence || 0) * 100)}%
                    </span>
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={updatingId === item.id}
                      onClick={() => handleUpdateStatus(item.id, "Dismissed")}
                      className={btnSecondarySm}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      disabled={updatingId === item.id}
                      onClick={() => handleUpdateStatus(item.id, "Confirmed")}
                      className={btnPrimarySm}
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Evidence inspection modal */}
      {activeAlert && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
          onClick={() => setActiveAlert(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="evidence-title"
            className="w-full max-w-3xl overflow-hidden rounded-md border border-slate-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-t-4 border-slate-200 border-t-red-700 px-5 py-4">
              <div className="min-w-0">
                <p className={labelClass}>Evidence Review</p>
                <h2
                  id="evidence-title"
                  className="mt-1 text-lg font-semibold text-slate-900"
                >
                  {activeAlert.violation_type}
                </h2>
                <p className="text-xs text-slate-600 tabular-nums">
                  {activeAlert.exam_id} ·{" "}
                  {new Date(activeAlert.timestamp).toLocaleString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveAlert(null)}
                className={btnSecondarySm}
              >
                Close (Esc)
              </button>
            </div>

            <div className="flex max-h-[65vh] items-center justify-center overflow-hidden border-b border-slate-200 bg-slate-100">
              {activeAlert.evidence_snapshot ? (
                <img
                  src={activeAlert.evidence_snapshot}
                  alt="Violation Evidence"
                  className="h-auto max-h-[65vh] w-full object-contain"
                />
              ) : (
                <div className="py-24 text-sm text-slate-500">
                  No Snapshot Available
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    {activeAlert.student_name || "Unidentified Student"}
                  </span>
                  <span className="text-xs text-slate-500 tabular-nums">
                    ID {activeAlert.student_id || "—"}
                  </span>
                  <Badge tone={statusTone(activeAlert.status)}>
                    {activeAlert.status || "Unreviewed"}
                  </Badge>
                </div>
                <p className="text-sm text-slate-700">{activeAlert.details}</p>
                <p className="text-xs text-slate-600">
                  Model confidence{" "}
                  <span className="font-semibold text-slate-900 tabular-nums">
                    {Math.round((activeAlert.confidence || 0) * 100)}%
                  </span>
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  disabled={updatingId === activeAlert.id}
                  onClick={() =>
                    handleUpdateStatus(activeAlert.id, "Dismissed")
                  }
                  className={btnSecondary}
                >
                  Dismiss / False Alarm
                </button>
                <button
                  type="button"
                  disabled={updatingId === activeAlert.id}
                  onClick={() =>
                    handleUpdateStatus(activeAlert.id, "Confirmed")
                  }
                  className={btnPrimary}
                >
                  Confirm Violation
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
