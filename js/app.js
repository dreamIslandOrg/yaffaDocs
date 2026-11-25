/* המסך: קבלת קבצים/הדבקות, זיהוי, הצלבה והצגה. כל העיבוד מקומי בדפדפן. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var LS_KEY = "dreamRecon.zipPassword";
  var fileItems = [];   // [{name, kind, cfg, recs, error}]
  var pasteItems = [];
  var lastOut = null, lastDay = null;
  var busy = 0; // קבצים שעדיין בעיבוד

  function esc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function getZipPw() { try { return localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; } }

  // ---------- הגדרות ----------
  $("#settingsBtn").onclick = function () { $("#settings").classList.toggle("hidden"); $("#zipPw").value = getZipPw(); };
  $("#saveSettings").onclick = function () {
    try { localStorage.setItem(LS_KEY, $("#zipPw").value); $("#settingsMsg").textContent = "נשמר"; }
    catch (e) { $("#settingsMsg").textContent = "לא ניתן לשמור בדפדפן הזה – הסיסמה תישמר רק עד סגירת הדף"; window.__zipPw = $("#zipPw").value; }
    setTimeout(function () { $("#settingsMsg").textContent = ""; }, 2500);
  };

  // ---------- קבצים ----------
  async function addFiles(list) {
    busy++; refresh();
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      try {
        var bytes = new Uint8Array(await f.arrayBuffer());
        var parts = await Recon.unpack(bytes, f.name, [getZipPw() || window.__zipPw || ""]);
        parts.forEach(function (p) {
          try { var r = Recon.loadBytes(p.bytes, p.name, SUPPLIERS); fileItems.push(Object.assign({ name: p.name }, r)); }
          catch (e) { fileItems.push({ name: p.name, error: e.message }); }
        });
      } catch (e) { fileItems.push({ name: f.name, error: e.message }); }
    }
    busy--; refresh();
  }
  $("#files").onchange = function (e) { var l = Array.from(e.target.files); e.target.value = ""; addFiles(l); };
  var drop = $("#drop");
  ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { addFiles(Array.from(e.dataTransfer.files)); });

  // ---------- הדבקות ----------
  var pasteTimer;
  document.querySelectorAll(".paste").forEach(function (ta) {
    ta.addEventListener("input", function () { clearTimeout(pasteTimer); pasteTimer = setTimeout(readPastes, 300); });
  });
  function readPastes() {
    pasteItems = [];
    document.querySelectorAll(".paste").forEach(function (ta, i) {
      if (!ta.value.trim()) return;
      var name = "טבלה מודבקת " + (i + 1);
      try { pasteItems.push(Object.assign({ name: name }, Recon.loadPaste(ta.value, SUPPLIERS))); }
      catch (e) { pasteItems.push({ name: name, error: e.message }); }
    });
    refresh();
  }

  // ---------- מצב ----------
  function collect() {
    var items = fileItems.concat(pasteItems), easy = null, sups = [];
    items.forEach(function (it) {
      if (it.error) return;
      if (it.kind === "easy") easy = (easy || []).concat(it.recs);
      else {
        var ex = sups.filter(function (s) { return s.cfg.name === it.cfg.name; })[0];
        if (ex) ex.recs = ex.recs.concat(it.recs); else sups.push({ cfg: it.cfg, recs: it.recs.slice() });
      }
    });
    return { items: items, easy: easy, sups: sups };
  }
  function refresh() {
    var st = collect();
    var ul = $("#status");
    if (!st.items.length) ul.innerHTML = '<li class="muted">עדיין לא הועלו קבצים</li>';
    else ul.innerHTML = st.items.map(function (it) {
      if (it.error) return '<li class="err">' + esc(it.name) + ": " + esc(it.error) + "</li>";
      var what = it.kind === "easy" ? "דוח איזי (" + it.recs.length + " שורות, בלי הזמנות פנימיות)" : esc(it.cfg.name) + " (" + it.recs.length + " שורות)";
      return '<li class="good">' + esc(it.name) + " – " + what + "</li>";
    }).join("") + (busy ? '<li class="muted">⏳ פותח קבצים...</li>' : (st.easy ? "" : '<li class="err">עדיין חסר דוח איזי</li>'));
    if (busy && !st.items.length) ul.innerHTML = '<li class="muted">⏳ פותח קבצים...</li>';
    if (st.easy && !$("#day").value) {
      var cnt = {}, best = null;
      st.easy.forEach(function (r) { if (r.start_date) { cnt[r.start_date] = (cnt[r.start_date] || 0) + 1; if (!best || cnt[r.start_date] > cnt[best]) best = r.start_date; } });
      if (best) $("#day").value = best;
    }
    $("#run").disabled = !!busy || !(st.easy && st.sups.length && $("#day").value);
  }
  $("#day").onchange = refresh;
  $("#clear").onclick = function () {
    fileItems = []; pasteItems = []; lastOut = null;
    document.querySelectorAll(".paste").forEach(function (ta) { ta.value = ""; });
    $("#day").value = ""; $("#results").innerHTML = ""; $("#download").classList.add("hidden"); refresh();
  };

  // ---------- הצלבה ----------
  $("#run").onclick = function () {
    var st = collect(), day = $("#day").value;
    lastOut = Recon.reconcile(st.easy, st.sups, day); lastDay = day;
    render(lastOut);
    $("#download").classList.remove("hidden");
    $("#results").scrollIntoView({ behavior: "smooth" });
  };
  $("#download").onclick = function () {
    if (!lastOut) return;
    var p = lastDay.split("-");
    Recon.XLSX.writeFile(Recon.buildWorkbook(lastOut, lastDay), "הצלבה_" + p[2] + "-" + p[1] + "-" + p[0] + ".xlsx");
  };

  function table(rows) {
    if (!rows.length) return '<p class="muted">אין</p>';
    var cols = Recon.columnsOf(rows);
    return '<div class="tbl-wrap"><table><thead><tr>' + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") +
      "</tr></thead><tbody>" + rows.map(function (r) {
        return "<tr>" + cols.map(function (c) { return "<td>" + esc(r[c]) + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";
  }
  function section(title, rows) { return "<h3>" + title + " (" + rows.length + ")</h3>" + table(rows); }
  function money(n) { return Number(n).toLocaleString("he-IL", { maximumFractionDigits: 2 }); }

  function render(out) {
    var tabs = out.results.map(function (r) { return r.name; }).concat(["לא נבדקו"]);
    var html = '<div class="card"><h2>תוצאות – ' + Recon.fmtDate(lastDay) + '</h2><div class="tabs">' +
      tabs.map(function (t, i) { return '<button type="button" class="tab' + (i ? "" : " active") + '" data-i="' + i + '">' + esc(t) + "</button>"; }).join("") + "</div>";
    out.results.forEach(function (r, i) {
      var mis = new Set(r.mismatches.map(function (m) { return m["מספר שובר"]; })).size;
      var missing = r.missingInEasy.length + r.missingInSupplier.length;
      html += '<div class="pane' + (i ? " hidden" : "") + '" data-i="' + i + '">';
      html += '<div class="metrics">' +
        '<div class="metric good"><b>' + r.verified.length + "</b>אומתו</div>" +
        '<div class="metric ' + (mis ? "bad" : "") + '"><b>' + mis + "</b>אי-התאמות</div>" +
        '<div class="metric ' + (missing ? "bad" : "") + '"><b>' + missing + "</b>חסרים</div>" +
        '<div class="metric"><b>' + r.notArrived.length + "</b>לא הגיעו</div>" +
        '<div class="metric ' + (r.exceptions.length ? "warn" : "") + '"><b>' + r.exceptions.length + "</b>חריגות</div></div>";
      html += "<h3>✅ אומתו</h3>";
      var sum = Recon.verifiedSummary(r);
      if (!sum.length) html += '<p class="muted">לא אומתו שוברים.</p>';
      sum.forEach(function (s) {
        html += '<div class="verified-line">אומתו <b>' + s["מספר חבילות"] + "</b> חבילות <b>" + esc(s["סוג חבילה"]) +
          "</b> (כמות " + s["כמות"] + ', סה"כ ' + money(s["מחיר סופי"]) + " ₪) – שוברים: " + esc(s["מספרי שובר"]) + "</div>";
      });
      html += "<details><summary>פירוט השוברים שאומתו</summary>" + table(r.verified) + "</details>";
      html += section("❌ אי-התאמות", r.mismatches);
      html += section("🔎 קיים אצל הספק – חסר באיזי", r.missingInEasy);
      html += section("🔎 קיים באיזי – לא נמצא בדוח הספק", r.missingInSupplier);
      html += section("⚠️ חריגות (לא ניתן לשייך בוודאות)", r.exceptions);
      html += section("🕓 לא הגיעו (תאריך התחלה שונה)", r.notArrived);
      if (r.alerts.length) html += "<h3>🔔 התרעות (" + r.alerts.length + ')</h3><ul class="alerts">' +
        r.alerts.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ul>";
      html += "</div>";
    });
    html += '<div class="pane hidden" data-i="' + out.results.length + '"><p>שורות באיזי (בתאריך שנבחר) של ספקים שלא הועלה להם דוח:</p>' +
      table(out.notChecked.map(Recon.easyView)) + "</div></div>";
    $("#results").innerHTML = html;
    document.querySelectorAll(".tab").forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll(".tab").forEach(function (x) { x.classList.toggle("active", x === b); });
        document.querySelectorAll(".pane").forEach(function (p) { p.classList.toggle("hidden", p.dataset.i !== b.dataset.i); });
      };
    });
  }
  refresh();
})();
