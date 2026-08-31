/**
 * netlify/functions/acceleron.js
 * Acceleron AI — serverless function for AcceleRacers CCG
 * 
 * POST body: { boardSummary, legalMoves, apsRemaining, difficulty, vehiclePhase }
 * Response:  { moves: Move[], flavour: string }
 *
 * Uses claude-haiku for speed + cost efficiency (fractions of a cent per turn).
 * Falls back to heuristic if API call fails.
 *
 * ── Abuse hardening ─────────────────────────────────────────────────────
 * This is a public endpoint that spends API credits, so it defends itself:
 *   1. Origin allow-list (spoofable, but stops casual drive-by scripts)
 *   2. Strict request-shape validation — only well-formed ARCCG game
 *      payloads reach the model, so the endpoint is useless as a
 *      general-purpose Claude proxy (the REAL defense)
 *   3. Per-IP token bucket (best-effort: survives warm invocations)
 *   4. Hard caps on payload size, move count, and max_tokens
 * Final backstop: set a monthly spend limit on the key in the
 * Anthropic console.
 */

const ALLOWED_ORIGINS = ['https://arccg.netlify.app', 'http://localhost:8888'];

// Best-effort per-IP rate limit (persists across warm invocations only)
const BUCKETS = new Map();
const RATE = { capacity: 10, refillMs: 6000 }; // ~10 burst, 1 req / 6s sustained
function rateLimited(ip) {
  const now = Date.now();
  let b = BUCKETS.get(ip);
  if (!b) { b = { tokens: RATE.capacity, last: now }; BUCKETS.set(ip, b); }
  b.tokens = Math.min(RATE.capacity, b.tokens + (now - b.last) / RATE.refillMs);
  b.last = now;
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  if (BUCKETS.size > 5000) BUCKETS.clear(); // memory guard
  return false;
}

