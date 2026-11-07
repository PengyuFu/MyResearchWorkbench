"""Native Word page equivalence on synthetic mixed-layout DOCX files."""
import sys, json, hashlib, traceback
from pathlib import Path
SOURCE, DEPENDENCY, EVIDENCE = map(Path, sys.argv[1:4])
EVIDENCE.mkdir(parents=True, exist_ok=True)
WORK = EVIDENCE / "workspace"
WORK.mkdir(exist_ok=True)
sys.path.insert(0, str(SOURCE / "packages/workspace/workbench-word/worker"))
sys.argv = [sys.argv[0], str(DEPENDENCY), str(EVIDENCE / "app-data")]
import bridge
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

report = {"passed": False, "checks": []}
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def fixture(name, complex_table):
    target = WORK / (name + ".docx")
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.left_margin, sec.right_margin = Cm(2.6), Cm(2.2)
    sec.header.paragraphs[0].text = "合成文稿 · 格式验证"
    sec.footer.paragraphs[0].text = "仅用于本机界面验证"
    normal = doc.styles["Normal"]
    normal.font.name, normal.font.size = "宋体", Pt(12)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
    normal.paragraph_format.line_spacing = 1.5
    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run("开题报告版式验证" if complex_table else "Editable manuscript")
    run.bold = True
    run.font.size, run.font.name = Pt(20), "黑体"
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "黑体")
    if complex_table:
        table = doc.add_table(rows=6, cols=4)
        table.style = "Table Grid"
        for r, row in enumerate(table.rows):
            for c, cell in enumerate(row.cells):
                cell.text = "栏目 " + str(r + 1) + "-" + str(c + 1)
        table.cell(0, 0).merge(table.cell(0, 3)).text = "合并标题：研究课题与写作计划"
        table.cell(1, 0).merge(table.cell(2, 0)).text = "纵向合并"
        table.cell(3, 1).merge(table.cell(3, 3)).text = "研究内容：检查表格宽度、边框及段落缩进。"
    doc.add_heading("一、研究背景", level=1)
    doc.add_paragraph("Unique editable body. 保留中文字体、英文 Times New Roman 和页面边距。")
    for i in range(12):
        p = doc.add_paragraph("段落" + str(i+1) + "：这是本机合成验证资料，包含中文、标点和 English text。页面应由 Word 排版。")
        p.paragraph_format.first_line_indent = Cm(.75)
        p.paragraph_format.space_after = Pt(6)
    doc.add_page_break()
    doc.add_heading("二、工作安排", level=1)
    doc.add_paragraph("Second page marker. 分页后应保持标题、页眉和页脚。")
    doc.save(target)
    return target

def request(method, **values):
    return bridge.execute({"method":method, "scope":"word-layout-test", "root":str(WORK), **values})

bridge.pythoncom.CoInitializeEx(bridge.pythoncom.COINIT_APARTMENTTHREADED)
try:
    for name, complex_table in (("merged-layout", True), ("editable", False)):
        original = fixture(name, complex_table)
        before = digest(original)
        snap = request("open", path=str(original), create=False)
        proof = request("proof", documentId=snap["id"], revision=snap["revision"])
        native_pdf = EVIDENCE / (name + "-board.pdf")
        native_pdf.write_bytes(bridge.base64.b64decode(proof["data"]))
        reference_pdf = EVIDENCE / (name + "-word.pdf")
        reference = bridge.word().Documents.Open(str(original), ConfirmConversions=False, ReadOnly=True,
            AddToRecentFiles=False, Visible=False, OpenAndRepair=False, NoEncodingDialog=True)
        try:
            reference.ExportAsFixedFormat(str(reference_pdf), 17, OpenAfterExport=False)
        finally:
            reference.Close(0)
        pages = int(bridge.documents[snap["id"]]["doc"].ComputeStatistics(2))
        assert pages >= 2
        request("close", documentId=snap["id"], discard=False)
        assert digest(original) == before
        report["checks"].append({"name":name,"passed":True,"projectionReadOnly":snap["projection"].get("readOnly"),
            "originalSha256":before,"originalUnchanged":True,"pageCount":pages,
            "boardPdf":str(native_pdf),"referencePdf":str(reference_pdf)})
    report["passed"] = True
except Exception:
    report["error"] = traceback.format_exc()
    raise
finally:
    for record in list(bridge.documents.values()):
        record["doc"].Close(0)
    bridge.documents.clear()
    if bridge.application is not None:
        bridge.application.Quit(0)
    bridge.application = None
    bridge.gc.collect()
    if bridge.owned_job is not None:
        bridge.owned_job.Close()
    bridge.pythoncom.CoUninitialize()
    (EVIDENCE / "report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf8")
    print(json.dumps(report,ensure_ascii=False))
