"""קריאת קבצים גולמיים: CSV (כולל קידודים עבריים) ו-Excel (כולל קבצים מוגני סיסמה)."""
from __future__ import annotations

import csv
import io
import re

import pandas as pd


def decode_bytes(raw: bytes) -> str:
    """מנסה UTF-8 (עם/בלי BOM) ואחר כך windows-1255 (עברית ישנה)."""
    for enc in ("utf-8-sig", "cp1255"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def clean_header(h) -> str:
    """מנקה שם עמודה: רווחים, ירידות שורה."""
    if h is None or (isinstance(h, float) and pd.isna(h)):
        return ""
    return re.sub(r"\s+", " ", str(h)).strip()


def split_quoted_line(line: str) -> list[str]:
    """פיצול שורת CSV שבה כל שדה עטוף במירכאות, גם כשבתוך שדה יש גרשיים לא תקניים (בע"מ)."""
    line = line.rstrip("\r\n")
    if line.startswith('"') and line.endswith('"') and len(line) >= 2:
        return line[1:-1].split('","')
    return next(csv.reader([line]))


def read_csv_rows(raw: bytes) -> list[list[str]]:
    text = decode_bytes(raw)
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        rows.append(split_quoted_line(line))
    return rows


def _maybe_decrypt(raw: bytes, password: str | None) -> bytes:
    """אם קובץ האקסל מוצפן בסיסמה – פותח אותו."""
    try:
        import msoffcrypto
    except ImportError:
        return raw
    try:
        office = msoffcrypto.OfficeFile(io.BytesIO(raw))
        if not office.is_encrypted():
            return raw
    except Exception:
        return raw
    if not password:
        raise ValueError("קובץ האקסל מוגן בסיסמה ולא הוגדרה סיסמה בהגדרות.")
    out = io.BytesIO()
    office.load_key(password=str(password))
    office.decrypt(out)
    return out.getvalue()


def read_excel_rows(raw: bytes, password: str | None = None) -> list[list]:
    raw = _maybe_decrypt(raw, password)
    df = pd.read_excel(io.BytesIO(raw), header=None, dtype=object)
    rows = []
    for rec in df.itertuples(index=False):
        rows.append([None if (isinstance(v, float) and pd.isna(v)) else v for v in rec])
    return rows


def read_any(raw: bytes, filename: str, password: str | None = None) -> list[list]:
    name = filename.lower()
    if name.endswith((".xlsx", ".xls", ".xlsm")):
        return read_excel_rows(raw, password)
    return read_csv_rows(raw)
