from __future__ import annotations

import html
from io import BytesIO
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table as DocxTable
from docx.text.paragraph import Paragraph as DocxParagraph
from PIL import Image as PILImage, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image as RLImage,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
DOCX = ROOT / "docs" / "marca" / "Manual-de-Marca-FundoSmart.docx"
PDF = ROOT / "output" / "pdf" / "Manual-de-Marca-FundoSmart.pdf"
TMP = ROOT / "tmp" / "brand-manual" / "pdf-assets"

SLATE = "#151B21"
FOREST = "#1F4127"
CREAM = "#FAF7EE"
CLAY = "#D49656"
MUTED = "#4D5660"
STONE = "#DBD7CD"
MIST = "#E4EEE6"
WHITE = "#FFFFFF"
LIST_COUNTERS: dict[int, int] = {}


def register_fonts():
    candidates = {
        "Arial": r"C:\Windows\Fonts\arial.ttf",
        "Arial-Bold": r"C:\Windows\Fonts\arialbd.ttf",
        "Arial-Italic": r"C:\Windows\Fonts\ariali.ttf",
        "Arial-BoldItalic": r"C:\Windows\Fonts\arialbi.ttf",
        "Georgia": r"C:\Windows\Fonts\georgia.ttf",
        "Georgia-Bold": r"C:\Windows\Fonts\georgiab.ttf",
        "Georgia-Italic": r"C:\Windows\Fonts\georgiai.ttf",
        "Consolas": r"C:\Windows\Fonts\consola.ttf",
    }
    for name, path in candidates.items():
        if Path(path).exists():
            pdfmetrics.registerFont(TTFont(name, path))
    pdfmetrics.registerFontFamily(
        "Arial",
        normal="Arial",
        bold="Arial-Bold",
        italic="Arial-Italic",
        boldItalic="Arial-BoldItalic",
    )
    pdfmetrics.registerFontFamily(
        "Georgia",
        normal="Georgia",
        bold="Georgia-Bold",
        italic="Georgia-Italic",
        boldItalic="Georgia-Bold",
    )


def iter_blocks(doc: Document):
    for child in doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            yield DocxParagraph(child, doc._body)
        elif child.tag == qn("w:tbl"):
            yield DocxTable(child, doc._body)


def get_hex_color(run, fallback: str) -> str:
    value = run.font.color.rgb
    if value:
        return "#" + str(value)
    return fallback


def paragraph_has_page_break(paragraph: DocxParagraph) -> bool:
    return bool(paragraph._p.xpath('.//w:br[@w:type="page"]'))


def numbering_marker(paragraph: DocxParagraph) -> str | None:
    p_pr = paragraph._p.pPr
    if p_pr is None or p_pr.numPr is None or p_pr.numPr.numId is None:
        return None
    num_id = int(p_pr.numPr.numId.val)
    numbering = paragraph.part.numbering_part.element
    nums = numbering.xpath(f'.//w:num[@w:numId="{num_id}"]')
    if not nums:
        return "-"
    abstract_ref = nums[0].find(qn("w:abstractNumId"))
    if abstract_ref is None:
        return "-"
    abstract_id = abstract_ref.get(qn("w:val"))
    abstracts = numbering.xpath(f'.//w:abstractNum[@w:abstractNumId="{abstract_id}"]')
    if not abstracts:
        return "-"
    fmt_node = abstracts[0].find(".//" + qn("w:numFmt"))
    fmt = fmt_node.get(qn("w:val")) if fmt_node is not None else "bullet"
    if fmt == "bullet":
        return "-"
    LIST_COUNTERS[num_id] = LIST_COUNTERS.get(num_id, 0) + 1
    return f"{LIST_COUNTERS[num_id]}."


def image_flowables(paragraph: DocxParagraph, max_width=6.5 * inch):
    output = []
    for blip in paragraph._p.xpath(".//a:blip"):
        rid = blip.get(qn("r:embed"))
        if not rid or rid not in paragraph.part.related_parts:
            continue
        part = paragraph.part.related_parts[rid]
        ext = Path(part.partname).suffix or ".png"
        target = TMP / f"{rid.replace(':', '_')}{ext}"
        if not target.exists():
            target.write_bytes(part.blob)

        extents = paragraph._p.xpath(".//wp:extent")
        if extents:
            cx = int(extents[0].get("cx"))
            cy = int(extents[0].get("cy"))
            width = cx / 12700
            height = cy / 12700
        else:
            width = max_width
            height = max_width * 0.6
        if width > max_width:
            scale = max_width / width
            width *= scale
            height *= scale
        image = RLImage(str(target), width=width, height=height)
        image.hAlign = "CENTER" if paragraph.alignment == 1 else "LEFT"
        output.append(image)
    return output


