"""Private JSON-lines worker. All Word COM calls remain on this STA thread."""
import base64
import gc
import io
import json
import os
from pathlib import Path
import queue
import shutil
import sys
import threading
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
import pythoncom
import pywintypes
import win32api
import win32com
win32com.__gen_path__=str(DATA/"generated-com")
import win32com.client
import win32con
import win32file
import win32gui
import win32job
import win32process
from lxml import etree
from safe_save import WordFailure,confined,durable,durable_json,sha,read_original,commit,recover_commit,finish_commit
from projection import project,project_local_text,mapped_range,units,page_regions
from storage import startup,retain,cleanup_working,diagnostic,proof_name,read_json

documents={}
application=None
owned_job=None
owned_pid=None
input_queue=queue.Queue()
MAX_MESSAGE=32*1024*1024

def emit(value):
    sys.stdout.write(json.dumps(value,ensure_ascii=False,separators=(",",":"))+"\n")
    sys.stdout.flush()

def reader():
    while True:
        line=sys.stdin.buffer.readline(MAX_MESSAGE+1)
        if not line:
            input_queue.put(None);return
        if len(line)>MAX_MESSAGE:
            input_queue.put({"invalid":"message-too-large"});return
        try:
            value=json.loads(line)
            if not isinstance(value,dict):raise ValueError("object required")
            input_queue.put(value)
            if value.get("method")=="shutdown":return
        except (ValueError,UnicodeDecodeError):input_queue.put({"invalid":"json"})

def word():
    global application,owned_job,owned_pid
    if application is not None:return application
    before=set(win32process.EnumProcesses())
    created=win32com.client.DispatchEx("Word.Application")
    created.Visible=False;created.DisplayAlerts=0;created.AutomationSecurity=3
    bootstrap=None;exclusive=False
    try:
        bootstrap=created.Documents.Add(Visible=False)
        pid=win32process.GetWindowThreadProcessId(int(bootstrap.Windows(1).Hwnd))[1]
        if pid in before or created.Documents.Count!=1:
            raise WordFailure("ownership","Word did not provide an exclusive process.")
        exclusive=True
        durable_json(DATA/"owner.json",{"pid":pid,"createdAt":time.time(),"exclusive":True})
        handle=win32api.OpenProcess(win32con.PROCESS_SET_QUOTA|win32con.PROCESS_TERMINATE|win32con.PROCESS_QUERY_INFORMATION,False,pid)
        try:
            job=win32job.CreateJobObject(None,'')
            info=win32job.QueryInformationJobObject(job,win32job.JobObjectExtendedLimitInformation)
            info["BasicLimitInformation"]["LimitFlags"]|=win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            win32job.SetInformationJobObject(job,win32job.JobObjectExtendedLimitInformation,info)
            win32job.AssignProcessToJobObject(job,handle)
        finally:handle.Close()
        owned_job=job;owned_pid=pid
        bootstrap.Close(0);bootstrap=None
        application=created
        return application
    except Exception:
        if bootstrap is not None:bootstrap.Close(0)
        # Never quit an instance that failed the exclusive-process proof.
        if exclusive:created.Quit(0)
        created=None;gc.collect()
        raise

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
        "checkpointHash","checkpointTime","requests","readOnly","anchorIds","savedRequests","storageVersion","checkpointSequence") if key in record}

def checkpoint(record,request_id=None):
    document=record["doc"]
    document.Save()
    record["anchorIds"]=[{"start":mapping["start"],"id":mapping["block"]["id"]} for mapping in record.get("mapping",[])]
    data=record["working"].read_bytes()
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
    return {**serial(record),"projection":record["projection"],"ownedPid":owned_pid,
            "saveRecovery":record.get("saveRecovery",[])}

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
        current["doc"].Close(0);del documents[identifier]
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
    working=directory/"working.docx"
    app=word()
    if data is None:
        doc=app.Documents.Add(Visible=False)
        doc.SaveAs2(str(working),FileFormat=16,AddToRecentFiles=False)
    else:
        durable(working,data)
        doc=app.Documents.Open(str(working),ConfirmConversions=False,ReadOnly=False,AddToRecentFiles=False,
            Visible=False,OpenAndRepair=False,NoEncodingDialog=True)
    record.update(directory=directory,working=working,doc=doc)
    # Read-only status is derived from this open document, not an earlier projection failure.
    record.pop("readOnly",None)
    if bool(doc.ReadOnly) or int(doc.ProtectionType)!=-1:record["readOnly"]="protected-document"
    if bool(doc.TrackRevisions):record["readOnly"]="tracking-enabled"
    try:
        project(record)
        if restore is None:checkpoint(record)
        documents[identifier]=record
        return snapshot(record)
    except Exception:
        doc.Close(0)
        raise

