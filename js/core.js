/*
 * לוגיקת ההצלבה – רצה כולה בתוך הדפדפן. שום נתון לא נשלח לשרת.
 * חלקים: קריאת קבצים, נרמול לטבלה אחידה, סיווג חבילות, הצלבה, בניית דוח אקסל.
 * תלוי בספריות XLSX (SheetJS) ו-zip (zip.js) – נטענות מתיקיית js/vendor.
 */
(function (root) {
  "use strict";
  var XLSX = root.XLSX || (typeof require !== "undefined" ? require("./vendor/xlsx.full.min.js") : null);
  var zipLib = root.zip || (typeof require !== "undefined" ? require("./vendor/zip.min.js") : null);

  var INTERNAL_SUPPLIERS_TO_DROP = ["חמי יואב תיירות"]; // הזמנות פנימיות – לא נבדקות
  var PRICE_TOLERANCE = 1.0; // ש"ח – בגלל עיגולים

  // ---------------- סיווג חבילות ----------------
  var DELUXE = "דלאקס (צהרים + טיפול)";
  var CLASSIC_DINNER = "קלאסיק + ערב";
  var CLASSIC_LUNCH = "קלאסיק + צהרים";
  var UNKNOWN = "לא מסווגת";

  function categorize(name) {
    if (!name) return UNKNOWN;
    var low = String(name).replace(/\s+/g, " ").toLowerCase();
    var nospace = low.replace(/ /g, "");
    var has = function (k) { return low.indexOf(k) >= 0; };
    if (["deluxe", "דלאקס", "דלקס", "שקיעה"].some(has)) return DELUXE;
    var isClassic = has("classic") || has("קלאסיק");
    if (nospace.indexOf("classic&dinner") >= 0 || (isClassic && (has("dinner") || has("night") || has("ערב"))))
      return CLASSIC_DINNER;
    if (nospace.indexOf("classic&more") >= 0 || (isClassic && (has("צהרים") || has("lunch")))) return CLASSIC_LUNCH;
    return UNKNOWN;
  }

  // ---------------- עזרים ----------------
  function isEmpty(v) { return v === null || v === undefined || (typeof v === "number" && isNaN(v)); }
  function cleanText(v) { return isEmpty(v) ? "" : String(v).replace(/\s+/g, " ").trim(); }
  var cleanHeader = cleanText;
  function digits(v) {
    if (isEmpty(v)) return "";
    if (typeof v === "number" && Number.isInteger(v)) v = String(v);
    return String(v).replace(/\D/g, "");
  }
  function stripZeros(s) { if (!s) return ""; var t = s.replace(/^0+/, ""); return t || "0"; }
  function toNumber(v) {
    if (isEmpty(v)) return null;
    if (typeof v === "number") return v;
    var s = String(v).replace(/,/g, "").replace(/₪/g, "").trim();
    if (s === "") return null;
    var n = Number(s);
    return isNaN(n) ? null : n;
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(y, m, d) {
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return y + "-" + pad(m) + "-" + pad(d);
  }
  /** תאריך -> מחרוזת YYYY-MM-DD (או null) */
  function toDate(v) {
    if (isEmpty(v) || v === "") return null;
    if (v instanceof Date) return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === "number" && v > 20000 && v < 80000) { // מספר סידורי של אקסל
      var dt = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
      return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    var s = String(v);
    var m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
    if (m) {
      var y = parseInt(m[3], 10); if (y < 100) y += 2000;
      return ymd(y, parseInt(m[2], 10), parseInt(m[1], 10));
    }
    m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return ymd(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
    return null;
  }
  function fmtDate(s) { if (!s) return ""; var p = s.split("-"); return p[2] + "/" + p[1] + "/" + p[0]; }
  function fmt(v) { return isEmpty(v) ? "" : v; }

  // ---------------- קריאת קבצים ----------------
  function decodeBytes(bytes) {
    try {
      var t = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
    } catch (e) {
      return new TextDecoder("windows-1255").decode(bytes);
    }
  }
  /** פיצול שורת CSV שבה כל שדה במירכאות, גם כשבתוך שדה יש גרשיים לא תקניים (בע"מ) */
  function splitQuotedLine(line) {
    line = line.replace(/[\r\n]+$/, "");
    if (line.length >= 2 && line[0] === '"' && line[line.length - 1] === '"') return line.slice(1, -1).split('","');
    // CSV רגיל
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  function readCsvRows(bytes) {
    return decodeBytes(bytes).split(/\r?\n/).filter(function (l) { return l.trim(); }).map(splitQuotedLine);
  }
  function readExcelRows(bytes) {
    var wb;
    try { wb = XLSX.read(bytes, { type: "array" }); }
    catch (e) {
      throw new Error("לא ניתן לפתוח את קובץ האקסל. אם הוא מוגן בסיסמה – העלו את קובץ הזיפ המקורי, או העתיקו את הטבלה מהאתר והדביקו.");
    }
    var ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  }
  function readAny(bytes, filename) {
    return /\.(xlsx|xls|xlsm)$/i.test(filename) ? readExcelRows(bytes) : readCsvRows(bytes);
  }
  /** זיפ (גם מוגן סיסמה) -> [{name, bytes}] */
  async function unpack(bytes, filename, passwords) {
    if (!/\.zip$/i.test(filename)) return [{ name: filename, bytes: bytes }];
    zipLib.configure({ useWebWorkers: false });
    var reader = new zipLib.ZipReader(new zipLib.Uint8ArrayReader(bytes));
    var entries = await reader.getEntries();
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      if (en.directory) continue;
      var data = null;
      var tries = [undefined].concat((passwords || []).filter(Boolean));
      for (var j = 0; j < tries.length && !data; j++) {
        try { data = await en.getData(new zipLib.Uint8ArrayWriter(), tries[j] ? { password: tries[j] } : {}); }
        catch (e) { data = null; }
      }
      if (!data) { await reader.close(); throw new Error("לא הצלחתי לפתוח את '" + en.filename + "' שבתוך הזיפ – בדקו את הסיסמה בהגדרות."); }
      out.push({ name: en.filename, bytes: data });
    }
    await reader.close();
    return out;
  }

  // ---------------- איזי – קובץ CSV ----------------
  var EASY_SIGNATURE = ["CouponNo", "CouponDesc", "ת. התחלה"];
  function isEasy(rows) {
    if (!rows.length) return false;
    var h = rows[0].map(cleanHeader);
    return EASY_SIGNATURE.every(function (s) { return h.indexOf(s) >= 0; });
  }
  function isInternal(supplier) {
    return INTERNAL_SUPPLIERS_TO_DROP.some(function (s) { return supplier.indexOf(s) >= 0; });
  }
  function normalizeEasy(rows) {
    var header = rows[0].map(cleanHeader);
    function idx(name, last) {
      var pos = []; header.forEach(function (h, i) { if (h === name) pos.push(i); });
      if (!pos.length) throw new Error("בדוח איזי חסרה העמודה '" + name + "'");
      return last ? pos[pos.length - 1] : pos[0];
    }
    var iC = idx("CouponNo"), iD = idx("CouponDesc"), iQ = idx("כמות"), iP = idx("מחיר"), iT = idx("ת. התחלה"),
      iS = idx("חברת שוברים", true), iId = idx("מזהה"), iO = idx("מס. הזמנה"), iCu = idx("שם לקוח"), iSi = idx("SIName");
    var recs = [];
    rows.slice(1).forEach(function (r) {
      if (r.length < header.length - 1) return;
      var supplier = cleanText(r[iS]);
      if (isInternal(supplier)) return;
      var qty = toNumber(r[iQ]) || 0, price = toNumber(r[iP]) || 0, v = digits(r[iC]);
      var desc = cleanText(r[iD]), booked = cleanText(r[iSi]);
      recs.push({
        voucher_raw: cleanText(r[iC]), voucher_id: stripZeros(v), voucher_digits: v,
        id_number: stripZeros(digits(r[iId])), package_name: desc, category: categorize(desc),
        quantity: qty, price: price, final_price: Math.round(qty * price * 100) / 100,
        start_date: toDate(r[iT]), supplier: supplier, order_no: cleanText(r[iO]), customer: cleanText(r[iCu]),
        booked_package: booked, booked_category: categorize(booked),
      });
    });
    return recs;
  }

  // ---------------- איזי – דוח מודפס שהועתק מהמסך ----------------
  var EASY_PRINT_HEADER = "מס. הזמנה/חשבונית מס";
  var RE_MONEY = /^-?\d[\d,]*\.\d{2}$/, RE_ORDER = /^\d{4,8}$/, RE_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}( \d{1,2}:\d{2}(:\d{2})?)?$/;
  var HEADER_CELLS = ["מס. הזמנה/חשבונית מס", "ת. הגעה", "כמות", "מס. שובר", "התקבל", "חשבונית מס", "ערך ₪"];
  function isEasyPrint(text) { return text.indexOf(EASY_PRINT_HEADER) >= 0 && text.indexOf("ת. הגעה") >= 0; }
  function normalizeEasyPrint(text) {
    var cells = [];
    text.replace(/\r/g, "").split("\n").forEach(function (line) {
      line.split("\t").forEach(function (c) { cells.push(c.trim()); });
    });
    var hasLetters = function (c) { return /[A-Za-z֐-׿]/.test(c); };
    var money = function (c) { return RE_MONEY.test(c.replace(/₪/g, "").trim()); };
    var recs = [], buf = [], supplier = "", pkg = "", i = 0, n = cells.length;
    while (i < n) {
      var c = cells[i];
      if (c === EASY_PRINT_HEADER) {
        if (buf.length) { pkg = buf[buf.length - 1]; if (buf.length >= 2) supplier = buf[buf.length - 2]; }
        buf = []; i++; continue;
      }
      if (HEADER_CELLS.indexOf(c) >= 0 || c === "" || c === "...") { i++; continue; }
      if (c.indexOf("סהכ") === 0) { // שורת סיכום – מדלגים עד הסכום
        i++;
        while (i < n && !money(cells[i])) i++;
        i++; buf = []; continue;
      }
      if (RE_ORDER.test(c) && i + 1 < n && RE_DATE.test(cells[i + 1])) {
        var order = c, date = cells[i + 1], j = i + 2;
        while (j < n && cells[j] === "") j++;
        var qty = j < n ? toNumber(cells[j]) : null; j++;
        while (j < n && cells[j] === "") j++;
        var voucher = j < n ? cells[j] : ""; j++;
        var value = null;
        while (j < n && j <= i + 12) {
          if (money(cells[j])) { value = toNumber(cells[j]); break; }
          j++;
        }
        i = j + 1; buf = [];
        if (isInternal(supplier)) continue;
        qty = qty || 0;
        var vd = digits(voucher);
        recs.push({
          voucher_raw: voucher, voucher_id: stripZeros(vd), voucher_digits: vd, id_number: "",
          package_name: pkg, category: categorize(pkg), quantity: qty,
          price: value !== null && qty ? Math.round((value / qty) * 100) / 100 : 0,
          final_price: value || 0, start_date: toDate(date), supplier: supplier, order_no: order,
          customer: "", booked_package: "", booked_category: UNKNOWN,
        });
        continue;
      }
      if (hasLetters(c)) buf.push(c);
      i++;
    }
    return recs;
  }

  // ---------------- ספקים ----------------
  function headerIndex(cells, name) {
    name = cleanHeader(name);
    var i = cells.indexOf(name);
    if (i >= 0) return i;
    for (i = 0; i < cells.length; i++) if (cells[i].indexOf(name) === 0) return i;
    return -1;
  }
  function findHeaderRow(rows, required) {
    for (var i = 0; i < Math.min(rows.length, 2000); i++) {
      var cells = (rows[i] || []).map(cleanHeader);
      if (required.every(function (x) { return headerIndex(cells, x) >= 0; })) return { i: i, cells: cells };
    }
    return null;
  }
  function detectSupplier(rows, configs) {
    for (var k = 0; k < configs.length; k++) if (findHeaderRow(rows, configs[k].detect)) return configs[k];
    return null;
  }
  function normalizeSupplier(rows, cfg) {
    var h = findHeaderRow(rows, cfg.detect);
    if (!h) throw new Error("לא נמצאה שורת כותרות בדוח " + cfg.name);
    var header = h.cells, cols = cfg.columns;
    function col(key) {
      if (!cols[key]) return -1;
      var i = headerIndex(header, cols[key]);
      if (i < 0) throw new Error("בדוח " + cfg.name + " חסרה העמודה '" + cols[key] + "'");
      return i;
    }
    var iV = col("voucher_id"), iId = col("id_number"), iPkg = col("package_name"), iQ = col("quantity"),
      iFp = col("final_price"), iU = col("unit_price"), iDt = col("date"), iCu = col("customer"), iRef = col("reference");
    var parts = cols.date_parts;
    var get = function (r, i) { return i >= 0 && i < r.length ? r[i] : null; };
    var recs = [];
    rows.slice(h.i + 1).forEach(function (r) {
      var v = digits(get(r, iV));
      if (!v) return; // שורות סיכום / ריקות
      var pkg = iPkg >= 0 ? cleanText(get(r, iPkg)) : "";
      var qty = iQ >= 0 ? toNumber(get(r, iQ)) : null;
      var fp = iFp >= 0 ? toNumber(get(r, iFp)) : null;
      if (fp === null && iU >= 0 && qty !== null) { var u = toNumber(get(r, iU)); fp = u === null ? null : u * qty; }
      var date = null;
      if (parts) {
        var y = toNumber(get(r, headerIndex(header, parts.year))), m = toNumber(get(r, headerIndex(header, parts.month))),
          d = toNumber(get(r, headerIndex(header, parts.day)));
        date = y && m && d ? ymd(y, m, d) : null;
      } else date = toDate(get(r, iDt));
      recs.push({
        voucher_raw: cleanText(get(r, iV)), voucher_id: stripZeros(v), match_key: stripZeros(v),
        id_number: iId >= 0 ? stripZeros(digits(get(r, iId))) : "", package_name: pkg,
        category: iPkg >= 0 && pkg ? categorize(pkg) : null, quantity: qty, final_price: fp, start_date: date,
        supplier: cfg.name, customer: iCu >= 0 ? cleanText(get(r, iCu)) : "", reference: iRef >= 0 ? cleanText(get(r, iRef)) : "",
      });
    });
    return recs;
  }
  function easyMatchKey(e, cfg) {
    var v = e.voucher_digits || "";
    if (cfg.easyKey === "coupon_drop_first_digit") v = v.slice(1);
    return stripZeros(v);
  }
  function rowsFromPaste(text) {
    return text.replace(/\r/g, "").split("\n").filter(function (l) { return l.trim(); })
      .map(function (l) { return l.split("\t").map(function (c) { return c.trim(); }); });
  }
  /** מזהה ומנרמל טבלה: {kind:'easy'|'supplier', cfg, recs} */
  function loadRows(rows, configs) {
    if (isEasy(rows)) return { kind: "easy", cfg: null, recs: normalizeEasy(rows) };
    var cfg = detectSupplier(rows, configs);
    if (!cfg) throw new Error("לא זוהה לאיזה ספק שייכת הטבלה. ודאו שהעתקתם גם את שורת הכותרות.");
    return { kind: "supplier", cfg: cfg, recs: normalizeSupplier(rows, cfg) };
  }
  function loadPaste(text, configs) {
    if (isEasyPrint(text)) return { kind: "easy", cfg: null, recs: normalizeEasyPrint(text) };
    return loadRows(rowsFromPaste(text), configs);
  }
  function loadBytes(bytes, filename, configs) { return loadRows(readAny(bytes, filename), configs); }

  // ---------------- הצלבה ----------------
  function easyView(r) {
    return {
      "מספר שובר": r.voucher_raw, "מס. הזמנה": r.order_no, "לקוח": r.customer, "חבילה באיזי": r.package_name,
      "סוג חבילה": r.category, "כמות": fmt(r.quantity), "מחיר ליחידה": fmt(r.price), "מחיר × כמות": fmt(r.final_price),
      "ת. התחלה": fmtDate(r.start_date), "חברת שוברים": r.supplier,
    };
  }
  function supView(r) {
    return {
      "מספר שובר אצל הספק": r.voucher_raw, 'ת"ז אצל הספק': r.id_number || "", "לקוח": r.customer || "",
      "חבילה אצל הספק": r.package_name || "", "סוג חבילה": r.category || "", "כמות": fmt(r.quantity),
      "מחיר סופי": fmt(r.final_price), "תאריך": fmtDate(r.start_date), "אסמכתא": r.reference || "",
    };
  }
  function uniqJoin(arr, sep) {
    var seen = [];
    arr.forEach(function (x) { if (x !== null && x !== undefined && x !== "" && seen.indexOf(String(x)) < 0) seen.push(String(x)); });
    return seen.join(sep);
  }
  function aggregate(list) {
    var groups = [], byKey = {};
    list.forEach(function (r) {
      if (!(r.match_key in byKey)) { byKey[r.match_key] = []; groups.push(byKey[r.match_key]); }
      byKey[r.match_key].push(r);
    });
    return groups.map(function (g) {
      var r = Object.assign({}, g[0]);
      r.voucher_raw = uniqJoin(g.map(function (x) { return x.voucher_raw; }), ", ");
      r.package_name = uniqJoin(g.map(function (x) { return x.package_name; }), " | ");
      var cats = uniqJoin(g.map(function (x) { return x.category; }), "\u0000").split("\u0000").filter(Boolean).sort();
      r.category = cats.length ? cats.join(" / ") : null;
      var qs = g.map(function (x) { return x.quantity; }).filter(function (x) { return !isEmpty(x); });
      r.quantity = qs.length ? qs.reduce(function (a, b) { return a + b; }, 0) : null;
      var ps = g.map(function (x) { return x.final_price; }).filter(function (x) { return !isEmpty(x); });
      r.final_price = ps.length ? ps.reduce(function (a, b) { return a + b; }, 0) : null;
      ["order_no", "reference", "supplier"].forEach(function (c) {
        if (c in g[0]) r[c] = uniqJoin(g.map(function (x) { return x[c]; }), ", ");
      });
      if (g[0]._idxs) r._idxs = [].concat.apply([], g.map(function (x) { return x._idxs; }));
      return r;
    });
  }
  function cmpForPair(a, b) {
    var ca = a.category || "￿", cb = b.category || "￿";
    if (ca !== cb) return ca < cb ? -1 : 1;
    var pa = isEmpty(a.final_price) ? Infinity : a.final_price, pb = isEmpty(b.final_price) ? Infinity : b.final_price;
    return pa - pb;
  }
  /** מצליב לפי מפתח: אותו מספר שורות בשני הצדדים – זוגות; מספר שונה – חריגה, בלי לנחש. */
  function pairGroups(easy, sup, eKey, sKey, method, pairs, exceptions) {
    if (!easy.length || !sup.length) return [easy, sup];
    var eMap = {}, sMap = {};
    easy.forEach(function (r) { var k = r[eKey]; if (k) (eMap[k] = eMap[k] || []).push(r); });
    sup.forEach(function (r) { var k = r[sKey]; if (k) (sMap[k] = sMap[k] || []).push(r); });
    var common = Object.keys(eMap).filter(function (k) { return k in sMap; }).sort();
    var usedE = new Set(), usedS = new Set();
    common.forEach(function (k) {
      var ge = eMap[k].slice().sort(cmpForPair), gs = sMap[k].slice().sort(cmpForPair);
      ge.forEach(function (r) { usedE.add(r); });
      gs.forEach(function (r) { usedS.add(r); });
      if (ge.length === gs.length) ge.forEach(function (er, i) { pairs.push([er, gs[i], method]); });
      else {
        var reason = "לפי " + method + ": " + ge.length + " שורות באיזי מול " + gs.length + " שורות אצל הספק – לא ניתן לשייך בוודאות";
        ge.forEach(function (r) { exceptions.push(["easy", r, reason]); });
        gs.forEach(function (r) { exceptions.push(["sup", r, reason]); });
      }
    });
    return [easy.filter(function (r) { return !usedE.has(r); }), sup.filter(function (r) { return !usedS.has(r); })];
  }
  function matchOneSupplier(cfg, supRecs, pool) {
    var res = { name: cfg.name, hasPrice: cfg.hasPrice !== false, verified: [], mismatches: [], exceptions: [],
      missingInEasy: [], missingInSupplier: [], notArrived: [], alerts: [] };
    var eIn = pool.map(function (r) { return Object.assign({}, r, { match_key: easyMatchKey(r, cfg), _idxs: [r._i] }); });
    var sIn = supRecs;
    if (cfg.aggregateByKey) { eIn = aggregate(eIn); sIn = aggregate(supRecs); }
    var pairs = [], exc = [];
    var left = pairGroups(eIn, sIn, "match_key", "match_key", "מספר שובר", pairs, exc);
    if (cfg.idFallback) {
      left = pairGroups(left[0], left[1], "voucher_id", "id_number", 'ת"ז (מספר שובר באיזי)', pairs, exc);
      left = pairGroups(left[0], left[1], "id_number", "id_number", 'ת"ז (מזהה באיזי)', pairs, exc);
      left = pairGroups(left[0], left[1], "id_number", "match_key", 'ת"ז (מזהה באיזי)', pairs, exc);
    }
    var used = [];
    pairs.forEach(function (p) {
      var er = p[0], sr = p[1], method = p[2], problems = [];
      used = used.concat(er._idxs);
      if (sr.category !== null && sr.category !== undefined && sr.category !== er.category)
        problems.push(["סוג חבילה", sr.category + " (" + sr.package_name + ")", er.category + " (" + er.package_name + ")"]);
      if (!isEmpty(sr.quantity) && Math.abs((sr.quantity || 0) - (er.quantity || 0)) > 0.001)
        problems.push(["כמות", fmt(sr.quantity), fmt(er.quantity)]);
      if (res.hasPrice && !isEmpty(sr.final_price) && Math.abs(sr.final_price - er.final_price) > PRICE_TOLERANCE)
        problems.push(["מחיר", fmt(sr.final_price), fmt(er.final_price) + " (" + fmt(er.price) + " × " + fmt(er.quantity) + ")"]);
      var base = { "ספק": cfg.name, "חבילה": er.package_name, "מספר שובר": er.voucher_raw, "מספר שובר אצל הספק": sr.voucher_raw,
        "מס. הזמנה": er.order_no, "לקוח": er.customer, "חברת שוברים באיזי": er.supplier, "הותאם לפי": method };
      if (problems.length) problems.forEach(function (pr) {
        res.mismatches.push(Object.assign({}, base, { "שדה שלא תאם": pr[0], "ערך אצל הספק": pr[1], "ערך באיזי": pr[2] }));
      });
      else res.verified.push(Object.assign({}, base, { "סוג חבילה": er.category, "כמות": fmt(er.quantity),
        "מחיר באיזי": er.final_price, "מחיר אצל הספק": fmt(sr.final_price) }));
    });
    exc.forEach(function (x) {
      if (x[0] === "easy") { used = used.concat(x[1]._idxs); res.exceptions.push(Object.assign({ "מקור": "איזי" }, easyView(x[1]), { "סיבה": x[2] })); }
      else res.exceptions.push(Object.assign({ "מקור": "ספק" }, supView(x[1]), { "סיבה": x[2] }));
    });
    return { res: res, used: used, sLeft: left[1] };
  }
  function owner(supplierName, cfgs) {
    for (var i = 0; i < cfgs.length; i++)
      if ((cfgs[i].easySuppliers || []).some(function (n) { return supplierName.indexOf(n) >= 0; })) return cfgs[i].name;
    return null;
  }
  /** easy: רשומות איזי; suppliers: [{cfg, recs}]; day: 'YYYY-MM-DD' */
  function reconcile(easy, suppliers, day) {
    easy = easy.map(function (r, i) { return Object.assign({}, r, { _i: i }); });
    var arrived = easy.filter(function (r) { return r.start_date === day; });
    var remaining = arrived.slice(), results = [], leftovers = [], matchedBy = {};
    suppliers.forEach(function (s) {
      var out = matchOneSupplier(s.cfg, s.recs, remaining);
      var usedSet = new Set(out.used);
      remaining = remaining.filter(function (r) { return !usedSet.has(r._i); });
      out.used.forEach(function (i) { matchedBy[i] = s.cfg.name; });
      results.push(out.res); leftovers.push(out.sLeft);
    });
    var byName = {}; results.forEach(function (r) { byName[r.name] = r; });
    var cfgs = suppliers.map(function (s) { return s.cfg; });
    results.forEach(function (r, i) { r.missingInEasy = leftovers[i].map(supView); });
    var notChecked = [];
    remaining.forEach(function (r) {
      var o = owner(r.supplier, cfgs);
      if (o) byName[o].missingInSupplier.push(Object.assign(easyView(r), { "הערה": "לא נמצא בדוח של אף ספק" }));
      else notChecked.push(r);
    });
    easy.filter(function (r) { return r.start_date !== day; }).forEach(function (r) {
      var o = owner(r.supplier, cfgs);
      if (o) byName[o].notArrived.push(easyView(r));
    });
    arrived.forEach(function (r) {
      var o = matchedBy[r._i] || owner(r.supplier, cfgs);
      if (!o) return;
      if (r.category === UNKNOWN)
        byName[o].alerts.push('חבילה לא מסווגת באיזי: "' + r.package_name + '" (שובר ' + r.voucher_raw + ")");
      else if (r.booked_category !== UNKNOWN && r.booked_category !== r.category)
        byName[o].alerts.push("שובר " + r.voucher_raw + " (הזמנה " + r.order_no + ", " + r.customer + '): השובר הוא "' +
          r.category + '" אבל בהזמנה באיזי רשומה חבילה "' + r.booked_package + '"');
    });
    suppliers.forEach(function (s) {
      s.recs.forEach(function (r) {
        if (r.category === UNKNOWN)
          byName[s.cfg.name].alerts.push('חבילה לא מסווגת אצל הספק: "' + r.package_name + '" (שובר ' + r.voucher_raw + ")");
      });
    });
    var bySupPkg = {};
    arrived.forEach(function (r) {
      var o = owner(r.supplier, cfgs); if (!o) return;
      var k = o + "\u0000" + r.package_name;
      (bySupPkg[k] = bySupPkg[k] || { o: o, desc: r.package_name, prices: [] });
      if (bySupPkg[k].prices.indexOf(r.price) < 0) bySupPkg[k].prices.push(r.price);
    });
    Object.keys(bySupPkg).forEach(function (k) {
      var g = bySupPkg[k];
      if (g.prices.length > 1) byName[g.o].alerts.push('אותה חבילה במחירים שונים באיזי: "' + g.desc + '" – ' +
        g.prices.sort(function (a, b) { return a - b; }).join(", "));
    });
    return { results: results, notChecked: notChecked };
  }
  function verifiedSummary(res) {
    var groups = {}, order = [];
    res.verified.forEach(function (v) {
      var k = v["סוג חבילה"];
      if (!groups[k]) { groups[k] = { "סוג חבילה": k, "מספר חבילות": 0, "כמות": 0, "מחיר סופי": 0, "מספרי שובר": [] }; order.push(k); }
      var g = groups[k];
      g["מספר חבילות"]++; g["כמות"] += Number(v["כמות"]) || 0; g["מחיר סופי"] += Number(v["מחיר באיזי"]) || 0;
      g["מספרי שובר"].push(v["מספר שובר"]);
    });
    return order.sort().map(function (k) {
      var g = groups[k]; return Object.assign({}, g, { "מספרי שובר": g["מספרי שובר"].join(", ") });
    });
  }

  // ---------------- דוח אקסל ----------------
  function columnsOf(rows) {
    var cols = [];
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); }); });
    return cols;
  }
  function block(aoa, title, rows) {
    aoa.push([title + " (" + rows.length + ")"]);
    if (!rows.length) aoa.push(["אין"]);
    else {
      var cols = columnsOf(rows);
      aoa.push(cols);
      rows.forEach(function (r) { aoa.push(cols.map(function (c) { return r[c] === undefined ? "" : r[c]; })); });
    }
    aoa.push([], []);
  }
  function sheetFrom(aoa) {
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var widths = [];
    aoa.forEach(function (r) { r.forEach(function (v, i) { var l = String(v === null ? "" : v).length; widths[i] = Math.max(widths[i] || 8, Math.min(l + 2, 60)); }); });
    ws["!cols"] = widths.map(function (w) { return { wch: w }; });
    return ws;
  }
  function summaryRows(results) {
    return results.map(function (r) {
      return { "ספק": r.name, "אומתו": r.verified.length,
        "אי-התאמות (שוברים)": new Set(r.mismatches.map(function (m) { return m["מספר שובר"]; })).size,
        "לא הגיעו": r.notArrived.length, "אצל הספק – חסר באיזי": r.missingInEasy.length,
        "באיזי – חסר אצל הספק": r.missingInSupplier.length, "חריגות": r.exceptions.length, "התרעות": r.alerts.length };
    });
  }
  function buildWorkbook(out, day) {
    var wb = XLSX.utils.book_new();
    var aoa = [["הצלבת שוברים – תאריך הגעה " + fmtDate(day)], []];
    block(aoa, "סיכום לפי ספק", summaryRows(out.results));
    block(aoa, "שורות באיזי של ספקים שלא הועלה להם דוח (לא נבדקו)", out.notChecked.map(easyView));
    XLSX.utils.book_append_sheet(wb, sheetFrom(aoa), "סיכום");
    out.results.forEach(function (r) {
      var a = [];
      block(a, "אומתו – לפי סוג חבילה", verifiedSummary(r));
      block(a, "אי-התאמות", r.mismatches);
      block(a, "קיים אצל הספק – חסר באיזי", r.missingInEasy);
      block(a, "קיים באיזי – לא נמצא בדוח הספק", r.missingInSupplier);
      block(a, "חריגות (לא ניתן לשייך בוודאות)", r.exceptions);
      block(a, "לא הגיעו (תאריך התחלה שונה)", r.notArrived);
      block(a, "התרעות", r.alerts.map(function (x) { return { "התרעה": x }; }));
      block(a, "פירוט השוברים שאומתו", r.verified);
      XLSX.utils.book_append_sheet(wb, sheetFrom(a), r.name.replace(/[\\\/?*\[\]:]/g, "-").slice(0, 31));
    });
    wb.Workbook = { Views: [{ RTL: true }] };
    return wb;
  }

  var Recon = {
    categorize: categorize, UNKNOWN: UNKNOWN, toDate: toDate, fmtDate: fmtDate, unpack: unpack,
    loadBytes: loadBytes, loadPaste: loadPaste, reconcile: reconcile, verifiedSummary: verifiedSummary,
    buildWorkbook: buildWorkbook, columnsOf: columnsOf, easyView: easyView, XLSX: XLSX,
  };
  root.Recon = Recon;
  if (typeof module !== "undefined") module.exports = Recon;
})(typeof window !== "undefined" ? window : globalThis);
