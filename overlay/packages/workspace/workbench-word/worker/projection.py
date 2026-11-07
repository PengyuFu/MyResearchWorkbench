"""Read-only Word projection. Only verified plain ranges become editable."""
import base64
import uuid
from lxml import etree
from safe_save import WordFailure
NS={"w":"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "m":"http://schemas.openxmlformats.org/officeDocument/2006/math",
    "pkg":"http://schemas.microsoft.com/office/2006/xmlPackage",
    "a":"http://schemas.openxmlformats.org/drawingml/2006/main",
    "r":"http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
W="{"+NS["w"]+"}"
def units(text): return len(text.encode("utf-16-le"))//2
def slice_units(text,start,end):
    try:return text.encode("utf-16-le")[start*2:end*2].decode("utf-16-le")
    except UnicodeDecodeError:raise WordFailure("range", "The selection splits a Unicode character.")
def attr(element,name,default=None):
    return default if element is None else element.get(W+name,default)
def props(node):
    p=node.find("w:pPr",NS)
    level=attr(None if p is None else p.find("w:outlineLvl",NS),"val")
    return {"level": int(level)+1 if level is not None and level.isdigit() and int(level)<9 else 0}
def run_text(run):
    text=""
    for element in run:
        if element.tag==W+"t":text+=element.text or ""
        elif element.tag==W+"tab":text+="\t"
        elif element.tag in (W+"br",W+"cr"):text+="\v"
    return text
def font_marks(properties):
    marks={}
    if properties is None:return marks
    for xml,key in [("b","bold"),("i","italic"),("u","underline")]:
        e=properties.find("w:"+xml,NS)
        if e is not None:marks[key]=attr(e,"val","1") not in ("0","false","none")
    fonts=properties.find("w:rFonts",NS);size=properties.find("w:sz",NS)
    name=attr(fonts,"eastAsia") or attr(fonts,"ascii")
    if name:marks["font"]=name
    raw=attr(size,"val")
    if raw and raw.isdigit():marks["size"]=int(raw)/2
    return marks

def runs_of(node,styles=None,defaults=None,default_style='Normal'):
    styles={} if styles is None else styles
    inherited={**(defaults or {}),**styles.get(attr(node.find("w:pPr/w:pStyle",NS),"val",default_style),{})}
    runs=[];offset=0
    for run in node.findall("w:r",NS):
        text=run_text(run)
        if not text:continue
        end=offset+units(text);properties=run.find("w:rPr",NS)
        character=attr(run.find("w:rPr/w:rStyle",NS),"val")
        marks={**inherited,**styles.get(character,{}),**font_marks(properties)}
        runs.append({"from":offset,"to":end,**marks});offset=end
    return runs,offset

def project(record):
    document=record["doc"]
    xml=etree.fromstring(document.Content.WordOpenXML.encode("utf8"))
    body=xml.find(".//w:body",NS)
    paragraphs=[] if body is None else body.xpath(".//w:p[not(ancestor::w:txbxContent) and not(ancestor::w:tc[w:tcPr/w:vMerge[not(@w:val) or @w:val='continue']])]",namespaces=NS)
    # Cache each COM range once; nested table filtering must stay entirely local.
    native=[]
    for paragraph in document.Paragraphs:
        r=paragraph.Range
        native.append((r,int(r.Start),int(r.End),str(r.Text)))
    style_nodes={node.get(W+"styleId"):node for node in xml.findall(".//w:styles/w:style",NS)}
    styles=[attr(node.find("w:name",NS),"val",key) for key,node in style_nodes.items() if node.get(W+"type")=="paragraph"]
    default_style=next((key for key,node in style_nodes.items() if node.get(W+"type")=="paragraph" and node.get(W+"default")=="1"),"Normal")
    record["defaultStyle"]=default_style
    style_runs={}
    def inherited_font(identifier,seen=None):
        if identifier in style_runs:return style_runs[identifier]
        seen=set() if seen is None else seen
        node=style_nodes.get(identifier)
        if node is None or identifier in seen:return {}
        parent=attr(node.find("w:basedOn",NS),"val")
        result={**inherited_font(parent,seen|{identifier}),**font_marks(node.find("w:rPr",NS))}
        style_runs[identifier]=result
        return result
    for identifier in style_nodes:inherited_font(identifier)
    defaults=font_marks(xml.find(".//w:docDefaults/w:rPrDefault/w:rPr",NS))
    record["styleRuns"],record["defaultRun"]=style_runs,defaults
    def paragraph_value(node,name,attribute="val",fallback=None,seen=None):
        own=node.find("w:pPr/w:"+name,NS)
        if own is not None:return attr(own,attribute,fallback)
        identifier=attr(node.find("w:pPr/w:pStyle",NS),"val",default_style) if node.tag==W+"p" else attr(node.find("w:basedOn",NS),"val")
        seen=set() if seen is None else seen
        if identifier in style_nodes and identifier not in seen:
            return paragraph_value(style_nodes[identifier],name,attribute,fallback,seen|{identifier})
        return fallback
    table_ranges=[]
    for table in document.Tables:
        entry={"from":int(table.Range.Start),"to":int(table.Range.End),"id":"t"+str(table.Range.Start),"cells":[],"safe":False}
        # Range.Cells works for merged tables; Rows/Columns can reject vertical or irregular merges.
        cells=list(table.Range.Cells)
        for c in cells:
            r=c.Range
            entry["cells"].append({"from":int(r.Start),"to":int(r.End),"row":int(c.RowIndex)-1,
                "column":int(c.ColumnIndex)-1})
        entry["safe"]=int(table.NestingLevel)==1 and int(table.Range.Tables.Count)==1
        rows=max((c["row"]+1 for c in entry["cells"]),default=0)
        columns=max((c["column"]+1 for c in entry["cells"]),default=0)
        for cell in entry["cells"]:cell.update(rows=rows,columns=columns)
        table_ranges.append(entry)
    # A row terminator is outside every actual cell, including merged cells.
    native=[p for p in native if not any(t["from"]<=p[1]<t["to"]
        and not any(cell["from"]<=p[1]<cell["to"] for cell in t["cells"])
        and p[3]=="\r\a" for t in table_ranges)]
    if len(paragraphs)!=len(native):
        return protected_document(record,"unmapped-structure")
    previous={int(value["range"].Start):value["id"] for value in record.get("anchors",[])}
    if not previous:previous={int(value["start"]):value["id"] for value in record.get("anchorIds",[])}
    anchors=[];blocks=[];mapping=[];text="";images={}
    for index,((r,start,end,raw),node) in enumerate(zip(native,paragraphs)):
        value=raw[:-2] if raw.endswith("\r\a") else raw[:-1] if raw.endswith("\r") else raw
        value=value.replace("\r","\n").replace("\v","\n")
        protected=bool(node.xpath(".//w:fldChar | .//w:instrText | .//m:oMath | .//w:bookmarkStart | .//w:bookmarkEnd | .//w:footnoteReference | .//w:endnoteReference | .//w:commentRangeStart | .//w:commentRangeEnd | .//w:commentReference | .//w:ins | .//w:del | .//w:moveFrom | .//w:moveTo | .//w:hyperlink | .//w:sdt | .//w:pict | .//w:object | .//w:txbxContent",namespaces=NS))
        if node.xpath("ancestor::w:ins | ancestor::w:del | ancestor::w:sdt",namespaces=NS):protected=True
        drawings=node.xpath(".//w:drawing",namespaces=NS)
        inline=list(r.InlineShapes) if drawings else []
        single_image=len(inline)==1 and units(value)==1 and int(inline[0].Type)==3 and int(inline[0].Range.Start)==start
        if drawings:protected=True
        kind="image" if single_image else "protected" if protected else "paragraph"
        identifier=previous.get(start,"b"+uuid.uuid4().hex)
        run_values,run_length=runs_of(node,style_runs,defaults,default_style)
        native_end=end-(1 if raw.endswith("\r\a") or raw.endswith("\r") else 0)
        if not protected and (run_length!=units(value) or native_end-start!=units(value)):
            kind="protected"
        style_id=attr(node.find("w:pPr/w:pStyle",NS),"val",default_style)
        style_node=style_nodes.get(style_id)
        style_name=attr(None if style_node is None else style_node.find("w:name",NS),"val",style_id)
        outline_level=int(paragraph_value(node,"outlineLvl",fallback="9"))+1
        list_format=r.ListFormat if paragraph_value(node,"numPr",fallback=None) is not None or node.find("w:pPr/w:numPr",NS) is not None else None
        block={"id":identifier,"kind":kind,"from":units(text),"to":units(text)+units(value),
               "text":value,"style":style_name,"level":outline_level if 0<outline_level<10 else 0,
               "alignment":{"left":0,"center":1,"right":2,"both":3}.get(paragraph_value(node,"jc",fallback="left"),0),
               "spaceBefore":float(paragraph_value(node,"spacing","before","0"))/20,
               "spaceAfter":float(paragraph_value(node,"spacing","after","0"))/20,"runs":run_values,"list":str(list_format.ListString) if list_format is not None and int(list_format.ListType) in (2,3,4) else ""}
        line=paragraph_value(node,"spacing","line")
        if line is not None and paragraph_value(node,"spacing","lineRule","auto")=="auto":
            block["lineSpacing"]=float(line)/240
        if kind=="protected":block["reason"]="protected-object"
        if single_image:
            image=inline[0];block["image"]={"width":float(image.Width),"height":float(image.Height)}
            embed=node.find(".//a:blip",NS)
            rid=None if embed is None else embed.get("{"+NS["r"]+"}embed")
            parts=xml.findall("pkg:part",NS)
            relationship=None
            for part in parts:
                if part.get("{"+NS["pkg"]+"}name")=="/word/_rels/document.xml.rels":
                    for rel in part.iter():
                        if rel.get("Id")==rid:relationship=rel.get("Target")
            if relationship:
                import posixpath
                name=posixpath.normpath(posixpath.join("/word",relationship))
                for part in parts:
                    if part.get("{"+NS["pkg"]+"}name")==name:
                        binary=part.find("pkg:binaryData",NS)
                        mime=part.get("{"+NS["pkg"]+"}contentType","")
                        if binary is not None and mime in ("image/png","image/jpeg","image/gif"):
                            block["image"]["data"]="data:"+mime+";base64,"+"".join((binary.text or "").split())
            images[identifier]=image
        table=next((t for t in table_ranges if start>=t["from"] and end<=t["to"]),None)
        cell=None if table is None else next((c for c in table["cells"] if start>=c["from"] and end<=c["to"]),None)
        if table is not None:
            if not table["safe"] or cell is None:
                block.update(kind="protected",reason="complex-table")
            else:block["table"]={k:cell[k] for k in ("row","column","rows","columns")};block["table"]["id"]=table["id"]
        if record.get("readOnly"):block.update(kind="protected",reason=record["readOnly"])
        mapping.append({"from":block["from"],"to":block["to"],"start":start,"end":native_end,"block":block})
        anchors.append({"id":identifier,"range":r.Duplicate})
        blocks.append(block);text+=value+"\n"
    record["mapping"],record["anchors"],record["images"]=mapping,anchors,images
    snapshot={"blocks":blocks,"text":text,"styles":styles,"canUndo":record["revision"]>0,
              "canRedo":record.get("canRedo",False),"readOnly":record.get("readOnly")}
    record["projection"]=snapshot
    return snapshot

def page_regions(record):
    """Locate editable paragraphs from actual characters in Word's current print layout."""
    if record.get("readOnly"):return []
    doc=record["doc"]
    doc.Repaginate()
    window=doc.ActiveWindow
    window.View.Type=3
    sections=[]
    for section in doc.Sections:
        r=section.Range;setup=section.PageSetup
        sections.append({"from":int(r.Start),"to":int(r.End),"right":float(setup.PageWidth)-float(setup.RightMargin),
            "top":float(setup.TopMargin),"bottom":float(setup.PageHeight)-float(setup.BottomMargin)})
    regions=[];cell_widths={}
    for item in record["mapping"]:
        block=item["block"]
        if block["kind"]!="paragraph":continue
        # Collapsed ranges at a centered paragraph start report its margin rather than its first glyph.
        # Empty cells use an insertion point, never the cell/row terminator.
        first=doc.Range(item["start"],min(item["start"]+1,item["end"]))
        last=doc.Range(max(item["start"],item["end"]-1),item["end"])
        window.ScrollIntoView(first,True)
        page=int(first.Information(3))
        x,y=float(first.Information(5)),float(first.Information(6))
        window.ScrollIntoView(last,True)
        last_page,last_y=int(last.Information(3)),float(last.Information(6))
        left=x
        if min(left,y,last_y)<0:
            raise WordFailure("layout-unavailable","Word could not locate this paragraph on the page.")
        section=next(s for s in sections if s["from"]<=item["start"]<s["to"])
        right=section["right"]
        table=block.get("table")
        if table is not None:
            key=(table["id"],table["row"],table["column"])
            if key not in cell_widths:
                cell=first.Cells.Item(1)
                cell_widths[key]=float(cell.Width)-float(cell.LeftPadding)-float(cell.RightPadding)
            right=left+cell_widths[key]
        marks=block["runs"][0] if block["runs"] else {}
        font_name=marks.get("font")
        size=marks.get("size")
        if font_name is None or size is None:
            font=first.Font
            if font_name is None:font_name=str(font.NameFarEast or font.Name)
            if size is None:size=float(font.Size)
        line=max(size*1.2,12)
        for number in range(page,last_page+1):
            top=y if number==page else section["top"]
            bottom=last_y+line if number==last_page else section["bottom"]
            regions.append({"id":block["id"],"page":number,"x":left,"y":top,
                "width":max(12,right-left),"height":max(line,bottom-top),
                "font":font_name,"size":size,"alignment":block["alignment"]})
    return regions

def project_local_text(record,operation):
    """Re-read one verified plain paragraph; all unaffected native ranges retain their identity."""
    if operation.get("kind")!="replace" or any(c in operation.get("text","") for c in "\r\n\v"):return False
    previous=record["projection"]
    first=next((m for m in record["mapping"] if m["from"]<=operation["from"]<=operation["to"]<=m["to"]),None)
    if first is None or first["block"]["kind"]!="paragraph":return False
    old=first["block"]
    a,b=operation["from"]-old["from"],operation["to"]-old["from"]
    expected=slice_units(old["text"],0,a)+operation["text"]+slice_units(old["text"],b,units(old["text"]))
    delta=units(expected)-units(old["text"])
    native=record["doc"].Range(first["start"],first["end"]+delta)
    if str(native.Text).replace("\v","\n")!=expected:return False
    xml=etree.fromstring(native.WordOpenXML.encode("utf8"))
    nodes=xml.findall(".//w:body/w:p",NS)
    if len(nodes)!=1:return False
    values,length=runs_of(nodes[0],record.get("styleRuns"),record.get("defaultRun"),record.get("defaultStyle","Normal"))
    if length!=units(expected):return False
    old.update(text=expected,to=old["from"]+units(expected),runs=values)
    first["to"]=old["to"];first["end"]+=delta
    passed=False
    for mapping in record["mapping"]:
        if mapping is first:passed=True;continue
        if passed:
            for key in ("from","to","start","end"):mapping[key]+=delta
            mapping["block"]["from"]=mapping["from"];mapping["block"]["to"]=mapping["to"]
    previous["text"]="".join(block["text"]+"\n" for block in previous["blocks"])
    previous["canUndo"]=record["revision"]>0;previous["canRedo"]=record.get("canRedo",False)
    return True

def protected_document(record,reason):
    text=str(record["doc"].Content.Text).replace("\r","\n")
    snapshot={"blocks":[{"id":"protected","kind":"protected","from":0,"to":units(text),"text":text,
        "reason":reason,"style":"","level":0,"alignment":0,"spaceBefore":0,"spaceAfter":0,"runs":[]}],
        "text":text,"styles":[],"canUndo":False,"canRedo":False,"readOnly":reason}
    record["mapping"]=[];record["anchors"]=[];record["images"]={};record["projection"]=snapshot;record["readOnly"]=reason
    return snapshot

def mapped_range(record,start,end,before=None):
    if record.get("readOnly"):
        raise WordFailure("read-only","This document is protected.")
    text=record["projection"]["text"]
    if not isinstance(start,int) or not isinstance(end,int) or start<0 or end<start or end>units(text)-1:
        raise WordFailure("range","The selection is no longer valid.")
    if before is not None and slice_units(text,start,end)!=before:
        raise WordFailure("stale","The selected text changed.")
    mapping=record["mapping"]
    first=next((m for m in mapping if m["from"]<=start<=m["to"]),None)
    last=next((m for m in mapping if m["from"]<=end<=m["to"]),None)
    if first is None or last is None:raise WordFailure("range","Choose a text range.")
    covered=[m for m in mapping if first["from"]<=m["from"]<=last["from"]]
    if any(m["block"]["kind"]!="paragraph" for m in covered):
        raise WordFailure("protected","The selection includes a protected object.")
    cells=[m["block"].get("table") for m in covered]
    if any(c is not None for c in cells) and any(c!=cells[0] for c in cells):
        raise WordFailure("protected","Edit one table cell at a time.")
    slice_units(text,start,end)  # Refuse surrogate halves before touching COM.
    return record["doc"].Range(first["start"]+start-first["from"],last["start"]+end-last["from"])
