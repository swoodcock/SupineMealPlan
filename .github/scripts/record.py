"""
Triggered by .github/workflows/record.yml (repository_dispatch).

  save-recipe      copies a recipe from the committed week file into
                   data/book.json, with an optional note.
  choose-plan      records which of the week's plans was picked.
  recipe-feedback  records a "not for me" on a recipe.
  week-review      records how the week went (taste, prep effort, note).
  pantry           replaces data/pantry.json with what's on hand.

Everything but the book and pantry goes in data/history.json.

Inputs come from the environment, never shell-interpolated. They are only
ids and fixed choices, re-validated here and looked up in files already in
the repo; pantry ids must be catalog foods. The only free text is the note,
filtered to a safe character set. The pages escape everything they render.
"""
import datetime
import json
import os
import re
import sys

WEEK_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^[A-Za-z0-9-]{1,40}$")
PLAN_RE = re.compile(r"^[A-Z]$")
NOTES_STRIP = re.compile(r"[^A-Za-z0-9 .,!'?-]")
MAX_SAVES_PER_DAY = 15

TASTES = {"great", "fine", "meh", ""}
EFFORTS = {"too-much", "right", "more", ""}

BOOK = "data/book.json"
HISTORY = "data/history.json"
PANTRY = "data/pantry.json"
FOODS = "data/foods.json"


def read(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")


def output(message):
    print(message)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"message={message}\n")


def load_week(week):
    path = f"data/weeks/{week}.json"
    if not os.path.exists(path):
        return None
    return read(path, None)


def save_recipe(week_id, recipe_id, notes, today):
    found = find_recipe(load_week(week_id), recipe_id)
    if not found:
        return output(f"No recipe {recipe_id} in {week_id}; nothing saved.")
    plan, recipe = found

    book = read(BOOK, [])
    key = f"{week_id}/{recipe_id}"
    if any(b.get("key") == key for b in book):
        return output(f"{key} already in the book.")
    if sum(1 for b in book if b.get("saved") == today) >= MAX_SAVES_PER_DAY:
        return output("Daily save limit reached; nothing saved.")

    book.append({
        "key": key, "week": week_id, "plan": plan["id"], "saved": today,
        "notes": notes, "recipe": recipe,
    })
    write(BOOK, book)

    history = read(HISTORY, {"choices": []})
    history.setdefault("saves", []).append({
        "week": week_id, "recipe": recipe_id, "name": recipe["name"],
        "cuisine": recipe.get("cuisine"), "slot": recipe.get("slot"), "date": today,
    })
    write(HISTORY, history)
    output(f"Save recipe: {recipe['name']}")


def find_recipe(week, recipe_id):
    for plan in (week or {}).get("plans", []):
        for r in plan["recipes"]:
            if r["id"] == recipe_id:
                return plan, r
    return None


def recipe_feedback(week_id, recipe_id, notes, today):
    found = find_recipe(load_week(week_id), recipe_id)
    if not found:
        return output(f"No recipe {recipe_id} in {week_id}; nothing recorded.")
    _, recipe = found
    history = read(HISTORY, {"choices": []})
    feedback = [f for f in history.get("feedback", []) if not (f["week"] == week_id and f["recipe"] == recipe_id)]
    feedback.append({
        "week": week_id, "recipe": recipe_id, "name": recipe["name"], "cuisine": recipe.get("cuisine"),
        "verdict": "less", "notes": notes, "date": today,
    })
    history["feedback"] = feedback
    write(HISTORY, history)
    output(f"Not for me: {recipe['name']}")


def week_review(week_id, plan_id, taste, effort, notes, today):
    week = load_week(week_id)
    plan = next((p for p in (week or {}).get("plans", []) if p["id"] == plan_id), None)
    if not plan:
        return output(f"No plan {plan_id} in {week_id}; nothing recorded.")
    history = read(HISTORY, {"choices": []})
    reviews = [r for r in history.get("reviews", []) if r.get("week") != week_id]
    reviews.append({
        "week": week_id, "plan": plan_id, "name": plan["name"], "taste": taste, "effort": effort,
        "effortPlanned": plan.get("effort", {}).get("activeMin"), "notes": notes, "date": today,
    })
    history["reviews"] = reviews
    write(HISTORY, history)
    output(f"Week review for {week_id}")


def pantry(week_id, raw, today):
    foods = read(FOODS, {})
    try:
        items = json.loads(raw)
    except ValueError:
        return output("Bad pantry payload; ignored.")
    if not isinstance(items, dict):
        return output("Bad pantry payload; ignored.")
    clean = {}
    for fid, g in items.items():
        if isinstance(fid, str) and fid in foods and not fid.startswith("_") and isinstance(g, (int, float)) and 0 < g <= 100000:
            clean[fid] = round(g)
    write(PANTRY, {"updated": today, "week": week_id, "items": dict(sorted(clean.items()))})
    output(f"Pantry update ({len(clean)} items)")


def choose_plan(week_id, plan_id, today):
    week = load_week(week_id)
    plan = next((p for p in (week or {}).get("plans", []) if p["id"] == plan_id), None)
    if not plan:
        return output(f"No plan {plan_id} in {week_id}; nothing recorded.")
    history = read(HISTORY, {"choices": []})
    choices = [c for c in history.get("choices", []) if c.get("week") != week_id]
    choices.append({
        "week": week_id, "plan": plan_id, "name": plan["name"],
        "cuisines": plan.get("cuisines", []), "recipes": [r["name"] for r in plan["recipes"]],
        "date": today,
    })
    history["choices"] = choices
    write(HISTORY, history)
    output(f"Chose plan {plan_id} ({plan['name']}) for {week_id}")


def clean_notes():
    return NOTES_STRIP.sub("", os.environ.get("NOTES", ""))[:300].strip()


def main():
    event = os.environ.get("EVENT", "")
    week = os.environ.get("WEEK", "")
    today = datetime.date.today().isoformat()
    if not WEEK_RE.match(week):
        return output("Bad week id; ignored.")
    if event == "save-recipe":
        rid = os.environ.get("RECIPE_ID", "")
        if not ID_RE.match(rid):
            return output("Bad recipe id; ignored.")
        save_recipe(week, rid, clean_notes(), today)
    elif event == "choose-plan":
        pid = os.environ.get("PLAN_ID", "")
        if not PLAN_RE.match(pid):
            return output("Bad plan id; ignored.")
        choose_plan(week, pid, today)
    elif event == "recipe-feedback":
        rid = os.environ.get("RECIPE_ID", "")
        if not ID_RE.match(rid) or os.environ.get("VERDICT") != "less":
            return output("Bad feedback; ignored.")
        recipe_feedback(week, rid, clean_notes(), today)
    elif event == "week-review":
        pid, taste, effort = os.environ.get("PLAN_ID", ""), os.environ.get("TASTE", ""), os.environ.get("EFFORT", "")
        if not PLAN_RE.match(pid) or taste not in TASTES or effort not in EFFORTS:
            return output("Bad review; ignored.")
        week_review(week, pid, taste, effort, clean_notes(), today)
    elif event == "pantry":
        pantry(week, os.environ.get("ITEMS", "")[:8000], today)
    else:
        output(f"Unknown event {event!r}; ignored.")


if __name__ == "__main__":
    sys.exit(main())
