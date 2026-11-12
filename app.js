/* TillTally frontend.
 *
 * Two storage modes:
 *  - Local-only (default): data lives in this browser's localStorage.
 *  - Shared sync: a Worker URL + household code are configured (Settings).
 *    Both phones use the same code and read/write the same dataset on the
 *    Worker. The local copy is kept as an offline cache; sync is
 *    whole-dataset, last-write-wins (see README's sync notes).
 * All money math comes from core.js (window.TillCore) in both modes.
 */
(function () {
  "use strict";
  var Core = window.TillCore;
  var DATA_KEY = "tilltally.data.v1";
  var SETTINGS_KEY = "tilltally.settings.v1";

  // ---------- settings ----------
  var settings = { apiUrl: "", code: "" };
  try {
    var savedSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (savedSettings) settings = savedSettings;
  } catch (e) { /* ignore */ }
  var cfg = window.TILLTALLY_CONFIG || {};
  if (!settings.apiUrl && cfg.apiUrl) settings.apiUrl = cfg.apiUrl;
  if (!settings.code && cfg.householdCode) settings.code = cfg.householdCode;
  settings.apiUrl = (settings.apiUrl || "").replace(/\/+$/, "");

  function syncConfigured() {
    return !!(settings.apiUrl && settings.code);
  }

  // ---------- data ----------
  var data;
  try {
    data = JSON.parse(localStorage.getItem(DATA_KEY) || "null") || Core.createEmptyData();
  } catch (e) {
    data = Core.createEmptyData();
  }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function money(n) {
    var sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(n).toFixed(2);
  }
  function today() { return Core.todayString(); }

  function setStatus(text) { $("sync-status").textContent = text; }
  function setDetail(text) { $("sync-detail").textContent = text; }

  // ---------- persistence + sync ----------
  var pushTimer = null;
  function persist() {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
    if (syncConfigured()) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushToServer, 250);
    }
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign(
      { "Content-Type": "application/json", "X-Household-Code": settings.code },
      options.headers || {}
    );
    return fetch(settings.apiUrl + path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
        return body;
      });
    });
  }

  function pushToServer() {
    if (!syncConfigured()) return Promise.resolve();
    return api("/api/state", { method: "PUT", body: JSON.stringify({ data: data }) })
      .then(function () {
        setStatus("Synced · code " + settings.code);
        setDetail("Last synced " + new Date().toLocaleTimeString());
      })
      .catch(function (err) {
        setStatus("Sync offline — changes kept on this device");
        setDetail("Sync failed: " + err.message + ". Your local copy is safe; try Sync now when back online.");
      });
  }

  function pullFromServer() {
    if (!syncConfigured()) return Promise.resolve(false);
    return api("/api/state")
      .then(function (body) {
        if (body && body.data) {
          data = body.data;
          localStorage.setItem(DATA_KEY, JSON.stringify(data));
          return true;
        }
        // Household exists but has no data yet: seed it with local data.
        return pushToServer().then(function () { return false; });
      })
      .catch(function (err) {
        setStatus("Sync offline — showing this device's copy");
        setDetail("Could not reach the Worker: " + err.message);
        return false;
      });
  }

  // ---------- rendering ----------
  function personOptions(selectedId) {
    return data.people.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === selectedId ? " selected" : "") + ">" + esc(p.label) + "</option>";
    }).join("");
  }
  function categoryOptions(selectedId) {
    return data.categories.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === selectedId ? " selected" : "") + ">" + esc(c.name) + "</option>";
    }).join("");
  }

  function render() {
    var state = Core.computeState(data, today());
    var byId = {};
    data.people.forEach(function (p) { byId[p.id] = p.label; });
    var catById = {};
    data.categories.forEach(function (c) { catById[c.id] = c.name; });

    // Till tab
    $("combined-amount").textContent = money(state.combinedAvailable);
    $("fund-cards").innerHTML = state.people.map(function (p) {
      return '<div class="fund-card"><span class="fund-label">' + esc(p.label) + "</span>" +
        '<span class="fund-amount">' + money(p.available) + "</span>" +
        '<span class="fund-detail">In ' + money(p.paychecksTotal) + " · Spent " + money(p.spendsTotal) +
        " · Bills paid " + money(p.billsPaidTotal) + "</span></div>";
    }).join("");

    // Activity: paychecks, spends, and auto bill payments, newest first
    var events = [];
    state.paychecks.forEach(function (p) {
      events.push({ date: p.date, sort: p.date, html: "<b>Paycheck</b> — " + esc(byId[p.personId] || ""),
        amt: "+" + money(p.amount), kind: "paycheck", id: p.id });
    });
    state.spends.forEach(function (s) {
      events.push({ date: s.date, sort: s.date,
        html: "<b>" + esc(s.note || "Spend") + "</b> — " + esc(catById[s.categoryId] || "No category") + " · " + esc(byId[s.personId] || ""),
        amt: "−" + money(s.amount), kind: "spend", id: s.id });
    });
    state.billPayments.forEach(function (bp) {
      var bill = data.bills.filter(function (b) { return b.id === bp.billId; })[0];
      events.push({ date: bp.date, sort: bp.date,
        html: "<b>Bill paid: " + esc(bill ? bill.name : "Bill") + "</b> — " + esc(byId[bp.personId] || ""),
        amt: "−" + money(bp.amount), kind: "billpay", id: null });
    });
    events.sort(function (a, b) { return a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0; });
    $("activity-list").innerHTML = events.length ? events.map(function (e) {
      var del = e.id ? ' <button class="danger" data-del="' + e.kind + '" data-id="' + esc(e.id) + '">Delete</button>' : "";
      return "<li><span class='main-line'><span>" + e.html + "</span><span class='sub'>" + esc(e.date) + "</span></span>" +
        "<span class='amt'>" + e.amt + del + "</span></li>";
    }).join("") : '<li class="empty">Nothing yet — add a paycheck to start the till.</li>';

    // Spend tab: categories with totals
    $("category-list").innerHTML = state.categories.length ? state.categories.map(function (c) {
      return "<li><span class='main-line'><span>" + esc(c.name) + "</span><span class='sub'>" +
        c.count + (c.count === 1 ? " entry" : " entries") + "</span></span>" +
        "<span class='amt'>" + money(c.total) +
        ' <button class="danger" data-del="category" data-id="' + esc(c.id) + '">Delete</button></span></li>';
    }).join("") : '<li class="empty">No categories.</li>';

    // Bills tab
    var s = state.summary;
    $("bills-summary").textContent = s.upcomingCount + (s.upcomingCount === 1 ? " bill" : " bills") + " · " + money(s.upcomingTotal);
    $("bills-summary-note").textContent = s.windowBasis === "next paycheck" && s.nextPaycheck
      ? "Next paycheck: " + s.nextPaycheck
      : "No next-paycheck date entered — showing the next 30 days";

    $("bill-list").innerHTML = state.bills.length ? state.bills.map(function (b) {
      return "<li class='" + (b.active ? "" : "paused") + "'><span class='main-line'><span><b>" + esc(b.name) + "</b> — " +
        esc(b.categoryName || "No category") + " · from " + esc(byId[b.personId] || "") + "</span>" +
        "<span class='sub'>" + esc(b.frequency) + " · " + (b.active
          ? (b.nextDue ? "next due " + b.nextDue : "no upcoming due date")
          : "paused") +
        " · paid " + b.paidCount + "× (" + money(b.paidTotal) + ")</span></span>" +
        "<span class='amt'>" + money(b.amount) +
        ' <button class="danger" data-toggle-bill="' + esc(b.id) + '">' + (b.active ? "Pause" : "Resume") + "</button>" +
        ' <button class="danger" data-del="bill" data-id="' + esc(b.id) + '">Delete</button></span></li>';
    }).join("") : '<li class="empty">No bills set up yet.</li>';

    // Form selects + settings fields
    $("paycheck-person").innerHTML = personOptions($("paycheck-person").value);
    $("spend-person").innerHTML = personOptions($("spend-person").value);
    $("bill-person").innerHTML = personOptions($("bill-person").value);
    $("spend-category").innerHTML = categoryOptions($("spend-category").value);
    $("bill-category").innerHTML = categoryOptions($("bill-category").value);
    $("label-1").value = data.people[0] ? data.people[0].label : "";
    $("label-2").value = data.people[1] ? data.people[1].label : "";

    if (syncConfigured()) setStatus("Synced · code " + settings.code);
    else setStatus("Local only");
  }

  function mutate(fn) {
    try {
      fn();
      persist();
      render();
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- wiring ----------
  document.querySelectorAll(".tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (b) { b.classList.toggle("active", b === btn); });
      document.querySelectorAll(".panel").forEach(function (p) { p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab); });
    });
  });

  $("paycheck-date").value = today();
  $("spend-date").value = today();
  $("bill-first-due").value = today();

  $("paycheck-form").addEventListener("submit", function (e) {
    e.preventDefault();
    mutate(function () {
      Core.addPaycheck(data, {
        personId: $("paycheck-person").value,
        amount: $("paycheck-amount").value,
        date: $("paycheck-date").value,
        nextDate: $("paycheck-next").value || null
      });
      e.target.reset();
      $("paycheck-date").value = today();
    });
  });

  $("spend-form").addEventListener("submit", function (e) {
    e.preventDefault();
    mutate(function () {
      Core.addSpend(data, {
        personId: $("spend-person").value,
        amount: $("spend-amount").value,
        note: $("spend-note").value,
        categoryId: $("spend-category").value || null,
        date: $("spend-date").value
      });
      e.target.reset();
      $("spend-date").value = today();
    });
  });

  $("category-form").addEventListener("submit", function (e) {
    e.preventDefault();
    mutate(function () {
      Core.addCategory(data, $("category-name").value);
      e.target.reset();
    });
  });

  $("bill-form").addEventListener("submit", function (e) {
    e.preventDefault();
    mutate(function () {
      Core.addBill(data, {
        name: $("bill-name").value,
        personId: $("bill-person").value,
        amount: $("bill-amount").value,
        categoryId: $("bill-category").value || null,
        frequency: $("bill-frequency").value,
        firstDueDate: $("bill-first-due").value
      }, today());
      e.target.reset();
      $("bill-first-due").value = today();
    });
  });

  $("labels-form").addEventListener("submit", function (e) {
    e.preventDefault();
    mutate(function () {
      Core.updatePersonLabel(data, data.people[0].id, $("label-1").value);
      Core.updatePersonLabel(data, data.people[1].id, $("label-2").value);
    });
  });

  document.addEventListener("click", function (e) {
    var del = e.target.closest("[data-del]");
    if (del) {
      var kind = del.getAttribute("data-del"), id = del.getAttribute("data-id");
      mutate(function () {
        if (kind === "paycheck") Core.deletePaycheck(data, id);
        else if (kind === "spend") Core.deleteSpend(data, id);
        else if (kind === "category") Core.deleteCategory(data, id);
        else if (kind === "bill") Core.deleteBill(data, id);
      });
      return;
    }
    var toggle = e.target.closest("[data-toggle-bill]");
    if (toggle) {
      var billId = toggle.getAttribute("data-toggle-bill");
      var bill = data.bills.filter(function (b) { return b.id === billId; })[0];
      if (bill) mutate(function () { Core.setBillActive(data, billId, !bill.active); });
    }
  });

  // ---------- sync settings ----------
  $("sync-url").value = settings.apiUrl;
  $("sync-code").value = settings.code;

  $("sync-form").addEventListener("submit", function (e) {
    e.preventDefault();
    settings.apiUrl = $("sync-url").value.trim().replace(/\/+$/, "");
    settings.code = $("sync-code").value.trim().toUpperCase();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    if (syncConfigured()) {
      pullFromServer().then(function () { render(); });
    } else {
      setStatus("Local only");
      setDetail("Worker URL and household code cleared on this device — local mode.");
    }
  });

  $("create-household").addEventListener("click", function () {
    var url = $("sync-url").value.trim().replace(/\/+$/, "");
    if (!url) { alert("Enter your Worker URL first (deploy the Worker from the worker/ folder — see README)."); return; }
    fetch(url + "/api/households", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body.code) throw new Error(body.error || "No code returned");
        settings = { apiUrl: url, code: body.code };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        $("sync-code").value = body.code;
        setDetail("Household created. Enter this same code — " + body.code + " — on the other phone.");
        return pushToServer();
      })
      .then(function () { render(); })
      .catch(function (err) { alert("Could not create household: " + err.message); });
  });

  $("sync-now").addEventListener("click", function () {
    if (!syncConfigured()) { alert("No sync configured on this device yet."); return; }
    pullFromServer().then(function () { return pushToServer(); }).then(function () { render(); });
  });

  // ---------- boot ----------
  // Version stamp (stamped at deploy time; see config.js / sw.js). Shown in
  // Settings so an update landing is visible.
  var versionEl = $("app-version");
  if (versionEl) {
    var v = (cfg && cfg.version) || "";
    versionEl.textContent = (!v || v.indexOf("__") === 0) ? "dev (unstamped)" : v;
  }

  // Self-updating shell: check for a new service worker on load and whenever
  // the app returns to the foreground. Deploys stamp a fresh cache name, so
  // a new worker installs, activates (sw.js calls skipWaiting), and takes
  // control — when that happens after an update (not the first install),
  // reload once to serve the new shell. No reinstall, ever.
  if ("serviceWorker" in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    var reloadingForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!hadController || reloadingForUpdate) return;
      reloadingForUpdate = true;
      window.location.reload();
    });
    navigator.serviceWorker.register("./sw.js").then(function (reg) {
      var checkForUpdate = function () { reg.update().catch(function () { /* offline: keep current shell */ }); };
      checkForUpdate();
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) checkForUpdate();
      });
    }).catch(function () { /* offline shell is a bonus, not a requirement */ });
  }
  render();
  if (syncConfigured()) {
    pullFromServer().then(function () { render(); });
  }
})();