def validate_style(value):
    name=value.get("font")
    if name is not None and (not isinstance(name,str) or not 1<=len(name)<=100 or any(c in name for c in "\0\r\n")):
        raise WordFailure("invalid","Invalid font.")
    for key,low,high in (("size",6,96),("spaceBefore",0,100),("spaceAfter",0,100),("lineSpacing",0.5,5)):
        if key in value and (type(value[key]) not in (int,float) or not low<=value[key]<=high):
            raise WordFailure("invalid","Invalid paragraph or font measurement.")
    if "alignment" in value and (type(value["alignment"]) is not int or value["alignment"] not in (0,1,2,3)):
        raise WordFailure("invalid","Invalid alignment.")

def apply_font(font,name):
    font.Name=name
    try:font.NameFarEast=name
    except pywintypes.com_error as error:
        # Word rejects Latin-only faces for NameFarEast; keep its native East Asian fallback.
        if error.hresult!=-2146822444:raise

def apply_style(font,paragraph,value):
    if "font" in value:apply_font(font,value["font"])
    if "size" in value:font.Size=value["size"]
    if "bold" in value:font.Bold=-1 if value["bold"] else 0
    if "alignment" in value:paragraph.Alignment=value["alignment"]
    for key,attribute in (("spaceBefore","SpaceBefore"),("spaceAfter","SpaceAfter")):
        if key in value:setattr(paragraph,attribute,value[key])
    if "lineSpacing" in value:
        paragraph.LineSpacingRule=5;paragraph.LineSpacing=value["lineSpacing"]*12

