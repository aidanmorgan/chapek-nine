"""Convert deterministic coordinator JSONL into reviewable Parquet datasets.

The JSONL files remain the human-auditable source data.  Parquet is the
training/analysis format; DuckDB verifies split sizes, family isolation, and
role balance without requiring a separate database server.
"""

import argparse
import hashlib
import json
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args()


def load_jsonl(path):
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        value = json.loads(line)
        assistant = value["messages"][-1]["content"]
        route = json.loads(assistant)
        rows.append(
            {
                "id": value["id"],
                "task_id": value["taskId"],
                "category": value["category"],
                "messages_json": json.dumps(value["messages"], separators=(",", ":")),
                "route_json": assistant,
                "tier": route["tier"],
                "primary_role": route["primary"]["role"],
                "primary_model": route["primary"]["model"],
                "max_tokens": route["primary"].get("maxTokens"),
            }
        )
    return rows


def write_parquet(rows, path):
    pq.write_table(pa.Table.from_pylist(rows), path, compression="zstd")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    args = parse_args()
    source = Path(args.input_dir)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    source_manifest_path = source / "manifest.json"
    source_manifest = (
        json.loads(source_manifest_path.read_text(encoding="utf-8"))
        if source_manifest_path.exists()
        else {}
    )
    train = load_jsonl(source / "train.jsonl")
    validation = load_jsonl(source / "validation.jsonl")
    train_path = output / "train.parquet"
    validation_path = output / "validation.parquet"
    write_parquet(train, train_path)
    write_parquet(validation, validation_path)

    con = duckdb.connect(":memory:")
    con.execute("CREATE TABLE train AS SELECT * FROM read_parquet(?)", [str(train_path)])
    con.execute("CREATE TABLE validation AS SELECT * FROM read_parquet(?)", [str(validation_path)])
    overlap = con.execute(
        "SELECT count(*) FROM (SELECT DISTINCT task_id FROM train INTERSECT SELECT DISTINCT task_id FROM validation)"
    ).fetchone()[0]
    if overlap:
        raise RuntimeError(f"train/validation task-family leakage: {overlap} overlapping IDs")
    summary = {
        "version": 2,
        "format": "Parquet (Zstandard), verified with DuckDB",
        "trainRows": len(train),
        "validationRows": len(validation),
        "trainTaskFamilies": con.execute("SELECT count(DISTINCT task_id) FROM train").fetchone()[0],
        "validationTaskFamilies": con.execute("SELECT count(DISTINCT task_id) FROM validation").fetchone()[0],
        "taskFamilyOverlap": overlap,
        "trainRoleCounts": dict(con.execute("SELECT primary_role, count(*) FROM train GROUP BY 1").fetchall()),
        "validationRoleCounts": dict(con.execute("SELECT primary_role, count(*) FROM validation GROUP BY 1").fetchall()),
        "source": {
            key: source_manifest.get(key)
            for key in [
                "suiteVersion",
                "coreTaskCount",
                "generatedTaskCount",
                "taskFamilyCount",
                "sampling",
                "evalReport",
                "teacher",
                "admissionTiers",
                "trainExamples",
                "validationExamples",
                "validationTaskIds",
                "sha256",
            ]
        },
        "files": {
            "train.parquet": {"sha256": sha256(train_path), "bytes": train_path.stat().st_size},
            "validation.parquet": {"sha256": sha256(validation_path), "bytes": validation_path.stat().st_size},
        },
    }
    (output / "manifest.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
