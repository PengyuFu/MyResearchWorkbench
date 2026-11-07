"""Binary DOCX checkpoint worker. Never opens Word, WPS or another document writer."""
import base64
import io
import json
import os
from pathlib import Path
import sys
import time
import traceback
import uuid
import zipfile
ROOT=Path(__file__).resolve().parent
DEPENDENCY=Path(sys.argv[1]).resolve()
DATA=Path(sys.argv[2]).resolve()
DATA.mkdir(parents=True,exist_ok=True)
sys.path[:0]=[str(ROOT),str(DEPENDENCY),str(DEPENDENCY/"win32"),str(DEPENDENCY/"win32"/"lib")]
DLL=os.add_dll_directory(str(DEPENDENCY/"pywin32_system32"))
import pywintypes
from lxml import etree
from safe_save import WordFailure,confined,durable,durable_json,sha,read_original,commit,recover_commit,finish_commit
from storage import startup,retain,cleanup_working,diagnostic,read_json
documents={}
MAX_MESSAGE=96*1024*1024
W="{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

def emit(value):
    sys.stdout.write(json.dumps(value,ensure_ascii=False,separators=(",",":"))+"\n")
    sys.stdout.flush()

def project_bytes(data):
    """Read-only opening context. The mounted engine supplies semantic ids on acknowledgement."""
    parser=etree.XMLParser(resolve_entities=False,no_network=True,load_dtd=False)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        body=etree.fromstring(archive.read("word/document.xml"),parser).find(W+"body")
        paragraphs=[] if body is None else body.iter(W+"p")
        blocks=[]; offset=0
        for index,paragraph in enumerate(paragraphs):
            text="".join(node.text or "" if node.tag==W+"t" else "\t" if node.tag==W+"tab" else "\n"
                for node in paragraph.iter() if node.tag in (W+"t",W+"tab",W+"br",W+"cr"))
            style=paragraph.find(W+"pPr/"+W+"pStyle")
            style="" if style is None else style.get(W+"val","")
            level=paragraph.find(W+"pPr/"+W+"outlineLvl")
            level=0 if level is None else min(9,int(level.get(W+"val","8"))+1)
            blocks.append({"id":"opening:"+str(index),"kind":"paragraph","from":offset,"to":offset+len(text.encode("utf-16-le"))//2,
                "text":text,"style":style,"level":level,"alignment":0,"spaceBefore":0,"spaceAfter":0,"runs":[]})
            offset=blocks[-1]["to"]+1
        return {"blocks":blocks,"text":"".join(block["text"]+"\n" for block in blocks),
            "styles":[],"canUndo":False,"canRedo":False}
