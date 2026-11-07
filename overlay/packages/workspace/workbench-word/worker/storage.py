"""Reference-driven cleanup for this profile's version-2 Word records only."""
import json
from pathlib import Path
import re
import sys
import time
from safe_save import WordFailure, confined, durable_json, sha, clean_terminal_journals, remove_transaction_file

CHECKPOINT = re.compile(r"^[0-9]+-[a-f0-9]{32}$")
DOCUMENT = re.compile(r"^[a-f0-9]{32}$")
HASH = re.compile(r"^[a-f0-9]{64}$")

def read_json(path):
    return json.loads(Path(path).read_text("utf8"))

def diagnostic(directory, operation, deleted=0, error=None):
    value = {"operation": operation, "deleted": deleted, "time": time.time() * 1000}
    if error is not None:
        value["error"] = str(error)[:2000]
        print("Word storage " + operation + ": " + str(error), file=sys.stderr)
    try:
        durable_json(Path(directory) / "lifecycle.json", value)
    except OSError as failure:
        print("Word storage diagnostic failed: " + str(failure), file=sys.stderr)
    return value

def checkpoint_metadata(directory, identifier):
    if not isinstance(identifier, str) or CHECKPOINT.fullmatch(identifier) is None:
        raise WordFailure("recovery-invalid", "A retained checkpoint identity is invalid.")
    path = confined(directory, Path(directory) / ("checkpoint-" + identifier + ".docx"))
    metadata = read_json(path.with_suffix(".json"))
    if metadata.get("storageVersion") != 2 or metadata.get("checkpoint") != identifier:
        raise WordFailure("recovery-invalid", "The checkpoint storage version is unknown.")
    if not isinstance(metadata.get("checkpointSequence"), int) or metadata["checkpointSequence"] < 1:
        raise WordFailure("recovery-invalid", "The checkpoint sequence is invalid.")
    if not path.exists() or sha(path.read_bytes()) != metadata.get("checkpointHash"):
        raise WordFailure("recovery-invalid", "The retained checkpoint failed its integrity check.")
    return metadata

def proof_name(proof):
    revision, digest = proof.get("revision"), proof.get("sha256", proof.get("version"))
    if not isinstance(revision, int) or revision < 0 or not isinstance(digest, str) or HASH.fullmatch(digest) is None:
        raise WordFailure("recovery-invalid", "A retained proof identity is invalid.")
    return "proof-" + str(revision) + "-" + digest

def cleanup_working(directory):
    directory = Path(directory)
    record = read_json(directory / "record.json")
    if record.get("storageVersion") != 2: return
    checkpoint_metadata(directory, record["checkpoint"])
    working = confined(directory, directory / "working.docx")
    if working.exists():
        # Exclusive deletion fails safely if a native writer still owns this copy.
        remove_transaction_file(working, sha(working.read_bytes()))
        diagnostic(directory, "working-close", 1)

def startup(data):
    for directory in Path(data).iterdir():
        if DOCUMENT.fullmatch(directory.name) is None or not directory.is_dir(): continue
        try:
            confined(data, directory / "record.json")
            record = read_json(directory / "record.json")
            if record.get("storageVersion") != 2: continue
            cleanup_working(directory)
            clean_terminal_journals(directory, record.get("savedRequests", {}))
        except Exception as error:
            diagnostic(directory, "startup-retained", error=error)

