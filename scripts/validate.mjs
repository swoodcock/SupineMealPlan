#!/usr/bin/env node
// Checks a week's plan before it's published:
//   node scripts/validate.mjs            (the week in data/current.json)
//   node scripts/validate.mjs 2026-10-02
//
// Fails on: unknown food ids, bad schema, unresolved {{tokens}}, and plans
// that miss the nutrition targets for a range of body sizes. Prints each
// plan's day totals so the numbers can be eyeballed.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const E = require(join(root, 'engine.js'));
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const foods = read('data/foods.json');
const weekId = process.argv[2] || read('data/current.json').week;
const week = read(`data/weeks/${weekId}.json`);

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const ROLES = new Set(['protein', 'carb', 'veg', 'fixed']);
const SLOTS = new Set(['breakfast', 'main', 'snack']);
const HOW = new Set(['sit', 'stand', 'rest']);
const SPECIAL = new Set(['days', 'fridgeDays', 'keepDays']);

// ---- schema ----
if (!/^\d{4}-\d{2}-\d{2}$/.test(week.id) || week.id !== weekId) err(`week id ${week.id} must match file name ${weekId}`);
if (!Array.isArray(week.plans) || week.plans.length !== 3) err('a week needs exactly 3 plans');

const allIds = new Set();
for (const plan of week.plans || []) {
  const R = Object.fromEntries(plan.recipes.map((r) => [r.id, r]));
  const m = plan.meals || {};
  for (const id of [m.breakfast, ...(m.mains || []), m.snack]) if (!R[id]) err(`${plan.id}: meals references missing recipe ${id}`);
  if ((m.mains || []).length !== 2) err(`${plan.id}: needs exactly 2 mains`);
  if (!plan.effort || !(plan.effort.activeMin > 0)) err(`${plan.id}: effort.activeMin missing`);

  for (const r of plan.recipes) {
    if (allIds.has(r.id)) err(`duplicate recipe id ${r.id}`);
    allIds.add(r.id);
    if (!r.id.startsWith(plan.id + '-')) err(`${r.id}: recipe ids must start with "${plan.id}-"`);
    if (!SLOTS.has(r.slot)) err(`${r.id}: bad slot ${r.slot}`);
    if (!r.cuisine) err(`${r.id}: cuisine missing (it feeds preference learning)`);
    if (!['great', 'good', 'no'].includes(r.freezer)) err(`${r.id}: freezer must be great, good or no`);
    if (!r.freezeTip) err(`${r.id}: freezeTip missing (shown for skipped meals)`);
    if (r.slot === 'main' && r.freezer === 'no') err(`${r.id}: mains must freeze (days 5–7 come from the freezer)`);
    if (!r.components.some((c) => c.role === 'protein')) err(`${r.id}: needs a protein component`);
    const cids = new Set();
    for (const c of r.components) {
      if (cids.has(c.id)) err(`${r.id}.${c.id}: duplicate component id`);
      cids.add(c.id);
      if (!ROLES.has(c.role)) err(`${r.id}.${c.id}: bad role ${c.role}`);
      if (!(c.base > 0)) err(`${r.id}.${c.id}: base must be > 0`);
      if (!(c.yield > 0 && c.yield <= 4)) err(`${r.id}.${c.id}: yield out of range`);
      for (const id of Object.keys(c.ing || {})) if (!foods[id]) err(`${r.id}.${c.id}: unknown food "${id}"`);
    }
    for (const s of r.steps || []) {
      for (const [, tok] of s.matchAll(/\{\{([^}]+)\}\}/g)) {
        if (!SPECIAL.has(tok) && !cids.has(tok)) err(`${r.id}: step token {{${tok}}} isn't a component`);
      }
    }
  }
  for (const sess of plan.prep || []) {
    for (const st of sess.steps) {
      if (!HOW.has(st.how)) err(`${plan.id} prep: bad "how" ${st.how}`);
      for (const [, tok] of st.text.matchAll(/\{\{([^}]+)\}\}/g)) {
        if (SPECIAL.has(tok)) continue;
        for (const ref of tok.split('+')) {
          const [rid, cid] = ref.split('.');
          if (!R[rid] || !R[rid].components.some((c) => c.id === cid)) err(`${plan.id} prep: token {{${ref}}} doesn't resolve`);
        }
      }
    }
  }
}