def inspect_docx(data):
    try:
        archive=zipfile.ZipFile(io.BytesIO(data))
        infos=archive.infolist()
        if len(infos)>20000 or sum(item.file_size for item in infos)>256*1024*1024:
            raise WordFailure("too-large","The expanded document is too large.")
        names={item.filename for item in infos}
        if "word/document.xml" not in names or any(name.lower().endswith("vbaproject.bin") for name in names):
            raise WordFailure("unsupported","Only macro-free .docx documents are supported.")
        parser=etree.XMLParser(resolve_entities=False,no_network=True,load_dtd=False)
        for name in names:
            if name.endswith(".rels"):
                for rel in etree.fromstring(archive.read(name),parser):
                    if rel.get("TargetMode")=="External" and not rel.get("Type","").endswith("/hyperlink"):
                        raise WordFailure("external-link","This document uses an external template or linked object. Keep the original; edit a self-contained copy.")
        xml=archive.read("word/document.xml")
        if any(token in xml.upper() for token in (b"DDEAUTO",b"INCLUDETEXT",b"INCLUDEPICTURE",b"DATABASE ")):
            raise WordFailure("external-link","This document contains an external-content field.")
        if "word/settings.xml" in names:
            settings=etree.fromstring(archive.read("word/settings.xml"),parser)
            ns={"w":"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            protection=settings.find("w:documentProtection",ns)
            if protection is not None:
                enforcement=protection.get("{"+ns["w"]+"}enforcement","false")
                if enforcement not in ("true","1","on","false","0","off"):
                    raise WordFailure("unsupported","The document protection setting is invalid.")
                if enforcement in ("true","1","on"):
                    raise WordFailure("protected","Protected documents cannot be edited here.")
        archive.close()
    except (zipfile.BadZipFile,etree.XMLSyntaxError,KeyError) as error:
        raise WordFailure("unsupported","The file is encrypted, invalid or not a .docx document.") from error

def serial(record):
    return {key:record[key] for key in ("id","scope","root","path","baseline","revision","savedRevision","checkpoint",
        "checkpointHash","checkpointTime","requests","readOnly","anchorIds","savedRequests","storageVersion","checkpointSequence","projection","pendingOperations","resolvedOperations") if key in record}

def checkpoint(record,request_id=None):
    data=record["data"]
    inspect_docx(data)
    identifier=f'{record["revision"]}-{uuid.uuid4().hex}'
    destination=record["directory"]/("checkpoint-"+identifier+".docx")
    durable(destination,data)
    record.update(storageVersion=2,checkpointSequence=record.get("checkpointSequence",0)+1,
        checkpoint=identifier,checkpointHash=sha(data),checkpointTime=time.time()*1000)
    if request_id is not None:record["requests"][request_id]=record["revision"]
    durable_json(record["directory"]/("checkpoint-"+identifier+".json"),serial(record))
    durable_json(record["directory"]/"record.json",serial(record))
    return identifier

def snapshot(record):
    return {**serial(record),"data":base64.b64encode(record["data"]).decode("ascii"),"projection":record["projection"],
        "pendingOperations":record.get("pendingOperations",[]),
        **({"originalStatus":record["originalStatus"]} if "originalStatus" in record else {})}

def check_original(record):
    """Inspect the bound original once on recovery, retaining the draft on failure."""
    record.pop("originalStatus",None)
    try:
        if record["baseline"] is None:
            if Path(record["path"]).exists():record["originalStatus"]="conflict"
        else:
            _,baseline=read_original(record["root"],record["path"])
            if baseline!=record["baseline"]:record["originalStatus"]="conflict"
    except (WordFailure,OSError,pywintypes.error):
        record["originalStatus"]="unavailable"

def locate(request, allow_frozen=False):
    identifier=request.get("documentId")
    record=documents.get(identifier)
    if record is None:raise WordFailure("not-open","Reopen this document from its saved draft.")
    if request.get("scope")!=record["scope"] or request.get("root")!=record["root"]:
        raise WordFailure("scope","The document belongs to another session or workspace.")
    if record.get("frozen") and not allow_frozen:raise WordFailure("recovery-required","The last operation was not confirmed. Reopen the retained draft.")
    return record

def open_document(request):
    identifier=request.get("documentId") or uuid.uuid4().hex
    if len(identifier)!=32 or any(c not in "0123456789abcdef" for c in identifier):
        raise WordFailure("invalid","Invalid document identity.")
    if identifier in documents:
        current=documents[identifier]
        if current["scope"]!=request["scope"] or current["root"]!=request["root"]:
            raise WordFailure("scope","The draft belongs to another workspace.")
        if not current.get("frozen"):return snapshot(current)
        if request.get("checkpoint") is None:raise WordFailure("recovery-required","Reopen the retained draft.")
        del documents[identifier]
        try:cleanup_working(current["directory"])
        except Exception as error:diagnostic(current["directory"],"reopen-working-retained",error=error)
    scope=request["scope"];root=str(Path(request["root"]).resolve());path=request["path"]
    if not isinstance(scope,str) or len(scope)>200:raise WordFailure("scope","Invalid session.")
    directory=DATA/identifier
    meta=directory/"record.json"
    restore=request.get("checkpoint")
    if restore is not None:
        stored=json.loads(meta.read_text("utf8"))
        if stored["scope"]!=scope or stored["root"]!=root:
            raise WordFailure("scope","The draft belongs to another workspace.")
        # Use exactly the acknowledged checkpoint, not an unrelated later working copy.
        if not isinstance(restore,str) or len(restore)>80 or any(c not in "0123456789abcdef-" for c in restore):
            raise WordFailure("recovery-invalid","Invalid checkpoint.")
        checkpoint_path=directory/("checkpoint-"+restore+".docx")
        data=checkpoint_path.read_bytes()
        expected=request.get("checkpointHash")
        if expected!=sha(data):raise WordFailure("recovery-invalid","The saved draft did not pass its integrity check.")
        inspect_docx(data)
        checkpoint_meta=json.loads((directory/("checkpoint-"+restore+".json")).read_text("utf8"))
        if checkpoint_meta["revision"]!=int(request["revision"]) or checkpoint_meta["checkpointHash"]!=expected:
            raise WordFailure("recovery-invalid","The draft metadata does not match its content.")
        if checkpoint_meta["scope"]!=scope or checkpoint_meta["root"]!=root or checkpoint_meta["path"]!=path:
            raise WordFailure("scope","The checkpoint belongs to another document.")
        record=checkpoint_meta
        # Queue metadata is independent of document bytes; retain it at this exact base.
        record["pendingOperations"] = stored.get("pendingOperations", [])
        record["resolvedOperations"] = stored.get("resolvedOperations", {})
        record["checkpointSequence"]=max(record.get("checkpointSequence",0),stored.get("checkpointSequence",0))
        # A completed explicit save may have newer baseline metadata at the same revision.
        if stored["path"]==path and stored["revision"]==record["revision"] and stored.get("savedRevision")==record["revision"]:
            record.update(baseline=stored["baseline"],savedRevision=stored["savedRevision"],savedRequests=stored.get("savedRequests",{}))
        recovery=[]
        journals=list(directory.glob("save-*.json"))
        if (directory/"backup.json").exists():journals.append(directory/"backup.json")
        for journal in journals:
            entry=read_json(journal)
            if entry.get("root")==root and entry.get("target")==path and entry.get("version")==2:
                if entry.get("phase") in ("prepared","original-retained","needs-recovery","committed-unacknowledged") or not Path(path).exists():
                    status=recover_commit(entry,directory)
                    recovery.append({"journal":journal.name,"status":status})
                    if status=="restored-original":
                        _,record["baseline"]=read_original(root,path)
                        record["savedRevision"]=-1
        record["saveRecovery"]=recovery
        check_original(record)
    else:
        baseline=None
        if not request.get("create"):
            data,baseline=read_original(root,path);inspect_docx(data)
        else:
            if Path(path).exists():raise WordFailure("conflict","A file already exists at this destination.")
            data=None
        record={"id":identifier,"scope":scope,"root":root,"path":path,"baseline":baseline,
            "revision":0,"savedRevision":0 if baseline else -1,"requests":{},"storageVersion":2,"checkpointSequence":0}
    # Only one writer per identity, even through different session/path aliases.
    identity=None if record.get("baseline") is None else record["baseline"]["identity"]
    for current in documents.values():
        if current["path"].casefold()==path.casefold() or identity is not None and (current.get("baseline") or {}).get("identity")==identity:
            raise WordFailure("owned","This document is already open in another workbench.",{"owner":current["scope"]})
    directory.mkdir(exist_ok=True)
    if restore is None:durable_json(meta,serial(record))
    if data is None:data=(ROOT/"blank.docx").read_bytes()
    record.update(directory=directory,data=data)
    record["projection"]=record.get("projection") or project_bytes(data)
    record.setdefault("pendingOperations",[])
    if restore is None:checkpoint(record)
    documents[identifier]=record
    return snapshot(record)

def accept_bytes(request):
    record=locate(request); identity=request["requestId"]
    if identity in record["requests"]:return snapshot(record)
    if request["revision"]!=record["revision"]:
        raise WordFailure("stale","The confirmed DOCX checkpoint changed. The local draft has been retained.")
    data=base64.b64decode(request["data"],validate=True)
    if len(data)>64*1024*1024 or sha(data)!=request["sha256"]:
        raise WordFailure("invalid","The DOCX upload failed its integrity check.")
    inspect_docx(data)
    projection=request["projection"]
    if projection["text"]!="".join(block["text"]+"\n" for block in projection["blocks"]):
        raise WordFailure("invalid","The editing context is inconsistent.")
    if type(request["nextRevision"]) is not int or request["nextRevision"]<=record["revision"]:
        raise WordFailure("stale","The new DOCX revision must follow its base checkpoint.")
    queued=request.get("queuedRequestId")
    if queued and not any(item["requestId"]==queued and item["revision"]==request["revision"] for item in record.get("pendingOperations",[])):
        raise WordFailure("stale","The queued operation no longer matches this draft.")
    record["data"]=data
    record["projection"]=projection
    record["revision"]=request["nextRevision"]
    if queued:
        record["pendingOperations"]=[item for item in record.get("pendingOperations",[]) if item["requestId"]!=queued]
        # Persist the receipt with the committed bytes: polling must never see
        # a completed edit as missing while the client sends its final acknowledgement.
        record.setdefault("resolvedOperations",{})[queued]={"revision":record["revision"],"error":None}
    checkpoint(record,identity)
    return snapshot(record)

def page_info(record):
    """Read page regions from confirmed bytes; never mutate the package."""
    import posixpath
    ns={"w":"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        "r":"http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    parser=etree.XMLParser(resolve_entities=False,no_network=True,load_dtd=False)
    with zipfile.ZipFile(io.BytesIO(record["data"])) as archive:
        document=etree.fromstring(archive.read("word/document.xml"),parser)
        rels={}
        if "word/_rels/document.xml.rels" in archive.namelist():
            rels={item.get("Id"):posixpath.normpath(posixpath.join("word",item.get("Target",""))).lstrip("/")
                for item in etree.fromstring(archive.read("word/_rels/document.xml.rels"),parser)
                if item.get("TargetMode")!="External"}
        def enabled(node):
            return node is not None and node.get(W+"val","true") not in ("0","false","off")
        settings=etree.fromstring(archive.read("word/settings.xml"),parser) if "word/settings.xml" in archive.namelist() else None
        even=enabled(settings.find(W+"evenAndOddHeaders")) if settings is not None else False
        slots={};sections=[]
        section_nodes=document.findall(".//w:sectPr",ns)
        for index,section in enumerate(section_nodes):
            declared=set()
            for position in ("header","footer"):
                for reference in section.findall(W+position+"Reference"):
                    key=(position,reference.get(W+"type","default"));declared.add(key)
                    slots[key]=rels.get(reference.get("{"+ns["r"]+"}id"))
            regions=[]
            for (position,variant),part in slots.items():
                if not part or part not in archive.namelist():continue
                root=etree.fromstring(archive.read(part),parser)
                paragraphs=root.findall(".//w:p",ns)
                text="\n".join("".join(n.text or "" if n.tag==W+"t" else "\t" if n.tag==W+"tab" else "\n"
                    for n in p.iter() if n.tag in (W+"t",W+"tab",W+"br",W+"cr")) for p in paragraphs)
                fields=[n.text or "" for n in root.iter(W+"instrText")]+[n.get(W+"instr","") for n in root.iter(W+"fldSimple")]
                complex_region=any(n.tag in {W+k for k in ("tbl","drawing","pict","object","sdt","altChunk")} for n in root.iter())
                regions.append({"position":position,"variant":variant,"text":text[:4096],"truncated":len(text)>4096,
                    "fields":fields[:32],"inherited":(position,variant) not in declared,"complex":complex_region})
            margins=section.find(W+"pgMar")
            sections.append({"sectionIndex":index,"firstPageDifferent":enabled(section.find(W+"titlePg")),
                "oddEvenDifferent":even,"headerDistancePt":int(margins.get(W+"header","720"))/20 if margins is not None else 36,
                "footerDistancePt":int(margins.get(W+"footer","720"))/20 if margins is not None else 36,"regions":regions})
            if len(sections)>=64:break
    return {"revision":record["revision"],"savedRevision":record["savedRevision"],"sections":sections,
        "sectionCount":len(section_nodes),"sectionsTruncated":len(section_nodes)>len(sections),
        "pendingRequestIds":[op["requestId"] for op in record.get("pendingOperations",[])],
        "completed":[{"requestId":key,**value} for key,value in list(record.get("resolvedOperations",{}).items())[-20:]]}

def execute(request):
    method=request["method"]
    if method=="retain":return retain(DATA,request,documents)
    if method=="open":return open_document(request)
    if method=="hello":return {"protocol":1,"python":sys.version,"platform":sys.platform}
    if method=="shutdown":return {"closing":True}
    record=locate(request,allow_frozen=method=="close" and request.get("discard") is True)
    if method in ("snapshot","checkpoint"):return snapshot(record)
    if method=="page-info":return page_info(record)
    if method=="operation-status":
        receipt=record.get("resolvedOperations",{}).get(request["requestId"])
        if receipt is not None:return {"state":"completed",**receipt}
        pending=any(item["requestId"]==request["requestId"] for item in record.get("pendingOperations",[]))
        return {"state":"pending" if pending else "missing","revision":record["revision"],"error":None}
    if method=="commit-bytes":return accept_bytes(request)
    if method=="resolve-operation":
        record["pendingOperations"]=[item for item in record.get("pendingOperations",[]) if item["requestId"]!=request["requestId"]]
        record.setdefault("resolvedOperations",{})[request["requestId"]]={"revision":record["revision"],"error":request.get("error")}
        durable_json(record["directory"]/"record.json",serial(record))
        return {"resolved":True}
    if method=="mutate":
        if request["requestId"] in record.get("resolvedOperations",{}):return snapshot(record)
        if request["revision"]!=record["revision"]:raise WordFailure("stale","The document changed before the formatting request.")
        pending=record.setdefault("pendingOperations",[])
        if not any(item["requestId"]==request["requestId"] for item in pending):
            pending.append({key:request[key] for key in ("documentId","revision","requestId","operation")})
            durable_json(record["directory"]/"record.json",serial(record))
        return snapshot(record)
    if method=="save":
        if request["requestId"] in record.get("savedRequests",{}):return snapshot(record)
        if request["revision"]!=record["revision"]:raise WordFailure("stale","The document changed before save.")
        destination=request.get("path",record["path"])
        same=destination.casefold()==record["path"].casefold()
        result=commit(record["root"],destination,record["data"],record["baseline"] if same else None,
            record["directory"],request["requestId"])
        record["path"]=destination;record["baseline"]=result["baseline"];record["savedRevision"]=record["revision"]
        record.pop("originalStatus",None)
        record.setdefault("savedRequests",{})[request["requestId"]]=record["revision"]
        checkpoint(record)
        try:finish_commit(result["recovery"],record["directory"])
        except Exception as error:diagnostic(record["directory"],"save-cleanup-retained",error=error)
        return snapshot(record)
    if method in ("cached-proof","proof"):return None
    if method=="close":
        del documents[record["id"]]
        return {"closed":True}
    raise WordFailure("invalid","Unsupported DOCX checkpoint command.")

def main():
    startup(DATA)
    while True:
        line=sys.stdin.buffer.readline(MAX_MESSAGE+1)
        if not line:break
        request={}; identifier=None
        try:
            if len(line)>MAX_MESSAGE:raise WordFailure("too-large","The DOCX request exceeds its limit.")
            request=json.loads(line);identifier=request.get("id")
            result=execute(request)
            emit({"id":identifier,"ok":True,"result":result})
        except WordFailure as error:
            emit({"id":identifier,"ok":False,"error":{"code":error.code,"message":str(error),"details":error.details}})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({"id":identifier,"ok":False,"error":{"code":"docx-failed","message":"The DOCX operation failed.",
                "details":{"diagnostic":str(error)}}})
        if request.get("method")=="shutdown":break

if __name__=="__main__":main()
