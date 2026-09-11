"""Offline execution of the real SDK/API serializers and PostgreSQL wire codec.

Read-only reference roots are positional arguments; input is emitted by the adjacent
TypeScript producer. The service helper is compiled unchanged from its AST to avoid
initializing API application/database dependencies. No database connection is made.
"""
import ast
import hashlib
import json
import pathlib
import subprocess
import sys
from datetime import UTC, datetime

api_root = pathlib.Path(sys.argv[1])
python_root = pathlib.Path(sys.argv[2])
sys.path[:0] = [str(api_root / "shared/src"), str(api_root / "api/src"), str(python_root / "src")]

import pydantic
import psycopg
from psycopg.types.datetime import DatetimeNoTzBinaryDumper, TimestampBinaryLoader
from solwyn._types import MetadataEvent as SDKEvent
from solwyn_api.schemas.ingest import IngestMetadataEvent

service_path = api_root / "api/src/solwyn_api/services/metadata_ingest.py"
service_source = service_path.read_text()
normalizer_node = next(node for node in ast.parse(service_source).body if isinstance(node, ast.FunctionDef) and node.name == "_normalize_db_timestamp")
namespace = {"datetime": datetime, "UTC": UTC}
exec(compile(ast.Module(body=[normalizer_node], type_ignores=[]), str(service_path), "exec"), namespace)
normalize = namespace["_normalize_db_timestamp"]
schema_path = api_root / "api/tests/fixtures/expected_schema.sql"
schema = schema_path.read_text()
assert '"timestamp" timestamp without time zone NOT NULL' in schema
assert 'CREATE UNIQUE INDEX uq_cost_events_timestamp_sdk_instance ON ONLY public.cost_events USING btree ("timestamp", sdk_instance_id)' in schema

events = json.load(sys.stdin)
dumper = DatetimeNoTzBinaryDumper(datetime)
loader = TimestampBinaryLoader(1114)
normalized = []
wire = []
for event in events:
    # Both actual Pydantic serializer paths must preserve precision, not merely
    # Python's permissive datetime parser or the TypeScript fake's string handling.
    sdk = SDKEvent.model_validate_json(json.dumps(event))
    api = IngestMetadataEvent.model_validate_json(sdk.model_dump_json())
    reparsed = IngestMetadataEvent.model_validate_json(api.model_dump_json())
    stored = normalize(reparsed.timestamp)
    binary = dumper.dump(stored)
    assert loader.load(binary) == stored
    normalized.append(stored)
    wire.append(bytes(binary))
assert len(events) == len(set(normalized)) == len(set(wire)) == 2001
assert (normalized[-1] - normalized[0]).total_seconds() == 0.002
# Precision above six digits is insufficient: actual parser normalization collapses it.
controls = [{**events[0], "timestamp": "2026-09-07T12:00:00.0000001Z"}, {**events[0], "timestamp": "2026-09-07T12:00:00.0000002Z"}]
assert len({normalize(IngestMetadataEvent.model_validate(item).timestamp) for item in controls}) == 1

def revision(path):
    return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()

print(json.dumps({"ok": True, "events": len(events), "distinct_python_api_datetimes": len(set(normalized)), "distinct_postgres_binary_values": len(set(wire)), "span_microseconds": 2000, "seventh_digit_control_collides": True, "api_revision": revision(api_root), "python_sdk_revision": revision(python_root), "normalizer_sha256": hashlib.sha256(ast.get_source_segment(service_source, normalizer_node).encode()).hexdigest(), "schema_sha256": hashlib.sha256(schema.encode()).hexdigest(), "pydantic": pydantic.__version__, "psycopg": psycopg.__version__, "live_database": False}, indent=2))
