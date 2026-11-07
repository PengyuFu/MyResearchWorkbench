"""Document protection admission and native round-trip; synthetic files only."""
import sys, json, uuid, hashlib, traceback
from pathlib import Path
SOURCE, DEPENDENCY, EVIDENCE = map(Path, sys.argv[1:4])
EVIDENCE.mkdir(parents=True, exist_ok=True)
WORK = EVIDENCE / "workspace"
WORK.mkdir(exist_ok=True)
sys.path.insert(0, str(SOURCE / "packages/workspace/workbench-word/worker"))
sys.argv = [sys.argv[0], str(DEPENDENCY), str(EVIDENCE / "app-data")]
import bridge
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

report = {"passed": False, "checks": []}
def fixture(name, enforcement=None, protected=True):
    path = WORK / (name + ".docx")
    doc = Document()
    doc.add_heading("Protection admission", 1)
    doc.add_paragraph("Editable body.")
    if protected:
        protection = OxmlElement("w:documentProtection")
        protection.set(qn("w:edit"), "readOnly")
        protection.set(qn("w:formatting"), "1")
        if enforcement is not None:
            protection.set(qn("w:enforcement"), enforcement)
        doc.settings.element.append(protection)
    doc.save(path)
    return path

def request(method, **values):
    return bridge.execute({"method": method, "scope": "protection-test", "root": str(WORK), **values})

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

bridge.pythoncom.CoInitializeEx(bridge.pythoncom.COINIT_APARTMENTTHREADED)
try:
    accepted = [fixture("disabled-" + value, value) for value in ("0", "false", "off")]
    accepted += [fixture("unspecified"), fixture("ordinary", protected=False)]
    for path in accepted:
        before = digest(path)
        bridge.inspect_docx(path.read_bytes())
        assert digest(path) == before
        report["checks"].append({"name": "admit-" + path.stem, "passed": True})
    denied = [fixture("enabled-" + value, value) for value in ("1", "true", "on")]
    denied += [fixture("invalid", "invalid")]
    for path in denied:
        before = digest(path)
        try:
            request("open", path=str(path), create=False)
        except bridge.WordFailure as error:
            assert error.code == ("unsupported" if path.stem == "invalid" else "protected"), str(error)
        else:
            raise AssertionError("Active or invalid document protection was admitted")
        assert digest(path) == before and not bridge.documents
        report["checks"].append({"name": "deny-" + path.stem, "passed": True})
    for path in accepted[:3]:
        before = digest(path)
        value = request("open", path=str(path), create=False)
        assert value.get("readOnly") is None, value.get("readOnly")
        body = next(b for b in value["projection"]["blocks"] if b["text"] == "Editable body.")
        value = request("mutate", documentId=value["id"], revision=value["revision"],
            requestId=uuid.uuid4().hex, operation={"kind": "replace", "from": body["from"],
            "to": body["to"], "before": body["text"], "text": "Saved edit."})
        assert "Saved edit." in value["projection"]["text"] and digest(path) == before
        value = request("save", documentId=value["id"], revision=value["revision"],
            requestId=uuid.uuid4().hex, path=str(path))
        assert digest(path) != before
        request("close", documentId=value["id"], discard=False)
        value = request("open", path=str(path), create=False)
        assert "Saved edit." in value["projection"]["text"]
        request("close", documentId=value["id"], discard=False)
        settings = Document(path).settings.element
        protection = settings.find(qn("w:documentProtection"))
        assert protection is not None, "Native Word removed the disabled protection record"
        assert protection.get(qn("w:enforcement"), "false") in ("0", "false", "off")
        report["checks"].append({"name": "native-roundtrip-" + path.stem, "passed": True,
            "originalUnchangedBeforeExplicitSave": True, "disabledProtectionRetained": True})
    path = accepted[3]
    before = digest(path)
    value = request("open", path=str(path), create=False)
    assert value.get("readOnly") == "protected-document"
    try:
        request("mutate", documentId=value["id"], revision=value["revision"],
            requestId=uuid.uuid4().hex, operation={"kind": "undo"})
    except bridge.WordFailure as error:
        assert error.code == "read-only"
    else:
        raise AssertionError("Native Word protection was bypassed")
    request("close", documentId=value["id"], discard=False)
    assert digest(path) == before
    report["checks"].append({"name": "unspecified-keeps-native-word-protection", "passed": True})
    report["passed"] = True
except Exception:
    report["error"] = traceback.format_exc()
    raise
finally:
    for record in list(bridge.documents.values()):
        try:
            record["doc"].Close(0)
        except Exception:
            pass
    bridge.documents.clear()
    if bridge.application is not None:
        bridge.application.Quit(0)
    bridge.application = None
    bridge.gc.collect()
    if bridge.owned_job is not None:
        bridge.owned_job.Close()
    bridge.pythoncom.CoUninitialize()
    (EVIDENCE / "report.json").write_text(json.dumps(report, indent=2), encoding="utf8")
    print(json.dumps(report))
