"""
POLYTOS manual renderer.

One content model, two renderers:

  * `render_pdf`  — ReportLab. Two-pass build, so the table of contents
    carries real page numbers and every entry is a working internal link.
    Also writes the PDF outline (the sidebar bookmarks), page numbers in the
    footer, and embedded screenshots at their natural aspect ratio.

  * `render_docx` — python-docx. Real Word styles rather than direct
    formatting, so the document stays editable: changing "Heading 2" changes
    every section heading. Headers and footers carry live PAGE/NUMPAGES
    fields, and the table of contents is a real TOC field that Word and
    LibreOffice populate when the document is opened.

The content model is a flat list of blocks. Each block is a tuple whose first
element names the kind:

    ('chapter', number, title, standfirst)
    ('h2', title) ('h3', title) ('h4', title)
    ('p', text)
    ('lead', text)                  larger opening paragraph
    ('bullets', [text, ...])
    ('numbers', [text, ...])
    ('steps', [(action, result), ...])
    ('table', [headers], [[cells], ...], caption_or_None)
    ('figure', path, caption, explanation_or_None)
    ('figures2', path_a, path_b, caption, explanation_or_None)
    ('callout', kind, title, text)  kind: note | warning | money | control
    ('kv', [(term, definition), ...])
    ('code', text)
    ('pagebreak',)

Text may carry a very small amount of inline markup: **bold**, `code` and
*italic*. Both renderers understand the same three.
"""

from __future__ import annotations

import html
import os
import re
from dataclasses import dataclass, field

from PIL import Image

# --- palette ---------------------------------------------------------------
NAVY = "#102A54"
NAVY_DEEP = "#081A36"
NAVY_SOFT = "#2B4A7D"
GOLD = "#B8893B"
GOLD_SOFT = "#F3E6CE"
INK = "#1A1F2B"
MUTED = "#5A6273"
RULE = "#D4DAE4"
PAPER_TINT = "#F4F6FA"

A4_W, A4_H = 595.28, 841.89  # points

# --- figure preparation ----------------------------------------------------
# A capture is 2,880 pixels wide at device scale 2, and a full-page capture of
# a long admin screen can be 16,000 pixels tall. Embedded raw, two manuals came
# to 165 MB and the tall ones rendered as unreadable slivers. So every figure
# is prepared once into a cache: resampled to a width that is still crisp at
# A4 (about 190 dpi across a 155 mm column), and, where the page is far taller
# than it is wide, cropped to the top of the screen — which is the part a
# reader can actually read at that size, and is what the caption describes.
FIG_MAX_W = 1400
FIG_MAX_RATIO = 1.32
_FIG_CACHE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".figure-cache")


def prepared(path: str) -> str:
    """Return a print-sized copy of a screenshot, making it if need be."""
    if not os.path.exists(path):
        return path
    try:
        stat = os.stat(path)
        key = f"{abs(hash((os.path.abspath(path), int(stat.st_mtime), stat.st_size))):016x}.jpg"
        out = os.path.join(_FIG_CACHE, key)
        if os.path.exists(out):
            return out
        os.makedirs(_FIG_CACHE, exist_ok=True)
        with Image.open(path) as im:
            im = im.convert("RGB")
            if im.width > FIG_MAX_W:
                im = im.resize(
                    (FIG_MAX_W, max(1, round(im.height * FIG_MAX_W / im.width))),
                    Image.LANCZOS)
            limit = round(im.width * FIG_MAX_RATIO)
            if im.height > limit:
                im = im.crop((0, 0, im.width, limit))
            # JPEG rather than PNG: a screenshot embedded losslessly at this size
            # made the two manuals 165 MB between them, and at quality 88 the
            # interface text is indistinguishable on paper or on screen.
            im.save(out, "JPEG", quality=88, optimize=True, progressive=True)
        return out
    except Exception:
        return path


def figure_size(path: str):
    with Image.open(path) as im:
        return im.size


# ===========================================================================
# Inline markup
# ===========================================================================
_TOKEN = re.compile(r"(\*\*.+?\*\*|`[^`]+`|\*[^*]+\*)")


def _inline_tokens(text: str):
    """Split text into (kind, literal) pairs. kind: plain|bold|code|italic."""
    for part in _TOKEN.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            yield "bold", part[2:-2]
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            yield "code", part[1:-1]
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            yield "italic", part[1:-1]
        else:
            yield "plain", part


