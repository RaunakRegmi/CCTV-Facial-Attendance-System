import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "./firebase";

// ---------------------------------------------------------------------------
// Config & helpers
// ---------------------------------------------------------------------------

// Reads come straight from Firestore; writes go through the FastAPI backend
// (backend/api.py) because the Firestore rules deny all client writes.
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

// fetch() wrapper: throws with FastAPI's error detail on a non-2xx response.
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Can't reach the API at ${API_URL}. Is it running?`);
  }
  if (res.ok) return res.status === 204 ? null : res.json();

  const data = await res.json().catch(() => null);
  const detail = data?.detail;
  // 422 validation errors come back as a list of { loc, msg }
  const message = Array.isArray(detail)
    ? detail.map((d) => `${d.loc.at(-1)}: ${d.msg}`).join("; ")
    : detail || `HTTP ${res.status}`;
  const err = new Error(message);
  err.status = res.status;
  throw err;
}

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_UPLOAD_MB = 15; // raw file limit; it's shrunk before saving
const PHOTO_MAX_SIDE = 400; // px, longest side after resize
const PHOTO_JPEG_QUALITY = 0.85;
// Firestore caps a document at 1 MiB; leave room for the other fields
const MAX_PHOTO_CHARS = 900_000;

// Firestore doc IDs: no "/", not "." or "..", not __reserved__.
function idError(value, label) {
  if (!value) return `${label} is required.`;
  if (value.includes("/")) return `${label} can't contain "/".`;
  if (value === "." || value === "..") return `${label} can't be "." or "..".`;
  if (/^__.*__$/.test(value)) return `${label} can't start and end with "__".`;
  if (value.length > 100) return `${label} must be 100 characters or fewer.`;
  return null;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't decode image"));
    img.src = src;
  });
}

// File -> "data:image/jpeg;base64,..." scaled to fit PHOTO_MAX_SIDE (never upscaled).
async function compressPhoto(file) {
  const img = await loadImage(await readAsDataUrl(file));
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.width, img.height));
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  // JPEG has no alpha: paint white first so transparent PNG areas don't turn black
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);

  return {
    dataUrl: canvas.toDataURL("image/jpeg", PHOTO_JPEG_QUALITY),
    width,
    height,
  };
}

function formatKb(chars) {
  return `${Math.round(chars / 1024)} KB`;
}

// ---------------------------------------------------------------------------
// Small presentational components
// ---------------------------------------------------------------------------

