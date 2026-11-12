/*
 * TillTally core math tests. Run with:  npm test   (or: node tests/core.test.cjs)
 *
 * Main scenario mirrors the verified behaviour of the original app:
 *   - Paycheck: person 1 (You)        $850, next paycheck 2026-11-26
 *   - Paycheck: person 2 (Girlfriend) $600, next paycheck 2026-11-20
 *   - Spend:    $42 Food, out of person 1's fund
 *   - Bill:     $95 monthly "Electric", person 2, first due 2026-11-18
 *   - Bill:     $10 weekly, person 2, first due 2026-11-12 (today)
 * As of 2026-11-12 the weekly bill has paid exactly once, the monthly bill
 * has not paid yet, and the expected totals are:
 *   You $808 · Girlfriend $590 · Combined $1,398
 *   Bills before next paycheck (2026-11-20): 2 · $105 (Nov 18 $95 + Nov 19 $10)
 */
"use strict";

const assert = require("node:assert");
const Core = require("../core.js");

const AS_OF = "2026-11-12";
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("  ok - " + name);
}

console.log("TillTally core tests (as of " + AS_OF + ")");

const data = Core.createEmptyData();
check("starts empty of money data, with preset people and categories", () => {
  assert.strictEqual(data.paychecks.length, 0);
  assert.strictEqual(data.spends.length, 0);
  assert.strictEqual(data.bills.length, 0);
  assert.deepStrictEqual(data.people.map((p) => p.label), ["You", "Girlfriend"]);
  assert.deepStrictEqual(data.categories.map((c) => c.name), ["Food", "Rent", "Utilities"]);
});

const [you, girlfriend] = data.people;
const food = data.categories.find((c) => c.name === "Food");
const utilities = data.categories.find((c) => c.name === "Utilities");

Core.addPaycheck(data, { personId: you.id, amount: 850, date: "2026-11-12", nextDate: "2026-11-26" });
Core.addPaycheck(data, { personId: girlfriend.id, amount: 600, date: "2026-11-12", nextDate: "2026-11-20" });
Core.addSpend(data, { personId: you.id, amount: 42, note: "Groceries", categoryId: food.id, date: "2026-11-12" });
Core.addBill(data, { name: "Electric", personId: girlfriend.id, amount: 95, categoryId: utilities.id, frequency: "monthly", firstDueDate: "2026-11-18" }, AS_OF);
const weekly = Core.addBill(data, { name: "Weekly thing", personId: girlfriend.id, amount: 10, categoryId: utilities.id, frequency: "weekly", firstDueDate: "2026-11-12" }, AS_OF);

const state = Core.computeState(data, AS_OF);

check("person 1 available = 850 - 42 = $808", () => {
  assert.strictEqual(state.people[0].available, 808);
});
check("person 2 available = 600 - 10 (weekly bill paid once) = $590", () => {
  assert.strictEqual(state.people[1].available, 590);
  assert.strictEqual(state.people[1].billsPaidTotal, 10);
});
check("combined available = $1,398", () => {
  assert.strictEqual(state.combinedAvailable, 1398);
});
check("weekly bill paid exactly once, on its due date", () => {
  const w = state.bills.find((b) => b.id === weekly.id);
  assert.strictEqual(w.paidCount, 1);
  assert.strictEqual(w.paidTotal, 10);
  assert.strictEqual(w.nextDue, "2026-11-19");
});
check("monthly bill has not paid before its first due date", () => {
  const e = state.bills.find((b) => b.name === "Electric");
  assert.strictEqual(e.paidCount, 0);
  assert.strictEqual(e.nextDue, "2026-11-18");
});
check("household next paycheck = soonest entered = 2026-11-20", () => {
  assert.strictEqual(state.summary.nextPaycheck, "2026-11-20");
});
check("bills due before next paycheck: 2 occurrences, $105", () => {
  assert.strictEqual(state.summary.upcomingCount, 2);
  assert.strictEqual(state.summary.upcomingTotal, 105);
  assert.deepStrictEqual(
    state.summary.upcoming.map((u) => u.date + " $" + u.amount),
    ["2026-11-18 $95", "2026-11-19 $10"]
  );
});
check("category view: Food total $42 across 1 entry", () => {
  const f = state.categories.find((c) => c.name === "Food");
  assert.strictEqual(f.total, 42);
  assert.strictEqual(f.count, 1);
});

check("back-dated first due date does NOT invent past payments", () => {
  const d2 = Core.createEmptyData();
  Core.addPaycheck(d2, { personId: d2.people[0].id, amount: 100, date: "2026-11-12", nextDate: null });
  // Weekly bill set up 2026-11-12 but first due back-dated to 2026-11-01:
  // schedule dates are Nov 1, Nov 8, Nov 15... none is payable by Nov 12,
  // because Nov 1 and Nov 8 precede the day the bill was set up.
  Core.addBill(d2, { name: "Backdated", personId: d2.people[0].id, amount: 5, categoryId: null, frequency: "weekly", firstDueDate: "2026-11-01" }, "2026-11-12");
  const s2 = Core.computeState(d2, "2026-11-12");
  assert.strictEqual(s2.people[0].billsPaidTotal, 0);
  assert.strictEqual(s2.people[0].available, 100);
  // By Nov 15 the first post-setup schedule date has arrived and pays once.
  const s3 = Core.computeState(d2, "2026-11-15");
  assert.strictEqual(s3.people[0].billsPaidTotal, 5);
  assert.strictEqual(s3.people[0].available, 95);
});

check("paused bill has no upcoming occurrences; resumed bill does", () => {
  Core.setBillActive(data, weekly.id, false);
  const paused = Core.computeState(data, AS_OF);
  assert.strictEqual(paused.bills.find((b) => b.id === weekly.id).nextDue, null);
  assert.strictEqual(paused.summary.upcomingCount, 1); // only Electric remains
  Core.setBillActive(data, weekly.id, true);
  assert.strictEqual(Core.computeState(data, AS_OF).summary.upcomingCount, 2);
});

check("renaming a person and adding a custom category work", () => {
  Core.updatePersonLabel(data, girlfriend.id, "Sam");
  assert.strictEqual(Core.computeState(data, AS_OF).people[1].label, "Sam");
  const cat = Core.addCategory(data, "Pets");
  Core.addSpend(data, { personId: girlfriend.id, amount: 8, note: "Cat food", categoryId: cat.id, date: AS_OF });
  const s = Core.computeState(data, AS_OF);
  assert.strictEqual(s.categories.find((c) => c.name === "Pets").total, 8);
  assert.strictEqual(s.people[1].available, 582);
});

console.log("\nAll " + passed + " checks passed.");
console.log(
  "Scenario totals -> You: $" + state.people[0].available +
  " | Girlfriend: $" + state.people[1].available +
  " | Combined: $" + state.combinedAvailable +
  " | Due before next paycheck: " + state.summary.upcomingCount +
  " bills, $" + state.summary.upcomingTotal
);