def style_for_paragraph(paragraph: DocxParagraph, *, in_table=False) -> ParagraphStyle:
    style_name = paragraph.style.name if paragraph.style else "Normal"
    base_size = 8.5 if in_table else 9.4
    font = "Arial"
    color = SLATE
    leading = base_size * 1.22
    before = 0
    after = 4 if not in_table else 1.5
    keep = False

    if style_name == "Title":
        font, base_size, color, leading, after, keep = "Georgia-Bold", 30, FOREST, 33, 8, True
    elif style_name == "Subtitle":
        font, base_size, color, leading, after = "Helvetica", 10.8, MUTED, 14, 10
    elif style_name == "Heading 1":
        font, base_size, color, leading, after, keep = "Georgia-Bold", 22, FOREST, 25, 7, True
    elif style_name == "Heading 2":
        font, base_size, color, leading, before, after, keep = "Arial-Bold", 12.2, FOREST, 15, 8, 4, True
    elif style_name == "Heading 3":
        font, base_size, color, leading, before, after, keep = "Arial-Bold", 10, SLATE, 12, 5, 3, True
    elif paragraph.text and paragraph.text == paragraph.text.upper() and len(paragraph.text) < 70:
        font, base_size, color, leading, after, keep = "Helvetica-Bold", 7.5, FOREST, 9, 3, True

    if paragraph.runs:
        run = paragraph.runs[0]
        if run.font.size:
            base_size = min(float(run.font.size.pt), 34)
            leading = max(leading, base_size * 1.16)
        color = get_hex_color(run, color)
        if run.bold and font == "Arial":
            font = "Arial-Bold"
        if run.italic:
            font = "Georgia-Italic" if "Georgia" in font else "Arial-Italic"
        name = run.font.name
        if name in {"Fraunces", "Georgia"}:
            font = "Georgia-Bold" if run.bold else ("Georgia-Italic" if run.italic else "Georgia")
        elif name in {"Geist Mono", "Consolas"}:
            font = "Consolas"

    align = TA_LEFT
    if paragraph.alignment == 1:
        align = TA_CENTER
    elif paragraph.alignment == 2:
        align = TA_RIGHT

    pf = paragraph.paragraph_format
    if pf.space_before:
        before = min(float(pf.space_before.pt), 25)
    if pf.space_after:
        after = min(float(pf.space_after.pt), 18)

    return ParagraphStyle(
        name=f"p-{id(paragraph)}",
        fontName=font,
        fontSize=base_size,
        leading=leading,
        textColor=colors.HexColor(color),
        alignment=align,
        spaceBefore=before,
        spaceAfter=after,
        keepWithNext=keep,
        allowWidows=0,
        allowOrphans=0,
    )


def rich_text(paragraph: DocxParagraph, fallback_color: str, default_font: str) -> str:
    fragments = []
    for run in paragraph.runs:
        text = html.escape(run.text).replace("\n", "<br/>")
        if not text:
            continue
        color = get_hex_color(run, fallback_color)
        face = None
        if run.font.name in {"Fraunces", "Georgia"}:
            face = "Georgia"
        elif run.font.name in {"Geist Mono", "Consolas"}:
            face = "Consolas"
        else:
            face = default_font
        attrs = f' color="{color}" face="{face}"'
        size = f' size="{min(float(run.font.size.pt), 34):.1f}"' if run.font.size else ""
        text = f"<font{attrs}{size}>{text}</font>"
        if run.bold:
            text = f"<b>{text}</b>"
        if run.italic:
            text = f"<i>{text}</i>"
        fragments.append(text)
    if fragments:
        return "".join(fragments)
    return html.escape(paragraph.text).replace("\n", "<br/>")


def paragraph_flowables(paragraph: DocxParagraph, *, in_table=False, max_width=6.5 * inch):
    if paragraph_has_page_break(paragraph):
        return [PageBreak()]
    images = image_flowables(paragraph, max_width=max_width)
    text = paragraph.text.strip()
    output = []
    if images:
        output.extend(images)
    if text:
        style = style_for_paragraph(paragraph, in_table=in_table)
        marker = numbering_marker(paragraph)
        if marker:
            style.leftIndent = 17
            style.bulletIndent = 0
            style.bulletFontName = "Arial"
            style.bulletFontSize = style.fontSize
            style.firstLineIndent = 0
            output.append(
                Paragraph(
                    rich_text(paragraph, style.textColor.hexval(), style.fontName),
                    style,
                    bulletText=marker,
                )
            )
        else:
            output.append(
                Paragraph(
                    rich_text(paragraph, style.textColor.hexval(), style.fontName),
                    style,
                )
            )
    elif not images:
        height = 2
        if paragraph.paragraph_format.space_after:
            height = min(float(paragraph.paragraph_format.space_after.pt), 12)
        output.append(Spacer(1, max(height, 1)))
    return output


def cell_background(cell) -> str:
    shd = cell._tc.get_or_add_tcPr().find(qn("w:shd"))
    if shd is None:
        return WHITE
    fill = shd.get(qn("w:fill"))
    if not fill or fill in {"auto", "none"}:
        return WHITE
    return "#" + fill


def table_widths(docx_table: DocxTable):
    grid = docx_table._tbl.tblGrid
    widths = []
    for col in grid.findall(qn("w:gridCol")):
        raw = col.get(qn("w:w"))
        if raw:
            widths.append(int(raw) / 20)
    cols = len(docx_table.columns)
    if len(widths) != cols:
        widths = [6.5 * inch / cols] * cols
    total = sum(widths)
    if total > 6.5 * inch:
        scale = 6.5 * inch / total
        widths = [w * scale for w in widths]
    return widths