def collect_document(directory, record, reference, active):
    """Delete only behind a scene-acknowledged sequence; newer in-flight checkpoints stay pinned."""
    if record.get("storageVersion") != 2: return 0
    if reference is None and active: return 0
    latest = checkpoint_metadata(directory, record["checkpoint"])
    keep = {record["checkpoint"]}
    watermark = latest["checkpointSequence"] if reference is None else 0
    proofs = set()
    if reference is not None:
        for value in reference["checkpoints"]:
            metadata = checkpoint_metadata(directory, value["checkpoint"])
            if (metadata.get("id") != record["id"] or metadata.get("scope") != record["scope"]
                or metadata.get("root") != record["root"] or metadata["checkpointHash"] != value["checkpointHash"]
                or metadata["revision"] != value["revision"]):
                raise WordFailure("scope", "A retained checkpoint belongs to another document.")
            keep.add(value["checkpoint"])
            watermark = max(watermark, metadata["checkpointSequence"])
        if not reference["checkpoints"]:
            raise WordFailure("recovery-invalid", "An open scene must retain its checkpoint.")
        proofs = {proof_name(value) for value in reference["proofs"]}
    latest_proof = Path(directory) / "proof.json"
    if latest_proof.exists(): proofs.add(proof_name(read_json(latest_proof)))
    # Validate the entire candidate set before the first removal. Unknown metadata disables collection.
    checkpoints = []
    for path in Path(directory).glob("checkpoint-*.docx"):
        identifier = path.stem.removeprefix("checkpoint-")
        metadata = checkpoint_metadata(directory, identifier)
        if metadata.get("id") != record["id"] or metadata.get("scope") != record["scope"] or metadata.get("root") != record["root"]:
            raise WordFailure("scope", "The stored checkpoint scope is invalid.")
        if identifier not in keep and metadata["checkpointSequence"] <= watermark:
            checkpoints.append((path, metadata))
    proof_candidates = []
    proof_watermark = 0
    available_proofs = set()
    for path in Path(directory).glob("proof-*.pdf"):
        metadata = read_json(path.with_suffix(".json"))
        name = proof_name(metadata)
        if path.stem != name or not isinstance(metadata.get("proofSequence"), int):
            raise WordFailure("recovery-invalid", "The stored proof metadata is unknown.")
        confined(directory, path)
        if sha(path.read_bytes()) != metadata["sha256"]:
            raise WordFailure("recovery-invalid", "The stored proof failed its integrity check.")
        available_proofs.add(name)
        if reference is None or name in {proof_name(value) for value in reference["proofs"]}:
            proof_watermark = max(proof_watermark, metadata["proofSequence"])
        proof_candidates.append((path, metadata))
    if not proofs.issubset(available_proofs):
        raise WordFailure("recovery-invalid", "A referenced proof is unavailable; cleanup is suspended.")
    proof_files = [(path, metadata) for path, metadata in proof_candidates
        if path.stem not in proofs and metadata["proofSequence"] <= proof_watermark]
    deleted = 0
    for path, metadata in checkpoints:
        remove_transaction_file(path, metadata["checkpointHash"])
        path.with_suffix(".json").unlink()
        deleted += 1
    for path, metadata in proof_files:
        remove_transaction_file(path, metadata["sha256"])
        path.with_suffix(".json").unlink()
        deleted += 1
    return deleted

def retain(data, request, active_documents):
    references = request["documents"]
    identifiers = [reference["id"] for reference in references]
    if len(set(identifiers)) != len(identifiers) or any(DOCUMENT.fullmatch(identifier) is None for identifier in identifiers):
        raise WordFailure("invalid", "The scene reference set is invalid.")
    by_id = {reference["id"]: reference for reference in references}
    root, scope = str(Path(request["root"]).resolve()), request["scope"]
    candidates = []
    # Resolve every referenced identity before any deletion in this scope.
    for identifier in identifiers:
        path = confined(data, Path(data) / identifier / "record.json")
        record = read_json(path)
        if record.get("id") != identifier or record.get("scope") != scope or record.get("root") != root:
            raise WordFailure("scope", "The scene reference belongs to another workspace.")
    failures, deleted = [], 0
    for directory in Path(data).iterdir():
        if DOCUMENT.fullmatch(directory.name) is None or not directory.is_dir(): continue
        try:
            confined(data, directory / "record.json")
            record = read_json(directory / "record.json")
            if record.get("scope") != scope or record.get("root") != root: continue
            candidates.append((directory, record))
        except Exception as error:
            failures.append(directory.name)
            diagnostic(directory, "retain-read-failed", error=error)
    # An unreadable record can hide scope membership. Do not infer absence.
    if failures: return {"deleted": 0, "failures": failures}
    for directory, record in candidates:
        try:
            count = collect_document(directory, record, by_id.get(record["id"]), record["id"] in active_documents)
            deleted += count
            clean_terminal_journals(directory, record.get("savedRequests", {}))
            diagnostic(directory, "scene-retain", count)
        except Exception as error:
            failures.append(directory.name)
            diagnostic(directory, "retain-failed", error=error)
    return {"deleted": deleted, "failures": failures}