def mutate(request):
    record=locate(request);request_id=request["requestId"]
    if request_id in record["requests"]:return snapshot(record)
    if request["revision"]!=record["revision"]:raise WordFailure("stale","The document changed. Review the current text before applying.")
    operation=request["operation"];kind=operation["kind"];doc=record["doc"]
    if record.get("readOnly"):raise WordFailure("read-only","This document is protected.")
    if kind in ("undo","redo"):
        changed=doc.Undo() if kind=="undo" else doc.Redo()
        if not changed:return snapshot(record)
        record["canRedo"]=kind=="undo"
    else:
        target=None
        if kind not in ("resize-image","configure-styles"):
            target=mapped_range(record,operation["from"],operation["to"],operation.get("before"))
        app=word();app.UndoRecord.StartCustomRecord("MyResearchWorkbench")
        applied=False
        try:
            if kind=="configure-styles":
                styles=operation["styles"]
                if not isinstance(styles,list) or not 1<=len(styles)<=10:raise WordFailure("invalid","Choose up to ten built-in paragraph styles.")
                levels=[entry.get("level") for entry in styles]
                if any(type(level) is not int or not 0<=level<=9 for level in levels) or len(set(levels))!=len(levels):
                    raise WordFailure("invalid","Choose distinct heading levels from 0 (body) to 9.")
                for entry in styles:validate_style(entry)
                for entry in styles:
                    style=doc.Styles(-1 if entry["level"]==0 else -1-entry["level"])
                    apply_style(style.Font,style.ParagraphFormat,entry)
            elif kind=="replace":
                text=operation["text"]
                if not isinstance(text,str) or len(text)>200000 or any(c in text for c in "\0\a\x01"):
                    raise WordFailure("invalid","The replacement contains unsupported characters.")
                target.Text=text.replace("\r\n","\n").replace("\r","\n").replace("\n","\r")
            elif kind=="format":
                validate_style(operation)
                if "headingLevel" in operation:
                    level=operation["headingLevel"]
                    if type(level) is not int or not 0<=level<=9:raise WordFailure("invalid","Invalid heading level.")
                    target.Style=doc.Styles(-1 if level==0 else -1-level)
                if "lineSpacing" in operation:
                    target.ParagraphFormat.LineSpacingRule=5
                    target.ParagraphFormat.LineSpacing=float(operation["lineSpacing"])*12
                for key in ("bold","italic","underline"):
                    if key in operation:setattr(target.Font,key.capitalize(),1 if operation[key] else 0)
                if "font" in operation:
                    name=operation["font"]
                    if not isinstance(name,str) or not 1<=len(name)<=100:raise WordFailure("invalid","Invalid font.")
                    apply_font(target.Font,name)
                if "size" in operation:
                    size=float(operation["size"])
                    if not 6<=size<=96:raise WordFailure("invalid","Choose a font size from 6 to 96.")
                    target.Font.Size=size
                if "alignment" in operation:
                    alignment=int(operation["alignment"])
                    if alignment not in (0,1,2,3):raise WordFailure("invalid","Invalid alignment.")
                    target.ParagraphFormat.Alignment=alignment
                for key,attribute in (("spaceBefore","SpaceBefore"),("spaceAfter","SpaceAfter")):
                    if key in operation:
                        value=float(operation[key])
                        if not 0<=value<=100:raise WordFailure("invalid","Invalid paragraph spacing.")
                        setattr(target.ParagraphFormat,attribute,value)
                if "style" in operation:
                    if operation["style"] not in record["projection"]["styles"]:raise WordFailure("invalid","Choose a document style.")
                    target.Style=operation["style"]
                if "list" in operation:
                    if operation["list"]=="bullet":target.ListFormat.ApplyBulletDefault()
                    elif operation["list"]=="number":target.ListFormat.ApplyNumberDefault()
                    elif operation["list"]=="none":target.ListFormat.RemoveNumbers()
                    else:raise WordFailure("invalid","Invalid list.")
            elif kind=="image":
                image_path=confined(record["root"],operation["path"]) if not operation.get("staged") else Path(operation["path"])
                if operation.get("staged") and image_path.parent!=record["directory"]:raise WordFailure("scope","Invalid staged image.")
                from PIL import Image
                with Image.open(image_path) as image:
                    if image.format not in ("PNG","JPEG") or image.width*image.height>50_000_000:raise WordFailure("unsupported","Choose a PNG or JPEG image.")
                position=int(target.Start);target.Text="\r"
                anchor=doc.Range(position+1,position+1)
                shape=doc.InlineShapes.AddPicture(str(image_path),LinkToFile=False,SaveWithDocument=True,Range=anchor)
                width=float(operation.get("width",320))
                if not 12<=width<=500:raise WordFailure("invalid","Choose an image width from 12 to 500 points.")
                shape.LockAspectRatio=-1;shape.Width=width
                caption=operation.get("caption","")
                if len(caption)>4000:raise WordFailure("invalid","The caption is too long.")
                end=int(shape.Range.End);doc.Range(end,end).Text="\r"+caption+"\r"
            elif kind=="resize-image":
                shape=record["images"].get(operation["nodeId"])
                if shape is None:raise WordFailure("stale","The image changed.")
                width=float(operation["width"])
                if not 12<=width<=500:raise WordFailure("invalid","Choose an image width from 12 to 500 points.")
                shape.LockAspectRatio=-1;shape.Width=width
            elif kind=="table":
                rows=operation["rows"]
                if not rows or len(rows)>100 or not rows[0] or len(rows[0])>20 or any(len(row)!=len(rows[0]) for row in rows):
                    raise WordFailure("invalid","Use a rectangular table with at most 100 rows and 20 columns.")
                if any(not isinstance(value,str) or len(value)>4000 or any(c in value for c in "\0\a\x01") for row in rows for value in row):
                    raise WordFailure("invalid","Invalid table text.")
                position=int(target.Start);target.Text="\r"
                table=doc.Tables.Add(doc.Range(position+1,position+1),len(rows),len(rows[0]))
                for r,row in enumerate(rows):
                    for c,text in enumerate(row):table.Cell(r+1,c+1).Range.Text=text.replace("\n","\r")
                caption=operation.get("caption","")
                if caption:
                    if len(caption)>4000:raise WordFailure("invalid","The caption is too long.")
                    end=int(table.Range.End);doc.Range(end,end).Text=caption+"\r"
            else:raise WordFailure("invalid","Unsupported document operation.")
            applied=True
        except Exception:
            app.UndoRecord.EndCustomRecord()
            if applied:doc.Undo()
            else:
                # A compound operation may have started before it failed. Reload the last durable checkpoint.
                record["frozen"]=True
            raise
        else:app.UndoRecord.EndCustomRecord()
        record["canRedo"]=False
    record["revision"]+=1
    try:
        if not project_local_text(record,operation):project(record)
        checkpoint(record,request_id)
    except Exception:
        record["frozen"]=True
        raise
    return snapshot(record)

