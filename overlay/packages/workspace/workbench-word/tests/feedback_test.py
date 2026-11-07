"""Affected native Word paths only; synthetic documents and an exclusively owned Word instance."""
import sys, os, json, uuid, hashlib
from pathlib import Path
SOURCE,DEPENDENCY,EVIDENCE=map(Path,sys.argv[1:4])
EVIDENCE.mkdir(parents=True,exist_ok=True)
WORK=EVIDENCE/"workspace";WORK.mkdir(exist_ok=True)
sys.path.insert(0,str(SOURCE/"packages/workspace/workbench-word/worker"))
sys.argv=[sys.argv[0],str(DEPENDENCY),str(EVIDENCE/"app-data")]
import bridge
from docx import Document
path=WORK/"format.docx"
doc=Document();doc.add_heading("TITLE",1);doc.add_paragraph("Body paragraph.");doc.add_heading("SECOND",2)
for i in range(60):doc.add_paragraph("Long manuscript paragraph "+str(i)+". "+("Sample text. "*10))
doc.save(path)
sha=lambda:hashlib.sha256(path.read_bytes()).hexdigest()
before=sha();checks=[]
def request(method,**values):
    return bridge.execute({"method":method,"scope":"feedback-test","root":str(WORK),**values})
def mutate(value,operation):
    return request("mutate",documentId=value["id"],revision=value["revision"],requestId=uuid.uuid4().hex,operation=operation)
bridge.pythoncom.CoInitializeEx(bridge.pythoncom.COINIT_APARTMENTTHREADED)
try:
    value=request("open",path=str(path),create=False)
    value=mutate(value,{"kind":"configure-styles","styles":[
        {"level":0,"font":"Arial","size":15,"lineSpacing":1.5,"spaceAfter":8},
        {"level":1,"font":"Arial","size":22,"bold":True}]})
    body=next(b for b in value["projection"]["blocks"] if b["text"]=="Body paragraph.")
    assert body["runs"][0]["font"]=="Arial" and body["runs"][0]["size"]==15,body
    assert body["lineSpacing"]==1.5 and body["spaceAfter"]==8,body
    checks.append("native styles, inherited font and paragraph projection")
    value=mutate(value,{"kind":"format","from":body["from"],"to":body["to"],"before":body["text"],"headingLevel":3})
    assert next(b for b in value["projection"]["blocks"] if b["text"]=="Body paragraph.")["level"]==3
    value=mutate(value,{"kind":"undo"})
    assert next(b for b in value["projection"]["blocks"] if b["text"]=="Body paragraph.")["level"]==0
    assert sha()==before
    checks.append("semantic heading, native undo, original hash unchanged")
    value=request("save",documentId=value["id"],revision=value["revision"],requestId=uuid.uuid4().hex,path=str(path))
    assert sha()!=before
    request("close",documentId=value["id"],discard=False)
    value=request("open",path=str(path),create=False)
    assert next(b for b in value["projection"]["blocks"] if b["text"]=="Body paragraph.")["runs"][0]["size"]==15
    saved=sha();checks.append("explicit save and reopen preserve style policy")
    body=next(b for b in value["projection"]["blocks"] if b["text"]=="Body paragraph.")
    value=mutate(value,{"kind":"replace","from":body["from"],"to":body["to"],"before":body["text"],"text":"DISCARDED"})
    directory=bridge.documents[value["id"]]["directory"]
    count=len(list(directory.glob("checkpoint-*.docx")))
    bridge.documents[value["id"]]["frozen"]=True
    request("close",documentId=value["id"],discard=True)
    assert len(list(directory.glob("checkpoint-*.docx")))==count
    assert not (directory/"working.docx").exists()
    assert sha()==saved
    value=request("open",path=str(path),create=False)
    assert "DISCARDED" not in value["projection"]["text"]
    checks.append("discard frozen draft without checkpoint/write; reopen original")
    request("close",documentId=value["id"],discard=False)
    assert not bridge.documents
    (EVIDENCE/"report.json").write_text(json.dumps({"passed":True,"checks":checks},indent=2),encoding="utf8")
    print(json.dumps({"passed":True,"checks":checks}))
finally:
    for record in list(bridge.documents.values()):
        try:record["doc"].Close(0)
        except Exception:pass
    bridge.documents.clear()
    if bridge.application is not None:
        try:bridge.application.Quit(0)
        except Exception:pass
    bridge.application=None;bridge.gc.collect()
    if bridge.owned_job is not None:bridge.owned_job.Close()
    bridge.pythoncom.CoUninitialize()
