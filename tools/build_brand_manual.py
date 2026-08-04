from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import nsdecls, qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
TMP = ROOT / "tmp" / "brand-manual"
OUT_DOCX = ROOT / "docs" / "marca" / "Manual-de-Marca-FundoSmart.docx"

TMP.mkdir(parents=True, exist_ok=True)
OUT_DOCX.parent.mkdir(parents=True, exist_ok=True)


COLORS = {
    "black": "050505",
    "wordmark": "0A0A0A",
    "slate": "151B21",
    "forest": "1F4127",
    "cream": "FAF7EE",
    "clay": "D49656",
    "white": "FFFFFF",
    "mist": "E4EEE6",
    "stone": "DBD7CD",
    "muted": "4D5660",
    "product_forest": "143B2B",
    "product_emerald": "19784B",
    "product_lime": "C8EC74",
    "soft_gray": "F4F5F2",
    "danger": "9B2C2C",
}

FONT_SANS = "Inter"
FONT_DISPLAY = "Fraunces"
FONT_UI = "Geist"
FONT_MONO = "Geist Mono"
FONT_FALLBACK = "Arial"


def rgb(hex_value: str) -> RGBColor:
    value = hex_value.lstrip("#")
    return RGBColor(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def set_run_font(
    run,
    *,
    name: str = FONT_SANS,
    size: float | None = None,
    color: str | None = None,
    bold: bool | None = None,
    italic: bool | None = None,
):
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    for key in ("ascii", "hAnsi", "eastAsia", "cs"):
        rfonts.set(qn(f"w:{key}"), name)
    if size is not None:
        run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = rgb(color)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    return run


def set_cell_shading(cell, fill: str):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)
    shd.set(qn("w:val"), "clear")


def set_cell_margins(cell, top=100, start=140, bottom=100, end=140):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{margin}"))
        if node is None:
            node = OxmlElement(f"w:{margin}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_cell_border(cell, **edges):
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_borders = tc_pr.first_child_found_in("w:tcBorders")
    if tc_borders is None:
        tc_borders = OxmlElement("w:tcBorders")
        tc_pr.append(tc_borders)
    for edge_name, edge_data in edges.items():
        edge = tc_borders.find(qn(f"w:{edge_name}"))
        if edge is None:
            edge = OxmlElement(f"w:{edge_name}")
            tc_borders.append(edge)
        edge.set(qn("w:val"), edge_data.get("val", "single"))
        edge.set(qn("w:sz"), str(edge_data.get("sz", 6)))
        edge.set(qn("w:space"), "0")
        edge.set(qn("w:color"), edge_data.get("color", COLORS["stone"]))


def set_table_geometry(table, widths_dxa: list[int], indent_dxa: int = 120):
    total = sum(widths_dxa)
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    tbl_pr = table._tbl.tblPr

    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(total))
    tbl_w.set(qn("w:type"), "dxa")

    tbl_ind = tbl_pr.find(qn("w:tblInd"))
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn("w:w"), str(indent_dxa))
    tbl_ind.set(qn("w:type"), "dxa")

    layout = tbl_pr.find(qn("w:tblLayout"))
    if layout is None:
        layout = OxmlElement("w:tblLayout")
        tbl_pr.append(layout)
    layout.set(qn("w:type"), "fixed")

    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths_dxa:
        grid_col = OxmlElement("w:gridCol")
        grid_col.set(qn("w:w"), str(width))
        grid.append(grid_col)

    for row in table.rows:
        for idx, cell in enumerate(row.cells):
            width = widths_dxa[min(idx, len(widths_dxa) - 1)]
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.find(qn("w:tcW"))
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.append(tc_w)
            tc_w.set(qn("w:w"), str(width))
            tc_w.set(qn("w:type"), "dxa")
            cell.width = Inches(width / 1440)
            set_cell_margins(cell)


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def add_picture_with_alt(run, image_path: Path, *, width, alt_text: str):
    picture = run.add_picture(str(image_path), width=width)
    doc_pr = picture._inline.docPr
    doc_pr.set("descr", alt_text)
    doc_pr.set("title", alt_text)
    return picture


def add_page_field(paragraph):
    run = paragraph.add_run()
    fld_char1 = OxmlElement("w:fldChar")
    fld_char1.set(qn("w:fldCharType"), "begin")
    instr_text = OxmlElement("w:instrText")
    instr_text.set(qn("xml:space"), "preserve")
    instr_text.text = " PAGE "
    fld_char2 = OxmlElement("w:fldChar")
    fld_char2.set(qn("w:fldCharType"), "end")
    run._r.append(fld_char1)
    run._r.append(instr_text)
    run._r.append(fld_char2)
    set_run_font(run, name=FONT_SANS, size=8.5, color=COLORS["muted"])


def add_paragraph_border(paragraph, color: str, size: int = 8, space: int = 2):
    p_pr = paragraph._p.get_or_add_pPr()
    p_bdr = p_pr.find(qn("w:pBdr"))
    if p_bdr is None:
        p_bdr = OxmlElement("w:pBdr")
        p_pr.append(p_bdr)
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(size))
    bottom.set(qn("w:space"), str(space))
    bottom.set(qn("w:color"), color)
    p_bdr.append(bottom)


def create_numbering(doc: Document, fmt: str, text: str) -> int:
    numbering = doc.part.numbering_part.element
    abstract_ids = [
        int(node.get(qn("w:abstractNumId")))
        for node in numbering.findall(qn("w:abstractNum"))
        if node.get(qn("w:abstractNumId"))
    ]
    num_ids = [
        int(node.get(qn("w:numId")))
        for node in numbering.findall(qn("w:num"))
        if node.get(qn("w:numId"))
    ]
    abstract_id = max(abstract_ids, default=0) + 1
    num_id = max(num_ids, default=0) + 1

    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))
    multi = OxmlElement("w:multiLevelType")
    multi.set(qn("w:val"), "singleLevel")
    abstract.append(multi)
    level = OxmlElement("w:lvl")
    level.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:start")
    start.set(qn("w:val"), "1")
    level.append(start)
    num_fmt = OxmlElement("w:numFmt")
    num_fmt.set(qn("w:val"), fmt)
    level.append(num_fmt)
    lvl_text = OxmlElement("w:lvlText")
    lvl_text.set(qn("w:val"), text)
    level.append(lvl_text)
    lvl_jc = OxmlElement("w:lvlJc")
    lvl_jc.set(qn("w:val"), "left")
    level.append(lvl_jc)
    p_pr = OxmlElement("w:pPr")
    tabs = OxmlElement("w:tabs")
    tab = OxmlElement("w:tab")
    tab.set(qn("w:val"), "num")
    tab.set(qn("w:pos"), "540")
    tabs.append(tab)
    p_pr.append(tabs)
    ind = OxmlElement("w:ind")
    ind.set(qn("w:left"), "540")
    ind.set(qn("w:hanging"), "260")
    p_pr.append(ind)
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:after"), "80")
    spacing.set(qn("w:line"), "280")
    spacing.set(qn("w:lineRule"), "auto")
    p_pr.append(spacing)
    level.append(p_pr)
    abstract.append(level)
    numbering.append(abstract)

    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(num_id))
    abstract_ref = OxmlElement("w:abstractNumId")
    abstract_ref.set(qn("w:val"), str(abstract_id))
    num.append(abstract_ref)
    numbering.append(num)
    return num_id


def add_list_item(doc: Document, text: str, num_id: int, *, bold_prefix: str | None = None):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.line_spacing = 1.16
    p_pr = p._p.get_or_add_pPr()
    num_pr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "0")
    num_id_node = OxmlElement("w:numId")
    num_id_node.set(qn("w:val"), str(num_id))
    num_pr.append(ilvl)
    num_pr.append(num_id_node)
    p_pr.append(num_pr)
    if bold_prefix and text.startswith(bold_prefix):
        prefix = p.add_run(bold_prefix)
        set_run_font(prefix, size=10.5, color=COLORS["slate"], bold=True)
        rest = p.add_run(text[len(bold_prefix) :])
        set_run_font(rest, size=10.5, color=COLORS["slate"])
    else:
        set_run_font(p.add_run(text), size=10.5, color=COLORS["slate"])
    return p