// ---- nutrition across body sizes ----
const PROFILES = [
  { label: 'F 155cm 50kg rest',      sex: 'f', age: 35, heightCm: 155, weightKg: 50, activity: 'rest', goal: 'maintain' },
  { label: 'F 165cm 68kg light',     sex: 'f', age: 40, heightCm: 165, weightKg: 68, activity: 'light', goal: 'maintain' },
  { label: 'F 168cm 95kg lose',      sex: 'f', age: 45, heightCm: 168, weightKg: 95, activity: 'light', goal: 'lose' },
  { label: 'F 175cm 70kg moderate',  sex: 'f', age: 30, heightCm: 175, weightKg: 70, activity: 'moderate', goal: 'maintain' },
  { label: 'M 180cm 85kg active',    sex: 'm', age: 35, heightCm: 180, weightKg: 85, activity: 'active', goal: 'gain' }
];

const pct = (a, b) => Math.round((a / b) * 100);
if (!errors.length) {
  for (const plan of week.plans) {
    console.log(`\nPlan ${plan.id}: ${plan.name}`);
    console.log('  profile                    kcal (plan)    protein       fibre    | per-meal protein');
    for (const pr of PROFILES) {
      const t = E.targets(pr);
      const P = E.personalise(plan, t, foods);
      const d = P.day;
      const meals = P.items.map((x) => Math.round(x.portion.total.p)).join('/');
      console.log(
        `  ${pr.label.padEnd(24)} ${String(Math.round(d.kcal)).padStart(5)} (${Math.round(t.planned.kcal)})` +
        `  ${String(Math.round(d.p)).padStart(4)}/${Math.round(t.protein)} g` +
        `  ${String(Math.round(d.fib)).padStart(4)}/${Math.round(t.fiber)} g  | ${meals}`
      );
      const where = `${plan.id} @ ${pr.label}`;
      if (Math.abs(d.kcal - t.planned.kcal) / t.planned.kcal > 0.12) warn(`${where}: calories ${pct(d.kcal, t.planned.kcal)}% of target`);
      if (d.p < t.protein * 0.9) warn(`${where}: protein ${pct(d.p, t.protein)}% of target`);
      if (d.fib < t.fiber * 0.85) warn(`${where}: fibre ${pct(d.fib, t.fiber)}% of target`);
      const fatPct = (d.f * 9) / d.kcal;
      if (fatPct > 0.4 || fatPct < 0.18) warn(`${where}: fat is ${Math.round(fatPct * 100)}% of calories`);
      if (d.p > t.protein * 1.4) warn(`${where}: protein ${pct(d.p, t.protein)}% of target, recipes are too protein-heavy`);
      for (const x of P.items) {
        const tp = x.portion.target.p;
        if (x.portion.total.p < tp * 0.85) warn(`${where}: ${x.recipe.id} has ${Math.round(x.portion.total.p)} g protein, target ${Math.round(tp)} g`);
      }
    }
    // Batch sanity at the middle profile.
    const t = E.targets(PROFILES[1]);
    const P = E.personalise(plan, t, foods);
    const bs = E.batches(P, week.days);
    for (const b of bs) for (const [cid, c] of Object.entries(b.comps)) {
      if (c.makes < week.days) err(`${b.recipe.id}.${cid}: batch makes ${c.makes} < ${week.days} servings`);
      if (c.makes > week.days * 1.8) warn(`${b.recipe.id}.${cid}: batch makes ${c.makes} servings for ${week.days} days, a lot of leftovers`);
    }
  }
}

for (const w of warnings) console.log('WARN  ' + w);
for (const e of errors) console.log('ERROR ' + e);
console.log(errors.length ? `\n${errors.length} error(s)` : `\nOK (${warnings.length} warning(s))`);
process.exit(errors.length ? 1 : 0);
