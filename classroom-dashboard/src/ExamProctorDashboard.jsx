import React, { useEffect, useState, useMemo } from "react";
import { collection, query, orderBy, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

export default function ExamProctorDashboard() {
  const [violations, setViolations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedExam, setSelectedExam] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [activeAlert, setActiveAlert] = useState(null);
  const [updatingId, setUpdatingId] = useState(null);

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
    const phones = filteredViolations.filter((v) =>
      v.violation_type?.toLowerCase().includes("phone"),
    ).length;
    const gaze = filteredViolations.filter((v) =>
      v.violation_type?.toLowerCase().includes("gaze"),
    ).length;
    return { total, unreviewed, phones, gaze };
  }, [filteredViolations]);

  // Send status update through FastAPI write proxy
  const handleUpdateStatus = async (violationId, newStatus) => {
    setUpdatingId(violationId);
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

  const getStatusBadgeStyle = (status) => {
    switch (status) {
      case "Confirmed":
        return "bg-red-950/70 text-red-400 border-red-800/60";
      case "Dismissed":
        return "bg-zinc-900 text-zinc-500 border-zinc-800";
      default:
        return "bg-amber-950/70 text-amber-400 border-amber-800/60";
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-zinc-100 font-sans p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header & Filters */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800 pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <h1 className="text-xl font-semibold tracking-tight text-white">
                Exam Proctor Monitor
              </h1>
            </div>
            <p className="text-sm text-zinc-400 mt-1">
              Real-time AI anomaly feed and annotated frame evidence
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              value={selectedExam}
              onChange={(e) => setSelectedExam(e.target.value)}
              className="bg-[#141414] border border-zinc-800 text-zinc-200 text-sm rounded-md px-3 py-2 focus:outline-none focus:border-zinc-600"
            >
              {examIds.map((id) => (
                <option key={id} value={id}>
                  {id === "ALL" ? "All Exam Sessions" : id}
                </option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-[#141414] border border-zinc-800 text-zinc-200 text-sm rounded-md px-3 py-2 focus:outline-none focus:border-zinc-600"
            >
              <option value="ALL">All Statuses</option>
              <option value="Unreviewed">Unreviewed</option>
              <option value="Confirmed">Confirmed</option>
              <option value="Dismissed">Dismissed</option>
            </select>
          </div>
        </div>

        {/* Flat KPI Strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-[#141414] border border-zinc-800/90 rounded-lg p-4">
            <p className="text-xs uppercase tracking-wider text-zinc-500">
              Total Flags
            </p>
            <p className="text-2xl font-semibold text-white mt-1">
              {stats.total}
            </p>
          </div>
          <div className="bg-[#141414] border border-zinc-800/90 rounded-lg p-4">
            <p className="text-xs uppercase tracking-wider text-zinc-500">
              Pending Review
            </p>
            <p className="text-2xl font-semibold text-amber-400 mt-1">
              {stats.unreviewed}
            </p>
          </div>
          <div className="bg-[#141414] border border-zinc-800/90 rounded-lg p-4">
            <p className="text-xs uppercase tracking-wider text-zinc-500">
              Device Detections
            </p>
            <p className="text-2xl font-semibold text-red-400 mt-1">
              {stats.phones}
            </p>
          </div>
          <div className="bg-[#141414] border border-zinc-800/90 rounded-lg p-4">
            <p className="text-xs uppercase tracking-wider text-zinc-500">
              Gaze Anomalies
            </p>
            <p className="text-2xl font-semibold text-zinc-200 mt-1">
              {stats.gaze}
            </p>
          </div>
        </div>

        {/* Violations Feed */}
        {loading ? (
          <div className="bg-[#141414] border border-zinc-800 rounded-lg p-12 text-center text-zinc-500 text-sm">
            Connecting to live proctoring stream...
          </div>
        ) : filteredViolations.length === 0 ? (
          <div className="bg-[#141414] border border-zinc-800 rounded-lg p-12 text-center">
            <p className="text-zinc-300 font-medium">No anomalies recorded</p>
            <p className="text-zinc-500 text-sm mt-1">
              Active alerts from proctor_engine.py will appear here
              automatically.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredViolations.map((item) => (
              <div
                key={item.id}
                className="bg-[#141414] border border-zinc-800 hover:border-zinc-700 transition-colors rounded-lg overflow-hidden flex flex-col"
              >
                {/* Base64 Evidence Thumbnail */}
                <button
                  type="button"
                  onClick={() => setActiveAlert(item)}
                  className="relative group w-full aspect-video bg-black overflow-hidden text-left focus:outline-none"
                >
                  {item.evidence_snapshot ? (
                    <img
                      src={item.evidence_snapshot}
                      alt={item.violation_type}
                      className="w-full h-full object-cover group-hover:opacity-90 transition-opacity"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-zinc-600">
                      No Snapshot Available
                    </div>
                  )}
                  <span className="absolute bottom-2 right-2 bg-black/80 text-zinc-200 text-[11px] px-2 py-0.5 rounded border border-zinc-700">
                    Inspect Frame
                  </span>
                </button>

                {/* Alert Metadata */}
                <div className="p-4 flex-1 flex flex-col justify-between space-y-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-zinc-400">
                        {item.exam_id} • {formatTime(item.timestamp)}
                      </span>
                      <span
                        className={`text-[11px] font-medium px-2 py-0.5 rounded border ${getStatusBadgeStyle(
                          item.status,
                        )}`}
                      >
                        {item.status || "Unreviewed"}
                      </span>
                    </div>

                    <h3 className="text-sm font-semibold text-white mt-2">
                      {item.violation_type}
                    </h3>
                    <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                      {item.details}
                    </p>
                  </div>

                  {/* Quick Review Actions */}
                  <div className="pt-3 border-t border-zinc-800/80 flex items-center justify-between gap-2">
                    <span className="text-xs text-zinc-500">
                      Conf: {Math.round((item.confidence || 0) * 100)}%
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={updatingId === item.id}
                        onClick={() => handleUpdateStatus(item.id, "Dismissed")}
                        className="px-2.5 py-1 text-xs rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 disabled:opacity-50"
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        disabled={updatingId === item.id}
                        onClick={() => handleUpdateStatus(item.id, "Confirmed")}
                        className="px-2.5 py-1 text-xs rounded bg-red-950 hover:bg-red-900 text-red-200 border border-red-800 disabled:opacity-50"
                      >
                        Confirm
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Fullscreen Evidence Inspection Modal */}
      {activeAlert && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4"
          onClick={() => setActiveAlert(null)}
        >
          <div
            className="bg-[#141414] border border-zinc-800 rounded-lg max-w-3xl w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800">
              <div>
                <h2 className="text-base font-semibold text-white">
                  {activeAlert.violation_type}
                </h2>
                <p className="text-xs text-zinc-400">
                  {activeAlert.exam_id} •{" "}
                  {new Date(activeAlert.timestamp).toLocaleString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveAlert(null)}
                className="text-zinc-400 hover:text-white text-sm px-2 py-1"
              >
                Close [ESC]
              </button>
            </div>

            <div className="bg-black flex items-center justify-center max-h-[65vh] overflow-hidden">
              <img
                src={activeAlert.evidence_snapshot}
                alt="Violation Evidence"
                className="w-full h-auto object-contain"
              />
            </div>

            <div className="p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-t border-zinc-800">
              <div className="space-y-1">
                <p className="text-sm text-zinc-200">{activeAlert.details}</p>
                <p className="text-xs text-zinc-500">
                  Model Confidence:{" "}
                  {Math.round((activeAlert.confidence || 0) * 100)}% • Current
                  Status: {activeAlert.status}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={updatingId === activeAlert.id}
                  onClick={() =>
                    handleUpdateStatus(activeAlert.id, "Dismissed")
                  }
                  className="px-3.5 py-2 text-xs font-medium rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700"
                >
                  Dismiss False Positive
                </button>
                <button
                  type="button"
                  disabled={updatingId === activeAlert.id}
                  onClick={() =>
                    handleUpdateStatus(activeAlert.id, "Confirmed")
                  }
                  className="px-3.5 py-2 text-xs font-medium rounded bg-red-600 hover:bg-red-500 text-white"
                >
                  Confirm Violation
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
