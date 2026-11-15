"""
Unpack a Label Studio "YOLO" export and split it 80/20 for training.

    1. Export from Label Studio: Project -> Export -> "YOLO" (or "YOLO with Images")
    2. Save the zip as backend/yolo_contraband/export.zip
    3. python split_dataset.py

Output (consumed by train_contraband.py):

    yolo_contraband/images/{train,val}/*.jpg
    yolo_contraband/labels/{train,val}/*.txt

Images with no bounding boxes are kept as negative (background) samples
with an empty label file, which teaches the model what "no contraband"
looks like and cuts false positives.

Re-running replaces the previous images/ and labels/ split; raw_frames/
and export.zip are never touched. Stdlib only, so any Python 3.9+ works.
"""

import argparse
import random
import shutil
import tempfile
import zipfile
from collections import Counter
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATASET_DIR = BASE_DIR / "yolo_contraband"

# Order defines class IDs; must match train_contraband.py and proctor_engine.py
CLASSES = ["cell_phone", "chit_paper", "smartwatch", "earbuds"]
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
SPLITS = ("train", "val")


def find_export_root(extract_dir):
    """Label Studio zips are flat, but tolerate a wrapping folder."""
    hits = sorted(extract_dir.rglob("classes.txt"), key=lambda p: len(p.parts))
    return hits[0].parent if hits else extract_dir


def build_class_remap(root):
    """Returns {export_class_id: canonical_class_id}."""
    classes_file = root / "classes.txt"
    if not classes_file.exists():
        print("[WARN] classes.txt not found in export; assuming IDs already follow:")
        print(f"       {CLASSES}")
        return {i: i for i in range(len(CLASSES))}

    exported = [line.strip() for line in classes_file.read_text().splitlines() if line.strip()]
    if exported == CLASSES:
        print(f"[OK] classes.txt matches {CLASSES}")
        return {i: i for i in range(len(CLASSES))}

    unknown = [name for name in exported if name not in CLASSES]
    if unknown:
        raise SystemExit(
            f"[ERROR] classes.txt has labels the model doesn't know: {unknown}\n"
            f"        Expected names: {CLASSES}\n"
            f"        Rename them in the Label Studio labeling config and export again."
        )

    print("[WARN] classes.txt order differs from the training order!")
    print(f"       export:   {exported}")
    print(f"       expected: {CLASSES}")
    print("       Remapping class IDs by name so labels stay correct.")
    return {i: CLASSES.index(name) for i, name in enumerate(exported)}


def collect_samples(root):
    """Pairs every image with its label file (or None for negatives)."""
    labels = {}
    for txt in root.rglob("*.txt"):
        if txt.name != "classes.txt":
            labels.setdefault(txt.stem, txt)

    images, seen = [], set()
    for img in sorted(root.rglob("*")):
        if img.suffix.lower() not in IMAGE_EXTS or not img.is_file():
            continue
        if img.stem in seen:
            print(f"[WARN] Duplicate image name {img.name}, skipping the second copy")
            continue
        seen.add(img.stem)
        images.append((img, labels.get(img.stem)))

    orphans = set(labels) - seen
    if orphans:
        print(f"[WARN] {len(orphans)} label file(s) have no matching image and were skipped")
        print("       (export with 'YOLO with Images' to include the images)")
    return images


def remap_label(label_path, remap):
    """Rewrites class IDs; returns (text, Counter of canonical class IDs)."""
    if label_path is None:
        return "", Counter()

    out, counts, bad = [], Counter(), 0
    for line in label_path.read_text().splitlines():
        parts = line.split()
        if not parts:
            continue
        try:
            src_id = int(parts[0])
            coords = [float(v) for v in parts[1:]]
        except ValueError:
            bad += 1
            continue
        # Boxes have 4 coords; polygon exports have an even count >= 6
        if src_id not in remap or len(coords) < 4 or len(coords) % 2:
            bad += 1
            continue
        dst_id = remap[src_id]
        out.append(" ".join([str(dst_id), *parts[1:]]))
        counts[dst_id] += 1

    if bad:
        print(f"[WARN] {label_path.name}: skipped {bad} malformed line(s)")
    return ("\n".join(out) + "\n") if out else "", counts


