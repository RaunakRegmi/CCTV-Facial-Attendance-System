import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "./firebase";
import { PageHeading } from "./ui";
import { btnPrimary, cardClass, inputClass, labelClass } from "./styles";

// ---------------------------------------------------------------------------
// Config & helpers
// ---------------------------------------------------------------------------

// Reads come straight from Firestore; writes go through the FastAPI backend
// (backend/api.py) because the Firestore rules deny all client writes.
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

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

// White panel with a titled header bar; `flush` drops body padding for tables
function Card({ title, description, flush = false, children }) {
  return (
    <section className={`${cardClass} overflow-hidden`}>
      <div className="border-b border-slate-200 px-5 py-4">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-slate-600">{description}</p>
        )}
      </div>
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && (
        <span className="mt-1 block text-xs text-slate-500">{hint}</span>
      )}
    </label>
  );
}

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
      className={btnPrimary}
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
      ? "border-red-200 bg-red-50 text-red-800"
      : "border-emerald-200 bg-emerald-50 text-emerald-800";
  return (
    <p
      role="status"
      className={`rounded-md border px-3 py-2 text-sm font-medium ${tone}`}
    >
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
    <Card
      title="Add Class"
      description="Register a class so the engine and roster can reference it."
    >
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
        <div className="mt-6 overflow-hidden rounded-md border border-slate-200">
          <p className={`${labelClass} border-b border-slate-200 bg-white px-4 py-2.5`}>
            Existing classes ({classes.length})
          </p>
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">
              <tr>
                <th className="border-b border-slate-200 px-4 py-2.5">
                  Class ID
                </th>
                <th className="border-b border-slate-200 px-4 py-2.5">Name</th>
                <th className="border-b border-slate-200 px-4 py-2.5">Room</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {classes.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-slate-900">
                    {c.id}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">{c.name}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                    {c.room ?? <span className="text-slate-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
    <Card
      title="Add Student"
      description="Enroll a student with a reference photo for face recognition."
    >
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
          <legend className="text-sm font-medium text-slate-700">
            Enrolled classes
          </legend>
          {classes.length === 0 ? (
            <p className="mt-1.5 text-sm text-slate-500">
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
                    className={`rounded-md border px-3 py-1 text-sm transition-colors disabled:opacity-50 ${
                      on
                        ? "border-red-700 bg-red-50 font-semibold text-red-800"
                        : "border-slate-300 bg-white font-medium text-slate-600 hover:border-slate-400 hover:text-slate-900"
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
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-300 bg-slate-50">
              {photo ? (
                <img
                  src={photo.dataUrl}
                  alt="Selected student"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-xs text-slate-400">No photo</span>
              )}
            </div>
            <input
              key={fileInputKey}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFile}
              disabled={busy}
              className="block w-full text-sm text-slate-600 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-solid file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50 disabled:opacity-50"
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
      description="Reference photos used by the recognition engine."
      flush
    >
      {deleteStatus && (
        <div className="border-b border-slate-200 p-4">
          <StatusMessage status={deleteStatus} />
        </div>
      )}
      {feed.status === "loading" && (
        <p className="px-5 py-8 text-center text-sm text-slate-500">
          Loading students…
        </p>
      )}
      {feed.status === "error" && (
        <p className="px-5 py-8 text-center text-sm font-medium text-red-700">
          Couldn't load students: {feed.error?.code ?? "error"}
        </p>
      )}
      {feed.status === "ready" && feed.students.length === 0 && (
        <p className="px-5 py-8 text-center text-sm text-slate-500">
          No students enrolled yet.
        </p>
      )}
      {feed.students.length > 0 && (
        <div className="max-h-[32rem] overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-slate-100 text-left text-xs font-semibold uppercase tracking-wider text-slate-700">
              <tr>
                <th className="border-b border-slate-200 px-5 py-3">
                  Student
                </th>
                <th className="border-b border-slate-200 px-5 py-3">
                  Classes
                </th>
                <th className="border-b border-slate-200 px-5 py-3 text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {feed.students.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      {s.photo_base64 ? (
                        <img
                          src={s.photo_base64}
                          alt=""
                          className="h-10 w-10 shrink-0 rounded-md border border-slate-200 bg-slate-50 object-cover"
                        />
                      ) : (
                        <div className="h-10 w-10 shrink-0 rounded-md border border-slate-200 bg-slate-50" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-900">
                          {s.full_name}
                        </p>
                        <p className="text-xs text-slate-500 tabular-nums">
                          {s.student_id}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(s.enrolled_classes ?? []).map((c) => (
                        <span
                          key={c}
                          className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(s)}
                      disabled={deleting.has(s.id)}
                      aria-label={`Delete ${s.full_name || s.id}`}
                      title="Delete student"
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {deleting.has(s.id) ? <Spinner /> : <TrashIcon />}
                      <span className="hidden sm:inline">
                        {deleting.has(s.id) ? "Deleting…" : "Delete"}
                      </span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function AdminPanel({ classes, classesStatus }) {
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeading
        eyebrow="Student Roster"
        title="Classes & Student Enrollment"
        description="Create classes and enroll students with their reference photos."
      />

      {classesStatus === "error" && (
        <p
          role="alert"
          className="mb-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
        >
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
    </main>
  );
}
