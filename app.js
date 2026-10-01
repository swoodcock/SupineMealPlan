/*
 * Supine Meal Plan UI. Renders this week's plans (data/current.json →
 * data/weeks/<id>.json) and the recipe book (data/book.json), sized to the
 * profile saved on this device. All the maths lives in engine.js.
 *
 * Storage (localStorage, this device only):
 *   supine_profile_v1     personal details and settings, kept forever
 *   supine_pantry_v1      { have: {foodId: grams}, sent }   kept forever
 *   supine_week_<id>      { chosen, reported, shop, saved, feedback,
 *                           review, bought, made }          per week
 *
 * Pantry bookkeeping, per plan: ticking a shopping item adds what was bought
 * to `have` (remembered in bought[plan]); "prep done" takes what the plan
 * used back out (remembered in made[plan]). So what was on hand before shopping
 * is always have + made − bought, and both steps can be undone.
 */
(function () {
  'use strict';

  var E = window.Engine;
  var WORKER_URL = 'https://supine-meal-plan.woodcock-s.workers.dev';
  var NOTES_ALLOWED = /[^A-Za-z0-9 .,!'?-]/g;
  var PROFILE_KEY = 'supine_profile_v1';
  var PANTRY_KEY = 'supine_pantry_v1';
  var MAX_QTY = 100000;
  var PAGE = document.body.dataset.page;

  // Used to show sensible portions before any details are filled in.
  var EXAMPLE = { sex: 'f', age: 40, heightCm: 165, weightKg: 68, activity: 'light', goal: 'maintain' };

  var SLOT_LABEL = { breakfast: 'Breakfast', main: 'Lunch & dinner', snack: 'Snack' };
  var SLOT_ICON = { breakfast: '🍳', main: '🍲', snack: '🍓' };
  var GROUPS = [
    ['meat', '🍗 Meat'], ['dairy', '🥛 Dairy & eggs'], ['produce', '🥬 Produce'], ['frozen', '🧊 Frozen'],
    ['bakery', '🍞 Bakery'], ['pantry', '🥫 Canned & dry'], ['sauces', '🫙 Sauces & spreads']
  ];
  var HOW = { sit: ['🪑', 'Sit'], stand: ['🧍', 'Stand'], rest: ['🛋️', 'Rest'] };
  var FREEZE = { great: '❄️ Freezes great', good: '❄️ Freezes well', no: '🚫 Fridge only' };

  var S = { foods: null, week: null, book: [], profile: null, pantry: null, ws: null, view: null, tab: null, invView: 'week' };

  /* ---------------- utilities ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function load(k) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
  }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function getJSON(p) {
    return fetch(p, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(p + ' → ' + r.status);
      return r.json();
    });
  }
  function $(id) { return document.getElementById(id); }
  function r0(n) { return Math.round(n); }
  function num(v) { var n = parseFloat(v); return isFinite(n) && n > 0 ? n : null; }
  function dispatch(body) {
    return fetch(WORKER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  /* ---------------- profile ---------------- */
  function defaultProfile() {
    return { sex: 'f', age: null, heightCm: null, weightKg: null, units: { h: 'cm', w: 'kg' },
      activity: 'light', goal: 'maintain', flex: 0.1, days: null, freezeMore: false, custom: {} };
  }
  function loadProfile() {
    var p = Object.assign(defaultProfile(), load(PROFILE_KEY) || {});
    p.units = Object.assign({ h: 'cm', w: 'kg' }, p.units || {});
    p.custom = p.custom || {};
    return p;
  }
  function saveProfile() { store(PROFILE_KEY, S.profile); }
  function hasProfile() { return !!E.profileOk(S.profile); }
  function days() {
    var d = parseInt(S.profile.days, 10);
    return d >= 3 && d <= 7 ? d : S.week ? S.week.days : 7;
  }
  // keepDays: how long cooked food is good in the fridge (food safety).
  // fridgeDays: how many days of freezable meals stay in the fridge;
  // "freeze more" keeps just 2, so skipped meals are easy to save.
  function keepDays() { return S.week ? S.week.fridgeDays : 4; }
  function fridgeDays() { return S.profile.freezeMore ? 2 : keepDays(); }
  function T() { return E.targets(hasProfile() ? S.profile : Object.assign({}, EXAMPLE, { flex: S.profile.flex })); }

  /* ---------------- pantry ---------------- */
  // Only catalog foods with sane numbers, so stale or hand-edited data can't
  // break rendering. Pantry staples (oil, spices) are assumed, not tracked.
  function cleanHave(m) {
    var out = {};
    if (m && typeof m === 'object') {
      Object.keys(m).forEach(function (id) {
        var n = parseFloat(m[id]);
        if (S.foods[id] && !S.foods[id].pantry && isFinite(n) && n > 0 && n <= MAX_QTY) out[id] = n;
      });
    }
    return out;
  }
  function loadPantry() {
    var p = load(PANTRY_KEY) || {};
    S.pantry = { have: cleanHave(p.have), sent: p.sent || null };
  }
  function savePantry() { store(PANTRY_KEY, S.pantry); }
  function addHave(id, g) {
    var v = (S.pantry.have[id] || 0) + g;
    if (v > 0.5) S.pantry.have[id] = Math.min(MAX_QTY, v); else delete S.pantry.have[id];
  }
  // What was on hand before this plan's shopping and prep (see header comment).
  function preHave(planId) {
    var out = Object.assign({}, S.pantry.have), b = S.ws.bought[planId] || {}, m = S.ws.made[planId] || {};
    Object.keys(m).forEach(function (id) { out[id] = (out[id] || 0) + m[id]; });
    Object.keys(b).forEach(function (id) { out[id] = Math.max(0, (out[id] || 0) - b[id]); });
    return out;
  }
  function trackable(n) { return !n.food.pantry; }

  /* ---------------- per-plan numbers ---------------- */
  function compute(plan) {
    var P = E.personalise(plan, T(), S.foods);
    var bs = E.batches(P, days());
    var batch = {};
    bs.forEach(function (b) { batch[b.recipe.id] = b.comps; });
    return { P: P, bs: bs, batch: batch };
  }
  function planById(id) {
    return S.week.plans.filter(function (p) { return p.id === id; })[0] || S.week.plans[0];
  }

  // Fill {{tokens}} in a step with this person's batch amounts.
  function fill(text, batch, rid) {
    return esc(text).replace(/\{\{([^}]+)\}\}/g, function (_, tok) {
      if (tok === 'days') return '<b>' + days() + '</b>';
      if (tok === 'fridgeDays') return '<b>' + Math.min(fridgeDays(), days()) + '</b>';
      if (tok === 'keepDays') return '<b>' + Math.min(keepDays(), days()) + '</b>';
      var list = tok.split('+').map(function (ref) {
        var p = ref.indexOf('.') > -1 ? ref.split('.') : [rid, ref];
        return batch[p[0]] && batch[p[0]][p[1]];
      });
      if (list.some(function (x) { return !x; })) return '…';
      var b = list.length === 1 ? list[0] : E.mergeIng(list);
      return '<b>' + esc(E.batchText(b, S.foods)) + '</b>';
    });
  }

  function macroLine(n) {
    return '<b>' + r0(n.kcal) + '</b> kcal · <b>' + r0(n.p) + ' g</b> protein · <b>' + r0(n.fib) + ' g</b> fibre · ' +
      r0(n.f) + ' g fat · ' + r0(n.c) + ' g carbs';
  }

  function storageText(recipe) {
    var d = days();
    if (recipe.freezer === 'no') {
      var k = Math.min(keepDays(), d);
      if (d <= k + 1) return 'Fridge only. All ' + d + ' keep fine for the week.';
      return 'Fridge only. Make days 1–' + k + ' on prep day and the last ' + (d - k) + ' on day ' + k + ' (about 3 minutes).';
    }
    var f = Math.min(fridgeDays(), d);
    if (d <= f) return 'All ' + d + ' go in the fridge.';
    return 'Days 1–' + f + ' in the fridge, days ' + (f + 1) + '–' + d + ' in the freezer. Move one to the fridge the night before.';
  }

  function freezeLine(recipe) {
    if (!FREEZE[recipe.freezer]) return '';
    return '<div class="freeze ' + esc(recipe.freezer) + '"><b>' + FREEZE[recipe.freezer] + '.</b> ' + esc(recipe.freezeTip || '') + '</div>';
  }

  /* ---------------- recipe card (week tab + book) ---------------- */
  function recipeCard(recipe, portion, batch, opts) {
    var n = opts.count;
    var rows = portion.parts.map(function (p) {
      return '<div class="row"><span>' + esc(p.name) + (p.side ? '<span class="side">ON THE SIDE</span>' : '') + '</span><b>' +
        esc(E.portionText(p)) + '</b></div>';
    }).join('');

    var batchInfo = recipe.components.filter(function (c) { return c.batchStep; }).map(function (c) {
      var b = batch[recipe.id][c.id];
      var pieces = c.piece ? ' (about ' + Math.round(b.finished / c.piece) + ' ' + (c.pieceName || 'piece') + 's)' : '';
      return b.makes > n
        ? '<div class="note">The ' + esc(c.name.toLowerCase()) + ' batch makes about <b>' + b.makes + '</b> portions' + pieces +
          ' at your size. You need ' + n + '; freeze the extra ' + (b.makes - n) + ' as backups for low days.</div>'
        : '';
    }).join('');

    var steps = (recipe.steps || []).map(function (s) { return '<li>' + fill(s, batch, recipe.id) + '</li>'; }).join('');
    var notes = (recipe.notes || []).map(function (s) { return '<div class="note">' + esc(s) + '</div>'; }).join('');

    return '<details class="card" id="rc-' + esc(recipe.id) + '"' + (opts.open ? ' open' : '') + ' data-name="' + esc(recipe.name) + '">' +
      '<summary><div class="cnum">' + SLOT_ICON[recipe.slot] + '</div><div class="ctitle"><div class="t">' + esc(recipe.name) + '</div>' +
      '<div class="s">' + esc(opts.subtitle) + '</div></div><div class="chev">▾</div></summary>' +
      '<div class="cbody">' +
      '<p class="small">' + esc(recipe.summary) + '</p>' +
      '<h4>Each container</h4><div class="pcard">' + rows +
      '<div class="macros">' + macroLine(portion.total) + '</div>' +
      '<div class="storage">🧊 ' + storageText(recipe) + '</div></div>' +
      freezeLine(recipe) +
      batchInfo +
      '<h4>Make it (amounts are for ' + n + ' portions)</h4><ol>' + steps + '</ol>' + notes +
      (opts.extra || '') +
      '</div></details>';
  }

  // Save to the book (a like) or "not for me" (a dislike). Both teach the
  // weekly planner; only one can be sent per recipe.
  function saveWidget(recipe) {
    var rid = recipe.id;
    var inBook = S.book.some(function (b) { return b.week === S.week.id && b.recipe && b.recipe.id === rid; });
    if (inBook) return '<div class="savewidget"><span class="savestatus">📖 In the Recipe Book</span></div>';
    if (S.ws.saved[rid]) return '<div class="savewidget"><span class="savestatus">✅ Saved. It shows up in the Recipe Book in a few minutes.</span></div>';
    if (S.ws.feedback[rid]) return '<div class="savewidget"><span class="savestatus">👎 Noted. The planner will steer away from dishes like this.</span></div>';
    return '<div class="savewidget" data-rid="' + esc(rid) + '">' +
      '<button class="btn ghost small" data-act="fbopen" data-kind="save">💾 Save to Recipe Book</button> ' +
      '<button class="btn ghost small" data-act="fbopen" data-kind="less">👎 Not for me</button>' +
      '<div class="savebox"><textarea maxlength="300"></textarea>' +
      '<button class="btn small" data-act="fbsubmit">Send</button></div></div>';
  }

  /* ================================================================== *
   * Me
   * ================================================================== */
  function renderMe() {
    var p = S.profile;
    var h = p.heightCm, w = p.weightKg;
    var ft = h ? Math.floor(h / 30.48) : '', inch = h ? Math.round((h / 2.54) % 12) : '';
    var heightInputs = p.units.h === 'cm'
      ? '<input type="number" inputmode="decimal" id="f-hcm" placeholder="cm" value="' + (h ? r0(h) : '') + '">'
      : '<div class="inline"><input type="number" inputmode="numeric" id="f-hft" placeholder="ft" value="' + ft + '">' +
        '<input type="number" inputmode="numeric" id="f-hin" placeholder="in" value="' + inch + '"></div>';
    var weightVal = w ? (p.units.w === 'kg' ? Math.round(w * 10) / 10 : Math.round(w * 2.20462)) : '';

    function radios(name, map, current) {
      return '<div class="choices">' + Object.keys(map).map(function (k) {
        return '<label class="choice"><input type="radio" name="' + name + '" value="' + k + '"' + (k === current ? ' checked' : '') + '>' +
          '<div><b>' + esc(map[k].label) + '</b><span>' + esc(map[k].hint) + '</span></div></label>';
      }).join('') + '</div>';
    }

    $('tab-me').innerHTML =
      '<h2 class="sec">About you</h2>' +
      '<div class="note">Your details stay on this phone and are only used to size your portions. Change the activity level each Friday if the week ahead looks different.</div>' +
      '<div class="box"><div class="form">' +
        '<div class="field"><label>Sex (for the calorie formula)</label><select id="f-sex"><option value="f">Female</option><option value="m">Male</option></select></div>' +
        '<div class="field"><label>Age</label><input type="number" inputmode="numeric" id="f-age" value="' + (p.age || '') + '"></div>' +
        '<div class="field"><label>Height <span class="seg" data-unit="h"><button data-u="cm">cm</button><button data-u="ft">ft/in</button></span></label>' + heightInputs + '</div>' +
        '<div class="field"><label>Weight <span class="seg" data-unit="w"><button data-u="kg">kg</button><button data-u="lb">lb</button></span></label>' +
          '<input type="number" inputmode="decimal" id="f-w" placeholder="' + p.units.w + '" value="' + weightVal + '"></div>' +
      '</div></div>' +
      '<h2 class="sec">Activity this week</h2>' + radios('activity', E.ACTIVITY, p.activity) +
      '<p class="small muted">On a low-energy or recovery week, pick Rest. Portions get a little smaller, but protein stays the same because it\'s based on your body, not your activity.</p>' +
      '<h2 class="sec">Goal</h2>' + radios('goal', E.GOALS, p.goal) +
      '<div class="box"><details class="more"><summary>Fine-tune</summary>' +
        '<div class="form" style="margin-top:10px">' +
          '<div class="field"><label>Days to prep</label><select id="f-days">' + [7, 6, 5, 4, 3].map(function (d) {
            return '<option value="' + d + '"' + (d === days() ? ' selected' : '') + '>' + d + ' days</option>';
          }).join('') + '</select></div>' +
          '<div class="field"><label>Room for extras (coffee, treats)</label><select id="f-flex">' + [0, 0.1, 0.2].map(function (f) {
            return '<option value="' + f + '"' + (Math.abs(f - p.flex) < 0.01 ? ' selected' : '') + '>' + Math.round(f * 100) + '% of calories</option>';
          }).join('') + '</select></div>' +
          '<div class="field full"><label>Fridge or freezer</label><select id="f-freeze">' +
            '<option value="0"' + (p.freezeMore ? '' : ' selected') + '>Standard: fridge for the first ' + keepDays() + ' days, then freezer</option>' +
            '<option value="1"' + (p.freezeMore ? ' selected' : '') + '>Freeze more: fridge for 2 days, freeze the rest (easier if you skip meals)</option>' +
          '</select></div>' +
          '<div class="field full"><label>My own targets (optional, overrides the estimate)</label><div class="inline">' +
            '<input type="number" inputmode="numeric" id="f-ck" placeholder="kcal/day" value="' + (p.custom.kcal || '') + '">' +
            '<input type="number" inputmode="numeric" id="f-cp" placeholder="protein g" value="' + (p.custom.protein || '') + '">' +
            '<input type="number" inputmode="numeric" id="f-cf" placeholder="fibre g" value="' + (p.custom.fiber || '') + '">' +
          '</div></div>' +
        '</div></details></div>' +
      '<div id="targets"></div>' +
      '<div class="box"><details class="more"><summary>Move these settings to another device</summary>' +
        '<p class="small">Copy a code here, then paste it on the other phone. It includes your pantry.</p>' +
        '<button class="btn ghost small" id="f-export">Copy settings code</button> <button class="btn ghost small" id="f-import">Paste settings code</button>' +
      '</details></div>';

    $('f-sex').value = p.sex;
    document.querySelectorAll('.seg').forEach(function (seg) {
      seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.dataset.u === p.units[seg.dataset.unit]); });
    });
    renderTargets();
  }

  function readMe() {
    var p = S.profile;
    p.sex = $('f-sex').value;
    p.age = num($('f-age').value);
    if (p.units.h === 'cm') p.heightCm = num($('f-hcm').value);
    else {
      var ft = num($('f-hft').value) || 0, inch = parseFloat($('f-hin').value) || 0;
      p.heightCm = ft ? (ft * 12 + inch) * 2.54 : null;
    }
    var wv = num($('f-w').value);
    p.weightKg = wv ? (p.units.w === 'kg' ? wv : wv / 2.20462) : null;
    var a = document.querySelector('input[name=activity]:checked'); if (a) p.activity = a.value;
    var g = document.querySelector('input[name=goal]:checked'); if (g) p.goal = g.value;
    p.days = parseInt($('f-days').value, 10);
    p.flex = parseFloat($('f-flex').value);
    p.freezeMore = $('f-freeze').value === '1';
    p.custom = { kcal: num($('f-ck').value), protein: num($('f-cp').value), fiber: num($('f-cf').value) };
    saveProfile();
    renderTargets();
    renderPlans();
  }

  function renderTargets() {
    var el = $('targets');
    if (!hasProfile()) {
      el.innerHTML = '<div class="note warn">Fill in age, height and weight to see your targets. Until then, the plans show example portions for a 165 cm, 68 kg woman.</div>';
      return;
    }
    var t = T();
    var rows = [['Breakfast', 'breakfast'], ['Lunch', 'main'], ['Dinner', 'main'], ['Snack', 'snack']].map(function (x) {
      var s = E.slotTarget(t, x[1]);
      return '<tr><td>' + x[0] + '</td><td>' + r0(s.kcal) + '</td><td>' + r0(s.p) + ' g</td><td>' + r0(s.fib) + ' g</td></tr>';
    }).join('');
    var flexK = t.kcal - t.planned.kcal;
    el.innerHTML =
      '<h2 class="sec">Your daily targets' + (t.custom ? ' (your own)' : '') + '</h2>' +
      '<div class="stats">' +
        '<div class="stat"><div class="v">' + r0(t.kcal) + '</div><div class="l">calories / day</div></div>' +
        '<div class="stat"><div class="v">' + r0(t.protein) + '<small> g</small></div><div class="l">protein</div></div>' +
        '<div class="stat"><div class="v">' + r0(t.fiber) + '<small> g</small></div><div class="l">fibre</div></div>' +
        '<div class="stat"><div class="v">' + r0(t.fat) + '<small> g</small></div><div class="l">fat (about 30%)</div></div>' +
        '<div class="stat"><div class="v">' + r0(t.carb) + '<small> g</small></div><div class="l">carbs (the rest)</div></div>' +
      '</div>' +
      '<div class="box"><table class="meals"><tr><th>Meal</th><th>kcal</th><th>Protein</th><th>Fibre</th></tr>' + rows +
      (flexK > 0 ? '<tr><td class="muted">Extras (your choice)</td><td class="muted">' + r0(flexK) + '</td><td></td><td></td></tr>' : '') +
      '</table></div>' +
      '<div class="box why"><details class="more"><summary>Why these numbers?</summary>' +
        '<p><b>Calories:</b> resting needs from the Mifflin–St Jeor equation (' + r0(t.bmr) + ' kcal), times ' + t.pal +
          ' for this week\'s activity = ' + r0(t.tdee) + ' kcal' + (S.profile.goal !== 'maintain' ? ', adjusted for your goal' : '') + '.</p>' +
        '<p><b>Protein:</b> ' + E.GOALS[S.profile.goal].proteinPerKg + ' g per kg' +
          (t.proteinBasisKg < S.profile.weightKg - 0.5 ? ' of a lean-mass-adjusted ' + r0(t.proteinBasisKg) + ' kg' : ' of body weight') +
          '. That sits in the 1.2–1.6 g/kg range that best protects muscle and keeps you full. It\'s spread evenly so each main meal has about 0.4 g/kg, enough to switch on muscle repair.</p>' +
        '<p><b>Fibre:</b> 14 g per 1,000 kcal and at least 25 g. Large reviews link 25–29 g+ a day to lower heart disease, diabetes and bowel cancer risk. If you\'re not used to this much, increase it gradually and drink plenty of water.</p>' +
        '<p><b>Fat and carbs:</b> fat at about 30% of calories (the healthy range is 20–35%), with mostly whole-grain and bean carbs filling the rest.</p>' +
        '<p><b>Low energy:</b> steady, regular meals rich in protein and fibre, that take little energy to make, are the practical win. That\'s what this plan is built for.</p>' +
      '</details></div>';
  }

  /* ================================================================== *
   * Options
   * ================================================================== */
  function bar(label, val, target, kind) {
    var pc = val / target, cls = '';
    if (kind === 'kcal' && (pc < 0.9 || pc > 1.1)) cls = pc < 0.9 ? 'under' : 'over';
    if (kind !== 'kcal' && pc < 0.9) cls = 'under';
    return '<div class="bar"><div class="row"><span>' + label + '</span><span>' + r0(val) + ' / ' + r0(target) + (kind === 'kcal' ? '' : ' g') + '</span></div>' +
      '<div class="track"><div class="fill ' + cls + '" style="width:' + Math.min(100, pc * 100) + '%"></div></div></div>';
  }

  function pantryHint(plan, c) {
    var using = E.shopping(c.bs, S.foods, preHave(plan.id)).filter(function (n) { return trackable(n) && n.have > 0; });
    if (!using.length) return '';
    return '<p class="small">🧺 Uses ' + using.length + ' thing' + (using.length > 1 ? 's' : '') + ' already in your pantry: ' +
      esc(using.map(function (n) { return n.food.short; }).join(', ')) + '.</p>';
  }

  function renderOptions() {
    var t = T();
    var act = E.ACTIVITY[S.profile.activity];
    var html = '<h2 class="sec">This week\'s three options</h2>' +
      '<div class="note">' + esc(S.week.intro) + '</div>' +
      (hasProfile()
        ? '<p class="small muted">Sized for you · activity this week: <b>' + esc(act.label) + '</b> · <a href="#" data-goto="me">change</a></p>'
        : '<div class="note warn">Showing example portions. <a href="#" data-goto="me">Add your details</a> to size them for you.</div>');

    S.week.plans.forEach(function (plan) {
      var c = compute(plan);
      var d = c.P.day, chosen = S.ws.chosen === plan.id;
      var menu = c.P.items.map(function (x, i) {
        var k = x.slot === 'main' ? (i === 1 ? 'Main 1' : 'Main 2') : SLOT_LABEL[x.slot];
        return '<li><span class="k">' + k + '</span>' + esc(x.recipe.name) + '</li>';
      }).join('');
      var lvl = plan.effort.level || 2;
      html += '<div class="opt' + (chosen ? ' chosen' : '') + '">' +
        '<div class="head"><div class="letter">' + esc(plan.id) + '</div><div><div class="name">' + esc(plan.name) + '</div>' +
        '<div>' + plan.appliances.map(function (a) { return '<span class="pill">' + esc(a) + '</span>'; }).join('') + '</div></div>' +
        (chosen ? '<span class="chosen-tag">✓ My pick</span>' : '') + '</div>' +
        '<div class="body"><p class="blurb">' + esc(plan.blurb) + '</p>' +
        '<ul class="menu">' + menu + '</ul>' +
        '<div class="effort"><span><span class="dots">' + '●●●'.slice(0, lvl) + '○○○'.slice(lvl) + '</span> effort</span>' +
          '<span><b>' + plan.effort.activeMin + ' min</b> hands-on</span>' +
          '<span><b>' + plan.effort.standingMin + ' min</b> standing</span>' +
          '<span>' + esc(plan.effort.span) + '</span></div>' +
        '<div class="bars">' + bar('Calories / day', d.kcal, t.planned.kcal, 'kcal') + bar('Protein', d.p, t.protein) + bar('Fibre', d.fib, t.fiber) + '</div>' +
        pantryHint(plan, c) +
        '<button class="btn' + (chosen ? ' ghost' : '') + '" data-act="choose" data-plan="' + esc(plan.id) + '">' +
          (chosen ? 'See my week →' : 'Choose ' + esc(plan.name)) + '</button>' +
        '</div></div>';
    });
    $('tab-options').innerHTML = html;
  }

  /* ================================================================== *
   * Week / Shop / Prep: share a plan switcher
   * ================================================================== */
  function switcher() {
    return '<div class="switch">Showing plan: ' + S.week.plans.map(function (p) {
      return '<button data-act="view" data-plan="' + p.id + '" class="' + (p.id === S.view ? 'active' : '') + (p.id === S.ws.chosen ? ' mine' : '') + '">' +
        esc(p.id + ' · ' + p.name) + '</button>';
    }).join('') + '</div>' +
      (S.ws.chosen ? '' : '<div class="note warn">You haven\'t picked a plan yet. Previewing plan ' + esc(S.view) + '. <a href="#" data-goto="options">Compare options</a></div>');
  }

  function renderWeek() {
    var plan = planById(S.view), c = compute(plan), t = T(), D = days(), F = Math.min(fridgeDays(), D);
    var it = c.P.items, b = it[0], m1 = it[1], m2 = it[2], sn = it[3];
    function dish(x) { return '<span class="dish" data-act="open" data-rid="' + esc(x.recipe.id) + '">' + esc(x.recipe.name) + '</span>'; }

    var cal = '';
    for (var i = 1; i <= D; i++) {
      var lunch = i % 2 ? m1 : m2, dinner = i % 2 ? m2 : m1;
      cal += '<div class="day"><div class="dbadge"><span class="dow">DAY</span><span class="dnum">' + i + '</span>' +
        '<span class="where">' + (i <= F ? 'fridge' : '🧊 freezer') + '</span></div><div class="dmeals">' +
        '<div><span class="k">Breakfast</span>' + dish(b) + '</div>' +
        '<div><span class="k">Lunch</span>' + dish(lunch) + '</div>' +
        '<div><span class="k">Snack</span>' + dish(sn) + '</div>' +
        '<div><span class="k">Dinner</span>' + dish(dinner) + '</div>' +
        '</div></div>';
    }

    var cards = it.map(function (x) {
      return recipeCard(x.recipe, x.portion, c.batch, {
        count: D,
        subtitle: SLOT_LABEL[x.slot] + (x.slot === 'main' ? ' (alternating)' : '') + ' · ' + D + ' containers',
        extra: saveWidget(x.recipe)
      });
    }).join('');

    $('tab-week').innerHTML = switcher() +
      '<h2 class="sec">A day of eating</h2>' +
      '<div class="box"><div class="bars">' + bar('Calories', c.P.day.kcal, t.planned.kcal, 'kcal') + bar('Protein', c.P.day.p, t.protein) + bar('Fibre', c.P.day.fib, t.fiber) + '</div>' +
      '<div class="small muted">' + (t.kcal - t.planned.kcal > 0 ? 'Leaves about ' + r0(t.kcal - t.planned.kcal) + ' kcal for extras like milk in coffee. ' : '') +
      'Lunch and dinner swap each day, so you never eat the same main twice in a row.</div></div>' +
      '<h2 class="sec">Containers</h2><div class="cal">' + cal + '</div>' +
      '<h2 class="sec">Recipes & your portions</h2>' + cards +
      freezerGuide(it) + reviewCard();
  }

  function freezerGuide(items) {
    var K = keepDays();
    return '<h2 class="sec">Skipping a meal?</h2><div class="box small">' +
      'Cooked food keeps about ' + K + ' days in the fridge. If you won\'t get to a container in time, move it to the freezer before day ' + K +
      ' if it\'s marked ❄️. It\'ll keep for up to 3 months, as a spare for a low day or a swap next week.' +
      items.map(function (x) {
        return '<div class="freeze ' + esc(x.recipe.freezer) + '"><b>' + FREEZE[x.recipe.freezer] + ':</b> ' + esc(x.recipe.name) + '. ' + esc(x.recipe.freezeTip || '') + '</div>';
      }).join('') +
      (S.profile.freezeMore ? '' : '<p>Skip meals often? <a href="#" data-goto="me">Me → Fine-tune → Freeze more</a> keeps only 2 days in the fridge and freezes the rest up front.</p>') +
      '</div>';
  }

  function reviewCard() {
    if (!S.ws.chosen || S.view !== S.ws.chosen) return '';
    if (S.ws.review) return '<div class="box small">✅ Thanks. Your review of this week went to the planner.</div>';
    function q(key, label, opts) {
      return '<div class="rq"><b>' + label + '</b><div class="switch">' + opts.map(function (o) {
        return '<button data-act="rpick" data-q="' + key + '" data-v="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div></div>';
    }
    return '<h2 class="sec">How did this week go?</h2><div class="box review" id="review">' +
      '<div class="small muted">Any time before next Friday. It shapes the next set of options.</div>' +
      q('taste', 'The food', [['great', '😋 Loved it'], ['fine', '🙂 Fine'], ['meh', '😕 Not great']]) +
      q('effort', 'The prep', [['too-much', '😮‍💨 Too much'], ['right', '👌 About right'], ['more', '💪 Could do more']]) +
      '<div class="savebox open"><textarea maxlength="300" placeholder="Anything else? (optional). E.g. too much food, loved the chili"></textarea>' +
      '<button class="btn small" data-act="review">Send</button></div></div>';
  }

  function renderShop() {
    var plan = planById(S.view), c = compute(plan);
    var list = E.shopping(c.bs, S.foods, preHave(plan.id)).filter(trackable);
    var tick = S.ws.shop[plan.id] || {}, bought = S.ws.bought[plan.id] || {};
    var toBuy = list.filter(function (n) { return n.short > 0; });
    var covered = list.filter(function (n) { return !n.short; });
    var html = switcher() + '<h2 class="sec">Shopping list</h2>' +
      '<div class="note">Worked out from your portions for ' + days() + ' days, minus what\'s in your <a href="#" data-goto="pantry">pantry</a>. ' +
      'Ticking an item adds it to the pantry; store packs are rounded up and the extra stays there for next week.</div>' +
      (S.ws.made[plan.id] ? '<div class="note">✅ Prep is marked done for this plan.</div>' : '');
    GROUPS.forEach(function (g) {
      var items = toBuy.filter(function (n) { return n.food.group === g[0]; });
      if (!items.length) return;
      html += '<div class="grp"><h4>' + g[1] + '</h4>' + items.map(function (n) {
        return '<label class="item"><input type="checkbox" data-buy="' + esc(n.id) + '"' + (bought[n.id] ? ' checked' : '') + '>' +
          '<span class="what">' + esc(n.food.name) + '<span class="why">' + esc(n.needText) + ' · ' + esc(n.uses.join(', ')) +
          (n.have ? '<br>You have ' + esc(E.amount(n.food, n.have)) + ' already' : '') +
          (n.food.note ? '<br>' + esc(n.food.note) : '') + '</span></span><span class="buy">' + esc(n.buy) + '</span></label>';
      }).join('') + '</div>';
    });
    if (!toBuy.length) html += '<div class="note">🎉 Everything for this plan is already in your pantry.</div>';
    if (covered.length) {
      html += '<details class="grp fold"><summary>✅ Already in your pantry (' + covered.length + ')</summary>' + covered.map(function (n) {
        return '<div class="item"><span class="what">' + esc(n.food.name) + '<span class="why">need ' + esc(n.needText) +
          ' · have ' + esc(E.amount(n.food, n.have)) + '</span></span></div>';
      }).join('') + '</details>';
    }
    var pantry = E.shopping(c.bs, S.foods).filter(function (n) { return n.food.pantry; }).map(function (n) { return n.food.name; });
    var staples = (plan.pantry || []).concat(pantry.filter(function (n) { return (plan.pantry || []).indexOf(n) === -1; }));
    html += '<h2 class="sec">Pantry check</h2><div class="grp"><h4>🧂 Assumed at home</h4>' + staples.map(function (s, i) {
      return '<label class="item"><input type="checkbox" data-shop="pantry-' + i + '"' + (tick['pantry-' + i] ? ' checked' : '') + '><span class="what">' + esc(s) + '</span></label>';
    }).join('') + '</div>' +
      '<div class="grp"><h4>📦 Containers</h4><div class="item"><span class="what">' + days() + ' breakfast, ' + days() * 2 + ' main and ' + days() +
      ' snack containers. Glass is best for reheating.</span></div></div>' +
      '<button class="btn ghost small" data-act="clearshop">Clear pantry-check ticks</button>';
    $('tab-shop').innerHTML = html;
  }

  function renderPrep() {
    var plan = planById(S.view), c = compute(plan), D = days(), K = Math.min(keepDays(), D);
    var active = 0, standing = 0;
    var sessions = plan.prep.map(function (s) {
      var mins = 0;
      var steps = s.steps.map(function (st) {
        if (st.how !== 'rest') { active += st.min; mins += st.min; }
        if (st.how === 'stand') standing += st.min;
        var h = HOW[st.how];
        return '<li class="' + st.how + '"><div class="how ' + st.how + '"><span class="i">' + h[0] + '</span>' + h[1] + '</div>' +
          '<div><span class="tm">' + (st.how === 'rest' ? 'about ' : '') + st.min + ' min</span>' + fill(st.text, c.batch) + '</div></li>';
      }).join('');
      return '<div class="session"><div class="shead"><span class="n">' + esc(s.name) + '</span><span class="t">' + esc(s.when) + ' · ' + mins + ' min hands-on</span></div>' +
        '<ol class="steps">' + steps + '</ol></div>';
    }).join('');

    var topups = c.P.items.filter(function (x) { return x.recipe.freezer === 'no' && D > K + 1; });
    if (topups.length) {
      sessions += '<div class="session"><div class="shead"><span class="n">Day ' + K + ' top-up</span><span class="t">about 3 min</span></div><ol class="steps">' +
        topups.map(function (x) {
          return '<li class="sit"><div class="how sit"><span class="i">🪑</span>Sit</div><div>Make the last ' + (D - K) + ' ' +
            esc(x.recipe.name) + ' the same way (portion card below).</div></li>';
        }).join('') + '</ol></div>';
    }

    var cards = c.P.items.filter(function (x, i, a) { return a.indexOf(x) === i; }).map(function (x) {
      return '<div class="box"><b>' + SLOT_ICON[x.recipe.slot] + ' ' + esc(x.recipe.name) + '</b> <span class="muted small">× ' + D + '</span>' +
        '<div class="pcard">' + x.portion.parts.map(function (p) {
          return '<div class="row"><span>' + esc(p.name) + (p.side ? '<span class="side">ON THE SIDE</span>' : '') + '</span><b>' + esc(E.portionText(p)) + '</b></div>';
        }).join('') + '</div></div>';
    }).join('');

    $('tab-prep').innerHTML = switcher() +
      '<h2 class="sec">Prep day, paced</h2>' +
      '<div class="note">About <b>' + active + ' minutes</b> of hands-on work, only <b>' + standing + '</b> of them standing, split into sessions with rests in between. ' +
      'Spread the sessions across two days if that suits your energy better; cooked food keeps fine in the fridge overnight.</div>' +
      '<div class="legend"><span>🪑 sit (a stool at the counter counts)</span><span>🧍 stand</span><span>🛋️ rest, the machines are working</span></div>' +
      sessions +
      '<h2 class="sec">Portion cards</h2><div class="note">Put the container on the scale, zero it, add the first item, zero again, add the next. ' +
      'Side items get their own small container or bag.</div>' + cards +
      prepDone(plan);
  }

  function prepDone(plan) {
    if (S.ws.made[plan.id]) {
      return '<h2 class="sec">Done</h2><div class="box">✅ <b>Prep done.</b> This plan\'s ingredients came out of your pantry, so what\'s left there is your leftovers. ' +
        'Send them to the planner so next week can use them up.<div style="margin-top:10px">' +
        '<button class="btn small" data-act="sendpantry">📤 Send pantry to planner</button> ' +
        '<button class="btn ghost small" data-act="unmade">Undo prep done</button></div>' + sentStatus() + '</div>';
    }
    return '<h2 class="sec">Finished?</h2><div class="box"><b>Mark prep done</b> to take what this plan used out of your <a href="#" data-goto="pantry">pantry</a>. ' +
      'The leftovers (the rest of a bag of rice, a spare can) carry over to next week\'s list.' +
      '<div style="margin-top:10px"><button class="btn" data-act="made">✅ Prep done</button></div></div>';
  }

  function sentStatus() {
    return S.pantry.sent ? '<div class="small muted" style="margin-top:8px">Last sent to the planner ' + esc(S.pantry.sent) + '.</div>' : '';
  }

  /* ================================================================== *
   * Pantry
   * ================================================================== */
  function renderPantry() {
    var plan = planById(S.view), c = compute(plan);
    var need = {};
    E.shopping(c.bs, S.foods).forEach(function (n) { need[n.id] = n.g; });
    var have = S.pantry.have, v = S.invView;
    var ids = Object.keys(S.foods).filter(function (id) {
      var f = S.foods[id];
      if (id.charAt(0) === '_' || f.pantry) return false;
      return v === 'all' || (v === 'week' ? need[id] : have[id]);
    });
    var html = switcher() + '<h2 class="sec">Pantry: what\'s on hand</h2>' +
      '<div class="note">Carries over from week to week. The shopping list skips what you have; ticking an item bought adds it here, and marking prep done takes it back out. ' +
      'Type in anything else you have (a half bag of rice, a few cans) and leave the rest blank.</div>' +
      '<div class="switch">' + [['week', 'This plan\'s items'], ['have', 'On hand'], ['all', 'Everything']].map(function (x) {
        return '<button data-act="invview" data-v="' + x[0] + '" class="' + (v === x[0] ? 'active' : '') + '">' + x[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="legend"><span><i class="dot ok"></i>enough this week</span><span><i class="dot part"></i>some, buy more</span><span><i class="dot short"></i>none yet</span></div>';
    GROUPS.forEach(function (g) {
      var rows = ids.filter(function (id) { return S.foods[id].group === g[0]; });
      if (!rows.length) return;
      html += '<div class="grp"><h4>' + g[1] + '</h4>' + rows.map(function (id) {
        var f = S.foods[id], u = E.invUnit(f), h = have[id] || 0, n = need[id];
        var shown = h ? Math.round(h / u.per / (u.step < 1 ? u.step : 1)) * (u.step < 1 ? u.step : 1) : '';
        var dot = !n ? '' : h >= n * 0.95 ? 'ok' : h > 0 ? 'part' : 'short';
        return '<div class="item inv"><span class="what">' + esc(f.name) + '<span class="why">' +
          (n ? 'this plan uses ' + esc(E.amount(f, n)) : 'not in this plan') + '</span></span>' +
          '<span class="invq"><input type="number" inputmode="decimal" min="0" step="' + u.step + '" data-inv="' + esc(id) + '" value="' + shown + '"><small>' + esc(u.label) + '</small></span>' +
          '<i class="dot ' + dot + '"></i></div>';
      }).join('') + '</div>';
    });
    if (!ids.length) html += '<p class="empty">Nothing here yet.</p>';
    html += '<h2 class="sec">Share with the planner</h2><div class="box small">Next week\'s options are picked on GitHub, which can\'t see this phone. ' +
      'Sending your pantry (just the food list, nothing about you) lets the planner use up what you have.' +
      '<div style="margin-top:10px"><button class="btn small" data-act="sendpantry">📤 Send pantry to planner</button> ' +
      '<button class="btn ghost small" data-act="clearpantry">Empty pantry</button></div>' + sentStatus() + '</div>';
    $('tab-pantry').innerHTML = html;
  }

  function renderPlans() {
    if (!S.week) return;
    renderOptions(); renderWeek(); renderShop(); renderPantry(); renderPrep();
  }

  /* ---------------- tabs ---------------- */
  function showTab(name) {
    S.tab = name;
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
    document.querySelectorAll('#tabbar button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    window.scrollTo(0, 0);
  }

  /* ---------------- events ---------------- */
  function wirePlanPage() {
    document.querySelectorAll('#tabbar button').forEach(function (b) {
      b.addEventListener('click', function () { showTab(b.dataset.tab); });
    });
    $('tab-me').addEventListener('input', function (e) {
      if (e.target.matches('input[type=number]')) readMe();
    });
    $('tab-me').addEventListener('change', function (e) {
      if (e.target.matches('select, input[type=radio]')) readMe();
    });
    $('tab-me').addEventListener('click', function (e) {
      var u = e.target.closest('.seg button');
      if (u) {
        e.preventDefault();
        S.profile.units[u.parentNode.dataset.unit] = u.dataset.u;
        saveProfile(); renderMe();
        return;
      }
      if (e.target.id === 'f-export') {
        var code = btoa(unescape(encodeURIComponent(JSON.stringify({ profile: S.profile, pantry: S.pantry.have }))));
        (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(
          function () { alert('Copied. Paste it on the other device.'); },
          function () { prompt('Copy this code:', code); });
      }
      if (e.target.id === 'f-import') {
        var txt = prompt('Paste the settings code:');
        if (!txt) return;
        try {
          var p = JSON.parse(decodeURIComponent(escape(atob(txt.trim()))));
          if (!p || typeof p !== 'object' || !p.profile) throw 0;
          S.profile = Object.assign(defaultProfile(), p.profile);
          S.pantry.have = cleanHave(p.pantry);
          saveProfile(); savePantry(); renderMe(); renderPlans();
        } catch (err) { alert('That code didn\'t work. Copy it again and paste the whole thing.'); }
      }
    });

    document.addEventListener('click', function (e) {
      var go = e.target.closest('[data-goto]');
      if (go) { e.preventDefault(); showTab(go.dataset.goto); return; }
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var act = el.dataset.act;
      if (act === 'choose') choose(el.dataset.plan);
      else if (act === 'view') { S.view = el.dataset.plan; renderPlans(); }
      else if (act === 'open') openRecipe(el.dataset.rid);
      else if (act === 'clearshop') { S.ws.shop[S.view] = {}; saveWS(); renderShop(); }
      else if (act === 'fbopen') openFeedback(el);
      else if (act === 'fbsubmit') submitFeedback(el.closest('.savewidget'));
      else if (act === 'rpick') {
        el.parentNode.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === el); });
      }
      else if (act === 'review') submitReview();
      else if (act === 'made') markMade(true);
      else if (act === 'unmade') markMade(false);
      else if (act === 'invview') { S.invView = el.dataset.v; renderPantry(); }
      else if (act === 'sendpantry') sendPantry(el);
      else if (act === 'clearpantry') {
        if (!confirm('Empty the whole pantry list on this phone?')) return;
        S.pantry.have = {}; savePantry(); renderPlans();
      }
    });
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t.matches('input[data-shop]')) {
        var m = S.ws.shop[S.view] = S.ws.shop[S.view] || {};
        if (t.checked) m[t.dataset.shop] = 1; else delete m[t.dataset.shop];
        saveWS();
      } else if (t.matches('input[data-buy]')) {
        toggleBought(t.dataset.buy, t.checked);
      } else if (t.matches('input[data-inv]')) {
        var f = S.foods[t.dataset.inv], v = parseFloat(t.value);
        if (!f) return;
        if (isFinite(v) && v > 0) S.pantry.have[t.dataset.inv] = Math.min(MAX_QTY, v * E.invUnit(f).per);
        else delete S.pantry.have[t.dataset.inv];
        savePantry();
        renderOptions(); renderShop(); renderPantry();
      }
    });
    document.addEventListener('input', function (e) {
      if (e.target.matches('.savebox textarea')) e.target.value = e.target.value.replace(NOTES_ALLOWED, '');
    });
  }

  function wsKey() { return 'supine_week_' + S.week.id; }
  function saveWS() { store(wsKey(), S.ws); }

  function choose(planId) {
    var already = S.ws.chosen === planId;
    S.ws.chosen = planId;
    S.view = planId;
    saveWS();
    renderPlans();
    showTab('week');
    if (already || S.ws.reported === planId) return;
    // Recorded in the repo so future weeks learn which styles get picked.
    dispatch({ type: 'choose-plan', week: S.week.id, plan_id: planId }).then(function (r) {
      if (r.ok) { S.ws.reported = planId; saveWS(); }
    }).catch(function () {});
  }

  function openRecipe(rid) {
    var el = $('rc-' + rid);
    if (!el) return;
    el.open = true;
    setTimeout(function () { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 30);
  }

  // Shopping tick = bought: add what comes home (whole packs) to the pantry.
  function toggleBought(id, on) {
    var plan = planById(S.view), b = S.ws.bought[plan.id] = S.ws.bought[plan.id] || {};
    if (on) {
      var n = E.shopping(compute(plan).bs, S.foods, preHave(plan.id)).filter(function (x) { return x.id === id; })[0];
      if (!n || !n.buyG) return;
      b[id] = n.buyG; addHave(id, n.buyG);
    } else if (b[id]) {
      addHave(id, -b[id]); delete b[id];
    }
    saveWS(); savePantry();
    renderOptions(); renderPantry();
  }

  // Prep done: take what the plan uses out of the pantry (only what's there).
  function markMade(on) {
    var plan = planById(S.view);
    if (on) {
      var m = {};
      E.shopping(compute(plan).bs, S.foods).filter(trackable).forEach(function (n) {
        var take = Math.min(S.pantry.have[n.id] || 0, n.g);
        if (take > 0) { addHave(n.id, -take); m[n.id] = take; }
      });
      S.ws.made[plan.id] = m;
    } else {
      var made = S.ws.made[plan.id] || {};
      Object.keys(made).forEach(function (id) { addHave(id, made[id]); });
      delete S.ws.made[plan.id];
    }
    saveWS(); savePantry(); renderPlans();
  }

  function sendPantry(btn) {
    var items = {}, count = 0;
    Object.keys(S.pantry.have).forEach(function (id) {
      var g = Math.round(S.pantry.have[id]);
      if (g > 0 && count < 80) { items[id] = g; count++; }
    });
    btn.disabled = true;
    dispatch({ type: 'pantry', week: S.week.id, items: items }).then(function (r) {
      if (!r.ok) throw 0;
      S.pantry.sent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' (' + count + ' items)';
      savePantry(); renderPantry(); renderPrep();
    }).catch(function () {
      btn.disabled = false;
      btn.insertAdjacentHTML('afterend', '<div class="savestatus">⚠️ That didn\'t go through. Try again later.</div>');
    });
  }

  function openFeedback(btn) {
    var widget = btn.closest('.savewidget'), kind = btn.dataset.kind;
    var box = widget.querySelector('.savebox');
    var same = widget.dataset.kind === kind && box.classList.contains('open');
    widget.dataset.kind = kind;
    box.classList.toggle('open', !same);
    box.querySelector('textarea').placeholder = kind === 'save'
      ? 'Any notes? (optional). E.g. more spice, less rice'
      : 'What didn\'t work? (optional). E.g. too bland, didn\'t like the texture';
    box.querySelector('button').textContent = kind === 'save' ? 'Save' : 'Send';
  }

  function submitFeedback(widget) {
    if (widget.dataset.kind === 'save') return submitSave(widget);
    var rid = widget.dataset.rid;
    var notes = widget.querySelector('textarea').value.replace(NOTES_ALLOWED, '').slice(0, 300);
    sendFrom(widget, { type: 'recipe-feedback', week: S.week.id, recipe_id: rid, verdict: 'less', notes: notes }, function () {
      S.ws.feedback[rid] = 'less';
      return '👎 Noted. The planner will steer away from dishes like this.';
    });
  }

  function submitReview() {
    var box = $('review'), pick = {};
    box.querySelectorAll('button.active[data-q]').forEach(function (b) { pick[b.dataset.q] = b.dataset.v; });
    var notes = box.querySelector('textarea').value.replace(NOTES_ALLOWED, '').slice(0, 300);
    if (!pick.taste && !pick.effort && !notes) { alert('Pick an answer or write a note first.'); return; }
    sendFrom(box, { type: 'week-review', week: S.week.id, plan_id: S.ws.chosen, taste: pick.taste || '', effort: pick.effort || '', notes: notes }, function () {
      S.ws.review = { taste: pick.taste || '', effort: pick.effort || '' };
      return '✅ Thanks. Your review of this week went to the planner.';
    });
  }

  // Send a request from a widget, swapping it for a status line on success.
  function sendFrom(widget, body, onOk) {
    widget.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    dispatch(body).then(function (r) {
      if (!r.ok) throw 0;
      var msg = onOk(); saveWS();
      widget.innerHTML = '<span class="savestatus">' + msg + '</span>';
    }).catch(function () {
      widget.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      widget.insertAdjacentHTML('beforeend', '<div class="savestatus">⚠️ That didn\'t go through. Try again later.</div>');
    });
  }

  function submitSave(widget) {
    var rid = widget.dataset.rid;
    var notes = widget.querySelector('textarea').value.replace(NOTES_ALLOWED, '').slice(0, 300);
    sendFrom(widget, { type: 'save-recipe', week: S.week.id, recipe_id: rid, notes: notes }, function () {
      S.ws.saved[rid] = 1;
      return '✅ Saved. It shows up in the Recipe Book in a few minutes.';
    });
  }

  /* ================================================================== *
   * Recipe book page
   * ================================================================== */
  function renderBook() {
    var list = $('list'), q = ($('search').value || '').trim().toLowerCase();
    var cuisine = S.cuisine || '';
    if (!S.book.length) {
      list.innerHTML = '<p class="empty">Nothing saved yet. Tap 💾 <b>Save to Recipe Book</b> on any recipe in your weekly plan and it lands here.</p>';
      return;
    }
    var t = T(), D = days();
    var shown = S.book.slice().reverse().filter(function (b) {
      var r = b.recipe;
      if (cuisine && r.cuisine !== cuisine) return false;
      return !q || (r.name + ' ' + r.summary + ' ' + (b.notes || '')).toLowerCase().indexOf(q) > -1;
    });
    list.innerHTML = shown.map(function (b) {
      var r = b.recipe;
      var portion = E.portion(r, E.slotTarget(t, r.slot), S.foods);
      var batch = {}; batch[r.id] = {};
      r.components.forEach(function (c) {
        var part = portion.parts.filter(function (p) { return p.id === c.id; })[0];
        batch[r.id][c.id] = E.batchComponent(c, part.g, D);
      });
      var note = b.notes ? '<div class="usernote">📝 ' + esc(b.notes) + '</div>' : '';
      return recipeCard(r, portion, batch, {
        count: D,
        subtitle: SLOT_LABEL[r.slot] + ' · ' + r.cuisine + ' · saved ' + b.saved,
        extra: note
      });
    }).join('') || '<p class="empty">No saved recipes match.</p>';
  }

  function wireBookPage() {
    var cuisines = [];
    S.book.forEach(function (b) { if (cuisines.indexOf(b.recipe.cuisine) === -1) cuisines.push(b.recipe.cuisine); });
    $('cuisines').innerHTML = cuisines.length > 1 ? ['All'].concat(cuisines).map(function (c) {
      return '<button data-c="' + (c === 'All' ? '' : esc(c)) + '" class="' + (c === 'All' ? 'active' : '') + '">' + esc(c) + '</button>';
    }).join('') : '';
    $('cuisines').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      S.cuisine = b.dataset.c;
      $('cuisines').querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); });
      renderBook();
    });
    $('search').addEventListener('input', renderBook);
    if (!hasProfile()) $('booknote').innerHTML = '<div class="note warn">Showing example portions. Add your details on the <a href="index.html">plan page</a> to size them for you.</div>';
    renderBook();
  }

  /* ================================================================== *
   * Boot
   * ================================================================== */
  S.profile = loadProfile();
  var boot = PAGE === 'book'
    ? Promise.all([getJSON('data/foods.json'), getJSON('data/book.json')]).then(function (r) {
        S.foods = r[0]; S.book = r[1] || [];
        wireBookPage();
      })
    : Promise.all([getJSON('data/foods.json'), getJSON('data/current.json'), getJSON('data/book.json').catch(function () { return []; })])
      .then(function (r) {
        S.foods = r[0]; S.book = r[2] || [];
        loadPantry();
        return getJSON('data/weeks/' + r[1].week + '.json');
      }).then(function (week) {
        S.week = week;
        var w = load(wsKey()) || {};
        S.ws = { chosen: w.chosen || null, reported: w.reported || null, shop: w.shop || {}, saved: w.saved || {},
          feedback: w.feedback || {}, review: w.review || null, bought: w.bought || {}, made: w.made || {} };
        S.view = S.ws.chosen || week.plans[0].id;
        $('weeklabel').textContent = week.label;
        document.title = 'Supine Meal Plan · ' + week.label;
        wirePlanPage();
        renderMe();
        renderPlans();
        showTab(!hasProfile() ? 'me' : S.ws.chosen ? 'week' : 'options');
      });
  boot.catch(function (err) {
    document.querySelector('.wrap').insertAdjacentHTML('afterbegin',
      '<div class="note warn">Couldn\'t load the plan (' + esc(err.message) + '). Check your connection and reload.</div>');
  });
})();
