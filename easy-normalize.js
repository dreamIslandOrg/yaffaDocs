/*
 * easy-normalize.js – הפיכת דוח איזי לטבלה האחידה
 * -------------------------------------------------
 * מקבל: תוכן קובץ ה-CSV (טקסט) + ההגדרות מ-easy-config.js
 * מחזיר:
 *   rows       – הטבלה האחידה (שורה לכל שובר)
 *   exceptions – רשימת חריגים שנמצאו כבר בשלב הזה. לכל אחד severity:
 *                error   = חריגה, warning = התרעה, check = לבדיקה מול הספק בשלב ההצלבה
 *   excluded   – כמה שורות הוסרו מכל חברה פנימית
 *   totalRows  – כמה שורות נתונים היו בקובץ
 * הקובץ הזה לא מצליב מול ספקים – זה תפקיד של שלב ההצלבה.
 */
(function (global) {
  'use strict';

  // ---------- עזרים ----------

  // רווחים בקצוות → מוסרים, רווח כפול → רווח אחד
  function cleanSpaces(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  // להשוואת שמות חברות: מתעלמים מגרשיים ורווחים כפולים (בע"מ = בעמ)
  function companyKey(name) {
    return cleanSpaces(name).replace(/["'״׳]/g, '');
  }

  // "29/10/2026 00:00:00" → { iso: "2026-10-29", display: "29/10/2026" }
  function parseDate(value) {
    const m = cleanSpaces(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = m[3];
    const d = Number(dd), mo = Number(mm);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { iso: yyyy + '-' + mm + '-' + dd, display: dd + '/' + mm + '/' + yyyy };
  }

  function parseNumber(value) {
    const s = cleanSpaces(value).replace(/,/g, '');
    if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }

  // סימון לשובר שמופיע ביותר משורה אחת (נבדק בשלב ההצלבה)
  const FLAG_REPEATED = 'שובר חוזר – לבדיקה מול הספק';

  function round2(x) { return Math.round(x * 100) / 100; }

  // מציאת מיקום עמודה לפי שם (ואם יש כמה עמודות באותו שם – לפי מספר ההופעה)
  function findColumn(header, spec) {
    const occurrence = spec.occurrence || 1;
    let seen = 0;
    for (let i = 0; i < header.length; i++) {
      if (header[i] === spec.name) {
        seen++;
        if (seen === occurrence) return i;
      }
    }
    return -1;
  }

  function buildClassifier(categories) {
    const compiled = categories.map(function (cat) {
      return {
        name: cat.name,
        options: cat.options.map(function (opt) {
          return opt.map(function (p) { return new RegExp(p, 'i'); });
        })
      };
    });
    return function classify(text) {
      for (const cat of compiled) {
        for (const opt of cat.options) {
          if (opt.every(function (re) { return re.test(text); })) return cat.name;
        }
      }
      return null;
    };
  }

  // ---------- הפונקציה הראשית ----------

  function normalizeEasy(csvText, config) {
    const table = global.CsvParser.parseCsvTolerant(csvText);
    if (table.length < 2) throw new Error('הקובץ ריק או שאין בו שורות נתונים.');

    const header = table[0].map(cleanSpaces);

    // איתור העמודות
    const idx = {};
    const missing = [];
    Object.keys(config.columns).forEach(function (key) {
      const spec = config.columns[key];
      idx[key] = findColumn(header, spec);
      if (idx[key] === -1) missing.push(spec.name + (spec.occurrence ? ' (הופעה ' + spec.occurrence + ')' : ''));
    });
    if (missing.length) {
      throw new Error('בקובץ חסרות העמודות: ' + missing.join(', ') + '. האם זה באמת דוח איזי?');
    }

    const excludedKeys = config.excludedCompanies.map(companyKey);
    const classify = buildClassifier(config.categories);

    const rows = [];
    const exceptions = [];
    const excluded = {};

    for (let r = 1; r < table.length; r++) {
      const cells = table[r];
      const rowNumber = r + 1; // מספר השורה בקובץ (שורת הכותרות = 1)

      if (cells.length !== header.length) {
        exceptions.push({ type: 'שורה לא תקינה', severity: 'error', rowNumbers: [rowNumber], supplier: '', voucher_id: '', package_name: '',
          details: 'בשורה ' + cells.length + ' עמודות במקום ' + header.length });
        continue;
      }

      const supplier = cleanSpaces(cells[idx.supplier]);

      // סינון חברות פנימיות
      if (excludedKeys.indexOf(companyKey(supplier)) !== -1) {
        excluded[supplier] = (excluded[supplier] || 0) + 1;
        continue;
      }

      const voucherRaw = String(cells[idx.voucher]);
      const voucherId = voucherRaw.replace(/\D/g, ''); // ספרות בלבד
      const packageName = cleanSpaces(cells[idx.package]);
      const quantity = parseNumber(cells[idx.quantity]);
      const price = parseNumber(cells[idx.price]);
      const date = parseDate(cells[idx.startDate]);

      const problems = [];
      if (voucherId === '') problems.push('אין מספר שובר');
      if (quantity === null || !Number.isInteger(quantity)) problems.push('כמות לא תקינה: "' + cells[idx.quantity] + '"');
      if (price === null) problems.push('מחיר לא תקין: "' + cells[idx.price] + '"');
      if (date === null) problems.push('תאריך לא תקין: "' + cells[idx.startDate] + '"');
      if (problems.length) {
        exceptions.push({ type: 'שורה לא תקינה', severity: 'error', rowNumbers: [rowNumber], supplier: supplier,
          voucher_id: voucherId || voucherRaw, package_name: packageName, details: problems.join('; ') });
        continue;
      }

      rows.push({
        voucher_id: voucherId,
        voucher_raw: voucherRaw,
        voucher_cleaned: voucherRaw !== voucherId,
        package_name: packageName,
        category: classify(packageName),
        quantity: quantity,
        price: price,
        final_price: round2(price * quantity),
        start_date: date.iso,
        start_date_display: date.display,
        supplier: supplier,
        id_number: cleanSpaces(cells[idx.idNumber]),
        rowNumber: rowNumber,
        flags: []
      });
    }

    // --- חריג: חבילה לא מסווגת ---
    rows.forEach(function (row) {
      if (!row.category) {
        row.flags.push('חבילה לא מסווגת');
        exceptions.push({ type: 'חבילה לא מסווגת', severity: 'error', rowNumbers: [row.rowNumber], supplier: row.supplier,
          voucher_id: row.voucher_id, package_name: row.package_name,
          details: 'שם החבילה לא מתאים לאף כלל סיווג' });
      }
    });

    // --- לבדיקה מול הספק: אותו מספר שובר ביותר משורה אחת ---
    // זו לא חריגה סופית. בשלב ההצלבה בודקים אם אצל הספק יש שובר נפרד לכל שורה
    // (עם אותה חבילה). אם כן – תקין. אם לא – כל השורות הופכות לחריגה.
    const byVoucher = {};
    rows.forEach(function (row) { (byVoucher[row.voucher_id] = byVoucher[row.voucher_id] || []).push(row); });
    Object.keys(byVoucher).forEach(function (v) {
      const group = byVoucher[v];
      if (group.length < 2) return;
      group.forEach(function (row) { row.flags.push(FLAG_REPEATED); });
      exceptions.push({ type: FLAG_REPEATED, severity: 'check', rowNumbers: group.map(function (x) { return x.rowNumber; }),
        supplier: unique(group.map(function (x) { return x.supplier; })).join(' / '),
        voucher_id: v,
        package_name: unique(group.map(function (x) { return x.package_name; })).join(' / '),
        details: 'מופיע ב-' + group.length + ' שורות: ' + group.map(function (x) { return x.package_name + ' (' + x.price + ' ₪)'; }).join(', ') +
          '. ייבדק מול דוח הספק.' });
    });

    // --- התרעה: אותו שם חבילה במחירים שונים אצל אותו ספק ---
    const byPackage = {};
    rows.forEach(function (row) {
      const key = row.supplier + '|||' + row.package_name;
      (byPackage[key] = byPackage[key] || []).push(row);
    });
    Object.keys(byPackage).forEach(function (key) {
      const group = byPackage[key];
      const prices = unique(group.map(function (x) { return x.price; })).sort(function (a, b) { return a - b; });
      if (prices.length < 2) return;
      group.forEach(function (row) { row.flags.push('מחיר שונה לאותה חבילה'); });
      exceptions.push({ type: 'מחיר שונה לאותה חבילה', severity: 'warning', rowNumbers: group.map(function (x) { return x.rowNumber; }),
        supplier: group[0].supplier, voucher_id: unique(group.map(function (x) { return x.voucher_id; })).join(', '),
        package_name: group[0].package_name, details: 'מחירים: ' + prices.join(' ₪, ') + ' ₪' });
    });

    return { rows: rows, exceptions: exceptions, excluded: excluded, totalRows: table.length - 1 };
  }

  function unique(arr) {
    return arr.filter(function (x, i) { return arr.indexOf(x) === i; });
  }

  global.EasyNormalize = { normalizeEasy: normalizeEasy, cleanSpaces: cleanSpaces, FLAG_REPEATED: FLAG_REPEATED };
})(typeof globalThis !== 'undefined' ? globalThis : this);
