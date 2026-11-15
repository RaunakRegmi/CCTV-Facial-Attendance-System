"""
Benchmark the trained contraband model on the validation split.

Run after train_contraband.py, before deploying to a live classroom:
    python evaluate_contraband.py

Prints per-class Precision / Recall / mAP50 / mAP50-95 and the path to the
confusion matrix (backend/runs/detect/val*/confusion_matrix.png).
"""

from pathlib import Path

from ultralytics import YOLO

# Single source of truth for paths, class order and device choice
from train_contraband import BASE_DIR, CLASSES, DATA_YAML, OUTPUT_WEIGHTS, pick_device

VAL_PROJECT = BASE_DIR / "runs" / "detect"


def check_inputs():
    missing = []
    if not OUTPUT_WEIGHTS.exists():
        missing.append(f"  - {OUTPUT_WEIGHTS}  (run: python train_contraband.py)")
    if not DATA_YAML.exists():
        missing.append(f"  - {DATA_YAML}  (created by train_contraband.py)")
    if missing:
        raise SystemExit("[ERROR] Training hasn't been run yet. Missing:\n" + "\n".join(missing))


def run_val(model, device):
    return model.val(
        data=str(DATA_YAML),
        split="val",
        device=device,
        project=str(VAL_PROJECT),
        name="val",       # val, val2, val3, ... one folder per run
        plots=True,       # writes confusion_matrix.png + PR curves
        verbose=False,
    )


def fmt(value):
    return "—" if value is None else f"{value:.3f}"


def print_table(metrics, model_names):
    box = metrics.box
    evaluated = [int(i) for i in box.ap_class_index]

    headers = ["class", "Precision", "Recall", "mAP50", "mAP50-95"]
    rows = []
    for class_id, name in enumerate(CLASSES):
        if class_id in evaluated:
            p, r, ap50, ap = box.class_result(evaluated.index(class_id))
            rows.append([name, fmt(p), fmt(r), fmt(ap50), fmt(ap)])
        else:
            rows.append([name, "—", "—", "—", "—"])  # no instances in val split
    rows.append(["all", fmt(box.mp), fmt(box.mr), fmt(box.map50), fmt(box.map)])

    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    line = lambda r: "  ".join(c.ljust(w) if i == 0 else c.rjust(w) for i, (c, w) in enumerate(zip(r, widths)))
    rule = "  ".join("-" * w for w in widths)

    print()
    print(line(headers))
    print(rule)
    for r in rows[:-1]:
        print(line(r))
    print(rule)
    print(line(rows[-1]))
    print()

    absent = [CLASSES[i] for i in range(len(CLASSES)) if i not in evaluated]
    if absent:
        print(f"[NOTE] No validation instances for: {', '.join(absent)} (shown as —). Label more examples.")

    if [model_names.get(i) for i in range(len(CLASSES))] != CLASSES:
        print(f"[WARN] Model class names {model_names} don't match the expected order {CLASSES}.")


def main():
    check_inputs()
    model = YOLO(str(OUTPUT_WEIGHTS))
    device = pick_device()
    print(f"[EVAL] {OUTPUT_WEIGHTS.name} on {DATA_YAML.parent.name}/images/val | device={device}")

    try:
        metrics = run_val(model, device)
    except RuntimeError as e:
        if device == "cpu":
            raise
        # Some ops are still unimplemented on MPS; CPU is slower but always works
        print(f"[DEVICE] Validation failed on {device} ({e}); retrying on CPU")
        metrics = run_val(model, "cpu")

    print_table(metrics, model.names)

    save_dir = Path(metrics.save_dir)
    for name in ("confusion_matrix.png", "confusion_matrix_normalized.png"):
        path = save_dir / name
        if path.exists():
            print(f"[PLOT] {path}")
    print(f"[DONE] Full results in {save_dir}")


if __name__ == "__main__":
    main()