def execute(request):
    method=request["method"]
    if method=="retain":return retain(DATA,request,documents)
    if method=="open":return open_document(request)
    if method=="hello":return {"protocol":1,"python":sys.version,"platform":sys.platform}
    if method=="shutdown":return {"closing":True}
    record=locate(request, allow_frozen=request.get("method")=="close" and request.get("discard") is True)
    if method=="snapshot":return snapshot(record)
    if method=="mutate":return mutate(request)
    if method=="checkpoint":
        checkpoint(record);return snapshot(record)
    if method=="save":
        if request["requestId"] in record.get("savedRequests",{}):return snapshot(record)
        if request["revision"]!=record["revision"]:raise WordFailure("stale","The document changed before save.")
        checkpoint(record)
        destination=request.get("path",record["path"])
        same=destination.casefold()==record["path"].casefold()
        result=commit(record["root"],destination,record["working"].read_bytes(),
            record["baseline"] if same else None,record["directory"],request["requestId"])
        record["path"]=destination;record["baseline"]=result["baseline"];record["savedRevision"]=record["revision"]
        record.setdefault("savedRequests",{})[request["requestId"]]=record["revision"]
        durable_json(record["directory"]/"record.json",serial(record))
        # The scene must reference metadata that acknowledges the original save as well as the binary revision.
        checkpoint(record)
        try:finish_commit(result["recovery"],record["directory"])
        except Exception as error:diagnostic(record["directory"],"save-cleanup-retained",error=error)
        return snapshot(record)
    if method=="recover-save":
        result=[]
        for journal in record["directory"].glob("save-*.json"):
            value=json.loads(journal.read_text("utf8"))
            if value.get("phase") in ("prepared","original-retained","needs-recovery","committed-unacknowledged"):
                status=recover_commit(value,record["directory"]);result.append({"journal":journal.name,"status":status})
        record["saveRecovery"]=result
        return snapshot(record)
    if method=="cached-proof":
        reference=request.get("reference")
        metadata=record["directory"]/"proof.json" if reference is None else record["directory"]/(proof_name(reference)+".json")
        if not metadata.exists():
            if reference is not None:raise WordFailure("recovery-invalid","The retained proof is unavailable.")
            return None
        proof=read_json(metadata)
        path=record["directory"]/(proof_name(proof)+".pdf")
        data=path.read_bytes()
        if sha(data)!=proof["sha256"]:raise WordFailure("recovery-invalid","The retained proof changed.")
        return {**proof,"path":str(path),"data":base64.b64encode(data).decode("ascii"),
            "regions":page_regions(record) if proof["revision"]==record["revision"] else []}
    if method=="proof":
        if request["revision"]!=record["revision"]:raise WordFailure("stale","The document changed before proof generation.")
        temporary=record["directory"]/"proof.pending.pdf"
        record["doc"].ExportAsFixedFormat(str(temporary),17,OpenAfterExport=False)
        data=temporary.read_bytes()
        if len(data)>64*1024*1024:raise WordFailure("too-large","The proof exceeds the supported size.")
        proof={"revision":record["revision"],"sha256":sha(data),"createdAt":time.time()*1000,
            "proofSequence":(read_json(record["directory"]/"proof.json").get("proofSequence",0)+1)
                if (record["directory"]/"proof.json").exists() else 1}
        path=record["directory"]/(proof_name(proof)+".pdf")
        durable(path,data)
        durable_json(path.with_suffix(".json"),proof)
        durable_json(record["directory"]/"proof.json",proof)
        temporary.unlink()
        return {**proof,"path":str(path),"data":base64.b64encode(data).decode("ascii"),"regions":page_regions(record)}
    if method=="close":
        if not request.get("discard"):checkpoint(record)
        record["doc"].Close(0);del documents[record["id"]]
        try:cleanup_working(record["directory"])
        except Exception as error:diagnostic(record["directory"],"close-working-retained",error=error)
        return {"closed":True}
    raise WordFailure("invalid","Unsupported worker command.")

def main():
    startup(DATA)
    pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
    threading.Thread(target=reader,daemon=True).start()
    try:
        while True:
            pythoncom.PumpWaitingMessages()
            try:request=input_queue.get(timeout=0.02)
            except queue.Empty:continue
            if request is None:break
            identifier=request.get("id")
            try:
                if "invalid" in request:raise WordFailure("invalid","Invalid worker message.")
                # COM busy failures before an operation starts may be retried; no automatic replay of unknown effects.
                result=execute(request)
                emit({"id":identifier,"ok":True,"result":result})
            except WordFailure as error:
                emit({"id":identifier,"ok":False,"error":{"code":error.code,"message":str(error),"details":error.details}})
            except Exception as error:
                traceback.print_exc(file=sys.stderr)
                emit({"id":identifier,"ok":False,"error":{"code":"word-failed","message":"Word could not complete this operation.",
                    "details":{"diagnostic":str(error)}}})
            if request.get("method")=="shutdown":break
    finally:
        for record in list(documents.values()):
            try:
                if not record.get("frozen"):checkpoint(record)
                record["doc"].Close(0)
                cleanup_working(record["directory"])
            except Exception as error:diagnostic(record["directory"],"shutdown-retained",error=error)
        documents.clear()
        global application,owned_job
        if application is not None:
            try:application.Quit(0)
            except Exception:pass
        application=None;gc.collect()
        if owned_job is not None:owned_job.Close();owned_job=None
        pythoncom.CoUninitialize()
if __name__=="__main__":main()
