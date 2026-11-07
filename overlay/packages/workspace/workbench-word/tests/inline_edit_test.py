"""Affected native Word checks: merged cells, page editing, explicit save and draft restore."""
import sys,json,hashlib,traceback,uuid,zipfile
from pathlib import Path
SOURCE,DEP,OUT=map(Path,sys.argv[1:4])
WORK=OUT/"workspace";WORK.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(SOURCE/"packages/workspace/workbench-word/worker"))
sys.argv=[sys.argv[0],str(DEP),str(OUT/"native-data")]
import bridge
from projection import units,NS
from docx import Document
from lxml import etree
report={"passed":False,"checks":[]}
def request(method,**kw):return bridge.execute({"method":method,"scope":"inline-native","root":str(WORK),**kw})
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def topology(doc):
 xml=etree.fromstring(doc.Content.WordOpenXML.encode("utf8"))
 for element in xml.iter():
  for name in list(element.attrib):
   if etree.QName(name).localname.startswith("rsid"):del element.attrib[name]
 return [[etree.tostring(n,exclusive=True,method="c14n").decode() for n in xml.findall(".//w:body/"+q,NS)] for q in ("w:tbl/w:tblGrid","w:tbl/w:tr/w:tc/w:tcPr","w:sectPr")]
def mutate(snap,op):return request("mutate",documentId=snap["id"],revision=snap["revision"],requestId=uuid.uuid4().hex,operation=op)
doc=Document()
doc.add_heading("Native page edit fixture",level=1)
table=doc.add_table(rows=4,cols=3);table.style="Table Grid"
table.cell(0,0).merge(table.cell(0,2)).text="Horizontal merged title"
table.cell(1,0).merge(table.cell(2,0)).text="Vertical merge"
table.cell(1,1).text="Editable 中文😀 cell"
table.cell(3,0).text="Protected bookmark"
paragraph=table.cell(3,0).paragraphs[0]._p
start=etree.Element("{"+NS["w"]+"}bookmarkStart")
start.set("{"+NS["w"]+"}id","42");start.set("{"+NS["w"]+"}name","ProtectedTest")
paragraph.insert(0,start)
end=etree.SubElement(paragraph,"{"+NS["w"]+"}bookmarkEnd");end.set("{"+NS["w"]+"}id","42")
doc.add_paragraph("Outside table")
doc.save(WORK/"synthetic-merged.docx")
paths=[WORK/"synthetic-merged.docx",*sorted(WORK.glob("private-*.docx"))]
bridge.pythoncom.CoInitializeEx(bridge.pythoncom.COINIT_APARTMENTTHREADED)
try:
 for path in paths:
  initial_hash=digest(path)
  snap=request("open",path=str(path),create=False)
  assert not snap["projection"].get("readOnly"),snap["projection"].get("readOnly")
  record=bridge.documents[snap["id"]];before=topology(record["doc"])
  cells=[b for b in snap["projection"]["blocks"] if b.get("table") and b["kind"]=="paragraph"]
  assert cells
  proof=request("proof",documentId=snap["id"],revision=snap["revision"])
  assert proof["regions"]
  assert {b["id"] for b in cells}<={r["id"] for r in proof["regions"]}
  assert all(r["x"]>=0 and r["y"]>=0 and 0<r["width"]<1000 and 0<r["size"]<100 for r in proof["regions"])
  if path.name.startswith("synthetic"):
   blank_row=[b for b in cells if b["table"]["row"]==2]
   positions=[next(r["x"] for r in proof["regions"] if r["id"]==b["id"]) for b in blank_row]
   assert len(positions)==2 and positions[1]-positions[0]>100,"Empty-cell hit areas must stay in their own columns"
  block=next(b for b in cells if b["text"])
  original=block["text"]
  offset=block["to"]
  snap=mutate(snap,{"kind":"replace","from":offset,"to":offset,"before":"","text":" 修复验证😀"})
  assert "修复验证😀" in snap["projection"]["text"]
  assert digest(path)==initial_hash
  assert topology(record["doc"])==before
  snap=mutate(snap,{"kind":"undo"});assert "修复验证😀" not in snap["projection"]["text"]
  snap=mutate(snap,{"kind":"redo"});assert "修复验证😀" in snap["projection"]["text"]
  empty=next((b for b in snap["projection"]["blocks"] if b.get("table") and b["kind"]=="paragraph" and not b["text"]),None)
  if empty:
   snap=mutate(snap,{"kind":"replace","from":empty["from"],"to":empty["to"],"before":"","text":"空白填写"})
   assert "空白填写" in snap["projection"]["text"]
  cells=[b for b in snap["projection"]["blocks"] if b.get("table") and b["kind"]=="paragraph"]
  first=cells[0];other=next(b for b in cells if b["table"]!=first["table"])
  try:mutate(snap,{"kind":"replace","from":first["from"],"to":other["to"],"text":"must not replace cells"})
  except bridge.WordFailure as e:assert e.code=="protected"
  else:raise AssertionError("Cross-cell edit must be refused")
  if path.name.startswith("synthetic"):
   protected=next(b for b in snap["projection"]["blocks"] if b["kind"]=="protected")
   try:mutate(snap,{"kind":"replace","from":protected["from"],"to":protected["to"],"text":"must not replace field"})
   except bridge.WordFailure as e:assert e.code=="protected"
   else:raise AssertionError("Protected bookmark must be refused")
  # Close/reopen the exact acknowledged draft, without saving the workspace file.
  checkpoint={k:snap[k] for k in ("checkpoint","checkpointHash","revision")}
  text=snap["projection"]["text"]
  request("close",documentId=snap["id"],discard=False)
  snap=request("open",path=str(path),create=False,documentId=snap["id"],**checkpoint)
  assert snap["projection"]["text"]==text and not snap["projection"].get("readOnly")
  assert digest(path)==initial_hash
  saved=request("save",documentId=snap["id"],revision=snap["revision"],requestId=uuid.uuid4().hex)
  assert digest(path)!=initial_hash
  proof=request("proof",documentId=snap["id"],revision=snap["revision"])
  (OUT/(path.stem+"-board.pdf")).write_bytes(bridge.base64.b64decode(proof["data"]))
  reference=bridge.word().Documents.Open(str(path),ReadOnly=True,Visible=False,AddToRecentFiles=False)
  try:
   reference.ExportAsFixedFormat(str(OUT/(path.stem+"-word.pdf")),17,OpenAfterExport=False)
   assert topology(reference)==before
  finally:reference.Close(0)
  request("close",documentId=snap["id"],discard=False)
  print("Verified "+path.stem,flush=True)
  report["checks"].append({"case":path.stem,"passed":True,"editableCells":len(cells),"regions":len(proof["regions"]),
   "emptyCellEdited":empty is not None,"draftRestored":True,"originalUnchangedBeforeExplicitSave":True,"tableLayoutRetained":True})
 report["passed"]=True
except Exception:
 report["error"]=traceback.format_exc();raise
finally:
 for r in list(bridge.documents.values()):r["doc"].Close(0)
 bridge.documents.clear()
 if bridge.application is not None:bridge.application.Quit(0)
 bridge.application=None;bridge.gc.collect()
 if bridge.owned_job is not None:bridge.owned_job.Close()
 bridge.pythoncom.CoUninitialize()
 (OUT/"native-report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf8")
 print(json.dumps(report,ensure_ascii=False))
