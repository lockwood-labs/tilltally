/*
 * TillTally core money math.
 *
 * One shared, dependency-free module used by:
 *   - the PWA frontend in local-only mode (loaded as a classic script,
 *     exposed as window.TillCore), and
 *   - the Node test suite (require()).
 * The Cloudflare Worker stores the same data shape this module operates on,
 * so the math a user sees is identical wherever the data lives.
 *
 * Data shape (all dates are "YYYY-MM-DD" strings, all amounts are dollars):
 * {
 *   people:     [{ id, label }],
 *   categories: [{ id, name }],
 *   paychecks:  [{ id, personId, amount, date, nextDate|null }],
 *   spends:     [{ id, personId, amount, note, categoryId, date }],
 *   bills:      [{ id, name, personId, amount, categoryId, frequency,
 *                  firstDueDate, createdAt, active }],
 *   seq: number  // id counter
 * }
 *
 * Bill rule (per the product spec): a recurring bill auto-deducts from its
 * fund on each due date, but only for due dates on/after the day the bill
 * was set up (createdAt). Back-dating a first due date never invents
 * payments for before the bill existed.
 */
(function (global) {
  "use strict";

  var FREQUENCIES = ["weekly", "biweekly", "monthly"];
  var DAY_MS = 24 * 60 * 60 * 1000;

  // ---------- date helpers (UTC, string-based) ----------

  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function formatDate(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
  }

  function todayString() {
    return formatDate(Date.now());
  }

  function addDays(dateStr, n) {
    return formatDate(parseDate(dateStr) + n * DAY_MS);
  }

  function addMonthsClamped(dateStr, n) {
    var ms = parseDate(dateStr);
    var d = new Date(ms);
    var day = d.getUTCDate();
    var target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    var lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return formatDate(target.getTime());
  }

  function stepDate(dateStr, frequency) {
    if (frequency === "weekly") return addDays(dateStr, 7);
    if (frequency === "biweekly") return addDays(dateStr, 14);
    if (frequency === "monthly") return addMonthsClamped(dateStr, 1);
    throw new Error("Unknown frequency: " + frequency);
  }

  // ---------- money helpers (integer cents internally) ----------

  function toCents(amount) {
    var n = Number(amount);
    if (!isFinite(n)) throw new Error("Amount must be a number");
    return Math.round(n * 100);
  }

  function fromCents(cents) {
    return cents / 100;
  }

  function cleanAmount(amount) {
    var cents = toCents(amount);
    if (cents <= 0) throw new Error("Amount must be greater than zero");
    return fromCents(cents);
  }

  // ---------- data construction ----------

  function nextId(data, prefix) {
    data.seq = (data.seq || 0) + 1;
    return prefix + "-" + data.seq;
  }

  function createEmptyData() {
    return {
      people: [
        { id: "person-1", label: "You" },
        { id: "person-2", label: "Girlfriend" }
      ],
      categories: [
        { id: "cat-food", name: "Food" },
        { id: "cat-rent", name: "Rent" },
        { id: "cat-utilities", name: "Utilities" }
      ],
      paychecks: [],
      spends: [],
      bills: [],
      seq: 0
    };
  }

  function findPerson(data, personId) {
    for (var i = 0; i < data.people.length; i++) {
      if (data.people[i].id === personId) return data.people[i];
    }
    throw new Error("Unknown person: " + personId);
  }

  function findCategory(data, categoryId) {
    for (var i = 0; i < data.categories.length; i++) {
      if (data.categories[i].id === categoryId) return data.categories[i];
    }
    return null;
  }

  function requireDate(value, field) {
    if (parseDate(value) === null) throw new Error(field + " must be a YYYY-MM-DD date");
    return value;
  }

  // ---------- mutations ----------

  function addPaycheck(data, input) {
    findPerson(data, input.personId);
    var paycheck = {
      id: nextId(data, "paycheck"),
      personId: input.personId,
      amount: cleanAmount(input.amount),
      date: requireDate(input.date, "date"),
      nextDate: input.nextDate ? requireDate(input.nextDate, "nextDate") : null
    };
    data.paychecks.push(paycheck);
    return paycheck;
  }

  function deletePaycheck(data, id) {
    data.paychecks = data.paychecks.filter(function (p) { return p.id !== id; });
  }

  function addSpend(data, input) {
    findPerson(data, input.personId);
    if (input.categoryId && !findCategory(data, input.categoryId)) {
      throw new Error("Unknown category: " + input.categoryId);
    }
    var spend = {
      id: nextId(data, "spend"),
      personId: input.personId,
      amount: cleanAmount(input.amount),
      note: String(input.note || ""),
      categoryId: input.categoryId || null,
      date: requireDate(input.date, "date")
    };
    data.spends.push(spend);
    return spend;
  }

  function deleteSpend(data, id) {
    data.spends = data.spends.filter(function (s) { return s.id !== id; });
  }

  function addCategory(data, name) {
    var trimmed = String(name || "").trim();
    if (!trimmed) throw new Error("Category name is required");
    var category = { id: nextId(data, "cat"), name: trimmed };
    data.categories.push(category);
    return category;
  }

  function deleteCategory(data, id) {
    data.categories = data.categories.filter(function (c) { return c.id !== id; });
    // Spends/bills that used it keep their amount and lose the tag.
    data.spends.forEach(function (s) { if (s.categoryId === id) s.categoryId = null; });
    data.bills.forEach(function (b) { if (b.categoryId === id) b.categoryId = null; });
  }

  function addBill(data, input, createdAt) {
    findPerson(data, input.personId);
    if (FREQUENCIES.indexOf(input.frequency) === -1) {
      throw new Error("frequency must be one of: " + FREQUENCIES.join(", "));
    }
    if (input.categoryId && !findCategory(data, input.categoryId)) {
      throw new Error("Unknown category: " + input.categoryId);
    }
    var bill = {
      id: nextId(data, "bill"),
      name: String(input.name || "Bill"),
      personId: input.personId,
      amount: cleanAmount(input.amount),
      categoryId: input.categoryId || null,
      frequency: input.frequency,
      firstDueDate: requireDate(input.firstDueDate, "firstDueDate"),
      createdAt: requireDate(createdAt || todayString(), "createdAt"),
      active: input.active !== false
    };
    data.bills.push(bill);
    return bill;
  }

  function deleteBill(data, id) {
    data.bills = data.bills.filter(function (b) { return b.id !== id; });
  }

  function setBillActive(data, id, active) {
    for (var i = 0; i < data.bills.length; i++) {
      if (data.bills[i].id === id) { data.bills[i].active = !!active; return data.bills[i]; }
    }
    throw new Error("Unknown bill: " + id);
  }

  function updatePersonLabel(data, personId, label) {
    var person = findPerson(data, personId);
    var trimmed = String(label || "").trim();
    if (!trimmed) throw new Error("Label is required");
    person.label = trimmed;
    return person;
  }

  // ---------- bill occurrences ----------

  // All due dates for a bill from firstDueDate through `through` (inclusive),
  // stepping by frequency. Capped to avoid runaway loops on bad data.
  function occurrencesThrough(bill, through) {
    var out = [];
    var d = bill.firstDueDate;
    var guard = 0;
    while (d <= through && guard < 1000) {
      out.push(d);
      d = stepDate(d, bill.frequency);
      guard++;
    }
    return out;
  }

  // The first due date strictly after `after`, stepping from firstDueDate.
  function firstOccurrenceAfter(bill, after) {
    var d = bill.firstDueDate;
    var guard = 0;
    while (d <= after && guard < 1000) {
      d = stepDate(d, bill.frequency);
      guard++;
    }
    return d;
  }

  // Payments are the bill's own schedule dates (from firstDueDate, stepping
  // by frequency) that fall on/after the day the bill was set up and
  // on/before asOf. Schedule dates before set-up are simply not payable —
  // that is the whole "no invented past payments" rule.
  function billPayments(data, bill, asOf) {
    return occurrencesThrough(bill, asOf)
      .filter(function (d) { return d >= bill.createdAt; })
      .map(function (d) {
        return { billId: bill.id, date: d, amount: bill.amount, personId: bill.personId };
      });
  }

  function billNextDue(bill, asOf) {
    if (!bill.active) return null;
    var d = firstOccurrenceAfter(bill, asOf);
    // Next due must be a real payable date (not before set-up).
    while (d < bill.createdAt) d = stepDate(d, bill.frequency);
    return d;
  }

  // ---------- state computation ----------

  function computeState(data, asOf) {
    asOf = requireDate(asOf || todayString(), "asOf");

    // Next paycheck for the household: soonest nextDate entered for either
    // person that is today or later. Falls back to the soonest past-entered
    // nextDate if all are in the past (stale entries), else null.
    var nextDates = data.paychecks
      .map(function (p) { return p.nextDate; })
      .filter(function (d) { return !!d; })
      .sort();
    var futureNext = nextDates.filter(function (d) { return d >= asOf; });
    var nextPaycheck = futureNext.length ? futureNext[0] : (nextDates.length ? nextDates[nextDates.length - 1] : null);

    // Upcoming-bill window: through the next paycheck date if known,
    // otherwise the next 30 days.
    var windowEnd = nextPaycheck && nextPaycheck >= asOf ? nextPaycheck : addDays(asOf, 30);
    var windowBasis = nextPaycheck && nextPaycheck >= asOf ? "next paycheck" : "next 30 days";

    var people = data.people.map(function (person) {
      var payC = 0, spendC = 0, billC = 0;
      data.paychecks.forEach(function (p) { if (p.personId === person.id) payC += toCents(p.amount); });
      data.spends.forEach(function (s) { if (s.personId === person.id) spendC += toCents(s.amount); });
      return {
        id: person.id, label: person.label,
        paychecksTotal: fromCents(payC), spendsTotal: fromCents(spendC),
        _payC: payC, _spendC: spendC, _billC: 0
      };
    });
    var personById = {};
    people.forEach(function (p) { personById[p.id] = p; });

    var allPayments = [];
    var bills = data.bills.map(function (bill) {
      // Payments that already happened are a fact even if the bill is now
      // paused; pausing only stops future deductions (see `upcoming`).
      var payments = billPayments(data, bill, asOf);
      payments.forEach(function (p) {
        if (personById[p.personId]) personById[p.personId]._billC += toCents(p.amount);
      });
      allPayments = allPayments.concat(payments);

      var upcoming = [];
      if (bill.active) {
        var d = billNextDue(bill, asOf);
        var guard = 0;
        while (d && d <= windowEnd && guard < 1000) {
          upcoming.push({ billId: bill.id, name: bill.name, date: d, amount: bill.amount, personId: bill.personId });
          d = stepDate(d, bill.frequency);
          guard++;
        }
      }

      return {
        id: bill.id, name: bill.name, personId: bill.personId,
        amount: bill.amount, categoryId: bill.categoryId,
        categoryName: bill.categoryId && findCategory(data, bill.categoryId) ? findCategory(data, bill.categoryId).name : null,
        frequency: bill.frequency, firstDueDate: bill.firstDueDate,
        createdAt: bill.createdAt, active: bill.active,
        paidCount: payments.length,
        paidTotal: fromCents(payments.reduce(function (sum, p) { return sum + toCents(p.amount); }, 0)),
        nextDue: billNextDue(bill, asOf),
        upcoming: upcoming
      };
    });

    people.forEach(function (p) {
      p.billsPaidTotal = fromCents(p._billC);
      p.available = fromCents(p._payC - p._spendC - p._billC);
      delete p._payC; delete p._spendC; delete p._billC;
    });

    var combinedC = people.reduce(function (sum, p) { return sum + toCents(p.available); }, 0);

    var categories = data.categories.map(function (c) {
      var totalC = 0, count = 0;
      data.spends.forEach(function (s) {
        if (s.categoryId === c.id) { totalC += toCents(s.amount); count++; }
      });
      return { id: c.id, name: c.name, total: fromCents(totalC), count: count };
    });

    var upcomingAll = [];
    bills.forEach(function (b) { upcomingAll = upcomingAll.concat(b.upcoming); });
    upcomingAll.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var upcomingTotalC = upcomingAll.reduce(function (sum, u) { return sum + toCents(u.amount); }, 0);

    return {
      asOf: asOf,
      people: people,
      combinedAvailable: fromCents(combinedC),
      categories: categories,
      paychecks: data.paychecks.slice(),
      spends: data.spends.slice(),
      bills: bills,
      billPayments: allPayments,
      summary: {
        nextPaycheck: nextPaycheck,
        windowEnd: windowEnd,
        windowBasis: windowBasis,
        upcomingCount: upcomingAll.length,
        upcomingTotal: fromCents(upcomingTotalC),
        upcoming: upcomingAll
      }
    };
  }

  var api = {
    FREQUENCIES: FREQUENCIES,
    parseDate: parseDate,
    formatDate: formatDate,
    todayString: todayString,
    addDays: addDays,
    addMonthsClamped: addMonthsClamped,
    stepDate: stepDate,
    createEmptyData: createEmptyData,
    addPaycheck: addPaycheck,
    deletePaycheck: deletePaycheck,
    addSpend: addSpend,
    deleteSpend: deleteSpend,
    addCategory: addCategory,
    deleteCategory: deleteCategory,
    addBill: addBill,
    deleteBill: deleteBill,
    setBillActive: setBillActive,
    updatePersonLabel: updatePersonLabel,
    billPayments: billPayments,
    billNextDue: billNextDue,
    computeState: computeState
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.TillCore = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
