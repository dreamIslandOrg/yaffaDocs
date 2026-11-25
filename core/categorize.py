"""סיווג שם חבילה לסוג חבילה (לפי "הנחיות לדוח איזי")."""
from __future__ import annotations

import re

DELUXE = "דלאקס (צהרים + טיפול)"
CLASSIC_DINNER = "קלאסיק + ערב"
CLASSIC_LUNCH = "קלאסיק + צהרים"
UNKNOWN = "לא מסווגת"


def categorize(name: str | None) -> str:
    if not name:
        return UNKNOWN
    low = re.sub(r"\s+", " ", str(name)).lower()
    nospace = low.replace(" ", "")
    if any(k in low for k in ("deluxe", "דלאקס", "דלקס", "שקיעה")):
        return DELUXE
    is_classic = "classic" in low or "קלאסיק" in low
    if "classic&dinner" in nospace or (is_classic and ("dinner" in low or "night" in low or "ערב" in low)):
        return CLASSIC_DINNER
    if "classic&more" in nospace or (is_classic and ("צהרים" in low or "lunch" in low)):
        return CLASSIC_LUNCH
    return UNKNOWN
