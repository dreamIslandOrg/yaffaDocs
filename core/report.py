"""יצוא הדוח לאקסל – גיליון סיכום וגיליון לכל ספק, מימין לשמאל."""
from __future__ import annotations

import io

import pandas as pd
from openpyxl.styles import Alignment, Font, PatternFill

TITLE_FILL = PatternFill("solid", fgColor="1F4E78")
HEAD_FILL = PatternFill("solid", fgColor="D9E1F2")


def _write_block(ws, row: int, title: str, df: pd.DataFrame) -> int:
    ws.cell(row=row, column=1, value=f"{title} ({len(df)})").font = Font(bold=True, size=13, color="FFFFFF")
    ws.cell(row=row, column=1).fill = TITLE_FILL
    row += 1
    if df is None or df.empty:
        ws.cell(row=row, column=1, value="אין")
        return row + 2
    for j, c in enumerate(df.columns, 1):
        cell = ws.cell(row=row, column=j, value=str(c))
        cell.font = Font(bold=True)
        cell.fill = HEAD_FILL
    for rec in df.itertuples(index=False):
        row += 1
        for j, v in enumerate(rec, 1):
            if isinstance(v, float) and pd.isna(v):
                v = None
            ws.cell(row=row, column=j, value=v).alignment = Alignment(wrap_text=False)
    return row + 3


def _summary_rows(results, not_checked):
    rows = []
    for r in results:
        rows.append({
            "ספק": r.name,
            "אומתו": len(r.verified),
            "אי-התאמות (שוברים)": r.mismatches["מספר שובר"].nunique() if not r.mismatches.empty else 0,
            "לא הגיעו": len(r.not_arrived),
            "אצל הספק – חסר באיזי": len(r.missing_in_easy),
            "באיזי – חסר אצל הספק": len(r.missing_in_supplier),
            "חריגות": len(r.exceptions),
            "התרעות": len(r.alerts),
        })
    return pd.DataFrame(rows)


def build_excel(results, not_checked: pd.DataFrame, day) -> bytes:
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        wb = xw.book
        ws = wb.create_sheet("סיכום")
        ws.sheet_view.rightToLeft = True
        ws.cell(row=1, column=1, value=f"הצלבת שוברים – תאריך הגעה {day:%d/%m/%Y}").font = Font(bold=True, size=15)
        row = _write_block(ws, 3, "סיכום לפי ספק", _summary_rows(results, not_checked))
        cols = ["מספר שובר", "מס. הזמנה", "לקוח", "חבילה באיזי", "מחיר × כמות", "חברת שוברים"]
        nc = not_checked[["voucher_raw", "order_no", "customer", "package_name", "final_price", "supplier"]] \
            if not not_checked.empty else pd.DataFrame()
        if not nc.empty:
            nc.columns = cols
        _write_block(ws, row, "שורות באיזי של ספקים שלא הועלה להם דוח (לא נבדקו)", nc)

        for r in results:
            name = r.name.replace("/", "-")[:31]
            ws = wb.create_sheet(name)
            ws.sheet_view.rightToLeft = True
            row = 1
            row = _write_block(ws, row, "אומתו – לפי סוג חבילה", r.verified_summary())
            row = _write_block(ws, row, "אי-התאמות", r.mismatches)
            row = _write_block(ws, row, "קיים אצל הספק – חסר באיזי", r.missing_in_easy)
            row = _write_block(ws, row, "קיים באיזי – לא נמצא בדוח הספק", r.missing_in_supplier)
            row = _write_block(ws, row, "חריגות (לא ניתן לשייך בוודאות)", r.exceptions)
            row = _write_block(ws, row, "לא הגיעו (תאריך התחלה שונה)", r.not_arrived)
            row = _write_block(ws, row, "התרעות", pd.DataFrame({"התרעה": r.alerts}))
            row = _write_block(ws, row, "פירוט השוברים שאומתו", r.verified)
        if "Sheet" in wb.sheetnames:
            del wb["Sheet"]
        for ws in wb.worksheets:
            for col in ws.columns:
                width = max((len(str(c.value)) for c in col if c.value is not None), default=8)
                ws.column_dimensions[col[0].column_letter].width = min(max(10, width + 2), 60)
    return buf.getvalue()
