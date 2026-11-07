"""Real worker regressions for acknowledged edits and safe draft restoration."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
import zipfile

SOURCE, DEPENDENCY, EVIDENCE = map(Path, sys.argv[1:4])
EVIDENCE.mkdir(parents=True, exist_ok=True)
sys.argv = [sys.argv[0]]


class OperationReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mrw-operation-receipt-")
        self.root = Path(self.temp.name)
        worker_path = SOURCE / "packages/workspace/workbench-word/worker/binary_bridge.py"
        sys.argv = [str(worker_path), str(DEPENDENCY), str(self.root / "drafts")]
        spec = importlib.util.spec_from_file_location("receipt_worker", worker_path)
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)
        self.path = self.root / "paper.docx"
        self.original = (worker_path.parent / "blank.docx").read_bytes()
        self.path.write_bytes(self.original)
        self.address = {"scope": "receipt-test", "root": str(self.root), "path": str(self.path), "documentId": uuid.uuid4().hex}
        self.snapshot = self.worker.execute({**self.address, "method": "open"})
        output = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(self.original)) as source, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
            for item in source.infolist():
                data = source.read(item.filename)
                if item.filename == "word/document.xml":
                    xml = self.worker.etree.fromstring(data)
                    body = xml.find(self.worker.W + "body")
                    p = self.worker.etree.Element(self.worker.W + "p")
                    r = self.worker.etree.SubElement(p, self.worker.W + "r")
                    self.worker.etree.SubElement(r, self.worker.W + "t").text = "Committed receipt"
                    body.insert(0, p)
                    data = self.worker.etree.tostring(xml)
                target.writestr(item, data)
        self.edited = output.getvalue()
        self.worker.execute({**self.address, "method": "mutate", "revision": 0, "requestId": "queued", "operation": {"kind": "undo"}})

    def tearDown(self):
        self.worker.DLL.close()
        self.temp.cleanup()

    def commit(self, **changes):
        return self.worker.execute({**self.address, "method": "commit-bytes", "revision": 0, "nextRevision": 1,
            "requestId": "upload", "queuedRequestId": "queued", "data": base64.b64encode(self.edited).decode(),
            "sha256": self.worker.sha(self.edited), "projection": self.worker.project_bytes(self.edited), **changes})

    def status(self):
        return self.worker.execute({**self.address, "method": "operation-status", "requestId": "queued"})

    def test_receipt_is_complete_before_client_final_acknowledgement(self):
        snapshot = self.commit()
        self.assertEqual(self.status(), {"state": "completed", "revision": 1, "error": None})
        self.assertEqual(snapshot["pendingOperations"], [])
        directory = self.root / "drafts" / self.address["documentId"]
        record = json.loads((directory / "record.json").read_text("utf8"))
        self.assertEqual(record["resolvedOperations"]["queued"], {"revision": 1, "error": None})
        self.assertEqual((directory / ("checkpoint-" + snapshot["checkpoint"] + ".docx")).read_bytes(), self.edited)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(self.commit()["revision"], 1)

    def test_committed_receipt_survives_restart_before_final_acknowledgement(self):
        snapshot = self.commit()
        self.worker.documents.clear()
        self.worker.execute({**self.address, "method": "open", **{key: snapshot[key] for key in ("checkpoint", "checkpointHash", "revision")}})
        self.assertEqual(self.status(), {"state": "completed", "revision": 1, "error": None})

    def test_wrong_queue_identity_or_base_cannot_commit(self):
        for changes in ({"queuedRequestId": "unrelated"}, {"revision": 1, "nextRevision": 2}):
            with self.subTest(changes=changes), self.assertRaises(self.worker.WordFailure):
                self.commit(**changes)
            self.assertEqual(self.status()["state"], "pending")
            self.assertEqual(self.worker.execute({**self.address, "method": "snapshot"})["revision"], 0)

    def restore(self, snapshot):
        self.worker.documents.clear()
        return self.worker.execute({**self.address, "method": "open",
            **{key: snapshot[key] for key in ("checkpoint", "checkpointHash", "revision")}})

    def test_matching_original_restores_draft_and_saves_exact_bytes(self):
        restored = self.restore(self.commit())
        self.assertNotIn("originalStatus", restored)
        self.assertEqual(base64.b64decode(restored["data"]), self.edited)
        saved = self.worker.execute({**self.address, "method": "save", "revision": 1, "requestId": "save-draft"})
        self.assertEqual(self.path.read_bytes(), self.edited)
        self.assertEqual(saved["savedRevision"], 1)
        self.assertNotIn("originalStatus", self.restore(saved))

    def test_external_change_is_reported_on_restore_and_never_overwritten(self):
        snapshot = self.commit()
        external = self.original + b"external-change"
        self.path.write_bytes(external)
        restored = self.restore(snapshot)
        self.assertEqual(restored["originalStatus"], "conflict")
        self.assertEqual(base64.b64decode(restored["data"]), self.edited)
        with self.assertRaises(self.worker.WordFailure):
            self.worker.execute({**self.address, "method": "save", "revision": 1, "requestId": "blocked"})
        self.assertEqual(self.path.read_bytes(), external)
        copy = self.root / "recovered.docx"
        saved = self.worker.execute({**self.address, "path": str(copy), "method": "save", "revision": 1, "requestId": "copy"})
        self.assertNotIn("originalStatus", saved)
        self.assertEqual(copy.read_bytes(), self.edited)
        self.assertEqual(self.path.read_bytes(), external)

    def test_missing_original_keeps_recoverable_draft(self):
        snapshot = self.commit()
        self.path.unlink()
        restored = self.restore(snapshot)
        self.assertEqual(restored["originalStatus"], "unavailable")
        self.assertEqual(base64.b64decode(restored["data"]), self.edited)
        self.assertFalse(self.path.exists())

    def test_locked_original_keeps_recoverable_draft(self):
        import win32file
        snapshot = self.commit()
        handle = win32file.CreateFile(str(self.path), win32file.GENERIC_READ, 0, None,
            win32file.OPEN_EXISTING, 0, None)
        try:
            restored = self.restore(snapshot)
            self.assertEqual(restored["originalStatus"], "unavailable")
            self.assertEqual(base64.b64decode(restored["data"]), self.edited)
        finally:
            handle.Close()
        saved = self.worker.execute({**self.address, "method": "save", "revision": 1, "requestId": "retry"})
        self.assertNotIn("originalStatus", saved)
        self.assertEqual(self.path.read_bytes(), self.edited)


result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(OperationReceiptTests))
(EVIDENCE / "operation-receipt.json").write_text(json.dumps({"passed": result.wasSuccessful(), "tests": result.testsRun,
    "failures": [(str(test), error) for test, error in result.failures + result.errors]}, indent=2), encoding="utf8")
raise SystemExit(0 if result.wasSuccessful() else 1)
