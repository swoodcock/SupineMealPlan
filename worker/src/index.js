// Stateless proxy: holds the GitHub PAT as a Worker secret so it never reaches
// the browser. Its only job is to relay a small, validated request as a
// repository_dispatch event. The GitHub Actions workflow
// (.github/workflows/record.yml) does the actual writing with its own
// short-lived GITHUB_TOKEN.
//
// The browser never sends recipe HTML: only ids,
// short notes, a few fixed choices and a pantry of {foodId: grams}. The
// workflow looks recipes up in the committed week file, so nothing a visitor
// sends ends up as markup on the site.

const ALLOWED_ORIGIN = 'https://swoodcock.github.io';
const GITHUB_REPO = 'swoodcock/SupineMealPlan';
const MAX_BODY_BYTES = 4 * 1024;

const ID_RE = /^[A-Za-z0-9-]{1,40}$/;
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PANTRY_ITEMS = 80;

const cleanNotes = (s) => String(s || '').replace(/[^A-Za-z0-9 .,!'?-]/g, '').slice(0, 300);
const oneOf = (v, list) => (list.includes(v) ? v : '');

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function reply(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

// Returns the dispatch [event_type, client_payload], or null if invalid.
function validate(p) {
  if (!p || typeof p !== 'object' || !WEEK_RE.test(String(p.week))) return null;
  if (p.type === 'save-recipe' && ID_RE.test(String(p.recipe_id))) {
    return ['save-recipe', {
      week: p.week,
      recipe_id: p.recipe_id,
      notes: cleanNotes(p.notes),
    }];
  }
  if (p.type === 'choose-plan' && /^[A-Z]$/.test(String(p.plan_id))) {
    return ['choose-plan', { week: p.week, plan_id: p.plan_id }];
  }
  if (p.type === 'recipe-feedback' && ID_RE.test(String(p.recipe_id)) && p.verdict === 'less') {
    return ['recipe-feedback', { week: p.week, recipe_id: p.recipe_id, verdict: 'less', notes: cleanNotes(p.notes) }];
  }
  if (p.type === 'week-review' && /^[A-Z]$/.test(String(p.plan_id))) {
    return ['week-review', {
      week: p.week, plan_id: p.plan_id,
      taste: oneOf(p.taste, ['great', 'fine', 'meh']),
      effort: oneOf(p.effort, ['too-much', 'right', 'more']),
      notes: cleanNotes(p.notes),
    }];
  }
  if (p.type === 'pantry' && p.items && typeof p.items === 'object' && !Array.isArray(p.items)) {
    const entries = Object.entries(p.items);
    if (entries.length > MAX_PANTRY_ITEMS) return null;
    const items = {};
    for (const [id, g] of entries) {
      if (!ID_RE.test(id) || typeof g !== 'number' || !(g > 0 && g <= 100000)) return null;
      items[id] = Math.round(g);
    }
    // Sent as a JSON string so the workflow can pass it through one env var.
    return ['pantry', { week: p.week, items: JSON.stringify(items) }];
  }
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== 'POST') return reply(405, 'Method not allowed');

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return reply(413, 'Payload too large');

    let payload;
    try { payload = JSON.parse(raw); } catch (e) { return reply(400, 'Invalid JSON'); }

    const event = validate(payload);
    if (!event) return reply(400, 'Invalid request');

    const ghResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_PAT}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'supine-meal-plan-worker',
      },
      body: JSON.stringify({ event_type: event[0], client_payload: event[1] }),
    });

    return reply(ghResp.ok ? 200 : 502, { ok: ghResp.ok });
  },
};