def crop_image(source: Path, destination: Path, ratio: float, *, darken: float = 0.0):
    image = Image.open(source).convert("RGB")
    w, h = image.size
    current = w / h
    if current > ratio:
        new_w = int(h * ratio)
        left = (w - new_w) // 2
        image = image.crop((left, 0, left + new_w, h))
    else:
        new_h = int(w / ratio)
        top = (h - new_h) // 2
        image = image.crop((0, top, w, top + new_h))
    if darken:
        overlay = Image.new("RGB", image.size, "#" + COLORS["slate"])
        image = Image.blend(image, overlay, darken)
    image.resize((1800, int(1800 / ratio)), Image.Resampling.LANCZOS).save(destination, quality=93)


def alpha_colorize(image: Image.Image, color: str) -> Image.Image:
    src = image.convert("RGBA")
    alpha = src.getchannel("A")
    solid = Image.new("RGBA", src.size, "#" + color)
    solid.putalpha(alpha)
    return solid


def draw_spaced_text(draw, xy, text, font, fill, spacing, anchor="ls"):
    x, y = xy
    for char in text:
        draw.text((x, y), char, font=font, fill=fill, anchor=anchor)
        x += draw.textlength(char, font=font) + spacing
    return x


def build_logo_rasters():
    mark = Image.open(PUBLIC / "fundosmart-ultra-min-mark.png").convert("RGBA")
    scale = 2
    canvas_size = (1024 * scale, 276 * scale)
    tile_size = 276 * scale
    mark_scaled = mark.resize((tile_size, tile_size), Image.Resampling.LANCZOS)
    bold = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", 126 * scale)
    regular = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 126 * scale)

    for inverse, name in ((False, "logo-full.png"), (True, "logo-full-inverse.png")):
        canvas = Image.new("RGBA", canvas_size, (255, 255, 255, 0))
        draw = ImageDraw.Draw(canvas)
        draw.rounded_rectangle(
            (0, 0, tile_size - 1, tile_size - 1),
            radius=36 * scale,
            fill="#" + COLORS["black"],
        )
        canvas.alpha_composite(mark_scaled, (0, 0))
        word_color = "#" + (COLORS["white"] if inverse else COLORS["wordmark"])
        x = 324 * scale
        baseline = 181 * scale
        x = draw_spaced_text(draw, (x, baseline), "Fundo", bold, word_color, -5 * scale)
        draw_spaced_text(draw, (x, baseline), "Smart", regular, word_color, -5 * scale)
        canvas.save(TMP / name)

    tile = Image.new("RGBA", (1024, 1024), (255, 255, 255, 0))
    draw = ImageDraw.Draw(tile)
    draw.rounded_rectangle((0, 0, 1023, 1023), radius=132, fill="#" + COLORS["black"])
    tile.alpha_composite(mark.resize((1024, 1024), Image.Resampling.LANCZOS), (0, 0))
    tile.save(TMP / "logo-tile.png")

    black_mark = alpha_colorize(mark, COLORS["black"])
    black_mark.save(TMP / "mark-black.png")
    forest_mark = alpha_colorize(mark, COLORS["forest"])
    forest_mark.save(TMP / "mark-forest.png")

    crop_image(
        PUBLIC / "landing" / "fundosmart-community-hero.webp",
        TMP / "cover-photo.jpg",
        ratio=6.5 / 3.1,
        darken=0.09,
    )
    crop_image(
        PUBLIC / "landing" / "fundosmart-community-hero.webp",
        TMP / "photo-wide.jpg",
        ratio=6.5 / 2.45,
        darken=0.03,
    )


def configure_styles(doc: Document):
    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = FONT_SANS
    normal._element.rPr.rFonts.set(qn("w:ascii"), FONT_SANS)
    normal._element.rPr.rFonts.set(qn("w:hAnsi"), FONT_SANS)
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = rgb(COLORS["slate"])
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.16

    title = styles["Title"]
    title.font.name = FONT_DISPLAY
    title._element.rPr.rFonts.set(qn("w:ascii"), FONT_DISPLAY)
    title._element.rPr.rFonts.set(qn("w:hAnsi"), FONT_DISPLAY)
    title.font.size = Pt(30)
    title.font.color.rgb = rgb(COLORS["forest"])
    title.font.bold = True
    title.paragraph_format.space_after = Pt(8)
    title.paragraph_format.keep_with_next = True

    subtitle = styles["Subtitle"]
    subtitle.font.name = FONT_SANS
    subtitle._element.rPr.rFonts.set(qn("w:ascii"), FONT_SANS)
    subtitle._element.rPr.rFonts.set(qn("w:hAnsi"), FONT_SANS)
    subtitle.font.size = Pt(12)
    subtitle.font.color.rgb = rgb(COLORS["muted"])
    subtitle.paragraph_format.space_after = Pt(14)

    h1 = styles["Heading 1"]
    h1.font.name = FONT_DISPLAY
    h1._element.rPr.rFonts.set(qn("w:ascii"), FONT_DISPLAY)
    h1._element.rPr.rFonts.set(qn("w:hAnsi"), FONT_DISPLAY)
    h1.font.size = Pt(23)
    h1.font.bold = True
    h1.font.color.rgb = rgb(COLORS["forest"])
    h1.paragraph_format.space_before = Pt(0)
    h1.paragraph_format.space_after = Pt(9)
    h1.paragraph_format.keep_with_next = True

    h2 = styles["Heading 2"]
    h2.font.name = FONT_SANS
    h2._element.rPr.rFonts.set(qn("w:ascii"), FONT_SANS)
    h2._element.rPr.rFonts.set(qn("w:hAnsi"), FONT_SANS)
    h2.font.size = Pt(13)
    h2.font.bold = True
    h2.font.color.rgb = rgb(COLORS["forest"])
    h2.paragraph_format.space_before = Pt(11)
    h2.paragraph_format.space_after = Pt(5)
    h2.paragraph_format.keep_with_next = True

    h3 = styles["Heading 3"]
    h3.font.name = FONT_SANS
    h3._element.rPr.rFonts.set(qn("w:ascii"), FONT_SANS)
    h3._element.rPr.rFonts.set(qn("w:hAnsi"), FONT_SANS)
    h3.font.size = Pt(11)
    h3.font.bold = True
    h3.font.color.rgb = rgb(COLORS["slate"])
    h3.paragraph_format.space_before = Pt(8)
    h3.paragraph_format.space_after = Pt(3)
    h3.paragraph_format.keep_with_next = True


def add_kicker(doc: Document, text: str, *, light: bool = False):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.keep_with_next = True
    r = p.add_run(text.upper())
    set_run_font(
        r,
        size=8.5,
        color=COLORS["clay"] if light else COLORS["forest"],
        bold=True,
    )
    r.font.letter_spacing = Pt(1.3)
    return p


def add_page_title(doc: Document, section: str, title: str, lead: str | None = None):
    add_kicker(doc, section)
    doc.add_paragraph(title, style="Heading 1")
    if lead:
        p = doc.add_paragraph(style="Subtitle")
        set_run_font(p.add_run(lead), size=11.8, color=COLORS["muted"])
    divider = doc.add_paragraph()
    divider.paragraph_format.space_after = Pt(12)
    add_paragraph_border(divider, COLORS["clay"], size=16, space=1)