function Card({ title, description, children }) {
  return (
    <section className="rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900 dark:text-white">
        {title}
      </h2>
      {description && (
        <p className="mt-1 text-sm text-slate-500 dark:text-gray-400">
          {description}
        </p>
      )}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700 dark:text-gray-300">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
      {hint && (
        <span className="mt-1 block text-xs text-slate-400 dark:text-gray-500">
          {hint}
        </span>
      )}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-900 px-3 py-2 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50";

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
        className="opacity-25"
      />
      <path
        d="M4 12a8 8 0 0 1 8-8"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SubmitButton({ busy, busyLabel, disabled, children }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {busy && <Spinner />}
      {busy ? busyLabel : children}
    </button>
  );
}

function TrashIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function StatusMessage({ status }) {
  if (!status) return null;
  const tone =
    status.type === "error"
      ? "border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300"
      : "border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return (
    <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${tone}`}>
      {status.text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Add Class
// ---------------------------------------------------------------------------

function AddClassForm({ classes }) {
  const [form, setForm] = useState({ classId: "", className: "", room: "" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  const update = (field) => (e) =>
    setForm({ ...form, [field]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    const classId = form.classId.trim();
    const className = form.className.trim();
    const room = form.room.trim();

    const error =
      idError(classId, "Class ID") ?? (!className && "Class name is required.");
    if (error) return setStatus({ type: "error", text: error });

    setBusy(true);
    setStatus(null);
    try {
      // The API refuses an existing ID (409), so the engine's fields are never clobbered
      await api("POST", "/api/classes", {
        class_id: classId,
        class_name: className,
        room: room || null,
      });
      setStatus({
        type: "success",
        text: `Created ${classId} — ${className}.`,
      });
      setForm({ classId: "", className: "", room: "" });
    } catch (err) {
      console.error("Add class failed:", err);
      setStatus({
        type: "error",
        text:
          err.status === 409
            ? err.message
            : `Couldn't create class: ${err.message}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Add Class">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Class ID" hint="Must match the engine's --class-id">
            <input
              className={inputClass}
              value={form.classId}
              onChange={update("classId")}
              placeholder="CS-101"
              disabled={busy}
              required
            />
          </Field>
          <Field label="Room" hint="Optional">
            <input
              className={inputClass}
              value={form.room}
              onChange={update("room")}
              placeholder="LT-3"
              disabled={busy}
            />
          </Field>
        </div>
        <Field label="Class name">
          <input
            className={inputClass}
            value={form.className}
            onChange={update("className")}
            placeholder="Intro to Programming"
            disabled={busy}
            required
          />
        </Field>
        <StatusMessage status={status} />
        <SubmitButton busy={busy} busyLabel="Creating class…">
          Create class
        </SubmitButton>
      </form>

      {classes.length > 0 && (
        <div className="mt-6 border-t border-slate-200 dark:border-gray-700 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-gray-500">
            Existing classes ({classes.length})
          </p>
          <ul className="mt-2 divide-y divide-slate-100 dark:divide-gray-700/60">
            {classes.map((c) => (
              <li
                key={c.id}
                className="flex items-baseline justify-between gap-3 py-2 text-sm"
              >
                <span className="truncate">
                  <span className="font-medium text-slate-900 dark:text-white">
                    {c.id}
                  </span>
                  <span className="ml-2 text-slate-500 dark:text-gray-400">
                    {c.name}
                  </span>
                </span>
                {c.room && (
                  <span className="shrink-0 text-xs text-slate-400 dark:text-gray-500">
                    {c.room}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Add Student
// ---------------------------------------------------------------------------

const EMPTY_STUDENT = { fullName: "", studentId: "", enrolled: [] };

function AddStudentForm({ classes }) {
  const [form, setForm] = useState(EMPTY_STUDENT);
  const [photo, setPhoto] = useState(null); // { dataUrl, width, height }
  const [fileInputKey, setFileInputKey] = useState(0); // remount to clear the input
  const [phase, setPhase] = useState(null); // null | "processing" | "saving"
  const [status, setStatus] = useState(null);
  const busy = phase !== null;

  const toggleClass = (id) =>
    setForm((f) => ({
      ...f,
      enrolled: f.enrolled.includes(id)
        ? f.enrolled.filter((c) => c !== id)
        : [...f.enrolled, id],
    }));

  const rejectFile = (text) => {
    setStatus({ type: "error", text });
    setPhoto(null);
    setFileInputKey((k) => k + 1);
  };

  const handleFile = async (e) => {
    const picked = e.target.files?.[0];
    setStatus(null);
    if (!picked) return setPhoto(null);
    if (!PHOTO_TYPES.includes(picked.type))
      return rejectFile("Photo must be a .jpg, .png or .webp file.");
    if (picked.size > MAX_UPLOAD_MB * 1024 * 1024)
      return rejectFile(`Photo must be under ${MAX_UPLOAD_MB} MB.`);

    setPhase("processing");
    try {
      const compressed = await compressPhoto(picked);
      if (compressed.dataUrl.length > MAX_PHOTO_CHARS) {
        return rejectFile(
          `Compressed photo is too large (${formatKb(compressed.dataUrl.length)}).`,
        );
      }
      setPhoto(compressed);
    } catch (err) {
      console.error("Photo processing failed:", err);
      rejectFile("Couldn't read that image. Try a different file.");
    } finally {
      setPhase(null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const fullName = form.fullName.trim();
    const studentId = form.studentId.trim();

    const error =
      (!fullName && "Full name is required.") ||
      idError(studentId, "Student ID") ||
      (form.enrolled.length === 0 && "Select at least one class.") ||
      (!photo && "Choose a photo.");
    if (error) return setStatus({ type: "error", text: error });

    setStatus(null);
    try {
      // The API checks student_id is unused (409) before saving
      setPhase("saving");
      await api("POST", "/api/students", {
        full_name: fullName,
        student_id: studentId,
        photo_base64: photo.dataUrl,
        enrolled_classes: form.enrolled,
      });

      setStatus({
        type: "success",
        text: `Enrolled ${fullName} in ${form.enrolled.join(", ")}.`,
      });
      setForm(EMPTY_STUDENT);
      setPhoto(null);
      setFileInputKey((k) => k + 1);
    } catch (err) {
      console.error("Add student failed:", err);
      setStatus({
        type: "error",
        text:
          err.status === 409
            ? err.message
            : `Couldn't enroll student: ${err.message}`,
      });
    } finally {
      setPhase(null);
    }
  };

  const busyLabel = {
    processing: "Processing photo…",
    saving: "Saving student…",
  }[phase];

  return (
    <Card title="Add Student" description="">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" hint="Shown on the dashboard roster">
            <input
              className={inputClass}
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              placeholder="Raunak Regmi"
              disabled={busy}
              required
            />
          </Field>
          <Field label="Student ID">
            <input
              className={inputClass}
              value={form.studentId}
              onChange={(e) => setForm({ ...form, studentId: e.target.value })}
              placeholder="22012345"
              disabled={busy}
              required
            />
          </Field>
        </div>

        <fieldset disabled={busy}>
          <legend className="text-sm font-medium text-slate-700 dark:text-gray-300">
            Enrolled classes
          </legend>
          {classes.length === 0 ? (
            <p className="mt-1.5 text-sm text-slate-400 dark:text-gray-500">
              Create a class first.
            </p>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {classes.map((c) => {
                const on = form.enrolled.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleClass(c.id)}
                    aria-pressed={on}
                    title={c.name}
                    className={`rounded-full border px-3 py-1 text-sm font-medium transition-colors disabled:opacity-50 ${
                      on
                        ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-200"
                        : "border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-900 text-slate-500 dark:text-gray-400 hover:border-slate-400 dark:hover:border-gray-500 hover:text-slate-700 dark:hover:text-gray-200"
                    }`}
                  >
                    {on && "✓ "}
                    {c.id}
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>

        <Field
          label="Photo"
          hint={
            photo
              ? `Resized to ${photo.width}×${photo.height} · ${formatKb(photo.dataUrl.length)} stored`
              : `Clear, front-facing face photo. Resized to ${PHOTO_MAX_SIDE}px before saving.`
          }
        >
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-900">
              {photo ? (
                <img
                  src={photo.dataUrl}
                  alt="Selected student"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-xs text-slate-300 dark:text-gray-600">
                  No photo
                </span>
              )}
            </div>
            <input
              key={fileInputKey}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFile}
              disabled={busy}
              className="block w-full text-sm text-slate-500 dark:text-gray-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 dark:file:bg-gray-700 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-900 dark:file:text-white hover:file:bg-slate-300 dark:hover:file:bg-gray-600 disabled:opacity-50"
            />
          </div>
        </Field>

        <StatusMessage status={status} />
        <SubmitButton busy={busy} busyLabel={busyLabel}>
          Enroll student
        </SubmitButton>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Enrolled students list
// ---------------------------------------------------------------------------

function StudentList() {
  const [feed, setFeed] = useState({
    status: "loading",
    students: [],
    error: null,
  });

  useEffect(() => {
    const unsubscribe = onSnapshot(
      query(collection(db, "students"), orderBy("full_name")),
      (snapshot) =>
        setFeed({
          status: "ready",
          error: null,
          students: snapshot.docs.map((d) => ({ id: d.id, ...d.data() })),
        }),
      (err) => {
        console.error("students listener failed:", err);
        setFeed({ status: "error", students: [], error: err });
      },
    );
    return unsubscribe;
  }, []);

  // Doc IDs with a delete in flight; each row's button is disabled while its ID is here
  const [deleting, setDeleting] = useState(() => new Set());
  const [deleteStatus, setDeleteStatus] = useState(null);

  const handleDelete = async (student) => {
    const name = student.full_name || student.id;
    const confirmed = window.confirm(
      `Are you sure you want to delete ${name}?\n\n` +
        "Their photo is removed and they won't be recognized the next time " +
        "the engine starts. Past attendance logs are kept.",
    );
    if (!confirmed) return;

    setDeleteStatus(null);
    setDeleting((prev) => new Set(prev).add(student.id));
    try {
      // The onSnapshot listener above removes the row once the server delete lands
      await api("DELETE", `/api/students/${encodeURIComponent(student.id)}`);
    } catch (err) {
      console.error("Delete student failed:", err);
      setDeleteStatus({
        type: "error",
        text: `Couldn't delete ${name}: ${err.message}`,
      });
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(student.id);
        return next;
      });
    }
  };

  return (
    <Card
      title={`Enrolled Students${feed.status === "ready" ? ` (${feed.students.length})` : ""}`}
    >
      {deleteStatus && (
        <div className="mb-3">
          <StatusMessage status={deleteStatus} />
        </div>
      )}
      {feed.status === "loading" && (
        <p className="text-sm text-slate-400 dark:text-gray-500">
          Loading students…
        </p>
      )}
      {feed.status === "error" && (
        <p className="text-sm text-red-700 dark:text-red-300">
          Couldn't load students: {feed.error?.code ?? "error"}
        </p>
      )}
      {feed.status === "ready" && feed.students.length === 0 && (
        <p className="text-sm text-slate-400 dark:text-gray-500">
          No students enrolled yet.
        </p>
      )}
      {feed.students.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-gray-700/60">
          {feed.students.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-3">
              {s.photo_base64 ? (
                <img
                  src={s.photo_base64}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-full border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-900 object-cover"
                />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded-full border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-900" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
                  {s.full_name}
                </p>
                <p className="text-xs text-slate-400 dark:text-gray-500">
                  {s.student_id}
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                {(s.enrolled_classes ?? []).map((c) => (
                  <span
                    key={c}
                    className="rounded-full bg-slate-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-slate-700 dark:text-gray-300"
                  >
                    {c}
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={() => handleDelete(s)}
                disabled={deleting.has(s.id)}
                aria-label={`Delete ${s.full_name || s.id}`}
                title="Delete student"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 transition-colors hover:border-red-300 dark:hover:border-red-500/60 hover:bg-red-100 dark:hover:bg-red-500/20 hover:text-red-800 dark:hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting.has(s.id) ? <Spinner /> : <TrashIcon />}
                <span className="hidden sm:inline">
                  {deleting.has(s.id) ? "Deleting…" : "Delete"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function AdminPanel({ classes, classesStatus, actions }) {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-900 font-sans transition-colors duration-200 text-slate-900 dark:text-white">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
              Attendly
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              Admin Panel
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-gray-400">
              Create classes and enroll students with their reference photos.
            </p>
          </div>
          {actions}
        </div>

        {classesStatus === "error" && (
          <p className="mb-6 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            Couldn't load classes. Check your Firestore security rules.
          </p>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <AddClassForm classes={classes} />
          </div>
          <div className="space-y-6">
            <AddStudentForm classes={classes} />
            <StudentList />
          </div>
        </div>
      </div>
    </div>
  );
}
