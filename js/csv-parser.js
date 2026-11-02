/*
 * csv-parser.js – קריאת קובץ CSV בצורה סלחנית
 * ------------------------------------------------
 * למה לא קורא CSV רגיל? כי בדוח איזי יש שמות כמו  "חמי יואב תיירות בע"מ"
 * שבהם הגרשיים של בע"מ לא מסומנים כמו שצריך, וקורא רגיל משבש אותם.
 * הכלל כאן: גרש (") בתוך שדה סוגר את השדה רק אם אחריו בא פסיק או סוף שורה.
 * אחרת הוא נשמר כחלק מהטקסט.
 */
(function (global) {
  'use strict';

  function parseCsvTolerant(text) {
    // הסרת סימן BOM מתחילת הקובץ, אם יש
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;

    while (i < n) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          const next = text[i + 1];
          if (next === '"') { field += '"'; i += 2; continue; }            // "" = גרש אמיתי
          if (next === undefined || next === ',' || next === '\r' || next === '\n') {
            inQuotes = false; i++; continue;                                   // סוף השדה
          }
          field += '"'; i++; continue;                                         // גרש בתוך טקסט (בע"מ)
        }
        field += ch; i++; continue;
      }

      if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

    // השמטת שורות ריקות לגמרי (למשל שורה ריקה בסוף הקובץ)
    return rows.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });
  }

  global.CsvParser = { parseCsvTolerant: parseCsvTolerant };
})(typeof globalThis !== 'undefined' ? globalThis : this);