def rl_markup(text: str) -> str:
    """Inline markup to ReportLab's mini-HTML, escaping everything else."""
    out = []
    for kind, literal in _inline_tokens(text):
        safe = html.escape(literal)
        if kind == "bold":
            out.append(f"<b>{safe}</b>")
        elif kind == "italic":
            out.append(f"<i>{safe}</i>")
        elif kind == "code":
            out.append(
                f'<font face="DejaVuMono" size="8.5" color="{NAVY}">{safe}</font>'
            )
        else:
            out.append(safe)
    return "".join(out)


def plain(text: str) -> str:
    return "".join(literal for _, literal in _inline_tokens(text))


# ===========================================================================
# Document description
# ===========================================================================
@dataclass
class Manual:
    title: str
    subtitle: str
    audience: str
    version: str
    issued: str
    prepared_by: str
    system: str
    blocks: list = field(default_factory=list)
    logo: str | None = None

    def add(self, *blocks):
        self.blocks.extend(blocks)
        return self


# ===========================================================================
# PDF
# ===========================================================================
def render_pdf(manual: Manual, out_path: str) -> None:
    from reportlab.lib.colors import HexColor, white
    from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (
        BaseDocTemplate,
        Frame,
        Image as RLImage,
        KeepTogether,
        NextPageTemplate,
        PageBreak,
        PageTemplate,
        Paragraph,
        Spacer,
        Table,
        TableStyle,
    )
    from reportlab.platypus.tableofcontents import TableOfContents

    D = "/usr/share/fonts/truetype/liberation"
    for name, file in (
        ("DejaVu", "LiberationSans-Regular.ttf"),
        ("DejaVu-Bold", "LiberationSans-Bold.ttf"),
        ("DejaVu-Oblique", "LiberationSans-Italic.ttf"),
        ("DejaVu-BoldOblique", "LiberationSans-BoldItalic.ttf"),
        ("DejaVuMono", "LiberationMono-Regular.ttf"),
    ):
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, os.path.join(D, file)))
    from reportlab.pdfbase.pdfmetrics import registerFontFamily

    registerFontFamily(
        "DejaVu", normal="DejaVu", bold="DejaVu-Bold", italic="DejaVu-Oblique",
        boldItalic="DejaVu-BoldOblique",
    )

    M_L, M_R, M_T, M_B = 22 * mm, 20 * mm, 26 * mm, 20 * mm
    CONTENT_W = A4_W - M_L - M_R

    ss = getSampleStyleSheet()

    def S(name, **kw):
        base = dict(fontName="DejaVu", fontSize=9.6, leading=14.6,
                    textColor=HexColor(INK), alignment=TA_JUSTIFY,
                    spaceAfter=6, wordWrap="LTR")
        base.update(kw)
        return ParagraphStyle(name, parent=ss["Normal"], **base)

    st = {
        "body": S("body"),
        "lead": S("lead", fontSize=11, leading=17, textColor=HexColor(NAVY_SOFT),
                  spaceAfter=10),
        "chapnum": S("chapnum", fontName="DejaVu-Bold", fontSize=10, leading=13,
                     textColor=HexColor(GOLD), alignment=TA_LEFT, spaceAfter=2),
        "chaptitle": S("chaptitle", fontName="DejaVu-Bold", fontSize=22, leading=26,
                       textColor=HexColor(NAVY), alignment=TA_LEFT, spaceAfter=8),
        "stand": S("stand", fontSize=10.4, leading=15.6, textColor=HexColor(MUTED),
                   spaceAfter=14),
        "h2": S("h2", fontName="DejaVu-Bold", fontSize=13.4, leading=17.5,
                textColor=HexColor(NAVY), alignment=TA_LEFT,
                spaceBefore=15, spaceAfter=6),
        "h3": S("h3", fontName="DejaVu-Bold", fontSize=11, leading=15,
                textColor=HexColor(NAVY_SOFT), alignment=TA_LEFT,
                spaceBefore=11, spaceAfter=4),
        "h4": S("h4", fontName="DejaVu-Bold", fontSize=9.8, leading=13.5,
                textColor=HexColor(GOLD), alignment=TA_LEFT,
                spaceBefore=9, spaceAfter=3),
        "bullet": S("bullet", leftIndent=12, bulletIndent=2, spaceAfter=3.5),
        "cap": S("cap", fontName="DejaVu-Bold", fontSize=8.4, leading=11.5,
                 textColor=HexColor(NAVY), alignment=TA_LEFT, spaceBefore=4,
                 spaceAfter=2),
        "capx": S("capx", fontSize=8.4, leading=11.8, textColor=HexColor(MUTED),
                  spaceAfter=10),
        "cell": S("cell", fontSize=8.5, leading=11.8, alignment=TA_LEFT, spaceAfter=0),
        "cellh": S("cellh", fontName="DejaVu-Bold", fontSize=8.3, leading=11.4,
                   textColor=white, alignment=TA_LEFT, spaceAfter=0),
        "callt": S("callt", fontName="DejaVu-Bold", fontSize=9.2, leading=12.6,
                   textColor=HexColor(NAVY), alignment=TA_LEFT, spaceAfter=2.5),
        "callb": S("callb", fontSize=9.1, leading=13.6, spaceAfter=0),
        "code": S("code", fontName="DejaVuMono", fontSize=8, leading=11.4,
                  textColor=HexColor(NAVY_DEEP), alignment=TA_LEFT, spaceAfter=0),
        "cover_t": S("cover_t", fontName="DejaVu-Bold", fontSize=30, leading=36,
                     textColor=white, alignment=TA_LEFT, spaceAfter=10),
        "cover_s": S("cover_s", fontSize=13, leading=19, textColor=HexColor("#C9D6EC"),
                     alignment=TA_LEFT, spaceAfter=8),
        "cover_m": S("cover_m", fontSize=9.6, leading=15, textColor=HexColor("#9FB3D4"),
                     alignment=TA_LEFT, spaceAfter=3),
        "toch": S("toch", fontName="DejaVu-Bold", fontSize=18, leading=23,
                  textColor=HexColor(NAVY), alignment=TA_LEFT, spaceAfter=12),
    }

    # --- page furniture ----------------------------------------------------
    def cover_page(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(HexColor(NAVY))
        canvas.rect(0, 0, A4_W, A4_H, fill=1, stroke=0)
        canvas.setFillColor(HexColor(NAVY_DEEP))
        canvas.rect(0, 0, A4_W, 150, fill=1, stroke=0)
        canvas.setFillColor(HexColor(GOLD))
        canvas.rect(0, A4_H - 10, A4_W, 10, fill=1, stroke=0)
        canvas.rect(M_L, A4_H - 300, 62, 3.4, fill=1, stroke=0)
        canvas.restoreState()

    def body_page(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(HexColor(NAVY))
        canvas.rect(0, A4_H - 13, A4_W, 13, fill=1, stroke=0)
        canvas.setFillColor(HexColor(GOLD))
        canvas.rect(0, A4_H - 15.6, A4_W, 2.6, fill=1, stroke=0)

        canvas.setFont("DejaVu", 7.4)
        canvas.setFillColor(HexColor(MUTED))
        canvas.drawString(M_L, A4_H - 26, manual.system)
        canvas.drawRightString(A4_W - M_R, A4_H - 26, manual.title)

        canvas.setStrokeColor(HexColor(RULE))
        canvas.setLineWidth(0.5)
        canvas.line(M_L, 34, A4_W - M_R, 34)
        canvas.setFont("DejaVu", 7.4)
        canvas.setFillColor(HexColor(MUTED))
        canvas.drawString(M_L, 24, f"{manual.prepared_by}  ·  {manual.version}  ·  {manual.issued}")
        canvas.setFont("DejaVu-Bold", 8.4)
        canvas.setFillColor(HexColor(NAVY))
        canvas.drawRightString(A4_W - M_R, 24, str(canvas.getPageNumber()))
        canvas.restoreState()

    class Doc(BaseDocTemplate):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self._last_level = -1

        def afterFlowable(self, flowable):
            key = getattr(flowable, "_toc", None)
            if key is None:
                return
            level, text, anchor = key
            # The PDF outline refuses a jump of more than one level, and the
            # front matter opens at a sub-heading before any chapter exists.
            # Tracked on the canvas, not on the document: multiBuild runs two
            # passes over one document with a fresh canvas each time, and a
            # counter left high by the first pass lets the second through.
            last = getattr(self.canv, "_polytos_last_level", -1)
            level = min(level, last + 1)
            self.canv._polytos_last_level = level
            self.canv.bookmarkPage(anchor)
            self.canv.addOutlineEntry(plain(text)[:110], anchor, level=level, closed=(level > 0))
            self.notify("TOCEntry", (level, plain(text), self.page, anchor))

    doc = Doc(
        out_path, pagesize=(A4_W, A4_H),
        leftMargin=M_L, rightMargin=M_R, topMargin=M_T, bottomMargin=M_B,
        title=f"{manual.system} — {manual.title}",
        author=manual.prepared_by,
        subject=manual.subtitle,
    )
    frame = Frame(M_L, M_B, CONTENT_W, A4_H - M_T - M_B, id="f")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[Frame(M_L, M_B, CONTENT_W, A4_H - M_T - M_B, id="c")],
                     onPage=cover_page),
        PageTemplate(id="body", frames=[frame], onPage=body_page),
    ])

    story = []

    # --- cover -------------------------------------------------------------
    story.append(Spacer(1, 150))
    if manual.logo and os.path.exists(manual.logo):
        try:
            with Image.open(manual.logo) as im:
                ratio = im.height / im.width
            story.append(RLImage(manual.logo, width=105, height=105 * ratio))
            story.append(Spacer(1, 22))
        except Exception:
            pass
    story.append(Paragraph(manual.system.upper(), st["cover_m"]))
    story.append(Spacer(1, 42))
    story.append(Paragraph(html.escape(manual.title), st["cover_t"]))
    story.append(Paragraph(html.escape(manual.subtitle), st["cover_s"]))
    story.append(Spacer(1, 150))
    story.append(Paragraph(f"<b>For</b>  {html.escape(manual.audience)}", st["cover_m"]))
    story.append(Paragraph(f"<b>Version</b>  {html.escape(manual.version)}", st["cover_m"]))
    story.append(Paragraph(f"<b>Issued</b>  {html.escape(manual.issued)}", st["cover_m"]))
    story.append(Paragraph(f"<b>Prepared by</b>  {html.escape(manual.prepared_by)}", st["cover_m"]))
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())

    # --- contents ----------------------------------------------------------
    story.append(Paragraph("Contents", st["toch"]))
    toc = TableOfContents()
    toc.levelStyles = [
        ParagraphStyle("t0", fontName="DejaVu-Bold", fontSize=10, leading=19,
                       textColor=HexColor(NAVY), spaceBefore=7),
        ParagraphStyle("t1", fontName="DejaVu", fontSize=9, leading=15.5,
                       textColor=HexColor(INK), leftIndent=15),
        ParagraphStyle("t2", fontName="DejaVu", fontSize=8.4, leading=13.5,
                       textColor=HexColor(MUTED), leftIndent=30),
    ]
    story.append(toc)
    story.append(PageBreak())

    # --- body --------------------------------------------------------------
    anchor_n = [0]

    def anchored(para, level, text):
        anchor_n[0] += 1
        a = f"sec{anchor_n[0]}"
        para._toc = (level, text, a)
        return para

    def table_flow(headers, rows, caption):
        ncols = max(len(headers), max((len(r) for r in rows), default=1))
        data = [[Paragraph(rl_markup(str(c)), st["cellh"]) for c in headers]]
        for r in rows:
            data.append([Paragraph(rl_markup(str(c)), st["cell"]) for c in r])
        widths = [CONTENT_W / ncols] * ncols
        if ncols >= 3:
            widths[0] = CONTENT_W * (0.30 if ncols == 3 else 0.24)
            rest = (CONTENT_W - widths[0]) / (ncols - 1)
            for i in range(1, ncols):
                widths[i] = rest
        t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), HexColor(NAVY)),
            ("TOPPADDING", (0, 0), (-1, -1), 4.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("GRID", (0, 0), (-1, -1), 0.4, HexColor(RULE)),
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, HexColor(GOLD)),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, HexColor(PAPER_TINT)]),
        ]))
        out = [t]
        if caption:
            out.append(Paragraph(rl_markup(caption), st["capx"]))
        else:
            out.append(Spacer(1, 9))
        return out

    def image_flow(path, max_w, max_h=660):
        if not os.path.exists(path):
            return Paragraph(
                f'<font color="{GOLD}">[screenshot missing: {html.escape(os.path.basename(path))}]</font>',
                st["capx"])
        path = prepared(path)
        w, h = figure_size(path)
        scale = min(max_w / w, max_h / h)
        img = RLImage(path, width=w * scale, height=h * scale)
        img.hAlign = "LEFT"
        return img

    def callout_flow(kind, title, text):
        tone = {"note": (NAVY_SOFT, "#EEF2F9"), "warning": ("#9B2C2C", "#FDEDED"),
                "money": (GOLD, GOLD_SOFT), "control": ("#1F5F46", "#E8F5EF")}.get(
            kind, (NAVY_SOFT, "#EEF2F9"))
        inner = []
        if title:
            inner.append(Paragraph(rl_markup(title), st["callt"]))
        inner.append(Paragraph(rl_markup(text), st["callb"]))
        t = Table([[inner]], colWidths=[CONTENT_W], hAlign="LEFT")
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), HexColor(tone[1])),
            ("LINEBEFORE", (0, 0), (0, -1), 3, HexColor(tone[0])),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ]))
        return [t, Spacer(1, 10)]

    for b in manual.blocks:
        kind = b[0]
        if kind == "chapter":
            _, num, title, stand = b
            story.append(PageBreak())
            story.append(Paragraph(f"CHAPTER {num}", st["chapnum"]))
            story.append(anchored(Paragraph(html.escape(title), st["chaptitle"]), 0,
                                  f"{num}. {title}"))
            if stand:
                story.append(Paragraph(rl_markup(stand), st["stand"]))
        elif kind == "h2":
            story.append(anchored(Paragraph(rl_markup(b[1]), st["h2"]), 1, b[1]))
        elif kind == "h3":
            story.append(anchored(Paragraph(rl_markup(b[1]), st["h3"]), 2, b[1]))
        elif kind == "h4":
            story.append(Paragraph(rl_markup(b[1]), st["h4"]))
        elif kind == "p":
            story.append(Paragraph(rl_markup(b[1]), st["body"]))
        elif kind == "lead":
            story.append(Paragraph(rl_markup(b[1]), st["lead"]))
        elif kind == "bullets":
            for item in b[1]:
                story.append(Paragraph(rl_markup(item), st["bullet"],
                                       bulletText="•"))
            story.append(Spacer(1, 5))
        elif kind == "numbers":
            for i, item in enumerate(b[1], 1):
                story.append(Paragraph(rl_markup(item), st["bullet"],
                                       bulletText=f"{i}."))
            story.append(Spacer(1, 5))
        elif kind == "steps":
            rows = [[f"{i}", a, r] for i, (a, r) in enumerate(b[1], 1)]
            story.extend(table_flow(["#", "What you do", "What you should see"], rows, None))
        elif kind == "table":
            _, headers, rows, caption = (list(b) + [None])[:4]
            story.extend(table_flow(headers, rows, caption))
        elif kind == "figure":
            _, path, caption, expl = (list(b) + [None])[:4]
            group = [image_flow(path, CONTENT_W), Paragraph(rl_markup(caption), st["cap"])]
            if expl:
                group.append(Paragraph(rl_markup(expl), st["capx"]))
            else:
                group.append(Spacer(1, 8))
            story.append(KeepTogether(group))
        elif kind == "figures2":
            _, pa, pb, caption, expl = (list(b) + [None])[:5]
            half = (CONTENT_W - 14) / 2
            cells = [[image_flow(pa, half, 430), image_flow(pb, half, 430)]]
            t = Table(cells, colWidths=[half + 7, half + 7], hAlign="LEFT")
            t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                   ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                   ("RIGHTPADDING", (0, 0), (0, 0), 14)]))
            group = [t, Paragraph(rl_markup(caption), st["cap"])]
            if expl:
                group.append(Paragraph(rl_markup(expl), st["capx"]))
            else:
                group.append(Spacer(1, 8))
            story.append(KeepTogether(group))
        elif kind == "callout":
            story.extend(callout_flow(b[1], b[2], b[3]))
        elif kind == "kv":
            rows = [[t_, d_] for t_, d_ in b[1]]
            story.extend(table_flow(["Term", "What it means"], rows, None))
        elif kind == "code":
            t = Table([[Paragraph(html.escape(l) or "&nbsp;", st["code"])] for l in b[1].split("\n")],
                      colWidths=[CONTENT_W], hAlign="LEFT")
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), HexColor("#F2F4F8")),
                ("TOPPADDING", (0, 0), (-1, -1), 1.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
            ]))
            story.extend([t, Spacer(1, 10)])
        elif kind == "pagebreak":
            story.append(PageBreak())

    doc.multiBuild(story)


