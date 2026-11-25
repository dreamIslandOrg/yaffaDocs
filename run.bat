@echo off
REM לחיצה כפולה על הקובץ הזה בווינדוס מפעילה את מסך ההצלבה
cd /d "%~dp0"
if not exist .venv (
  echo First install - takes a minute or two...
  py -m venv .venv
  .venv\Scripts\pip install -q -r requirements.txt
)
.venv\Scripts\streamlit run app.py --server.address 0.0.0.0
