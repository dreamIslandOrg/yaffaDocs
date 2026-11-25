"""הפיכת כל דוח (איזי או ספק) לטבלה אחידה אחת.

עמודות הטבלה האחידה:
    voucher_raw   – מספר השובר כפי שמופיע בקובץ
    voucher_id    – מספר השובר אחרי ניקוי (ספרות בלבד, בלי אפסים מובילים)
    match_key     – המפתח שלפיו מצליבים (בדרך כלל = voucher_id)
    id_number     – ת"ז (להתאמה חלופית), ספרות בלבד בלי אפסים מובילים
    package_name, category, quantity, price, final_price, start_date, supplier
"""
from __future__ import annotations

import datetime as dt
import re
from pathlib import Path

import pandas as pd
import yaml

from .categorize import categorize
from .readers import clean_header, read_any

INTERNAL_SUPPLIERS_TO_DROP = ("חמי יואב תיירות",)  # הזמנות פנימיות – לא נבדקות


# ---------- פונקציות עזר ----------
def digits(v) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return re.sub(r"\D", "", str(v))


def strip_zeros(s: str) -> str:
    return s.lstrip("0") or ("0" if s else "")


def to_number(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or str(v).strip() == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(",", "").replace("₪", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def to_date(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, (int, float)) and 20000 < v < 80000:  # מספר סידורי של אקסל
        return (dt.datetime(1899, 12, 30) + dt.timedelta(days=float(v))).date()
    m = re.search(r"(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})", str(v))
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
        try:
            return dt.date(y, mo, d)
        except ValueError:
            return None
    m = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", str(v))
    if m:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def clean_text(v) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    return re.sub(r"\s+", " ", str(v)).strip()


COLUMNS = [
    "voucher_raw", "voucher_id", "match_key", "id_number", "package_name", "category",
    "quantity", "price", "final_price", "start_date", "supplier", "order_no", "customer",
    "booked_package", "booked_category",
]


# ---------- איזי ----------
EASY_SIGNATURE = ("CouponNo", "CouponDesc", "ת. התחלה")


def is_easy(rows: list[list]) -> bool:
    return bool(rows) and all(s in [clean_header(h) for h in rows[0]] for s in EASY_SIGNATURE)


def normalize_easy(rows: list[list]) -> pd.DataFrame:
    header = [clean_header(h) for h in rows[0]]

    def idx(name, last=False):
        positions = [i for i, h in enumerate(header) if h == name]
        if not positions:
            raise ValueError(f"בדוח איזי חסרה העמודה '{name}'")
        return positions[-1] if last else positions[0]

    i_coupon = idx("CouponNo")
    i_desc = idx("CouponDesc")
    i_qty = idx("כמות")
    i_price = idx("מחיר")
    i_date = idx("ת. התחלה")
    i_sup = idx("חברת שוברים", last=True)  # העמודה השנייה = שם החברה
    i_id = idx("מזהה")
    i_order = idx("מס. הזמנה")
    i_cust = idx("שם לקוח")
    i_si = idx("SIName")

    recs = []
    for r in rows[1:]:
        if len(r) < len(header) - 1:
            continue
        get = lambda i: r[i] if i < len(r) else None
        supplier = clean_text(get(i_sup))
        if any(s in supplier for s in INTERNAL_SUPPLIERS_TO_DROP):
            continue
        qty = to_number(get(i_qty)) or 0
        price = to_number(get(i_price)) or 0
        voucher = digits(get(i_coupon))
        desc = clean_text(get(i_desc))
        booked = clean_text(get(i_si))
        recs.append({
            "voucher_raw": clean_text(get(i_coupon)),
            "voucher_id": strip_zeros(voucher),
            "voucher_digits": voucher,
            "id_number": strip_zeros(digits(get(i_id))),
            "package_name": desc,
            "category": categorize(desc),
            "quantity": qty,
            "price": price,
            "final_price": round(qty * price, 2),
            "start_date": to_date(get(i_date)),
            "supplier": supplier,
            "order_no": clean_text(get(i_order)),
            "customer": clean_text(get(i_cust)),
            "booked_package": booked,
            "booked_category": categorize(booked),
        })
    return pd.DataFrame(recs)


# ---------- ספקים ----------
def load_supplier_configs(folder: Path) -> list[dict]:
    configs = []
    for p in sorted(Path(folder).glob("*.yaml")):
        with open(p, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        cfg["_file"] = p.name
        configs.append(cfg)
    return configs


def header_index(cells: list[str], name: str):
    """מיקום עמודה: התאמה מלאה, ואם אין – עמודה שמתחילה בשם (למשל 'קוד עסקה (שובר)')."""
    name = clean_header(name)
    if name in cells:
        return cells.index(name)
    for i, c in enumerate(cells):
        if c.startswith(name):
            return i
    return None


def find_header_row(rows: list[list], required: list[str], max_scan: int = 2000):
    for i, r in enumerate(rows[:max_scan]):
        cells = [clean_header(c) for c in r]
        if all(header_index(cells, x) is not None for x in required):
            return i, cells
    return None, None


def detect_supplier(rows: list[list], configs: list[dict]):
    for cfg in configs:
        i, _ = find_header_row(rows, cfg["detect"])
        if i is not None:
            return cfg
    return None


def normalize_supplier(rows: list[list], cfg: dict) -> pd.DataFrame:
    hdr_i, header = find_header_row(rows, cfg["detect"])
    if hdr_i is None:
        raise ValueError(f"לא נמצאה שורת כותרות בדוח {cfg['name']}")
    cols = cfg["columns"]

    def col(key):
        name = cols.get(key)
        if not name:
            return None
        i = header_index(header, name)
        if i is None:
            raise ValueError(f"בדוח {cfg['name']} חסרה העמודה '{name}'")
        return i

    i_v, i_id, i_pkg = col("voucher_id"), col("id_number"), col("package_name")
    i_q, i_fp, i_unit, i_date = col("quantity"), col("final_price"), col("unit_price"), col("date")
    i_cust = col("customer")
    i_ref = col("reference")
    parts = cols.get("date_parts")
    package_map = {clean_text(k): v for k, v in (cfg.get("package_map") or {}).items()}

    recs = []
    for r in rows[hdr_i + 1:]:
        get = lambda i: (r[i] if i is not None and i < len(r) else None)
        v = digits(get(i_v))
        if not v:  # שורות סיכום / ריקות
            continue
        pkg = clean_text(get(i_pkg)) if i_pkg is not None else ""
        qty = to_number(get(i_q)) if i_q is not None else None
        fp = to_number(get(i_fp)) if i_fp is not None else None
        if fp is None and i_unit is not None and qty is not None:
            u = to_number(get(i_unit))
            fp = None if u is None else u * qty
        if parts:
            hi = {k: header_index(header, n) for k, n in parts.items()}
            try:
                date = dt.date(int(to_number(r[hi["year"]])), int(to_number(r[hi["month"]])),
                               int(to_number(r[hi["day"]])))
            except Exception:
                date = None
        else:
            date = to_date(get(i_date))
        recs.append({
            "voucher_raw": clean_text(get(i_v)),
            "voucher_id": strip_zeros(v),
            "match_key": strip_zeros(v),
            "id_number": strip_zeros(digits(get(i_id))) if i_id is not None else "",
            "package_name": pkg,
            "category": package_map.get(pkg) or (categorize(pkg) if pkg else None),
            "quantity": qty,
            "final_price": fp,
            "start_date": date,
            "supplier": cfg["name"],
            "customer": clean_text(get(i_cust)) if i_cust is not None else "",
            "reference": clean_text(get(i_ref)) if i_ref is not None else "",
        })
    return pd.DataFrame(recs)


def easy_match_key(easy_row, cfg: dict) -> str:
    """איך הופכים את מספר השובר באיזי למפתח שמופיע בדוח הספק."""
    v = easy_row["voucher_digits"]
    rule = cfg.get("easy_key", "coupon")
    if rule == "coupon_drop_first_digit":
        v = v[1:]
    return strip_zeros(v)


def unpack(raw: bytes, filename: str, secrets: dict):
    """קובץ zip (גם מוגן סיסמה) -> רשימת (שם, תוכן) של הקבצים שבתוכו. קובץ רגיל -> הוא עצמו."""
    if not filename.lower().endswith(".zip"):
        return [(filename, raw)]
    import io
    try:
        import pyzipper
        zf = pyzipper.AESZipFile(io.BytesIO(raw))
    except ImportError:
        import zipfile
        zf = zipfile.ZipFile(io.BytesIO(raw))
    passwords = [None] + [str(v).encode() for v in secrets.values() if v]
    out = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        for pw in passwords:
            try:
                out.append((info.filename, zf.read(info, pwd=pw)))
                break
            except Exception:
                continue
        else:
            raise ValueError(f"לא הצלחתי לפתוח את '{info.filename}' שבתוך הזיפ – בדקו את הסיסמה בהגדרות.")
    return out


# ---------- איזי – דוח מודפס שהועתק מהמסך ----------
EASY_PRINT_HEADER = "מס. הזמנה/חשבונית מס"
_MONEY = re.compile(r"^-?\d[\d,]*\.\d{2}$")
_ORDER = re.compile(r"^\d{4,8}$")
_DATE = re.compile(r"^\d{1,2}/\d{1,2}/\d{4}( \d{1,2}:\d{2}(:\d{2})?)?$")
_HEADER_CELLS = {"מס. הזמנה/חשבונית מס", "ת. הגעה", "כמות", "מס. שובר", "התקבל", "חשבונית מס", "ערך ₪"}


def is_easy_print(text: str) -> bool:
    return EASY_PRINT_HEADER in text and "ת. הגעה" in text


def normalize_easy_print(text: str) -> pd.DataFrame:
    """דוח איזי מקובץ לפי חברת שוברים וחבילה (כל תא בשורה משלו, או מופרד בטאב).
    מבנה רשומה: מס. הזמנה, ת. הגעה, כמות, מס. שובר, [התקבל/חשבונית], ערך ₪ (סה"כ)."""
    cells = [c.strip() for line in text.replace("\r", "").split("\n") for c in line.split("\t")]
    has_letters = lambda c: bool(re.search(r"[A-Za-z\u0590-\u05FF]", c))
    recs, buf = [], []
    supplier = package = ""
    i, n = 0, len(cells)
    while i < n:
        c = cells[i]
        if c == EASY_PRINT_HEADER:
            if buf:
                package = buf[-1]
                if len(buf) >= 2:
                    supplier = buf[-2]
            buf = []
            i += 1
            continue
        if c in _HEADER_CELLS or c in ("", "..."):
            i += 1
            continue
        if c.startswith("סהכ"):  # שורת סיכום – מדלגים עד הסכום
            i += 1
            while i < n and not _MONEY.match(cells[i].replace("₪", "").strip()):
                i += 1
            i += 1
            buf = []
            continue
        if _ORDER.match(c) and i + 1 < n and _DATE.match(cells[i + 1]):
            order, date = c, cells[i + 1]
            j = i + 2
            while j < n and cells[j] == "":
                j += 1
            qty = to_number(cells[j]) if j < n else None
            j += 1
            while j < n and cells[j] == "":
                j += 1
            voucher = cells[j] if j < n else ""
            j += 1
            value = None
            while j < n and j <= i + 12:
                v = cells[j].replace("₪", "").strip()
                if _MONEY.match(v):
                    value = to_number(v)
                    break
                j += 1
            i = j + 1
            if any(s in supplier for s in INTERNAL_SUPPLIERS_TO_DROP):
                continue
            qty = qty or 0
            recs.append({
                "voucher_raw": voucher, "voucher_id": strip_zeros(digits(voucher)),
                "voucher_digits": digits(voucher), "id_number": "",
                "package_name": package, "category": categorize(package),
                "quantity": qty, "price": round(value / qty, 2) if (value is not None and qty) else 0,
                "final_price": value or 0, "start_date": to_date(date), "supplier": supplier,
                "order_no": order, "customer": "", "booked_package": "", "booked_category": "לא מסווגת",
            })
            buf = []
            continue
        if has_letters(c):
            buf.append(c)
        i += 1
    return pd.DataFrame(recs)


def rows_from_paste(text: str) -> list[list[str]]:
    """טבלה שהועתקה מדף אינטרנט: עמודות מופרדות בטאב, שורה לכל רשומה."""
    rows = []
    for line in text.replace("\r", "").split("\n"):
        if not line.strip():
            continue
        rows.append([c.strip() for c in line.split("\t")])
    return rows


def load_rows(rows: list[list], configs: list[dict]):
    if is_easy(rows):
        return "easy", None, normalize_easy(rows)
    cfg = detect_supplier(rows, configs)
    if cfg is None:
        raise ValueError("לא זוהה לאיזה ספק שייכת הטבלה. ודאו שהעתקתם גם את שורת הכותרות.")
    return "supplier", cfg, normalize_supplier(rows, cfg)


def load_file(raw: bytes, filename: str, configs: list[dict], secrets: dict):
    """מחזיר (סוג, הגדרות ספק או None, טבלה אחידה)."""
    # קודם מנסים בלי סיסמה; אם צריך – לפי הספק
    try:
        rows = read_any(raw, filename)
    except ValueError:
        rows = None
        for cfg in configs:
            pw_key = cfg.get("password_setting")
            if pw_key and secrets.get(pw_key):
                try:
                    rows = read_any(raw, filename, secrets[pw_key])
                    break
                except Exception:
                    continue
        if rows is None:
            raise
    if is_easy(rows):
        return "easy", None, normalize_easy(rows)
    cfg = detect_supplier(rows, configs)
    if cfg is None:
        raise ValueError("לא זוהה לאיזה ספק שייך הקובץ (אין קובץ הגדרות שמתאים לעמודות שלו).")
    return "supplier", cfg, normalize_supplier(rows, cfg)