# ===========================================================================
# DOCX
# ===========================================================================
def render_docx(manual: Manual, out_path: str) -> None:
    import docx
    from docx import Document
    from docx.enum.section import WD_SECTION
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Cm, Emu, Pt, RGBColor

    def hexc(h):
        return RGBColor.from_string(h.lstrip("#").upper())

    doc = Document()

    # --- page setup --------------------------------------------------------
    s = doc.sections[0]
    s.page_width, s.page_height = Cm(21.0), Cm(29.7)
    s.left_margin, s.right_margin = Cm(2.2), Cm(2.0)
    s.top_margin, s.bottom_margin = Cm(2.4), Cm(2.0)
    CONTENT_CM = 21.0 - 2.2 - 2.0

    # --- styles ------------------------------------------------------------
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = hexc(INK)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.15
    rpr = normal.element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rpr.append(rf)
    for a in ("w:ascii", "w:hAnsi", "w:cs"):
        rf.set(qn(a), "Calibri")

    def style_heading(name, size, color, bold=True, before=14, after=6):
        stl = doc.styles[name]
        stl.font.name = "Calibri"
        stl.font.size = Pt(size)
        stl.font.bold = bold
        stl.font.color.rgb = hexc(color)
        stl.paragraph_format.space_before = Pt(before)
        stl.paragraph_format.space_after = Pt(after)
        stl.paragraph_format.keep_with_next = True
        return stl

    style_heading("Title", 30, NAVY, before=0, after=10)
    style_heading("Heading 1", 22, NAVY, before=22, after=8)
    style_heading("Heading 2", 14.5, NAVY, before=16, after=6)
    style_heading("Heading 3", 12, NAVY_SOFT, before=12, after=4)
    style_heading("Heading 4", 10.5, GOLD, before=10, after=3)

    for nm, sz, col, ital in (("Caption", 9, NAVY, False),):
        try:
            cs = doc.styles[nm]
            cs.font.size, cs.font.color.rgb, cs.font.italic = Pt(sz), hexc(col), ital
            cs.font.bold = True
        except KeyError:
            pass

    def field(par, instr):
        r = par.add_run()
        f1 = OxmlElement("w:fldChar"); f1.set(qn("w:fldCharType"), "begin")
        it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve"); it.text = instr
        f2 = OxmlElement("w:fldChar"); f2.set(qn("w:fldCharType"), "separate")
        t = OxmlElement("w:t"); t.text = " "
        f3 = OxmlElement("w:fldChar"); f3.set(qn("w:fldCharType"), "end")
        r._r.append(f1); r._r.append(it); r._r.append(f2); r._r.append(t); r._r.append(f3)
        return r

    def shade(el, color):
        sh = OxmlElement("w:shd")
        sh.set(qn("w:val"), "clear"); sh.set(qn("w:color"), "auto")
        sh.set(qn("w:fill"), color.lstrip("#").upper())
        el.append(sh)

    def cell_shade(cell, color):
        shade(cell._tc.get_or_add_tcPr(), color)

    def para_border_left(par, color, width=18):
        pPr = par._p.get_or_add_pPr()
        bd = OxmlElement("w:pBdr")
        left = OxmlElement("w:left")
        left.set(qn("w:val"), "single"); left.set(qn("w:sz"), str(width))
        left.set(qn("w:space"), "6"); left.set(qn("w:color"), color.lstrip("#").upper())
        bd.append(left)
        pPr.append(bd)

    def write_inline(par, text, base_color=None, base_size=None, bold=False, italic=False):
        for kind, literal in _inline_tokens(text):
            r = par.add_run(literal)
            r.font.bold = bold or kind == "bold"
            r.font.italic = italic or kind == "italic"
            if base_size:
                r.font.size = Pt(base_size)
            if kind == "code":
                r.font.name = "Consolas"
                r.font.size = Pt((base_size or 10.5) - 1.2)
                r.font.color.rgb = hexc(NAVY)
                rp = r._r.get_or_add_rPr()
                rfo = OxmlElement("w:rFonts")
                for a in ("w:ascii", "w:hAnsi"):
                    rfo.set(qn(a), "Consolas")
                rp.append(rfo)
            elif base_color:
                r.font.color.rgb = hexc(base_color)
        return par

    # --- cover -------------------------------------------------------------
    if manual.logo and os.path.exists(manual.logo):
        try:
            p = doc.add_paragraph()
            p.add_run().add_picture(manual.logo, width=Cm(3.4))
            p.paragraph_format.space_after = Pt(18)
        except Exception:
            pass
    p = doc.add_paragraph()
    write_inline(p, manual.system.upper(), base_color=GOLD, base_size=11, bold=True)
    p.paragraph_format.space_after = Pt(30)

    doc.add_paragraph(manual.title, style="Title")
    p = doc.add_paragraph()
    write_inline(p, manual.subtitle, base_color=NAVY_SOFT, base_size=14)
    p.paragraph_format.space_after = Pt(40)

    meta = doc.add_table(rows=0, cols=2)
    meta.alignment = WD_TABLE_ALIGNMENT.LEFT
    for k, v in (("For", manual.audience), ("Version", manual.version),
                 ("Issued", manual.issued), ("Prepared by", manual.prepared_by)):
        row = meta.add_row().cells
        write_inline(row[0].paragraphs[0], k, base_color=MUTED, base_size=10, bold=True)
        write_inline(row[1].paragraphs[0], v, base_size=10)
        row[0].width, row[1].width = Cm(3.6), Cm(11.0)

    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    # --- contents ----------------------------------------------------------
    doc.add_paragraph("Contents", style="Heading 1")
    p = doc.add_paragraph()
    write_inline(
        p,
        "If the entries below appear blank, press Ctrl+A then F9 (Word) or use "
        "Tools ▸ Update ▸ Indexes and Tables (LibreOffice) to build the "
        "contents. The PDF edition of this manual carries the page numbers already.",
        base_color=MUTED, base_size=9,
    )
    field(doc.add_paragraph(), r'TOC \o "1-3" \h \z \u')
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    # --- header / footer ---------------------------------------------------
    hdr = s.header.paragraphs[0]
    hdr.text = ""
    write_inline(hdr, f"{manual.system}  ·  {manual.title}", base_color=MUTED, base_size=8)
    hdr.alignment = WD_ALIGN_PARAGRAPH.RIGHT

    ftr = s.footer.paragraphs[0]
    ftr.text = ""
    write_inline(ftr, f"{manual.prepared_by}  ·  {manual.version}  ·  {manual.issued}      ",
                 base_color=MUTED, base_size=8)
    ftr.add_run("Page ").font.size = Pt(8)
    field(ftr, "PAGE")
    ftr.add_run(" of ").font.size = Pt(8)
    field(ftr, "NUMPAGES")

    # --- body --------------------------------------------------------------
    def add_table(headers, rows, caption):
        ncols = max(len(headers), max((len(r) for r in rows), default=1))
        t = doc.add_table(rows=1, cols=ncols)
        t.style = "Table Grid"
        t.alignment = WD_TABLE_ALIGNMENT.LEFT
        t.autofit = True
        for i, h in enumerate(headers):
            c = t.rows[0].cells[i]
            c.text = ""
            write_inline(c.paragraphs[0], str(h), base_color="#FFFFFF", base_size=9, bold=True)
            c.paragraphs[0].paragraph_format.space_after = Pt(2)
            cell_shade(c, NAVY)
        for ri, r in enumerate(rows):
            cells = t.add_row().cells
            for i in range(ncols):
                cells[i].text = ""
                write_inline(cells[i].paragraphs[0], str(r[i]) if i < len(r) else "",
                             base_size=9)
                cells[i].paragraphs[0].paragraph_format.space_after = Pt(2)
                if ri % 2 == 1:
                    cell_shade(cells[i], PAPER_TINT)
        if caption:
            cp = doc.add_paragraph()
            write_inline(cp, caption, base_color=MUTED, base_size=9)
        else:
            doc.add_paragraph().paragraph_format.space_after = Pt(2)

    def add_image(path, max_cm=CONTENT_CM, max_h_cm=23.0):
        if not os.path.exists(path):
            p = doc.add_paragraph()
            write_inline(p, f"[screenshot missing: {os.path.basename(path)}]",
                         base_color=GOLD, base_size=9)
            return
        path = prepared(path)
        with Image.open(path) as im:
            w, h = im.size
        width_cm = min(max_cm, max_h_cm * w / h)
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(3)
        try:
            p.add_run().add_picture(path, width=Cm(width_cm))
        except Exception:
            write_inline(p, f"[screenshot could not be embedded: {os.path.basename(path)}]",
                         base_color=GOLD, base_size=9)

    for b in manual.blocks:
        kind = b[0]
        if kind == "chapter":
            _, num, title, stand = b
            doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
            p = doc.add_paragraph()
            write_inline(p, f"CHAPTER {num}", base_color=GOLD, base_size=10, bold=True)
            p.paragraph_format.space_after = Pt(0)
            doc.add_paragraph(title, style="Heading 1")
            if stand:
                sp = doc.add_paragraph()
                write_inline(sp, stand, base_color=MUTED, base_size=10.5)
                sp.paragraph_format.space_after = Pt(12)
        elif kind in ("h2", "h3", "h4"):
            lvl = {"h2": "Heading 2", "h3": "Heading 3", "h4": "Heading 4"}[kind]
            p = doc.add_paragraph(style=lvl)
            write_inline(p, b[1])
        elif kind == "p":
            write_inline(doc.add_paragraph(), b[1])
        elif kind == "lead":
            p = doc.add_paragraph()
            write_inline(p, b[1], base_color=NAVY_SOFT, base_size=12)
            p.paragraph_format.space_after = Pt(10)
        elif kind == "bullets":
            for item in b[1]:
                write_inline(doc.add_paragraph(style="List Bullet"), item)
        elif kind == "numbers":
            for item in b[1]:
                write_inline(doc.add_paragraph(style="List Number"), item)
        elif kind == "steps":
            add_table(["#", "What you do", "What you should see"],
                      [[str(i), a, r] for i, (a, r) in enumerate(b[1], 1)], None)
        elif kind == "table":
            add_table(b[1], b[2], b[3])
        elif kind == "figure":
            _, path, caption, expl = (list(b) + [None])[:4]
            add_image(path)
            cp = doc.add_paragraph(style="Caption")
            write_inline(cp, caption, base_color=NAVY, base_size=9, bold=True)
            if expl:
                ep = doc.add_paragraph()
                write_inline(ep, expl, base_color=MUTED, base_size=9)
        elif kind == "figures2":
            _, pa, pb, caption, expl = (list(b) + [None])[:5]
            t = doc.add_table(rows=1, cols=2)
            t.alignment = WD_TABLE_ALIGNMENT.LEFT
            for cell, path in zip(t.rows[0].cells, (pa, pb)):
                cell.text = ""
                if os.path.exists(path):
                    path = prepared(path)
                    with Image.open(path) as im:
                        w, h = im.size
                    width_cm = min((CONTENT_CM - 0.6) / 2, 15.0 * w / h)
                    try:
                        cell.paragraphs[0].add_run().add_picture(path, width=Cm(width_cm))
                    except Exception:
                        write_inline(cell.paragraphs[0], "[image]", base_size=9)
                else:
                    write_inline(cell.paragraphs[0],
                                 f"[screenshot missing: {os.path.basename(path)}]",
                                 base_color=GOLD, base_size=9)
            cp = doc.add_paragraph(style="Caption")
            write_inline(cp, caption, base_color=NAVY, base_size=9, bold=True)
            if expl:
                ep = doc.add_paragraph()
                write_inline(ep, expl, base_color=MUTED, base_size=9)
        elif kind == "callout":
            _, ck, title, text = b
            tone = {"note": (NAVY_SOFT, "#EEF2F9"), "warning": ("#9B2C2C", "#FDEDED"),
                    "money": (GOLD, GOLD_SOFT), "control": ("#1F5F46", "#E8F5EF")}.get(
                ck, (NAVY_SOFT, "#EEF2F9"))
            tbl = doc.add_table(rows=1, cols=1)
            tbl.alignment = WD_TABLE_ALIGNMENT.LEFT
            cell = tbl.rows[0].cells[0]
            cell.text = ""
            cell_shade(cell, tone[1])
            first = cell.paragraphs[0]
            if title:
                write_inline(first, title, base_color=tone[0], base_size=10, bold=True)
                body_p = cell.add_paragraph()
            else:
                body_p = first
            write_inline(body_p, text, base_size=10)
            para_border_left(first, tone[0])
            doc.add_paragraph().paragraph_format.space_after = Pt(2)
        elif kind == "kv":
            add_table(["Term", "What it means"], [[t_, d_] for t_, d_ in b[1]], None)
        elif kind == "code":
            tbl = doc.add_table(rows=1, cols=1)
            cell = tbl.rows[0].cells[0]
            cell.text = ""
            cell_shade(cell, "#F2F4F8")
            for i, line in enumerate(b[1].split("\n")):
                p = cell.paragraphs[0] if i == 0 else cell.add_paragraph()
                p.paragraph_format.space_after = Pt(0)
                r = p.add_run(line)
                r.font.name = "Consolas"
                r.font.size = Pt(9)
                r.font.color.rgb = hexc(NAVY_DEEP)
                rp = r._r.get_or_add_rPr()
                rfo = OxmlElement("w:rFonts")
                for a in ("w:ascii", "w:hAnsi"):
                    rfo.set(qn(a), "Consolas")
                rp.append(rfo)
            doc.add_paragraph().paragraph_format.space_after = Pt(2)
        elif kind == "pagebreak":
            doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    doc.save(out_path)