def add_body(doc: Document, text: str, *, bold_start: str | None = None, color: str | None = None):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(7)
    p.paragraph_format.line_spacing = 1.16
    if bold_start and text.startswith(bold_start):
        set_run_font(
            p.add_run(bold_start),
            size=10.5,
            color=color or COLORS["slate"],
            bold=True,
        )
        set_run_font(
            p.add_run(text[len(bold_start) :]),
            size=10.5,
            color=color or COLORS["slate"],
        )
    else:
        set_run_font(p.add_run(text), size=10.5, color=color or COLORS["slate"])
    return p


def add_callout(
    doc: Document,
    label: str,
    text: str,
    *,
    fill: str = "E4EEE6",
    accent: str = "1F4127",
    text_color: str = "151B21",
):
    table = doc.add_table(rows=1, cols=1)
    set_table_geometry(table, [9360])
    cell = table.cell(0, 0)
    set_cell_shading(cell, fill)
    set_cell_border(
        cell,
        top={"color": fill, "sz": 0, "val": "nil"},
        bottom={"color": fill, "sz": 0, "val": "nil"},
        end={"color": fill, "sz": 0, "val": "nil"},
        start={"color": accent, "sz": 22, "val": "single"},
    )
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(2)
    set_run_font(p.add_run(label.upper()), size=8.2, color=accent, bold=True)
    p2 = cell.add_paragraph()
    p2.paragraph_format.space_after = Pt(0)
    p2.paragraph_format.line_spacing = 1.14
    set_run_font(p2.add_run(text), size=10.7, color=text_color)
    doc.add_paragraph().paragraph_format.space_after = Pt(1)
    return table


