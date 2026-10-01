# Supine Meal Plan

A weekly meal-prep planner. Each Friday it offers three one-week plans; you
pick one, and every portion is sized to your height, weight, activity level
and goal. Built for low-energy cooking: one paced prep day, appliances doing
the work, store-bought sauces.

Static site (GitHub Pages). Personal details and the pantry live in the
browser's localStorage. Only the pantry's food list is sent to the repo,
and only when "Send pantry to planner" is tapped.

| File | What it is |
|---|---|
| `index.html`, `book.html`, `app.css`, `app.js` | The pages. Stable week to week. |
| `engine.js` | Targets, portion solver, batch and shopping maths. Shared by the pages and the validator. |
| `data/foods.json` | Ingredient catalog with nutrition. |
| `data/weeks/<date>.json` | One week's three plans. `data/current.json` points at the live one. |
| `data/book.json`, `data/history.json`, `data/pantry.json` | Saved recipes; choices, dislikes and weekly reviews; the last-sent pantry. Written only by the bot. |
| `worker/` | Cloudflare Worker that turns button presses into `repository_dispatch` events. |
| `.github/workflows/record.yml` | Writes saves and choices into `data/`. |
| `scripts/validate.mjs` | Checks a week before publishing (`node scripts/validate.mjs`). |
| `CLAUDE.md` | How to generate each week's plans. |

## One-time setup

1. Create the GitHub repo `swoodcock/SupineMealPlan` and push. Enable Pages
   (Settings → Pages → Deploy from branch → `main` / root).
2. Create a fine-grained PAT with access to **only this repo**, permission
   *Contents: read and write* (needed for `repository_dispatch`).
3. Deploy the worker:
   ```
   cd worker
   npx wrangler deploy
   npx wrangler secret put GITHUB_PAT
   ```
   It deploys to `https://supine-meal-plan.<account>.workers.dev`. If that
   isn't `woodcock-s`, update `WORKER_URL` in `app.js`.
4. Weekly generation: run Claude Code in this repo each Thursday or Friday
   with "make next week's plan", or set it up as a scheduled routine.
