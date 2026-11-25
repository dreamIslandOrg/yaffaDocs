"""מסך ההצלבה – מריצים עם:  streamlit run app.py"""
from __future__ import annotations

import datetime as dt
from collections import Counter
from pathlib import Path

import pandas as pd
import streamlit as st
import yaml

from core.matcher import reconcile
from core.normalize import is_easy_print, load_file, load_rows, normalize_easy_print, load_supplier_configs, rows_from_paste, unpack
from core.report import build_excel

BASE = Path(__file__).parent
st.set_page_config(page_title="הצלבת שוברים – דרים איילנד", layout="wide")
st.markdown("""
<style>
  html, body, [class*="css"], .stApp, .stMarkdown, .stDataFrame, label, p, h1, h2, h3, h4 {
    direction: rtl; text-align: right; }
  [data-testid="stSidebar"] { direction: rtl; }
  [data-testid="stMetricValue"] { direction: ltr; text-align: right; }
</style>""", unsafe_allow_html=True)


def load_secrets() -> dict:
    out = {}
    try:  # סודות שהוגדרו באתר האירוח (Streamlit Cloud -> Settings -> Secrets)
        out.update({k: v for k, v in st.secrets.items() if isinstance(v, (str, int, float))})
    except Exception:
        pass
    p = BASE / "config" / "secrets.yaml"
    if p.exists():
        with open(p, encoding="utf-8") as f:
            out.update(yaml.safe_load(f) or {})
    return out


def password_gate(secrets: dict):
    """אם הוגדרה סיסמת כניסה (app_password) – מבקשים אותה לפני שמציגים משהו."""
    import hmac
    expected = str(secrets.get("app_password", "") or "")
    if not expected or st.session_state.get("auth_ok"):
        return
    st.title("הצלבת שוברים – כניסה")
    pw = st.text_input("סיסמה", type="password")
    if st.button("כניסה", type="primary"):
        if hmac.compare_digest(pw, expected):
            st.session_state["auth_ok"] = True
            st.rerun()
        else:
            st.error("סיסמה שגויה")
    st.stop()


configs = load_supplier_configs(BASE / "suppliers")
secrets = load_secrets()
password_gate(secrets)

with st.sidebar:
    st.header("⚙️ הגדרות")
    pw = st.text_input("סיסמת קובץ האקסל/זיפ של אתר חבר", value=secrets.get("chaver_excel_password", ""),
                       type="password")
    if st.button("שמירה"):
        secrets["chaver_excel_password"] = pw
        (BASE / "config").mkdir(exist_ok=True)
        with open(BASE / "config" / "secrets.yaml", "w", encoding="utf-8") as f:
            yaml.safe_dump(secrets, f, allow_unicode=True)
        st.success("נשמר במחשב הזה בלבד")

st.title("הצלבת שוברים מול איזי גו")
st.caption("גרסה 7")
st.caption("מעלים את דוח איזי ואת דוחות הספקים (כמה שרוצים בבת אחת), בוחרים תאריך ולוחצים 'הצלב'.")

files = st.file_uploader("קבצים (CSV / אקסל)", accept_multiple_files=True,
                         type=["csv", "xlsx", "xls", "xlsm", "zip"])

easy_df, suppliers, problems = None, [], []
uploaded = []
for f in files or []:
    try:
        uploaded += unpack(f.getvalue(), f.name, secrets)
    except Exception as e:  # noqa: BLE001
        st.error(f"✖ {f.name}: {e}")

with st.expander("📋 הדבקת טבלה מאתר (כשאין קובץ להורדה)"):
    st.caption("באתר: מסמנים את כל הטבלה כולל שורת הכותרות (מהכותרת הראשונה עד השורה האחרונה), "
               "Cmd+C (בווינדוס Ctrl+C), ומדביקים כאן. אפשר להדביק כמה טבלאות – כל אחת בתיבה משלה.")
    pastes = [st.text_area(f"טבלה {i + 1}", height=120, key=f"paste{i}") for i in range(3)]

sources = [(n, r, None) for n, r in uploaded] + \
          [(f"טבלה מודבקת {i + 1}", None, t) for i, t in enumerate(pastes) if t.strip()]