def table_flowable(docx_table: DocxTable):
    widths = table_widths(docx_table)
    rows = []
    backgrounds = []
    for r_idx, row in enumerate(docx_table.rows):
        values = []
        for c_idx, cell in enumerate(row.cells):
            max_width = max(widths[c_idx] - 12, 30)
            flows = []
            for paragraph in cell.paragraphs:
                flows.extend(paragraph_flowables(paragraph, in_table=True, max_width=max_width))
            values.append(flows or [Spacer(1, 1)])
            backgrounds.append((r_idx, c_idx, cell_background(cell)))
        rows.append(values)

    table = Table(rows, colWidths=widths, hAlign="LEFT", repeatRows=1, splitByRow=1)
    commands = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor(STONE)),
    ]
    for row, col, fill in backgrounds:
        commands.append(("BACKGROUND", (col, row), (col, row), colors.HexColor(fill)))

    # Tables with white cell separators are visual cards/swatches.
    if any(fill not in {WHITE, "#FFFFFF", "#F4F5F2"} for _, _, fill in backgrounds):
        commands.append(("BOX", (0, 0), (-1, -1), 0.6, colors.white))
        commands.append(("INNERGRID", (0, 0), (-1, -1), 0.6, colors.white))
    table.setStyle(TableStyle(commands))
    return table


def page_furniture(canvas, doc):
    page = canvas.getPageNumber()
    canvas.saveState()
    canvas.setTitle("Manual de marca FundoSmart")
    canvas.setAuthor("FundoSmart")
    canvas.setSubject("Sistema de identidad verbal y visual")
    if page > 1:
        canvas.setStrokeColor(colors.HexColor(STONE))
        canvas.setLineWidth(0.5)
        canvas.line(72, letter[1] - 42, letter[0] - 72, letter[1] - 42)
        canvas.setFont("Helvetica-Bold", 7.2)
        canvas.setFillColor(colors.HexColor(FOREST))
        canvas.drawString(72, letter[1] - 34, "FUNDOSMART")
        canvas.setFont("Helvetica", 7.2)
        canvas.setFillColor(colors.HexColor(MUTED))
        canvas.drawString(132, letter[1] - 34, " /  MANUAL DE MARCA · V1.0")
        canvas.drawRightString(letter[0] - 72, 31, f"JULIO 2026  ·  {page}")
    canvas.restoreState()


def build_furniture_image(path: Path, page_number: int):
    image = PILImage.new("RGBA", (1224, 1584), (255, 255, 255, 0))
    draw = ImageDraw.Draw(image)
    regular = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 14)
    bold = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", 14)
    draw.text((144, 56), "FUNDOSMART", font=bold, fill=FOREST, anchor="la")
    draw.text(
        (268, 56),
        "/  MANUAL DE MARCA · V1.0",
        font=regular,
        fill=MUTED,
        anchor="la",
    )
    draw.line((144, 84, 1080, 84), fill=STONE, width=1)
    draw.text(
        (1080, 1523),
        f"JULIO 2026  ·  {page_number}",
        font=regular,
        fill=MUTED,
        anchor="ra",
    )
    image.save(path)


def image_page_furniture(canvas, doc):
    page_number = canvas.getPageNumber()
    if page_number <= 1:
        return
    furniture_image = TMP / f"manual-furniture-{page_number:02d}.png"
    if not furniture_image.exists():
        build_furniture_image(furniture_image, page_number)
    canvas.saveState()
    canvas.drawImage(
        str(furniture_image),
        0,
        0,
        width=letter[0],
        height=letter[1],
        mask="auto",
    )
    canvas.restoreState()


def build_pdf():
    TMP.mkdir(parents=True, exist_ok=True)
    PDF.parent.mkdir(parents=True, exist_ok=True)
    register_fonts()
    LIST_COUNTERS.clear()
    source = Document(DOCX)
    story = []
    for block in iter_blocks(source):
        if isinstance(block, DocxParagraph):
            story.extend(paragraph_flowables(block))
        else:
            story.append(table_flowable(block))
            story.append(Spacer(1, 5))

    pdf = BaseDocTemplate(
        str(PDF),
        pagesize=letter,
        leftMargin=72,
        rightMargin=72,
        topMargin=52,
        bottomMargin=48,
        title="Manual de marca FundoSmart",
        author="FundoSmart",
        subject="Sistema de identidad verbal y visual",
        creator="FundoSmart",
        pageCompression=1,
    )
    frame = Frame(
        pdf.leftMargin,
        pdf.bottomMargin,
        pdf.width,
        pdf.height,
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
        id="brand-frame",
    )
    pdf.addPageTemplates(
        [
            PageTemplate(
                id="brand",
                frames=[frame],
            )
        ]
    )
    pdf.build(story)
    print(PDF)


if __name__ == "__main__":
    build_pdf()