def print_summary(stats):
    headers = ["split", "images", "negatives", *CLASSES, "boxes"]
    rows = []
    for split in SPLITS:
        s = stats[split]
        boxes = [s["boxes"][i] for i in range(len(CLASSES))]
        rows.append([split, s["images"], s["negatives"], *boxes, sum(boxes)])
    rows.append(["total", *[sum(r[i] for r in rows) for i in range(1, len(headers))]])

    widths = [max(len(str(h)), *(len(str(r[i])) for r in rows)) for i, h in enumerate(headers)]
    fmt = "  ".join(f"{{:<{w}}}" if i == 0 else f"{{:>{w}}}" for i, w in enumerate(widths))
    rule = "  ".join("-" * w for w in widths)
    print()
    print(fmt.format(*headers))
    print(rule)
    for r in rows[:-1]:
        print(fmt.format(*r))
    print(rule)
    print(fmt.format(*rows[-1]))
    print()

    missing = [CLASSES[i] for i in range(len(CLASSES)) if stats["val"]["boxes"][i] == 0]
    if missing:
        print(f"[WARN] No validation boxes for: {', '.join(missing)} — their metrics will be empty.")
        print("       Label more examples of these classes.")


def split_dataset(zip_path, dataset_dir, val_ratio=0.2, seed=42):
    if not zip_path.exists():
        raise SystemExit(
            f"[ERROR] Export not found: {zip_path}\n"
            f"        In Label Studio: Export -> YOLO (with images), then save the zip there."
        )

    with tempfile.TemporaryDirectory(prefix="ls_export_") as tmp:
        extract_dir = Path(tmp)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(extract_dir)  # zipfile strips absolute / ".." member paths
        root = find_export_root(extract_dir)

        remap = build_class_remap(root)
        samples = collect_samples(root)
        if len(samples) < 2:
            raise SystemExit(f"[ERROR] Found {len(samples)} image(s) in the export; need at least 2 to split.")

        # Sort first so the shuffle is reproducible regardless of zip order
        samples.sort(key=lambda s: s[0].name)
        random.seed(seed)
        random.shuffle(samples)
        n_val = max(1, round(len(samples) * val_ratio))
        assignments = {"val": samples[:n_val], "train": samples[n_val:]}

        # Replace any previous split so stale files never leak between runs
        for kind in ("images", "labels"):
            for split in SPLITS:
                out = dataset_dir / kind / split
                if out.exists():
                    shutil.rmtree(out)
                out.mkdir(parents=True)

        stats = {split: {"images": 0, "negatives": 0, "boxes": Counter()} for split in SPLITS}
        for split, items in assignments.items():
            for img, label in items:
                text, counts = remap_label(label, remap)
                shutil.copy2(img, dataset_dir / "images" / split / img.name)
                (dataset_dir / "labels" / split / f"{img.stem}.txt").write_text(text)
                stats[split]["images"] += 1
                stats[split]["negatives"] += 0 if counts else 1
                stats[split]["boxes"].update(counts)
    # TemporaryDirectory removes the extraction folder here

    print(f"[DONE] Split {len(samples)} images into {dataset_dir}/images/{{train,val}} (seed={seed})")
    print_summary(stats)
    return stats


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zip", type=Path, default=None, help="Label Studio export (default: <dataset-dir>/export.zip)")
    parser.add_argument("--dataset-dir", type=Path, default=DATASET_DIR, help="Output root (default: backend/yolo_contraband)")
    parser.add_argument("--val-ratio", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if not 0 < args.val_ratio < 1:
        parser.error("--val-ratio must be between 0 and 1")
    dataset_dir = args.dataset_dir.resolve()
    zip_path = (args.zip or dataset_dir / "export.zip").resolve()
    split_dataset(zip_path, dataset_dir, args.val_ratio, args.seed)


if __name__ == "__main__":
    main()
