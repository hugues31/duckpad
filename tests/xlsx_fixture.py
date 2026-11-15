"""Create a small, deterministic OOXML workbook without an Excel dependency."""

import sys
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

SHEETS = {
    "Summary": [["total"], [999]],
    "Orders": [
        ["id", "region", "amount", "ordered_on", "active", "note"],
        [1, "North", 12.5, (45293, 1), True, "O'Brien & Sons"],
        [2, "South", 20, (45294, 1), False, "Unicode: \u2603"],
        [3, "North", 7.5, (45295, 1), True, None],
    ],
    "Mixed": [["value"], [10], ["pending"]],
    "Raw": [[1, 10], [2, 20]],
}
MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def workbook(path):
    def cell(column, row, value):
        ref = f"{chr(65 + column)}{row}"
        if value is None:
            return ""
        if isinstance(value, str):
            return f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'
        if isinstance(value, bool):
            return f'<c r="{ref}" t="b"><v>{int(value)}</v></c>'
        number, style = value if isinstance(value, tuple) else (value, 0)
        return f'<c r="{ref}" s="{style}"><v>{number}</v></c>'

    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            + "".join(
                f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                for i in range(1, len(SHEETS) + 1)
            )
            + "</Types>",
        )
        archive.writestr(
            "_rels/.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{REL}/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>",
        )
        archive.writestr(
            "xl/workbook.xml",
            f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets>'
            + "".join(
                f'<sheet name="{name}" sheetId="{i}" r:id="rId{i}"/>' for i, name in enumerate(SHEETS, 1)
            )
            + "</sheets></workbook>",
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(
                f'<Relationship Id="rId{i}" Type="{REL}/worksheet" Target="worksheets/sheet{i}.xml"/>'
                for i in range(1, len(SHEETS) + 1)
            )
            + f'<Relationship Id="styles" Type="{REL}/styles" Target="styles.xml"/></Relationships>',
        )
        archive.writestr(
            "xl/styles.xml",
            f'<styleSheet xmlns="{MAIN}"><cellXfs count="2">'
            '<xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
        )
        for i, rows in enumerate(SHEETS.values(), 1):
            archive.writestr(
                f"xl/worksheets/sheet{i}.xml",
                f'<worksheet xmlns="{MAIN}"><sheetData>'
                + "".join(
                    f'<row r="{row}">'
                    + "".join(cell(column, row, value) for column, value in enumerate(values))
                    + "</row>"
                    for row, values in enumerate(rows, 1)
                )
                + "</sheetData></worksheet>",
            )
    return path


if __name__ == "__main__":
    workbook(Path(sys.argv[1]))
