/*
 * Supine Meal Plan engine: daily targets, portion sizing, batch amounts and
 * the shopping list.
 *
 * Pure functions, no DOM. The pages load it as window.Engine and
 * scripts/validate.mjs loads it with require(), so the numbers the weekly
 * check verifies are the numbers on screen.
 *
 * Model
 *   A recipe is a list of components (chicken, quinoa, roasted veg, sauce).
 *   Each component is a reference batch of catalog ingredients (`ing`, raw
 *   grams) and a `yield` (cooked weight / raw weight). From that we know the
 *   nutrition of 100 g of the finished component, which is what gets weighed
 *   into containers. `base` is the finished grams in one reference serving.
 *
 *   Portioning scales the protein components to hit the protein target and
 *   the carb components to fill the calories; veg and sauces move a little
 *   with appetite but stay put so fibre doesn't drop on a small plate.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEYS = ['kcal', 'p', 'f', 'c', 'fib'];

  // Physical activity level multipliers (FAO/WHO/UNU PAL bands).
  var ACTIVITY = {
    rest:     { pal: 1.2,   label: 'Rest & recovery', hint: 'Mostly lying down or sitting. A low-energy or recovery week.' },
    light:    { pal: 1.375, label: 'Light',           hint: 'Short walks, light chores, some time on your feet.' },
    moderate: { pal: 1.55,  label: 'Moderate',        hint: 'On your feet much of most days, or light exercise 3–4 times.' },
    active:   { pal: 1.725, label: 'Active',          hint: 'Exercise or physical work most days.' }
  };

  // Protein g/kg: 1.2–1.6 preserves lean mass and helps fullness; the top
  // of that range matters most in a calorie deficit (Morton 2018,
  // ISSN 2017 position stand, Leidy 2015).
  var GOALS = {
    lose:     { factor: 0.85, proteinPerKg: 1.6, label: 'Gentle fat loss', hint: 'About 15% under maintenance. Slow enough to protect energy and muscle.' },
    maintain: { factor: 1.0,  proteinPerKg: 1.4, label: 'Maintain',        hint: 'Eat to your estimated needs.' },
    gain:     { factor: 1.1,  proteinPerKg: 1.6, label: 'Build / regain',  hint: 'About 10% over maintenance.' }
  };

  // Share of the day's prepped food each slot carries. Lunch and dinner are
  // equal so the two mains are interchangeable containers. Protein is spread
  // evenly across meals (~0.4 g/kg per main meal, Schoenfeld & Aragon 2018).
  var SHARES = { breakfast: 0.25, main: 0.30, snack: 0.15 };
  var SLOTS_PER_DAY = { breakfast: 1, main: 2, snack: 1 };

  // protein/carb: how far each group can scale from the reference serving.
  // tilt: protein scale ÷ carb scale, so a dish still looks like itself.
  var LIMITS = { protein: [0.4, 3], carb: [0.25, 3.5], veg: [0.8, 1.3], tilt: [0.75, 1.6] };

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  function zero() { return { kcal: 0, p: 0, f: 0, c: 0, fib: 0 }; }
  function add(a, b, k) { KEYS.forEach(function (key) { a[key] += b[key] * (k == null ? 1 : k); }); return a; }
  function scale(a, k) { return add(zero(), a, k); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function sum(list, fn) { return list.reduce(function (s, x) { return s + fn(x); }, 0); }
  function round(n, step) { return Math.round(n / step) * step; }

  /* ------------------------------------------------------------------ *
   * Daily targets
   * ------------------------------------------------------------------ */
  function profileOk(pr) {
    return pr && pr.heightCm >= 120 && pr.heightCm <= 230 && pr.weightKg >= 30 &&
      pr.weightKg <= 300 && pr.age >= 16 && pr.age <= 100 && ACTIVITY[pr.activity] && GOALS[pr.goal];
  }

  // pr: { sex: 'f'|'m', age, heightCm, weightKg, activity, goal, flex, custom }
  function targets(pr) {
    var h = pr.heightCm / 100;
    var bmi = pr.weightKg / (h * h);
    // Mifflin-St Jeor: the best-validated resting estimate for adults.
    var bmr = 10 * pr.weightKg + 6.25 * pr.heightCm - 5 * pr.age + (pr.sex === 'm' ? 5 : -161);
    var pal = ACTIVITY[pr.activity].pal;
    var goal = GOALS[pr.goal];
    var tdee = bmr * pal;
    var floor = pr.sex === 'm' ? 1500 : 1200;
    var kcal = Math.max(tdee * goal.factor, floor);

    // Protein tracks lean mass, not total weight. Above BMI 30, count only a
    // quarter of the extra weight so protein doesn't balloon (continuous, so
    // a kilo either side of the line doesn't jump the target).
    var w30 = 30 * h * h;
    var basis = pr.weightKg <= w30 ? pr.weightKg : w30 + 0.25 * (pr.weightKg - w30);
    var protein = basis * goal.proteinPerKg;

    // Fibre: 14 g per 1000 kcal (Dietary Guidelines / IOM), and never under
    // 25 g; the Lancet 2019 meta-analysis saw benefits climb past 25–29 g.
    var fiber = Math.max(25, 14 * kcal / 1000);

    var custom = pr.custom || {};
    if (custom.kcal > 0) kcal = custom.kcal;
    if (custom.protein > 0) protein = custom.protein;
    if (custom.fiber > 0) fiber = custom.fiber;

    var fat = kcal * 0.30 / 9;           // middle of the 20–35% AMDR
    var carb = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
    var flex = clamp(pr.flex == null ? 0.1 : pr.flex, 0, 0.3);

    return {
      bmi: bmi, bmr: bmr, pal: pal, tdee: tdee, kcal: kcal,
      protein: protein, proteinBasisKg: basis, fiber: fiber, fat: fat, carb: carb,
      flex: flex,
      // What the prepped food itself should deliver: all the protein and
      // fibre, and everything but the flex allowance for coffee, treats etc.
      planned: { kcal: kcal * (1 - flex), p: protein, fib: fiber },
      custom: !!(custom.kcal > 0 || custom.protein > 0 || custom.fiber > 0)
    };
  }

  function slotTarget(t, slot) {
    var s = SHARES[slot];
    return { kcal: t.planned.kcal * s, p: t.planned.p * s, fib: t.planned.fib * s };
  }

  /* ------------------------------------------------------------------ *
   * Component nutrition
   * ------------------------------------------------------------------ */
  function rawWeight(comp) { return sum(Object.keys(comp.ing), function (id) { return comp.ing[id]; }); }

  // Nutrition of 100 g of the finished component.
  function per100(comp, foods) {
    var tot = zero();
    Object.keys(comp.ing).forEach(function (id) {
      var f = foods[id];
      if (!f) throw new Error('Unknown food "' + id + '" in component ' + comp.id);
      add(tot, f, comp.ing[id] / 100);
    });
    var finished = rawWeight(comp) * (comp.yield || 1);
    return scale(tot, 100 / finished);
  }

  /* ------------------------------------------------------------------ *
   * Portioning: grams of each component in one container
   * ------------------------------------------------------------------ */
  function roundGrams(g) { return g >= 40 ? round(g, 5) : Math.max(1, Math.round(g)); }

  function setGrams(part, g) {
    var c = part.c;
    if (c.piece) {
      var step = c.pieceStep || 1;
      var n = Math.max(step, round(g / c.piece, step));
      part.count = n;
      part.g = n * c.piece;
    } else {
      part.g = roundGrams(g);
    }
  }

  function portion(recipe, target, foods) {
    var parts = recipe.components.map(function (c) {
      return { c: c, per: per100(c, foods), g: c.base };
    });
    function nut(list, key) { return sum(list, function (x) { return x.per[key] * x.g / 100; }); }
    function nutBase(list, key) { return sum(list, function (x) { return x.per[key] * x.c.base / 100; }); }

    var prot = parts.filter(function (x) { return x.c.role === 'protein'; });
    var carb = parts.filter(function (x) { return x.c.role === 'carb'; });
    var rest = parts.filter(function (x) { return x.c.role !== 'protein' && x.c.role !== 'carb'; });

    // Veg and sauces follow appetite a little.
    var appetite = target.kcal / nutBase(parts, 'kcal');
    rest.forEach(function (x) { setGrams(x, x.c.base * clamp(appetite, LIMITS.veg[0], LIMITS.veg[1])); });

    var P = target.p - nut(rest, 'p'), K = target.kcal - nut(rest, 'kcal');
    var Pp = nutBase(prot, 'p'), Kp = nutBase(prot, 'kcal');
    var Pc = nutBase(carb, 'p'), Kc = nutBase(carb, 'kcal');
    var a = 1, b = 1;

    // Two equations, two unknowns: a scales protein parts, b scales carb parts.
    // The exact answer can turn a chicken bowl into a quinoa bowl, so the
    // protein:carb tilt is capped and calories decide the overall size. Going
    // over on protein is fine; the validator flags recipes that come in under.
    if (prot.length && carb.length) {
      var det = Pp * Kc - Pc * Kp;
      a = (P * Kc - Pc * K) / det;
      b = (Pp * K - P * Kp) / det;
      var r = a / b;
      if (!(b > 0) || !(r >= LIMITS.tilt[0] && r <= LIMITS.tilt[1])) {
        r = !(b > 0) ? LIMITS.tilt[1] : clamp(r, LIMITS.tilt[0], LIMITS.tilt[1]);
        b = K / (r * Kp + Kc);
        a = r * b;
      }
      a = clamp(a, LIMITS.protein[0], LIMITS.protein[1]);
    } else if (prot.length) {
      a = clamp(P / Pp, LIMITS.protein[0], LIMITS.protein[1]);
    } else if (carb.length) {
      b = clamp(K / Kc, LIMITS.carb[0], LIMITS.carb[1]);
    }

    // Round protein first (pieces can move it a lot), then refill calories.
    prot.forEach(function (x) { setGrams(x, x.c.base * a); });
    if (carb.length) {
      var left = target.kcal - nut(rest, 'kcal') - nut(prot, 'kcal');
      b = clamp(left / Kc, LIMITS.carb[0], LIMITS.carb[1]);
      // maxScale stops a side from taking over (two pears is a lot of pear).
      carb.forEach(function (x) { setGrams(x, x.c.base * Math.min(b, x.c.maxScale || Infinity)); });
    }

    var total = zero();
    var out = parts.map(function (x) {
      var n = scale(x.per, x.g / 100);
      add(total, n);
      return {
        id: x.c.id, name: x.c.name, role: x.c.role, g: x.g, count: x.count,
        pieceName: x.c.pieceName, side: !!x.c.side, nut: n
      };
    });
    return { recipe: recipe.id, parts: out, total: total, target: target };
  }

  /* ------------------------------------------------------------------ *
   * A plan for one person
   * ------------------------------------------------------------------ */
  function recipeIndex(week) {
    var idx = {};
    week.plans.forEach(function (pl) { pl.recipes.forEach(function (r) { idx[r.id] = r; }); });
    return idx;
  }

  // Which recipes a plan uses, with the slot each fills.
  function planRecipes(plan) {
    var R = {};
    plan.recipes.forEach(function (r) { R[r.id] = r; });
    var list = [{ r: R[plan.meals.breakfast], slot: 'breakfast' }];
    plan.meals.mains.forEach(function (id) { list.push({ r: R[id], slot: 'main' }); });
    list.push({ r: R[plan.meals.snack], slot: 'snack' });
    return list;
  }

  function personalise(plan, t, foods) {
    var items = planRecipes(plan).map(function (x) {
      return { recipe: x.r, slot: x.slot, portion: portion(x.r, slotTarget(t, x.slot), foods) };
    });
    var day = zero();
    items.forEach(function (x) { add(day, x.portion.total); });
    return { plan: plan, items: items, day: day };
  }

  /* ------------------------------------------------------------------ *
   * Batch: how much to cook for `days` containers of each recipe
   * ------------------------------------------------------------------ */
  function batchComponent(comp, gramsPerServing, servings) {
    var ref = rawWeight(comp), y = comp.yield || 1;
    var rawNeeded = gramsPerServing * servings / y;
    var mult, ing = {};
    if (comp.batchStep) {
      // Composite dishes are cooked in whole multiples of a recipe built
      // around whole cans and packs; leftovers become freezer backups.
      mult = Math.max(comp.batchStep, Math.ceil(rawNeeded / ref / comp.batchStep - 0.03) * comp.batchStep);
    } else {
      mult = rawNeeded / ref;
    }
    Object.keys(comp.ing).forEach(function (id) { ing[id] = comp.ing[id] * mult; });
    var finished = ref * mult * y;
    return {
      ing: ing, mult: mult, finished: finished, perServing: gramsPerServing,
      makes: Math.floor(finished / gramsPerServing + 0.05), servings: servings
    };
  }

  function batches(personal, days) {
    return personal.items.map(function (x) {
      var comps = {};
      x.recipe.components.forEach(function (c) {
        var part = x.portion.parts.filter(function (p) { return p.id === c.id; })[0];
        comps[c.id] = batchComponent(c, part.g, days);
      });
      return { recipe: x.recipe, slot: x.slot, comps: comps };
    });
  }

  /* ------------------------------------------------------------------ *
   * Shopping
   * ------------------------------------------------------------------ */
  // What the batches use, less what's on hand. `have` is grams by food id
  // (missing = none). Each line: need, have, short, and what to buy.
  function shopping(bs, foods, have) {
    have = have || {};
    var need = {};
    bs.forEach(function (b) {
      Object.keys(b.comps).forEach(function (cid) {
        var ing = b.comps[cid].ing;
        Object.keys(ing).forEach(function (id) {
          if (!need[id]) need[id] = { id: id, g: 0, uses: [] };
          need[id].g += ing[id];
          if (need[id].uses.indexOf(b.recipe.name) === -1) need[id].uses.push(b.recipe.name);
        });
      });
    });
    return Object.keys(need).map(function (id) {
      var n = need[id], f = foods[id];
      n.food = f;
      n.have = Math.max(0, have[id] || 0);
      // A sliver short (under 5%) counts as enough; nobody buys a can for 10 g.
      n.short = n.g - n.have > n.g * 0.05 ? n.g - n.have : 0;
      n.buyG = n.short ? buyGrams(f, n.short) : 0;
      n.buy = n.short ? buyText(f, n.short) : '';
      n.needText = amount(f, n.g);
      return n;
    });
  }

  // Grams actually brought home when buying `g`: whole packs or pieces.
  function buyGrams(f, g) {
    if (f.pack) return Math.max(1, Math.ceil(g / f.pack.g - 0.05)) * f.pack.g;
    if (f.piece) return Math.max(1, Math.ceil(g / f.piece - 0.1)) * f.piece;
    return Math.ceil(g / 50) * 50;
  }

  // How to count a food in the pantry: cans, eggs, or grams/ml.
  function invUnit(f) {
    if (f.piece) return { per: f.piece, label: plural(2, f.pieceName || f.short), step: 1 };
    if (f.byPack && f.pack) return { per: f.pack.g, label: plural(2, f.pack.name, f.pack.plural), step: 0.25 };
    return { per: 1, label: f.liquid ? 'ml' : 'g', step: 10 };
  }

  /* ------------------------------------------------------------------ *
   * Formatting amounts
   * ------------------------------------------------------------------ */
  var FRACTIONS = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
  function frac(x) {
    var q = Math.round(x * 4) / 4, whole = Math.floor(q), part = q - whole;
    if (q === 0) return '¼';
    return (whole ? String(whole) : '') + (FRACTIONS[part] || '');
  }
  function plural(n, one, many) { return n > 1 ? (many || one + 's') : one; }

  function grams(g, liquid) {
    var u = liquid ? 'ml' : 'g', U = liquid ? 'L' : 'kg';
    if (g >= 1000) return (Math.round(g / 100) / 10) + ' ' + U;
    if (g >= 100) return round(g, 10) + ' ' + u;
    return Math.max(1, Math.round(g)) + ' ' + u;
  }

  // An amount for a recipe or a prep step: "1½ cans black beans", "6 eggs",
  // "420 g chicken breast".
  function amount(f, g) {
    if (f.piece) {
      var n = Math.max(1, Math.round(g / f.piece * 2) / 2);
      return frac(n) + ' ' + plural(n, f.pieceName || f.short);
    }
    if (f.byPack && f.pack) {
      var p = g / f.pack.g;
      return frac(p) + ' ' + plural(p, f.pack.name, f.pack.plural) + ' ' + f.short;
    }
    return grams(g, f.liquid) + ' ' + f.short;
  }

  // What to put in the cart.
  function buyText(f, g) {
    if (f.pack) {
      var n = Math.max(1, Math.ceil(g / f.pack.g - 0.05));
      var s = n + ' ' + plural(n, f.pack.name, f.pack.plural);
      if (!f.byPack && f.pack.name.indexOf(' ') === -1) s += ' (' + grams(f.pack.g, f.liquid) + (n > 1 ? ' each' : '') + ')';
      return s;
    }
    if (f.piece) {
      var c = Math.max(1, Math.ceil(g / f.piece - 0.1));
      return c + ' ' + plural(c, f.pieceName || f.short);
    }
    return 'about ' + grams(Math.ceil(g / 50) * 50, f.liquid);
  }

  // How a component reads in a step: single ingredient → one amount;
  // composite → the list.
  function batchText(b, foods) {
    return Object.keys(b.ing).map(function (id) { return amount(foods[id], b.ing[id]); }).join(', ');
  }

  // Sum several components' ingredients ("B-m1.rice+B-m2.rice") for a step.
  function mergeIng(list) {
    var ing = {};
    list.forEach(function (b) {
      Object.keys(b.ing).forEach(function (id) { ing[id] = (ing[id] || 0) + b.ing[id]; });
    });
    return { ing: ing };
  }

  function portionText(part) {
    if (part.count) return frac(part.count) + ' ' + plural(part.count, part.pieceName || 'piece') + ' (' + part.g + ' g)';
    return part.g + ' g';
  }

  return {
    KEYS: KEYS, ACTIVITY: ACTIVITY, GOALS: GOALS, SHARES: SHARES, SLOTS_PER_DAY: SLOTS_PER_DAY,
    profileOk: profileOk, targets: targets, slotTarget: slotTarget,
    per100: per100, portion: portion, recipeIndex: recipeIndex, planRecipes: planRecipes,
    personalise: personalise, batchComponent: batchComponent, batches: batches, shopping: shopping,
    buyGrams: buyGrams, invUnit: invUnit,
    amount: amount, grams: grams, batchText: batchText, mergeIng: mergeIng, portionText: portionText,
    frac: frac, zero: zero, add: add, scale: scale
  };
});