def add_two_col_cards(doc: Document, cards: list[tuple[str, str]], *, fills=None):
    rows = math.ceil(len(cards) / 2)
    table = doc.add_table(rows=rows, cols=2)
    set_table_geometry(table, [4680, 4680])
    fills = fills or [COLORS["soft_gray"]] * len(cards)
    for index, (title, text) in enumerate(cards):
        cell = table.cell(index // 2, index % 2)
        set_cell_shading(cell, fills[index])
        set_cell_border(
            cell,
            top={"color": COLORS["white"], "sz": 10},
            bottom={"color": COLORS["white"], "sz": 10},
            start={"color": COLORS["white"], "sz": 10},
            end={"color": COLORS["white"], "sz": 10},
        )
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(3)
        set_run_font(p.add_run(title), size=11.2, color=COLORS["forest"], bold=True)
        p2 = cell.add_paragraph()
        p2.paragraph_format.space_after = Pt(0)
        p2.paragraph_format.line_spacing = 1.11
        set_run_font(p2.add_run(text), size=9.5, color=COLORS["slate"])
    return table


def add_matrix(
    doc: Document,
    headers: list[str],
    rows: list[list[str]],
    widths: list[int],
    *,
    header_fill: str = "1F4127",
):
    table = doc.add_table(rows=1, cols=len(headers))
    set_table_geometry(table, widths)
    set_repeat_table_header(table.rows[0])
    for i, header in enumerate(headers):
        cell = table.rows[0].cells[i]
        set_cell_shading(cell, header_fill)
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        set_run_font(p.add_run(header), size=8.8, color=COLORS["cream"], bold=True)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    for row_index, values in enumerate(rows):
        cells = table.add_row().cells
        for i, value in enumerate(values):
            cell = cells[i]
            set_cell_shading(cell, COLORS["white"] if row_index % 2 == 0 else COLORS["soft_gray"])
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.08
            set_run_font(p.add_run(value), size=8.9, color=COLORS["slate"])
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            set_cell_border(
                cell,
                top={"color": COLORS["stone"], "sz": 4},
                bottom={"color": COLORS["stone"], "sz": 4},
                start={"color": COLORS["stone"], "sz": 4},
                end={"color": COLORS["stone"], "sz": 4},
            )
    set_table_geometry(table, widths)
    return table


def add_page_break(doc: Document):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(0)
    p.add_run().add_break(WD_BREAK.PAGE)


def sanitize_hyphens(doc: Document):
    def clean_paragraph(paragraph):
        for run in paragraph.runs:
            if run._r.xpath(".//w:br | .//w:drawing"):
                continue
            run.text = (
                run.text.replace("\u2011", "-")
                .replace("\u2012", "-")
                .replace("\u2013", "-")
                .replace("\u2014", "-")
            )

    for paragraph in doc.paragraphs:
        clean_paragraph(paragraph)
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    clean_paragraph(paragraph)


def build_document():
    build_logo_rasters()
    doc = Document()
    configure_styles(doc)

    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(0.82)
    section.bottom_margin = Inches(0.78)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1)
    section.header_distance = Inches(0.42)
    section.footer_distance = Inches(0.42)
    section.different_first_page_header_footer = True

    # Running furniture
    header = section.header
    hp = header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.LEFT
    hp.paragraph_format.space_after = Pt(0)
    set_run_font(hp.add_run("FUNDOSMART"), size=8.3, color=COLORS["forest"], bold=True)
    set_run_font(
        hp.add_run("   /   MANUAL DE MARCA · V1.0"),
        size=8.3,
        color=COLORS["muted"],
    )
    add_paragraph_border(hp, COLORS["stone"], size=6, space=3)

    footer = section.footer
    fp = footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    fp.paragraph_format.space_after = Pt(0)
    set_run_font(fp.add_run("JULIO 2026   ·   "), size=8.2, color=COLORS["muted"])
    add_page_field(fp)

    bullet_id = create_numbering(doc, "bullet", "•")
    decimal_id = create_numbering(doc, "decimal", "%1.")
    governance_decimal_id = create_numbering(doc, "decimal", "%1.")

    # 1 — Cover
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(20)
    p.paragraph_format.space_after = Pt(30)
    add_picture_with_alt(
        p.add_run(),
        TMP / "logo-full.png",
        width=Inches(3.25),
        alt_text="Logotipo principal de FundoSmart.",
    )

    add_kicker(doc, "Sistema de identidad · Versión 1.0")
    title = doc.add_paragraph()
    title.paragraph_format.space_after = Pt(9)
    r = title.add_run("Manual de marca")
    set_run_font(r, name=FONT_DISPLAY, size=35, color=COLORS["forest"], bold=True)
    sub = doc.add_paragraph()
    sub.paragraph_format.space_after = Pt(20)
    set_run_font(
        sub.add_run("El predio completo,\nen un solo sistema."),
        name=FONT_DISPLAY,
        size=19,
        color=COLORS["slate"],
        italic=True,
    )
    photo = doc.add_paragraph()
    photo.paragraph_format.space_before = Pt(0)
    photo.paragraph_format.space_after = Pt(15)
    add_picture_with_alt(
        photo.add_run(),
        TMP / "cover-photo.jpg",
        width=Inches(6.5),
        alt_text="Vacas pastando en praderas del sur de Chile frente a un volcán.",
    )
    meta = doc.add_paragraph()
    meta.paragraph_format.space_after = Pt(0)
    set_run_font(
        meta.add_run("FundoSmart · Osorno, Chile · Julio 2026"),
        size=9.5,
        color=COLORS["muted"],
        bold=True,
    )
    add_page_break(doc)

    # 2 — Guide
    add_page_title(
        doc,
        "Introducción",
        "Cómo usar este manual",
        "Una guía práctica para que cada expresión de FundoSmart se reconozca, se entienda y conserve su carácter.",
    )
    add_callout(
        doc,
        "Principio rector",
        "La marca debe sentirse tan confiable como un buen registro de campo: clara, útil, próxima y sin adornos que escondan la realidad.",
    )
    doc.add_paragraph("Qué resuelve", style="Heading 2")
    for item in [
        "Alinea decisiones de producto, comunicación, ventas y soporte.",
        "Define usos correctos del nombre, logotipo, color, tipografía, fotografía y voz.",
        "Entrega criterios concretos para crear nuevas piezas sin diluir la identidad.",
    ]:
        add_list_item(doc, item, bullet_id)
    doc.add_paragraph("Control del documento", style="Heading 2")
    add_matrix(
        doc,
        ["Campo", "Definición"],
        [
            ["Versión", "1.0 · sistema inicial de identidad"],
            ["Fecha", "23 de julio de 2026"],
            ["Alcance", "Marca comercial, producto digital y comunicaciones"],
            ["Propietario", "FundoSmart · dirección de marca/producto"],
            ["Revisión", "Cada 12 meses o ante un cambio sustantivo de identidad"],
        ],
        [1900, 7460],
    )
    add_page_break(doc)

    # 3 — Core
    add_page_title(
        doc,
        "Fundamentos",
        "El núcleo de FundoSmart",
        "Una marca de tecnología agropecuaria que ordena el predio sin borrar su historia ni su forma local de trabajar.",
    )
    add_two_col_cards(
        doc,
        [
            ("Propósito", "Dar continuidad y claridad a la gestión del predio, conectando territorio, animales, producción, sanidad y costos."),
            ("Promesa", "Toda la operación relevante, en un sistema común, con datos trazables y decisiones más simples."),
            ("Ambición", "Ser la infraestructura digital de confianza para la lechería y ganadería del Sur de Chile."),
            ("Mantra interno", "Ordenar sin borrar. Conectar sin complicar."),
        ],
        fills=[COLORS["mist"], COLORS["cream"], COLORS["cream"], COLORS["mist"]],
    )
    doc.add_paragraph("Posicionamiento", style="Heading 2")
    add_callout(
        doc,
        "Declaración",
        "Para productores y equipos ganaderos que necesitan una visión completa y confiable de su operación, FundoSmart es el sistema de gestión predial creado desde el Sur de Chile que unifica el trabajo del campo y conserva la trazabilidad de la información.",
        fill=COLORS["forest"],
        accent=COLORS["clay"],
        text_color=COLORS["cream"],
    )
    doc.add_paragraph("La diferencia", style="Heading 2")
    add_body(
        doc,
        "FundoSmart no se presenta como tecnología ajena que viene a “transformar” el campo. Se presenta como una herramienta moderna que entiende la memoria del predio, su vocabulario, sus sistemas anteriores y la necesidad de seguir trabajando mientras se ordena la información.",
    )
    add_page_break(doc)

    # 4 — Audiences
    add_page_title(
        doc,
        "Estrategia",
        "Personas a las que servimos",
        "La marca habla con distintos roles, pero siempre desde el mismo respeto por el oficio y por la evidencia.",
    )
    add_matrix(
        doc,
        ["Audiencia", "Necesidad principal", "Respuesta de marca"],
        [
            ["Propietario/a o administrador/a", "Ver la operación completa, controlar riesgos y decidir.", "Síntesis y visión económica con trazabilidad."],
            ["Encargado/a de campo", "Registrar rápido y evitar trabajo duplicado.", "Lenguaje directo y flujos simples."],
            ["Veterinario/a o asesor/a", "Acceder a datos consistentes y a su origen.", "Precisión, contexto y evidencia auditable."],
            ["Equipo administrativo", "Conciliar archivos, costos y producción.", "Orden, exportabilidad y reglas claras."],
            ["Nueva generación del predio", "Modernizar sin perder conocimiento acumulado.", "Continuidad, interoperabilidad y futuro posible."],
        ],
        [2100, 3380, 3880],
    )
    doc.add_paragraph("Contexto territorial", style="Heading 2")
    add_callout(
        doc,
        "Origen",
        "FundoSmart nace en Osorno y habla desde el Sur de Chile. Ese origen aporta criterio y cercanía; nunca folclor ni exclusión.",
        fill=COLORS["cream"],
        accent=COLORS["clay"],
    )
    doc.add_paragraph("Prioridad de comunicación", style="Heading 2")
    for item in [
        "Explicar el beneficio operativo.",
        "Demostrar cómo funciona y de dónde vienen los datos.",
        "Respaldar con capacidades, seguridad e interoperabilidad.",
    ]:
        add_list_item(doc, item, decimal_id)
    add_page_break(doc)

    # 5 — Personality
    add_page_title(
        doc,
        "Personalidad",
        "Cómo debe sentirse la marca",
        "FundoSmart combina oficio de campo y disciplina de software. La personalidad vive en esa tensión.",
    )
    add_matrix(
        doc,
        ["Rasgo", "Se expresa como", "Nunca como"],
        [
            ["Clara", "Explica una idea a la vez, con verbos concretos.", "Simplista, infantil o condescendiente."],
            ["Confiable", "Muestra origen, límites y consecuencias.", "Infalible, grandilocuente o evasiva."],
            ["Cercana", "Usa vocabulario reconocible del predio.", "Folclórica, caricaturesca o excesivamente informal."],
            ["Competente", "Resuelve problemas complejos con calma.", "Fría, burocrática o llena de tecnicismos."],
            ["Honesta", "Declara qué está disponible y qué sigue en desarrollo.", "Promocional a cualquier costo."],
            ["Local", "Comprende el Sur como realidad productiva.", "Provinciana, excluyente o nostálgica."],
        ],
        [1500, 3930, 3930],
    )
    doc.add_paragraph("Escala de carácter", style="Heading 2")
    add_two_col_cards(
        doc,
        [
            ("Más sobria que llamativa", "La utilidad y el contraste conducen el diseño."),
            ("Más humana que corporativa", "Se reconoce a las personas detrás del dato."),
            ("Más precisa que ingeniosa", "La frase memorable nunca sacrifica exactitud."),
            ("Más contemporánea que futurista", "Tecnología actual, sin estética de ciencia ficción."),
        ],
        fills=[COLORS["soft_gray"], COLORS["mist"], COLORS["mist"], COLORS["soft_gray"]],
    )
    add_page_break(doc)

    # 6 — Naming and messaging
    add_page_title(
        doc,
        "Identidad verbal",
        "Nombre, lema y arquitectura de mensajes",
        "El nombre une territorio y capacidad digital. Su escritura consistente es parte de la identidad.",
    )
    add_callout(
        doc,
        "Nombre comercial",
        "FundoSmart — una sola palabra, con F y S mayúsculas. No usar Fundo Smart, Fundosmart, FUNDO SMART ni abreviaturas públicas.",
    )
    doc.add_paragraph("Lema principal", style="Heading 2")
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(10)
    set_run_font(
        p.add_run("“El predio completo,\nen un solo sistema.”"),
        name=FONT_DISPLAY,
        size=22,
        color=COLORS["forest"],
        italic=True,
    )
    add_matrix(
        doc,
        ["Nivel", "Mensaje recomendado", "Uso"],
        [
            ["Idea central", "El predio completo, en un solo sistema.", "Portadas, campañas, presentaciones y hero principal."],
            ["Propuesta", "Territorio, animales, leche, sanidad y costos unificados.", "Descripción corta del producto."],
            ["Prueba", "Con tu historia migrada de forma auditable.", "Migración, ventas y demostraciones."],
            ["Origen", "Hecho en el Sur de Chile.", "Firma secundaria y piezas territoriales."],
        ],
        [1500, 4600, 3260],
    )
    note = doc.add_paragraph()
    note.paragraph_format.space_before = Pt(7)
    set_run_font(
        note.add_run("Nota legal: "),
        size=9,
        color=COLORS["muted"],
        bold=True,
    )
    set_run_font(
        note.add_run("usar una razón social solo cuando esté formalmente vigente y validada para el contexto."),
        size=9,
        color=COLORS["muted"],
    )
    add_page_break(doc)

    # 7 — Voice
    add_page_title(
        doc,
        "Identidad verbal",
        "La voz de FundoSmart",
        "Una sola voz con distintos registros: conversación, producto, soporte y comunicación institucional.",
    )
    add_two_col_cards(
        doc,
        [
            ("Habla desde el trabajo real", "Parte por la tarea o decisión que la persona necesita resolver."),
            ("Explica sin presumir", "Traduce la complejidad; deja el detalle cuando aporta."),
            ("Nombra límites", "Distingue lo disponible, experimental y pendiente."),
            ("Cuida el tiempo", "Usa títulos accionables y llamados inequívocos."),
        ],
        fills=[COLORS["mist"], COLORS["soft_gray"], COLORS["soft_gray"], COLORS["mist"]],
    )
    doc.add_paragraph("Registros", style="Heading 2")
    add_matrix(
        doc,
        ["Contexto", "Tono", "Ejemplo"],
        [
            ["Producto", "Directo y orientado a la acción.", "Guarda los cambios para actualizar el potrero."],
            ["Soporte", "Calmo, responsable y resolutivo.", "No se perdió información. Reintentemos la sincronización."],
            ["Ventas", "Concreto y demostrable.", "Reúne el mapa, los animales y la producción en una misma operación."],
            ["Institucional", "Sobrio, local y de largo plazo.", "Software de gestión ganadera construido desde Osorno."],
        ],
        [1700, 2850, 4810],
    )
    doc.add_paragraph("Convenciones", style="Heading 2")
    for item in [
        "Usar español de Chile claro, tratar de “tú” con respeto y elegir “predio” o “fundo” según el contexto.",
        "Escribir números, unidades y fechas sin ambigüedad: 27,6 ha · 23 jul 2026.",
    ]:
        add_list_item(doc, item, bullet_id)
    add_page_break(doc)

    # 8 — Copy examples
    add_page_title(
        doc,
        "Identidad verbal",
        "Escribir como FundoSmart",
        "Las mejores frases reducen incertidumbre: dicen qué ocurrió, qué sigue y qué control conserva la persona.",
    )
    add_matrix(
        doc,
        ["Evitar", "Preferir", "Por qué"],
        [
            ["Revolucionamos la industria con tecnología de punta.", "Ordena el predio en un sistema común y trazable.", "Cambia grandilocuencia por beneficio verificable."],
            ["Error inesperado.", "No pudimos guardar el cambio. Tus datos anteriores siguen intactos.", "Explica estado y reduce ansiedad."],
            ["Importación exitosa.", "Importamos 118 animales; 4 necesitan revisión.", "Aporta magnitud y siguiente acción."],
            ["Nuestra IA optimiza todo.", "FundoSmart detecta inconsistencias y te pide confirmar antes de aplicar cambios.", "Evita promesas vagas y mantiene control humano."],
            ["Digitaliza tu campo.", "Conecta potreros, animales, leche, sanidad y costos.", "Nombra el trabajo concreto."],
        ],
        [2800, 3860, 2700],
    )
    doc.add_paragraph("Llamados a la acción", style="Heading 2")
    add_two_col_cards(
        doc,
        [
            ("Acciones primarias", "Probar demo · Ingresar a mi cuenta · Guardar cambios · Revisar inconsistencias"),
            ("Acciones secundarias", "Ver origen · Descargar respaldo · Volver al mapa · Conocer el proceso"),
        ],
        fills=[COLORS["mist"], COLORS["cream"]],
    )
    add_callout(
        doc,
        "Regla de microcopy",
        "Un botón inicia una acción; su etiqueta debe usar un verbo. Un estado describe lo ocurrido; no debe parecer una instrucción.",
        fill=COLORS["soft_gray"],
        accent=COLORS["clay"],
    )
    add_page_break(doc)

    # 9 — Logo overview
    add_page_title(
        doc,
        "Identidad visual",
        "El sistema de logotipo",
        "La identidad combina una marca bovina de trazo geométrico, un contenedor negro y un nombre de alta legibilidad.",
    )
    logo_p = doc.add_paragraph()
    logo_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    logo_p.paragraph_format.space_before = Pt(8)
    logo_p.paragraph_format.space_after = Pt(18)
    add_picture_with_alt(
        logo_p.add_run(),
        TMP / "logo-full.png",
        width=Inches(4.9),
        alt_text="Logotipo principal de FundoSmart.",
    )
    add_two_col_cards(
        doc,
        [
            ("Símbolo", "Rostro bovino, escudo y estructura de cercos en una sola figura. Representa ganado, territorio y resguardo."),
            ("Contenedor", "Cuadrado negro de esquinas redondeadas. Asegura contraste, reconocimiento y consistencia digital."),
            ("Nombre", "Fundo en peso fuerte; Smart en peso regular. Equilibra oficio y tecnología."),
            ("Carácter", "Geométrico, directo y contemporáneo; nunca ornamental ni rústico por cliché."),
        ],
        fills=[COLORS["soft_gray"], COLORS["mist"], COLORS["mist"], COLORS["soft_gray"]],
    )
    add_callout(
        doc,
        "Activo maestro",
        "Usar siempre los archivos oficiales. El nombre del logotipo no se recompone con tipografía ni se redibuja el símbolo.",
        fill=COLORS["cream"],
        accent=COLORS["clay"],
    )
    add_page_break(doc)

    # 10 — Logo versions
    add_page_title(
        doc,
        "Identidad visual",
        "Versiones y jerarquía de uso",
        "Elegir la versión por espacio y contraste, no por preferencia estética.",
    )
    table = doc.add_table(rows=2, cols=2)
    set_table_geometry(table, [4680, 4680])
    specs = [
        (0, 0, COLORS["white"], "Horizontal principal", TMP / "logo-full.png", 2.55, "Uso predeterminado sobre fondos claros."),
        (0, 1, COLORS["slate"], "Horizontal inverso", TMP / "logo-full-inverse.png", 2.55, "Para fondos oscuros o fotografía controlada."),
        (1, 0, COLORS["cream"], "Marca en contenedor", TMP / "logo-tile.png", 1.12, "App, avatar, favicon y espacios compactos."),
        (1, 1, COLORS["mist"], "Símbolo monocromo", TMP / "mark-forest.png", 1.12, "Solo cuando el contenedor o la técnica de impresión lo exijan."),
    ]
    for row, col, fill, title_text, image_path, width, note_text in specs:
        cell = table.cell(row, col)
        set_cell_shading(cell, fill)
        set_cell_border(
            cell,
            top={"color": COLORS["white"], "sz": 10},
            bottom={"color": COLORS["white"], "sz": 10},
            start={"color": COLORS["white"], "sz": 10},
            end={"color": COLORS["white"], "sz": 10},
        )
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(7)
        add_picture_with_alt(
            p.add_run(),
            image_path,
            width=Inches(width),
            alt_text=f"{title_text} de FundoSmart.",
        )
        p2 = cell.add_paragraph()
        p2.paragraph_format.space_after = Pt(2)
        set_run_font(
            p2.add_run(title_text),
            size=10.4,
            color=COLORS["cream"] if fill == COLORS["slate"] else COLORS["forest"],
            bold=True,
        )
        p3 = cell.add_paragraph()
        p3.paragraph_format.space_after = Pt(0)
        set_run_font(
            p3.add_run(note_text),
            size=8.6,
            color=COLORS["cream"] if fill == COLORS["slate"] else COLORS["muted"],
        )
    add_callout(
        doc,
        "Orden de preferencia",
        "1. Horizontal principal · 2. Horizontal inverso · 3. Marca en contenedor · 4. Símbolo monocromo.",
        fill=COLORS["soft_gray"],
        accent=COLORS["forest"],
    )
    add_page_break(doc)

    # 11 — Clear space
    add_page_title(
        doc,
        "Identidad visual",
        "Área de protección y tamaños mínimos",
        "El logotipo necesita aire para conservar jerarquía y legibilidad en cualquier soporte.",
    )
    add_callout(
        doc,
        "Unidad X",
        "X equivale a un cuarto del lado del contenedor negro. Mantener al menos 1X libre alrededor de toda versión.",
    )
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(14)
    add_picture_with_alt(
        p.add_run(),
        TMP / "logo-full.png",
        width=Inches(4.65),
        alt_text="Logotipo principal de FundoSmart usado para medir el área de protección.",
    )
    add_matrix(
        doc,
        ["Activo", "Pantalla", "Impresión", "Condición"],
        [
            ["Logotipo horizontal", "160 px de ancho", "32 mm de ancho", "Nombre completamente legible."],
            ["Marca en contenedor", "32 px", "10 mm", "Preferir 48 px para interfaces táctiles."],
            ["Símbolo monocromo", "24 px", "8 mm", "Solo en alto contraste."],
            ["Favicon", "16 px", "No aplica", "Usar el archivo optimizado, no reducir el logo horizontal."],
        ],
        [2200, 1750, 1750, 3660],
    )
    doc.add_paragraph("Fondos", style="Heading 2")
    for item in [
        "Sobre claro: logotipo principal.",
        "Sobre oscuro: versión inversa.",
        "Sobre fotografía: ubicar en una zona calma y verificar contraste real.",
        "Si el fondo compite, usar la marca con su contenedor negro.",
    ]:
        add_list_item(doc, item, bullet_id)
    add_page_break(doc)

    # 12 — Misuse
    add_page_title(
        doc,
        "Identidad visual",
        "Usos incorrectos",
        "La consistencia se protege evitando intervenciones aparentemente pequeñas que cambian el carácter del sistema.",
    )
    add_matrix(
        doc,
        ["No hacer", "Motivo"],
        [
            ["Cambiar la relación entre símbolo y nombre o reconstruir el logotipo.", "Rompe el lockup maestro y sus proporciones."],
            ["Aplicar verde, degradados, sombras o texturas al contenedor.", "El contenedor negro es una constante de identidad."],
            ["Estirar, comprimir, rotar o inclinar.", "Deforma la geometría del símbolo."],
            ["Usar el símbolo blanco sin contraste suficiente.", "Pierde contorno y detalle interno."],
            ["Añadir otra forma, borde o elementos dentro del área de protección.", "Crea ruido y reduce jerarquía y legibilidad."],
            ["Usar versiones antiguas o archivos tomados de capturas.", "Introduce inconsistencias y pérdida de calidad."],
        ],
        [4000, 5360],
        header_fill=COLORS["danger"],
    )
    add_callout(
        doc,
        "Prueba rápida",
        "Si una modificación parece necesaria para que el logo “combine” con una pieza, primero ajustar la pieza. El activo maestro no se adapta.",
        fill=COLORS["cream"],
        accent=COLORS["clay"],
    )
    add_page_break(doc)

    # 13 — Core color
    add_page_title(
        doc,
        "Color",
        "Paleta principal",
        "Una paleta inspirada en bosque húmedo, tierra, crema y piedra volcánica. El contraste sostiene la identidad.",
    )
    swatches = [
        ("Bosque", COLORS["forest"], "Primario"),
        ("Crema", COLORS["cream"], "Fondo"),
        ("Pizarra volcánica", COLORS["slate"], "Texto / fondo"),
        ("Arcilla", COLORS["clay"], "Acento"),
        ("Negro marca", COLORS["black"], "Contenedor del logo"),
        ("Blanco", COLORS["white"], "Superficie"),
    ]
    table = doc.add_table(rows=2, cols=3)
    set_table_geometry(table, [3120, 3120, 3120])
    for idx, (name, hex_value, role) in enumerate(swatches):
        cell = table.cell(idx // 3, idx % 3)
        set_cell_shading(cell, hex_value)
        dark_text = hex_value in {COLORS["cream"], COLORS["white"], COLORS["clay"]}
        tc = COLORS["slate"] if dark_text else COLORS["cream"]
        p = cell.paragraphs[0]
        p.paragraph_format.space_before = Pt(25)
        p.paragraph_format.space_after = Pt(2)
        set_run_font(p.add_run(name), size=11, color=tc, bold=True)
        p2 = cell.add_paragraph()
        p2.paragraph_format.space_after = Pt(2)
        set_run_font(p2.add_run("#" + hex_value), size=9, color=tc)
        p3 = cell.add_paragraph()
        p3.paragraph_format.space_after = Pt(20)
        set_run_font(p3.add_run(role), size=8.5, color=tc)
        set_cell_border(
            cell,
            top={"color": COLORS["white"], "sz": 12},
            bottom={"color": COLORS["white"], "sz": 12},
            start={"color": COLORS["white"], "sz": 12},
            end={"color": COLORS["white"], "sz": 12},
        )
    doc.add_paragraph("Proporción orientativa", style="Heading 2")
    add_matrix(
        doc,
        ["Color", "Uso aproximado", "Función"],
        [
            ["Crema / blanco", "55–70 %", "Respiración y superficies."],
            ["Bosque / pizarra", "20–35 %", "Jerarquía, fondos y texto."],
            ["Arcilla", "5–10 %", "Énfasis y orientación."],
        ],
        [2500, 2400, 4460],
    )
    add_callout(
        doc,
        "Regla",
        "Arcilla es un acento, no un fondo dominante. El negro del contenedor pertenece al logotipo y no reemplaza automáticamente a pizarra.",
        fill=COLORS["soft_gray"],
        accent=COLORS["clay"],
    )
    add_page_break(doc)

    # 14 — Support and product colors
    add_page_title(
        doc,
        "Color",
        "Paleta de apoyo y producto",
        "La comunicación de marca y la interfaz comparten familia, pero cumplen trabajos distintos.",
    )
    add_matrix(
        doc,
        ["Token", "HEX", "Uso"],
        [
            ["Verde niebla", "#E4EEE6", "Fondos suaves, estados positivos y agrupación."],
            ["Piedra", "#DBD7CD", "Bordes, divisores y estructura."],
            ["Gris texto", "#4D5660", "Texto secundario sobre fondos claros."],
            ["Bosque producto", "#143B2B", "Tema de aplicación y superficies de alta jerarquía."],
            ["Esmeralda producto", "#19784B", "Foco, enlaces y acciones funcionales."],
            ["Lima producto", "#C8EC74", "Indicadores especiales; uso escaso y controlado."],
        ],
        [2600, 1800, 4960],
    )
    doc.add_paragraph("Separación de roles", style="Heading 2")
    add_two_col_cards(
        doc,
        [
            ("Marca / comunicación", "Bosque, crema, pizarra y arcilla construyen reconocimiento emocional y editorial."),
            ("Producto / interfaz", "Los tokens funcionales priorizan estados, densidad, foco, accesibilidad y consistencia operativa."),
        ],
        fills=[COLORS["cream"], COLORS["mist"]],
    )
    add_callout(
        doc,
        "No mezclar sin criterio",
        "Una campaña no debe parecer una pantalla de administración; una pantalla de trabajo no debe sacrificar claridad para parecer editorial.",
        fill=COLORS["forest"],
        accent=COLORS["clay"],
        text_color=COLORS["cream"],
    )
    add_page_break(doc)

    # 15 — Accessibility
    add_page_title(
        doc,
        "Color",
        "Contraste y combinaciones",
        "Las combinaciones aprobadas protegen legibilidad y reconocimiento en piezas digitales e impresas.",
    )
    add_matrix(
        doc,
        ["Texto", "Fondo", "Contraste", "Uso"],
        [
            ["Pizarra #151B21", "Crema #FAF7EE", "16,19:1", "Texto y títulos. Aprobado AA/AAA."],
            ["Bosque #1F4127", "Crema #FAF7EE", "10,63:1", "Títulos, botones contorno y énfasis. Aprobado AA/AAA."],
            ["Arcilla #D49656", "Pizarra #151B21", "6,85:1", "Acentos con texto. Aprobado AA/AAA."],
            ["Blanco #FFFFFF", "Bosque #1F4127", "11,39:1", "Botones y fondos oscuros. Aprobado AA/AAA."],
            ["Gris #4D5660", "Crema #FAF7EE", "6,96:1", "Texto secundario. Aprobado AA/AAA."],
            ["Blanco #FFFFFF", "Arcilla #D49656", "2,53:1", "No usar como texto normal."],
        ],
        [2260, 2260, 1600, 3240],
    )
    doc.add_paragraph("Reglas operativas", style="Heading 2")
    for item in [
        "Texto normal: mínimo 4,5:1. Texto grande: mínimo 3:1.",
        "Iconos funcionales y contornos: mínimo 3:1 respecto del fondo.",
        "La arcilla funciona mejor como acento sobre pizarra o con texto pizarra encima.",
        "Acompañar el color con texto, icono o patrón; separar estados críticos de acentos de marca.",
        "Validar la fotografía y las transparencias en el contexto final; el color nominal no garantiza contraste.",
    ]:
        add_list_item(doc, item, bullet_id)
    add_callout(
        doc,
        "Accesibilidad",
        "AA es el piso, no la meta. Cuando una combinación permite AAA sin perder jerarquía, se prefiere AAA.",
        fill=COLORS["mist"],
        accent=COLORS["forest"],
    )
    add_page_break(doc)

    # 16 — Typography
    add_page_title(
        doc,
        "Tipografía",
        "Una voz editorial y una voz operativa",
        "La tipografía diferencia relato, navegación y dato sin fragmentar la identidad.",
    )
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    set_run_font(p.add_run("Fraunces"), name=FONT_DISPLAY, size=27, color=COLORS["forest"], bold=True)
    p2 = doc.add_paragraph()
    p2.paragraph_format.space_after = Pt(12)
    set_run_font(
        p2.add_run("Títulos con oficio, calidez y una mirada editorial."),
        name=FONT_DISPLAY,
        size=16,
        color=COLORS["slate"],
        italic=True,
    )
    p3 = doc.add_paragraph()
    p3.paragraph_format.space_after = Pt(4)
    set_run_font(p3.add_run("Inter"), name=FONT_SANS, size=24, color=COLORS["forest"], bold=True)
    p4 = doc.add_paragraph()
    p4.paragraph_format.space_after = Pt(12)
    set_run_font(
        p4.add_run("Texto claro para explicar el producto, guiar acciones y sostener lectura prolongada."),
        name=FONT_SANS,
        size=12,
        color=COLORS["slate"],
    )
    add_matrix(
        doc,
        ["Familia", "Rol", "Pesos recomendados", "Alternativa Office"],
        [
            ["Fraunces", "Display editorial: H1, citas y mensajes de campaña.", "Semibold 600 · Semibold Italic 600", "Georgia"],
            ["Inter", "Comunicación: cuerpo, navegación y llamados.", "Regular 400 · Medium 500 · Semibold 600 · Bold 700", "Arial"],
            ["Geist", "Interfaz de producto y alta densidad.", "Regular 400 · Medium 500 · Semibold 600", "Arial"],
            ["Geist Mono", "IDs, códigos, valores técnicos y trazabilidad.", "Regular 400 · Medium 500", "Consolas"],
        ],
        [1700, 3200, 2640, 1820],
    )
    add_callout(
        doc,
        "Logotipo",
        "La tipografía del wordmark no se replica con estas familias. El logotipo es un activo gráfico cerrado.",
        fill=COLORS["cream"],
        accent=COLORS["clay"],
    )
    add_page_break(doc)

    # 17 — Type hierarchy
    add_page_title(
        doc,
        "Tipografía",
        "Jerarquía y composición",
        "La escala favorece lectura tranquila, bloques cortos y una relación clara entre relato y acción.",
    )
    add_matrix(
        doc,
        ["Rol", "Pantalla orientativa", "Peso", "Interlineado", "Uso"],
        [
            ["Display XL", "56–72 px", "Fraunces 600", "0,95–1,05", "Hero y campañas."],
            ["H1", "40–52 px", "Fraunces 600", "1,00–1,10", "Título de página."],
            ["H2", "28–36 px", "Fraunces 600", "1,10–1,20", "Secciones editoriales."],
            ["H3", "18–22 px", "Inter 600", "1,20–1,30", "Bloques y tarjetas."],
            ["Cuerpo L", "18 px", "Inter 400", "1,50–1,65", "Introducciones."],
            ["Cuerpo", "16 px", "Inter 400", "1,45–1,60", "Lectura principal."],
            ["Etiqueta", "12–14 px", "Inter 600", "1,20–1,35", "Metadatos y controles."],
        ],
        [1550, 1900, 1900, 1600, 2410],
    )
    doc.add_paragraph("Composición", style="Heading 2")
    for item in [
        "Alinear a la izquierda por defecto; centrar solo mensajes breves o portadas.",
        "Evitar columnas de texto superiores a 75 caracteres.",
        "Usar mayúsculas solo en etiquetas cortas, con tracking amplio.",
        "No justificar texto digital ni comprimir interlineado para ganar espacio.",
        "Limitar Fraunces a títulos, citas y frases de marca; no usarla en formularios o tablas densas.",
    ]:
        add_list_item(doc, item, bullet_id)
    add_callout(
        doc,
        "Ritmo",
        "Más aire entre ideas que entre líneas. La jerarquía debe poder leerse antes que el detalle.",
        fill=COLORS["soft_gray"],
        accent=COLORS["forest"],
    )
    add_page_break(doc)

    # 18 — Photography
    add_page_title(
        doc,
        "Dirección de arte",
        "Fotografía del predio real",
        "Las imágenes muestran oficio, escala y territorio con luz natural y una mirada documental.",
    )
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(12)
    add_picture_with_alt(
        p.add_run(),
        TMP / "photo-wide.jpg",
        width=Inches(6.5),
        alt_text="Vacas pastando en praderas húmedas con un volcán al fondo.",
    )
    add_two_col_cards(
        doc,
        [
            ("Buscar", "Personas trabajando · animales en contexto · praderas húmedas · clima real · herramientas · mapas y registros · amplitud territorial."),
            ("Evitar", "Stock genérico · poses publicitarias · saturación excesiva · drones sin propósito · tecnología flotante · animales aislados sobre fondos perfectos."),
        ],
        fills=[COLORS["mist"], COLORS["cream"]],
    )
    doc.add_paragraph("Tratamiento", style="Heading 2")
    for item in [
        "Color natural, contraste moderado y verdes contenidos.",
        "Composición con espacio negativo para texto, sin tapar el trabajo principal.",
        "Superposiciones pizarra o bosque entre 45 % y 85 % cuando el texto lo requiera.",
        "La arcilla puede señalar, nunca teñir toda la fotografía.",
        "Incluir ubicación y autor cuando corresponda; obtener permisos de uso.",
    ]:
        add_list_item(doc, item, bullet_id)
    add_page_break(doc)

    # 19 — Graphic system
    add_page_title(
        doc,
        "Dirección de arte",
        "Lenguaje gráfico, iconos y datos",
        "El sistema visual traduce territorio y operación mediante estructura, no mediante decoración rural.",
    )
    add_two_col_cards(
        doc,
        [
            ("Geometría", "Cuadrículas, líneas de límite, nodos y recorridos inspirados en mapas y cercos."),
            ("Contenedores", "Esquinas suaves y superficies claras; bordes finos antes que sombras pesadas."),
            ("Iconografía", "Trazos simples de 1,5–2 px, extremos redondeados y metáforas funcionales reconocibles."),
            ("Datos", "Tablas y gráficos sobrios, unidades visibles, origen identificable y color semántico consistente."),
        ],
        fills=[COLORS["mist"], COLORS["soft_gray"], COLORS["soft_gray"], COLORS["mist"]],
    )
    doc.add_paragraph("Principios de visualización", style="Heading 2")
    add_matrix(
        doc,
        ["Principio", "Aplicación"],
        [
            ["Contexto antes que impacto", "Mostrar periodo, unidad, población y fuente."],
            ["Comparar con honestidad", "Usar escalas coherentes; evitar ejes truncados sin aviso."],
            ["Una señal por color", "No reutilizar el mismo color para significados distintos."],
            ["Acción visible", "Destacar el dato que requiere decidir, no todos los datos."],
            ["Trazabilidad", "Permitir llegar desde el resumen hasta el registro de origen."],
        ],
        [2800, 6560],
    )
    add_callout(
        doc,
        "Evitar clichés",
        "No usar texturas de madera, tipografías western, siluetas de tractor ni hojas genéricas para “hacerlo agro”. El contexto real ya entrega identidad.",
        fill=COLORS["cream"],
        accent=COLORS["clay"],
    )
    add_page_break(doc)

    # 20 — Applications
    add_page_title(
        doc,
        "Aplicaciones",
        "Ecosistema digital y piezas clave",
        "Cada formato conserva el mismo orden: marca reconocible, beneficio claro, evidencia y siguiente acción.",
    )
    add_matrix(
        doc,
        ["Pieza", "Elementos obligatorios", "Criterio"],
        [
            ["Sitio / landing", "Logotipo horizontal, idea central, demostración y CTA.", "Equilibrar relato territorial con capacidades reales."],
            ["Producto", "Marca compacta, navegación, estados y soporte contextual.", "Priorizar operación y accesibilidad."],
            ["Redes sociales", "Marca en contenedor, titular breve y fotografía propia.", "Una sola idea por pieza; subtítulos en video."],
            ["Presentaciones", "Portada editorial, estructura simple y fuentes de datos.", "No convertir cada diapositiva en un afiche."],
            ["Documentos", "Logotipo, título, versión, fecha y responsable.", "Trazabilidad documental antes que decoración."],
            ["Correo", "Nombre claro del remitente y firma sobria.", "Evitar banners pesados y claims no demostrables."],
        ],
        [1800, 3800, 3760],
    )
    doc.add_paragraph("Vista social", style="Heading 2")
    add_two_col_cards(
        doc,
        [
            ("Titular", "FundoSmart — El predio completo, en un solo sistema"),
            ("Descripción", "Territorio, animales, leche, sanidad y costos en un solo sistema, con migración auditable."),
            ("Formato", "Relación 1,91:1 · alto contraste · zona segura central."),
            ("Control", "Revisar lectura a tamaño móvil y mantener el activo social público."),
        ],
        fills=[COLORS["mist"], COLORS["cream"], COLORS["cream"], COLORS["mist"]],
    )
    add_callout(
        doc,
        "Firma geográfica",
        "“Hecho en el Sur de Chile” es una firma secundaria. No debe competir con el beneficio principal ni aparecer como sello folclórico.",
        fill=COLORS["soft_gray"],
        accent=COLORS["forest"],
    )
    add_page_break(doc)

    # 21 — Governance
    add_page_title(
        doc,
        "Gobernanza",
        "Cómo mantener la marca",
        "La consistencia depende de decisiones repetibles, activos maestros y una revisión proporcional al riesgo.",
    )
    doc.add_paragraph("Flujo de aprobación", style="Heading 2")
    for item in [
        "Definir audiencia, objetivo y soporte.",
        "Elegir mensaje, versión de logotipo y jerarquía tipográfica.",
        "Aplicar paleta, fotografía y componentes aprobados.",
        "Revisar contenido, contraste, ortografía, permisos y datos.",
        "Guardar fuente editable, exportar y registrar versión final.",
    ]:
        add_list_item(doc, item, governance_decimal_id)
    doc.add_paragraph("Lista de control antes de publicar", style="Heading 2")
    checklist = [
        ["Nombre", "FundoSmart está escrito correctamente."],
        ["Mensaje", "El beneficio principal se entiende sin contexto adicional."],
        ["Evidencia", "Las afirmaciones se pueden demostrar y están actualizadas."],
        ["Logotipo", "Archivo maestro, contraste, área y tamaño correctos."],
        ["Accesibilidad", "Contraste, texto alternativo, lectura móvil y subtítulos."],
        ["Datos", "Unidades, fechas, fuentes y alcance están visibles."],
        ["Legal", "Permisos, privacidad y razón social validados cuando aplican."],
        ["Archivo", "Fuente editable y exportación final tienen nombre y versión."],
    ]
    add_matrix(doc, ["Control", "Criterio"], checklist, [2100, 7260])
    add_callout(
        doc,
        "Excepción",
        "Si una pieza necesita salir de estas reglas, documentar el motivo, el alcance y quién lo aprobó. Una excepción no crea automáticamente una nueva norma.",
        fill=COLORS["cream"],
        accent=COLORS["clay"],
    )
    add_page_break(doc)

    # 22 — Assets
    add_page_title(
        doc,
        "Recursos",
        "Activos maestros y cierre",
        "Usar los archivos desde el repositorio vigente y evitar copias locales sin control de versión.",
    )
    add_matrix(
        doc,
        ["Activo", "Archivo maestro", "Uso"],
        [
            ["Logotipo principal", "fundosmart-ultra-min-logo.svg", "Fondos claros."],
            ["Logotipo inverso", "fundosmart-ultra-min-logo-inverse.svg", "Fondos oscuros."],
            ["Símbolo", "fundosmart-ultra-min-mark.svg / .png", "Aplicaciones monocromas y composición."],
            ["Favicon", "fundosmart-ultra-min-favicon.svg / .ico", "Navegador."],
            ["Iconos de app", "fundosmart-ultra-min-app-icon-*.png", "PWA, accesos y plataformas."],
            ["Vista social", "og.png", "Open Graph y tarjetas sociales."],
            ["Fotografía", "public/landing/*", "Landing y piezas de relato territorial."],
        ],
        [2100, 4240, 3020],
    )
    doc.add_paragraph("Nomenclatura", style="Heading 2")
    add_callout(
        doc,
        "Formato",
        "fundosmart_[pieza]_[formato]_[variante]_v##.ext · Ejemplo: fundosmart_presentacion_16x9_corporativa_v03.pptx",
        fill=COLORS["soft_gray"],
        accent=COLORS["forest"],
    )
    doc.add_paragraph("Principios que no cambian", style="Heading 2")
    for item in [
        "El predio completo, en un solo sistema.",
        "Ordenar sin borrar. Conectar sin complicar.",
        "Claridad, trazabilidad, cercanía y respeto por el oficio.",
        "Tecnología contemporánea con origen real en el Sur de Chile.",
    ]:
        add_list_item(doc, item, bullet_id)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(4)
    add_picture_with_alt(
        p.add_run(),
        TMP / "logo-full.png",
        width=Inches(2.5),
        alt_text="Logotipo principal de FundoSmart.",
    )
    end = doc.add_paragraph()
    end.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_run_font(
        end.add_run("Manual de marca · Versión 1.0 · Julio 2026"),
        size=9,
        color=COLORS["muted"],
        bold=True,
    )

    # Core document properties.
    props = doc.core_properties
    props.title = "Manual de marca FundoSmart"
    props.subject = "Sistema de identidad verbal y visual"
    props.author = "FundoSmart"
    props.keywords = "FundoSmart, marca, identidad, logotipo, color, tipografía, voz"
    props.comments = "Versión 1.0 · Julio 2026"

    sanitize_hyphens(doc)
    doc.save(OUT_DOCX)
    print(OUT_DOCX)


if __name__ == "__main__":
    build_document()
