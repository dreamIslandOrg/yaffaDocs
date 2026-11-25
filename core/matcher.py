"""לוגיקת ההצלבה.

עיקרון: ההצלבה היא לפי מספר שובר בלבד, מול כל השורות באיזי – בלי תלות בשם חברת השוברים.
שם חברת השוברים באיזי משמש רק כדי לשבץ שורות שלא נמצאו בגיליון של הספק המתאים.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import pandas as pd

from .categorize import UNKNOWN
from .normalize import easy_match_key

PRICE_TOLERANCE = 1.0  # ש"ח – בגלל עיגולים


@dataclass
class SupplierResult:
    name: str
    verified: pd.DataFrame = field(default_factory=pd.DataFrame)
    mismatches: pd.DataFrame = field(default_factory=pd.DataFrame)
    not_arrived: pd.DataFrame = field(default_factory=pd.DataFrame)
    missing_in_easy: pd.DataFrame = field(default_factory=pd.DataFrame)
    missing_in_supplier: pd.DataFrame = field(default_factory=pd.DataFrame)
    exceptions: pd.DataFrame = field(default_factory=pd.DataFrame)
    alerts: list = field(default_factory=list)
    has_price: bool = True

    def verified_summary(self) -> pd.DataFrame:
        if self.verified.empty:
            return pd.DataFrame(columns=["סוג חבילה", "מספר חבילות", "כמות", "מחיר סופי", "מספרי שובר"])
        g = self.verified.groupby("סוג חבילה", sort=True)
        return pd.DataFrame({
            "מספר חבילות": g.size(),
            "כמות": g["כמות"].sum(),
            "מחיר סופי": g["מחיר באיזי"].sum(),
            "מספרי שובר": g["מספר שובר"].apply(lambda s: ", ".join(map(str, s))),
        }).reset_index()


def _fmt(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _easy_view(r) -> dict:
    return {
        "מספר שובר": r["voucher_raw"], "מס. הזמנה": r["order_no"], "לקוח": r["customer"],
        "חבילה באיזי": r["package_name"], "סוג חבילה": r["category"],
        "כמות": _fmt(r["quantity"]), "מחיר ליחידה": _fmt(r["price"]),
        "מחיר × כמות": _fmt(r["final_price"]), "ת. התחלה": r["start_date"],
        "חברת שוברים": r["supplier"],
    }


def _sup_view(r) -> dict:
    return {
        "מספר שובר אצל הספק": r["voucher_raw"], "ת\"ז אצל הספק": r.get("id_number", ""),
        "לקוח": r.get("customer", ""), "חבילה אצל הספק": r.get("package_name", ""),
        "סוג חבילה": r.get("category"), "כמות": _fmt(r.get("quantity")),
        "מחיר סופי": _fmt(r.get("final_price")), "תאריך": r.get("start_date"),
        "אסמכתא": r.get("reference", ""),
    }


def _aggregate(df: pd.DataFrame) -> pd.DataFrame:
    """מאחד שורות עם אותו מפתח לשורה אחת: כמויות ומחירים נסכמים, סוגי חבילה מצורפים."""
    if df.empty:
        return df
    join = lambda s: ", ".join(dict.fromkeys(str(x) for x in s if x not in (None, "")))
    out = []
    for _, g in df.groupby("match_key", sort=False):
        r = g.iloc[0].to_dict()
        r["voucher_raw"] = join(g["voucher_raw"])
        r["package_name"] = " | ".join(dict.fromkeys(str(x) for x in g["package_name"]))
        r["category"] = " / ".join(sorted(set(str(x) for x in g["category"] if x is not None))) or None
        r["quantity"] = g["quantity"].fillna(0).sum() if g["quantity"].notna().any() else None
        if "final_price" in g:
            r["final_price"] = g["final_price"].sum() if g["final_price"].notna().any() else None
        for c in ("order_no", "reference", "supplier"):
            if c in g:
                r[c] = join(g[c])
        if "_idxs" in g:
            r["_idxs"] = [i for lst in g["_idxs"] for i in lst]
        out.append(r)
    return pd.DataFrame(out)


def _pair_groups(easy, sup, e_key, s_key, method, pairs, exceptions):
    """מצליב לפי מפתח. מפתח שמופיע אותו מספר פעמים בשני הצדדים – מתאימים זוגות.
    מספר שונה של שורות – חריגה, בלי לנחש. מחזיר את מה שנשאר לא מותאם."""
    if easy.empty or sup.empty or e_key not in easy or s_key not in sup:
        return easy, sup
    e = easy[easy[e_key] != ""]
    s = sup[sup[s_key] != ""]
    common = set(e[e_key]) & set(s[s_key])
    used_e, used_s = [], []
    for k in sorted(common):
        ge = e[e[e_key] == k].sort_values(["category", "final_price"], na_position="last")
        gs = s[s[s_key] == k].sort_values(["category", "final_price"], na_position="last")
        used_e += list(ge.index)
        used_s += list(gs.index)
        if len(ge) == len(gs):
            for (_, er), (_, sr) in zip(ge.iterrows(), gs.iterrows()):
                pairs.append((er, sr, method))
        else:
            reason = (f"לפי {method}: {len(ge)} שורות באיזי מול {len(gs)} שורות אצל הספק "
                      f"– לא ניתן לשייך בוודאות")
            for _, er in ge.iterrows():
                exceptions.append(("easy", er, reason))
            for _, sr in gs.iterrows():
                exceptions.append(("sup", sr, reason))
    return easy.drop(index=used_e), sup.drop(index=used_s)


def _match_one_supplier(cfg, sup_df, pool):
    """מצליב דוח ספק אחד מול כל השורות באיזי שעוד לא הותאמו.
    מחזיר: תוצאה, רשימת אינדקסים של שורות איזי שנוצלו, שורות ספק שלא נמצאו."""
    res = SupplierResult(name=cfg["name"], has_price=cfg.get("has_price", True))
    pool = pool.copy()
    pool["match_key"] = pool.apply(lambda r: easy_match_key(r, cfg), axis=1) if not pool.empty else []
    pool["_idxs"] = pd.Series([[i] for i in pool.index], index=pool.index, dtype=object)

    e_in, s_in = pool, sup_df
    if cfg.get("aggregate_by_key"):
        e_in, s_in = _aggregate(pool), _aggregate(sup_df)

    pairs, exc = [], []
    e_left, s_left = _pair_groups(e_in, s_in, "match_key", "match_key", "מספר שובר", pairs, exc)
    if cfg.get("id_fallback"):
        e_left, s_left = _pair_groups(e_left, s_left, "voucher_id", "id_number",
                                      'ת"ז (מספר שובר באיזי)', pairs, exc)
        e_left, s_left = _pair_groups(e_left, s_left, "id_number", "id_number", 'ת"ז (מזהה באיזי)', pairs, exc)
        e_left, s_left = _pair_groups(e_left, s_left, "id_number", "match_key", 'ת"ז (מזהה באיזי)', pairs, exc)

    used = []
    verified, mismatches = [], []
    for er, sr, method in pairs:
        used += er["_idxs"]
        problems = []
        if sr.get("category") is not None and sr["category"] != er["category"]:
            problems.append(("סוג חבילה", f'{sr["category"]} ({sr["package_name"]})',
                             f'{er["category"]} ({er["package_name"]})'))
        if sr.get("quantity") is not None and abs((sr["quantity"] or 0) - (er["quantity"] or 0)) > 0.001:
            problems.append(("כמות", _fmt(sr["quantity"]), _fmt(er["quantity"])))
        if res.has_price and sr.get("final_price") is not None and \
                abs(sr["final_price"] - er["final_price"]) > PRICE_TOLERANCE:
            problems.append(("מחיר", _fmt(sr["final_price"]),
                             f'{_fmt(er["final_price"])} ({_fmt(er["price"])} × {_fmt(er["quantity"])})'))
        base = {"ספק": cfg["name"], "חבילה": er["package_name"], "מספר שובר": er["voucher_raw"],
                "מספר שובר אצל הספק": sr["voucher_raw"], "מס. הזמנה": er["order_no"],
                "לקוח": er["customer"], "חברת שוברים באיזי": er["supplier"], "הותאם לפי": method}
        if problems:
            for f, sv, ev in problems:
                mismatches.append({**base, "שדה שלא תאם": f, "ערך אצל הספק": sv, "ערך באיזי": ev})
        else:
            verified.append({**base, "סוג חבילה": er["category"], "כמות": _fmt(er["quantity"]),
                             "מחיר באיזי": er["final_price"],
                             "מחיר אצל הספק": _fmt(sr.get("final_price"))})

    exceptions = []
    for side, r, reason in exc:
        if side == "easy":
            used += r["_idxs"]
            exceptions.append({"מקור": "איזי", **_easy_view(r), "סיבה": reason})
        else:
            exceptions.append({"מקור": "ספק", **_sup_view(r), "סיבה": reason})

    res.verified = pd.DataFrame(verified)
    res.mismatches = pd.DataFrame(mismatches)
    res.exceptions = pd.DataFrame(exceptions)
    return res, used, s_left


def _owner(supplier_name: str, configs_used: list[dict]):
    for cfg in configs_used:
        if any(n in supplier_name for n in cfg.get("easy_suppliers", [])):
            return cfg["name"]
    return None


def reconcile(easy_df: pd.DataFrame, suppliers: list[tuple[dict, pd.DataFrame]], day, all_configs=None):
    easy = easy_df.reset_index(drop=True)
    arrived = easy[easy["start_date"] == day]
    remaining = arrived
    results, leftovers = [], []
    matched_by = {}  # אינדקס שורה באיזי -> שם הספק שאליו הותאמה

    for cfg, sup_df in suppliers:
        res, used, s_left = _match_one_supplier(cfg, sup_df, remaining)
        remaining = remaining.drop(index=[i for i in used if i in remaining.index])
        for i in used:
            matched_by[i] = cfg["name"]
        results.append(res)
        leftovers.append(s_left)

    by_name = {r.name: r for r in results}
    cfgs = [c for c, _ in suppliers]

    # שוברים אצל הספק שלא נמצאו באיזי
    for res, s_left in zip(results, leftovers):
        res.missing_in_easy = pd.DataFrame([_sup_view(r) for _, r in s_left.iterrows()])

    # שורות באיזי שלא נמצאו אצל אף ספק – לגיליון של הספק לפי שם החברה, אחרת "לא נבדקו"
    missing = {r.name: [] for r in results}
    not_checked = []
    for _, r in remaining.iterrows():
        owner = _owner(r["supplier"], cfgs)
        (missing[owner] if owner else not_checked).append(r)
    for name, rows in missing.items():
        df = pd.DataFrame([_easy_view(r) for r in rows])
        if not df.empty:
            df["הערה"] = "לא נמצא בדוח של אף ספק"
        by_name[name].missing_in_supplier = df

    # לא הגיעו – לפי שם החברה
    na = {r.name: [] for r in results}
    for _, r in easy[easy["start_date"] != day].iterrows():
        owner = _owner(r["supplier"], cfgs)
        if owner:
            na[owner].append(_easy_view(r))
    for name, rows in na.items():
        by_name[name].not_arrived = pd.DataFrame(rows)

    # התרעות על שורות איזי (בגיליון של הספק שאליו הותאמו או ששייכות אליו לפי שם)
    for i, r in arrived.iterrows():
        owner = matched_by.get(i) or _owner(r["supplier"], cfgs)
        if not owner:
            continue
        res = by_name[owner]
        if r["category"] == UNKNOWN:
            res.alerts.append(f'חבילה לא מסווגת באיזי: "{r["package_name"]}" (שובר {r["voucher_raw"]})')
        elif r["booked_category"] != UNKNOWN and r["booked_category"] != r["category"]:
            res.alerts.append(
                f'שובר {r["voucher_raw"]} (הזמנה {r["order_no"]}, {r["customer"]}): השובר הוא '
                f'"{r["category"]}" אבל בהזמנה באיזי רשומה חבילה "{r["booked_package"]}"')
    for cfg, sup_df in suppliers:
        if not sup_df.empty and "category" in sup_df:
            for _, r in sup_df[sup_df["category"] == UNKNOWN].iterrows():
                by_name[cfg["name"]].alerts.append(
                    f'חבילה לא מסווגת אצל הספק: "{r["package_name"]}" (שובר {r["voucher_raw"]})')
    for sup_name, g in arrived.groupby("supplier"):
        owner = _owner(sup_name, cfgs)
        if not owner:
            continue
        for desc, gg in g.groupby("package_name"):
            prices = sorted(set(gg["price"]))
            if len(prices) > 1:
                by_name[owner].alerts.append(
                    f'אותה חבילה במחירים שונים באיזי: "{desc}" – {", ".join(str(_fmt(p)) for p in prices)}')

    return results, pd.DataFrame(not_checked)