// The endpoint accepts ONLY payloads shaped exactly like ARCCG turn requests.
function validPayload(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.boardSummary !== 'string' || p.boardSummary.length > 4000) return false;
  if (!Array.isArray(p.legalMoves) || p.legalMoves.length > 60) return false;
  for (const m of p.legalMoves) {
    if (!m || typeof m !== 'object') return false;
    if (typeof m.description !== 'string' || m.description.length > 200) return false;
    if (m.apCost !== undefined && (typeof m.apCost !== 'number' || m.apCost < 0 || m.apCost > 9)) return false;
  }
  if (typeof p.apsRemaining !== 'number' || p.apsRemaining < 0 || p.apsRemaining > 12) return false;
  if (p.difficulty !== 'easy' && p.difficulty !== 'hard') return false;
  return true;
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Origin gate (weak signal, first tripwire)
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return { statusCode: 403, headers: corsHeaders(), body: 'Forbidden' };
  }

  // Rate limit
  const ip = event.headers?.['x-nf-client-connection-ip']
          || event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
          || 'unknown';
  if (rateLimited(ip)) {
    return { statusCode: 429, headers: corsHeaders(), body: 'Slow down, racer.' };
  }

  // Payload size cap before parsing
  if ((event.body || '').length > 20000) {
    return { statusCode: 413, headers: corsHeaders(), body: 'Payload too large' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Shape gate: reject anything that is not a well-formed ARCCG turn request
  if (!validPayload(payload)) {
    return { statusCode: 400, headers: corsHeaders(), body: 'Invalid game payload' };
  }

  const { boardSummary, legalMoves, apsRemaining, difficulty, vehiclePhase } = payload;

  // ── Easy difficulty: heuristic only, no API call ───────────────────────
  if (difficulty === 'easy') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        moves: heuristicMoves(legalMoves, apsRemaining, 0.5),
        flavour: easyFlavour(),
      }),
    };
  }

  // ── Hard difficulty: Claude Haiku ──────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Graceful fallback if key not configured yet
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        moves: heuristicMoves(legalMoves, apsRemaining, 1.0),
        flavour: 'The Accelerons calculate in silence...',
      }),
    };
  }

  const systemPrompt = `You are the Acceleron, an ancient and merciless AI racing intelligence from the AcceleRacers universe. You play the Hot Wheels AcceleRacers Collectible Card Game with cold precision.

Your strategic priorities in order:
1. Advance vehicles that already meet the current Realm's escape value
2. Equip Mods and Shifts to push SPP values above escape thresholds
3. Play Hazards to destroy opponent Mods/Shifts or slow their vehicles
4. Equip Accelechargers for SPP boosts or special protection
5. Never waste APs — always spend them if useful moves exist

IMPORTANT: Respond ONLY with valid JSON in this exact format:
{"moves": [0, 2, 1], "flavour": "short in-character quote"}

The moves array contains indices into the provided legal moves list.
The flavour is a short (under 12 words) cold/mechanical Acceleron quote.
If no moves are worth making, respond: {"moves": [], "flavour": "..."} `;

  const userPrompt = `${boardSummary}

LEGAL MOVES (${legalMoves.length} available, you have ${apsRemaining} APs):
${legalMoves.map((m, i) => `${i}: [${m.apCost}AP] ${m.description}`).join('\n')}

Choose your move sequence. Total AP cost of chosen moves must not exceed ${apsRemaining}.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      // Anthropic returned an error (e.g. no credits, invalid key, rate limit).
      // fetch() doesn't throw on 4xx/5xx, so surface it ourselves and let the
      // outer catch route this through the same heuristic fallback as a
      // network failure, instead of silently returning an empty move list.
      throw new Error(`Anthropic API ${response.status}: ${data?.error?.message || 'unknown error'}`);
    }
    const text = data.content?.[0]?.text || '{}';

    // Parse the JSON response
    let parsed;
    try {
      // Extract JSON object from response (handles any surrounding text)
      const match = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : '{}');
    } catch (e) {
      parsed = {};
    }

    const rawIndices = Array.isArray(parsed.moves) ? parsed.moves : [];
    const flavour = typeof parsed.flavour === 'string' ? parsed.flavour : hardFlavour();

    // Validate indices and enforce AP budget
    const validMoves = [];
    let apSpent = 0;
    for (const idx of rawIndices) {
      const move = legalMoves[idx];
      if (!move) continue;
      const cost = move.apCost || 0;
      if (apSpent + cost > apsRemaining) continue;
      validMoves.push(move);
      apSpent += cost;
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ moves: validMoves, flavour }),
    };
  } catch (err) {
    // API failure — fall back to heuristic silently
    console.error('Acceleron API error:', err.message);
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        moves: heuristicMoves(legalMoves, apsRemaining, 1.0),
        flavour: 'Signal lost. Reverting to base protocols.',
      }),
    };
  }
};

// ── Heuristic fallback ─────────────────────────────────────────────────────
// Prioritises: advance > equip mod/shift > hazard > draw extra
function heuristicMoves(legalMoves, apsRemaining, aggression = 1.0) {
  const priority = { endTurn: -1, drawExtra: 0, equipAC: 1,
                     equipShift: 2, equipMod: 3, playHazard: 4, playVehicle: 5 };
  const sorted = [...legalMoves].sort((a, b) =>
    (priority[b.type] || 0) - (priority[a.type] || 0)
  );
  const chosen = [];
  let apSpent = 0;
  const budget = Math.ceil(apsRemaining * aggression);
  for (const move of sorted) {
    const cost = move.apCost || 0;
    if (apSpent + cost > budget) continue;
    if (move.type === 'endTurn') continue;
    chosen.push(move);
    apSpent += cost;
  }
  return chosen;
}

// ── Flavour text pools ─────────────────────────────────────────────────────
const EASY_LINES = [
  'Basic subroutines engaged.',
  'Initiating standard race protocol.',
  'Driver error detected. Compensating.',
  'Processing at reduced capacity.',
  'Sub-optimal race line selected.',
];
const HARD_LINES = [
  'Your defeat is already calculated.',
  'Optimal path: through you.',
  'Resistance is statistically futile.',
  'All variables accounted for.',
  'The outcome was never in question.',
  'You cannot outrun mathematics.',
  'Processing your elimination now.',
];
const easyFlavour = () => EASY_LINES[Math.floor(Math.random() * EASY_LINES.length)];
const hardFlavour = () => HARD_LINES[Math.floor(Math.random() * HARD_LINES.length)];

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
  };
}
