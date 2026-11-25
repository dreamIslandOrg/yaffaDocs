#!/bin/bash
# לחיצה כפולה על הקובץ הזה במק מפעילה את מסך ההצלבה
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "התקנה ראשונה – זה לוקח דקה-שתיים..."
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
mkdir -p ~/.streamlit; [ -f ~/.streamlit/credentials.toml ] || printf "[general]\nemail = \"\"\n" > ~/.streamlit/credentials.toml
.venv/bin/streamlit run app.py --server.address 0.0.0.0