for fname, raw, pasted in sources:
    try:
        if pasted is not None and is_easy_print(pasted):
            kind, cfg, df = "easy", None, normalize_easy_print(pasted)
        elif pasted is not None:
            kind, cfg, df = load_rows(rows_from_paste(pasted), configs)
        else:
            kind, cfg, df = load_file(raw, fname, configs, secrets)
        if kind == "easy":
            easy_df = df if easy_df is None else pd.concat([easy_df, df], ignore_index=True)
            st.success(f"✔ {fname} – דוח איזי ({len(df)} שורות, בלי הזמנות פנימיות)")
        else:
            existing = [i for i, (c, _) in enumerate(suppliers) if c["name"] == cfg["name"]]
            if existing:
                i = existing[0]
                suppliers[i] = (cfg, pd.concat([suppliers[i][1], df], ignore_index=True))
            else:
                suppliers.append((cfg, df))
            st.success(f"✔ {fname} – {cfg['name']} ({len(df)} שורות)")
    except Exception as e:  # noqa: BLE001
        problems.append(fname)
        st.error(f"✖ {fname}: {e}")

default_day = dt.date.today()
if easy_df is not None and not easy_df.empty:
    common = Counter(d for d in easy_df["start_date"] if d).most_common(1)
    if common:
        default_day = common[0][0]
day = st.date_input("תאריך הגעה", value=default_day, format="DD/MM/YYYY")

if st.button("הצלב", type="primary", disabled=easy_df is None or not suppliers):
    results, not_checked = reconcile(easy_df, suppliers, day, configs)
    st.session_state["out"] = (results, not_checked, day)

if easy_df is None and files:
    st.warning("לא הועלה דוח איזי.")

if "out" in st.session_state:
    results, not_checked, day = st.session_state["out"]
    st.download_button("⬇ הורדת הדוח לאקסל", build_excel(results, not_checked, day),
                       file_name=f"הצלבה_{day:%Y-%m-%d}.xlsx",
                       mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    tabs = st.tabs([r.name for r in results] + ["לא נבדקו"])
    for tab, r in zip(tabs, results):
        with tab:
            c = st.columns(5)
            c[0].metric("אומתו", len(r.verified))
            c[1].metric("אי-התאמות", r.mismatches["מספר שובר"].nunique() if not r.mismatches.empty else 0)
            c[2].metric("חסרים", len(r.missing_in_easy) + len(r.missing_in_supplier))
            c[3].metric("לא הגיעו", len(r.not_arrived))
            c[4].metric("חריגות", len(r.exceptions))

            st.subheader("✅ אומתו")
            summ = r.verified_summary()
            if summ.empty:
                st.write("לא אומתו שוברים.")
            for _, s in summ.iterrows():
                st.markdown(f"- אומתו **{s['מספר חבילות']}** חבילות **{s['סוג חבילה']}** "
                            f"(כמות {s['כמות']:g}, סה\"כ {s['מחיר סופי']:,.0f} ₪)")
            with st.expander("פירוט השוברים שאומתו"):
                st.dataframe(r.verified, hide_index=True, use_container_width=True)

            sections = [
                ("❌ אי-התאמות", r.mismatches),
                ("🔎 קיים אצל הספק – חסר באיזי", r.missing_in_easy),
                ("🔎 קיים באיזי – לא נמצא בדוח הספק", r.missing_in_supplier),
                ("⚠️ חריגות (לא ניתן לשייך בוודאות)", r.exceptions),
                ("🕓 לא הגיעו (תאריך התחלה שונה)", r.not_arrived),
            ]
            for title, df in sections:
                st.subheader(f"{title} ({len(df)})")
                if df.empty:
                    st.write("אין")
                else:
                    st.dataframe(df, hide_index=True, use_container_width=True)
            if r.alerts:
                st.subheader(f"🔔 התרעות ({len(r.alerts)})")
                for a in r.alerts:
                    st.markdown(f"- {a}")
    with tabs[-1]:
        st.write("שורות באיזי (בתאריך שנבחר) של ספקים שלא הועלה להם דוח:")
        if not_checked.empty:
            st.write("אין")
        else:
            nc = not_checked.groupby("supplier").size().reset_index()
            nc.columns = ["חברת שוברים", "מספר שורות"]
            st.dataframe(nc, hide_index=True)
