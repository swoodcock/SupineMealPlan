# Supine Meal Plan: weekly generation guide

A static GitHub Pages site for a single user. Every Friday the user sees
**three** one-week meal-prep plans, picks one, and the site sizes every
portion to their body and goals on their phone. There is no backend: the
only writes are the user's buttons (choose a plan, 💾 save, 👎 not for me, the
weekly review, send pantry), which go through the Cloudflare Worker →
`repository_dispatch` → `.github/workflows/record.yml`.

## Who it's for

- **Very limited energy.** Energy is the scarcest ingredient. Every
  plan must be doable in one prep day split into rested sessions. Mostly
  sitting, appliances doing the cooking, minimal standing at the stove.
- Equipment: **Instant Pot, air fryer, sous vide**, oven, normal kitchen.
  Kitchen scale for portioning.
- **Store-bought shortcuts are good.** Jarred sauces (marinara, salsa,
  teriyaki, bulgogi, curry paste), frozen pre-cut veg, canned beans, hummus,
  rotisserie chicken. Never ask for a reduction, emulsion, roux, from-scratch
  sauce, deep-frying, or fine chopping. If a recipe needs more than ~3 items
  chopped by hand, swap in a frozen or pre-cut version.
- No allergies. Goals are macro- and fibre-driven (see below).

## Each week

1. Read `data/history.json`:
   - `choices` is which plan was picked each week, with its cuisines. Lean
     toward cuisines that get picked; don't repeat last week's mains.
   - `saves` lists recipes saved to the book. Saved = liked. Their
     cuisines count double.
   - `feedback` lists "not for me" recipes. Don't repeat them, and read the
     note (too bland? texture?) to avoid similar dishes.
   - `reviews` is how each week went. `effort: "too-much"` means make next
     week's plans lighter: lower `activeMin`, more assembly, fewer
     appliances. `"more"` means a more involved option is fine. Bad `taste`
     means steer away from that plan's style.
   Recent weeks matter more than old ones.
2. Read `data/pantry.json` (what's on hand, in grams, as of
   `updated`). If it's under two weeks old, have each plan use up some of
   it, especially open packs and perishables. The site shows which
   plans do. Ignore it if it's stale.
3. Read `data/book.json`. At least one of the three plans should include a
   saved favourite (copy the recipe object, re-id it for this week) once the
   book has three or more entries. Read the `notes` and apply them ("more
   spice", "less rice").
4. Write `data/weeks/<friday-date>.json` (copy the shape of the latest week)
   and point `data/current.json` at it. **Don't edit the HTML, CSS or JS for
   a normal week.** Those files are stable.
5. Run `node scripts/validate.mjs` and fix every ERROR. Treat WARNs on the
   three female profiles as things to fix by adjusting component `base`
   grams. Male-profile warnings are informational.
6. Commit as `Meal plan for <Mon D>` and push. Don't touch `data/book.json`,
   `data/history.json` or `data/pantry.json`; the bot owns them.

## Plan rules

- Exactly 3 plans with ids `A`, `B`, `C`. Each has 1 breakfast, 2 mains
  (alternating lunch/dinner), and 1 snack.
- **Spread them out:** different cuisines, and different effort levels.
  At least one plan should be `effort.level: 1` (≤ 40 min hands-on,
  mostly assembly). The `effort` numbers should match the `prep` steps.
- Share work within a plan: one rice/quinoa batch for both mains, one
  appliance session doing double duty, and the same frozen veg bag in two
  recipes.
- Everything is prepped in one day for `days` (7) days. Cooked food is
  fridge-safe ~4 days (`fridgeDays`), so mains must freeze and breakfasts
  should. Avoid raw salad veg, fried coatings, and cream sauces that split.
- Every recipe has `freezer`: `"great"`, `"good"` (fine, small texture
  change), or `"no"` (fridge only; a 3-minute top-up on day 4),
  plus a one-line `freezeTip`. Meals get skipped sometimes, and these
  ratings decide what goes in the freezer, so be honest. Prefer `great` where it's easy.
- Frozen veg can go into containers raw-frozen; it cooks on reheat.
- Mark items eaten separately (fruit, crunchy toppings, kimchi) `side: true`.

## Nutrition rules (evidence base)

The engine sets targets from the user's profile: Mifflin–St Jeor × activity,
protein 1.4 g/kg (1.6 when losing or gaining; BMI > 30 uses a lean-adjusted
weight), fibre ≥ 14 g/1000 kcal and ≥ 25 g, fat about 30%. Recipes just need
to be **scalable toward those targets**:

- Each recipe: at least one `protein` component, and usually one or two
  `carb` components. The engine scales protein to hit protein and carbs to
  hit calories, within limits, so the dish keeps its look.
- Aim for each main at its `base` to be about **500 kcal / 30–35 g protein /
  8+ g fibre**, breakfast about **420 kcal / 25 g / 6+ g**, snack about
  **250 kcal / 14 g / 3+ g**. The validator prints the real numbers.
- Fibre comes from beans/lentils, whole grains, frozen veg, berries, chia.
  Prefer whole grains (brown rice, quinoa, whole-wheat pasta, oats).
- Lean proteins, olive oil, minimal added sugar. Pick lower-sodium jarred
  sauces where it's easy.

## Data shape

`data/foods.json` is the catalog: nutrition per 100 g **as bought**
(raw, dry, or drained). Add new foods here (USDA / label values), with a
`pack` so the shopping list rounds sensibly. Every `ing` id must exist.

A component:

```jsonc
{ "id": "quinoa", "name": "Quinoa, cooked", "role": "carb",
  "base": 130,            // finished grams per reference serving
  "yield": 2.8,           // finished weight / raw weight (rice 2.6, pasta 2.3, meat 0.75–0.8)
  "ing": { "quinoa": 100 } }
```

Composite dishes (chili, egg bake, sauce) list a whole reference batch in
`ing`, built on whole cans and packs, with `"batchStep": 0.5` so the
batch scales in half-recipes. Count-based items use `piece` (finished
grams each) and `pieceName`.

Steps can use tokens that are filled with the user's amounts: `{{compId}}` inside
a recipe, `{{recipeId.compId}}` in prep steps, `{{a.x+b.y}}` to sum (e.g.
one rice batch for two mains), plus `{{days}}`, `{{fridgeDays}}` (days of
freezable food kept in the fridge; a user setting may make it 2) and
`{{keepDays}}` (fridge-only items like yogurt cups).

`maxScale` on a carb component caps how far it can grow (e.g. 1.4 on a pear
so a hungry week doesn't mean two pears). Prep
steps have `how`: `sit`, `stand`, or `rest`, and a `min` (minutes).

## Local preview

```
python3 -m http.server 8765    # then open http://localhost:8765
```
