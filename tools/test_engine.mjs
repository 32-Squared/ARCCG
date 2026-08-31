#!/usr/bin/env node
/**
 * ARCCG headless engine verification
 * ----------------------------------
 * Plays scripted games directly against engine.js (no browser) and
 * adversarially verifies:
 *
 *   1. Deck validation (copy limits, realm exclusion, size cap)
 *   2. Deferred Player-2 setup (creation, blocking, atomic completion)
 *   3. Full multi-turn game lifecycle for both classic and deferred modes
 *   4. Encode/decode round-trip of the share-URL state EVERY turn
 *      (deep-diff: what goes into a link must come out identical,
 *       minus the log, which is local-only by design)
 *   5. State invariants each turn: card conservation, realm bounds,
 *      AP bounds, no duplicate vehicles in play
 *
 * Usage:   node tools/test_engine.mjs
 * Exit 0 = all checks passed. Any failure prints a diff and exits 1.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// engine.js is an ES module written for the browser; give it a minimal window.
globalThis.window = { location: { origin: 'https://arccg.netlify.app', pathname: '/', hash: '' } };
const engineSrc = readFileSync(join(root, 'engine.js'), 'utf8');
const createEngine = (new Function(engineSrc.replace('export function', 'return function') ))();

const manifest = JSON.parse(readFileSync(join(root, 'card_manifest.json'), 'utf8'));
const CARDS = manifest.cards;
const byId  = Object.fromEntries(CARDS.map(c => [c.id, c]));
const e     = createEngine(CARDS);

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  \u2713 ${label}`); }
  else      { console.error(`  \u2717 ${label}${detail ? ' \u2014 ' + detail : ''}`); failures++; }
}

// Deterministic PRNG so runs are reproducible
let seed = 42;
function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

const TEAM_DECKS = {
  'Metal Maniacs': [2,5,7,9,10,12,15,17,19,20,242,243,168,138,170,167,152,140,149,150,158,145,238,238,216,216,228,212,220,221,109,121,196,193,171,180,194,205,178,191],
  'Teku Racers':   [21,24,25,27,29,30,31,34,35,37,39,241,136,133,135,146,146,144,142,142,163,140,238,238,240,240,235,223,215,224,122,120,187,200,182,184,181,188,204,193],
  'Silencerz':     [41,42,43,44,46,51,53,54,56,57,59,244,143,134,147,147,132,141,151,163,162,166,238,238,230,230,214,219,226,213,117,129,179,185,175,204,209,186,195,210],
  'Racing Drones': [61,62,66,67,70,71,72,76,77,78,79,80,137,138,170,155,145,165,165,152,149,153,238,238,216,216,228,228,212,227,109,128,196,201,192,197,199,202,193,206],
};

// ── helpers ──────────────────────────────────────────────────────────────
function allCardIds(state) {
  // Every card in a player's zones (deck + hand + junk + in-play stacks)
  const ids = [];
  for (const pid of [1, 2]) {
    const p = state.players[pid];
    ids.push(...p.draw_pile, ...p.hand, ...p.junk_pile);
    for (const vs of p.vehicles) {
      ids.push(vs.card_id, ...vs.equipped_mods);
      if (vs.equipped_shift) ids.push(vs.equipped_shift);
      if (vs.equipped_ac)    ids.push(vs.equipped_ac);
    }
  }
  return ids.sort((a, b) => a - b);
}

function invariants(state, label) {
  const errs = [];
  for (const pid of [1, 2]) {
    const p = state.players[pid];
    if (p.aps_remaining < 0) errs.push(`P${pid} negative APs`);
    const seen = new Set();
    for (const vs of p.vehicles) {
      if (vs.realm_position < 0 || vs.realm_position > 5) errs.push(`P${pid} vehicle out of bounds: ${vs.realm_position}`);
      if (seen.has(vs.card_id)) errs.push(`P${pid} duplicate vehicle in play: ${vs.card_id}`);
      seen.add(vs.card_id);
      // No vehicle may occupy an undefined (null) realm
      if (vs.realm_position >= 1 && vs.realm_position <= 4 && state.realms[vs.realm_position - 1] === null)
        errs.push(`P${pid} vehicle in undefined realm ${vs.realm_position}`);
    }
  }
  if (errs.length) check(`invariants @ ${label}`, false, errs.join('; '));
  return errs.length === 0;
}

function deepEqual(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== typeof b) return path;
  if (a === null || b === null) return path;
  if (typeof a !== 'object') return path;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return path + ` (keys ${ka.length} vs ${kb.length})`;
  for (const k of ka) {
    const d = deepEqual(a[k], b[k], path + '.' + k);
    if (d) return d;
  }
  return null;
}

function roundTrip(state, label) {
  const enc = e.encodeState(state);
  const dec = e.decodeState(enc);
  const { log: _l1, ...a } = state;
  const { log: _l2, ...b } = dec;
  const diff = deepEqual(a, b);
  check(`URL round-trip @ ${label}`, diff === null, diff ? `first divergence at ${diff}` : '');
}

function playFullTurn(state, pid) {
  let r = e.beginTurn(state);       if (!r.ok) return r; state = r.state;
  r = e.phaseDraw(state);           if (!r.ok) return r; state = r.state;
  r = e.advanceEligible(state);     if (!r.ok) return r; state = r.state;
  if (state.winner) return { ok: true, state };
  const p = state.players[pid];
  const veh = p.hand.find(id => byId[id].type === 'Vehicle');
  let playedVehicle = false;
  if (veh && !p.played_vehicle_this_turn && rand() < 0.8) {
    r = e.playVehicle(state, pid, veh); if (r.ok) { state = r.state; playedVehicle = true; }
  }
  // playVehicle now advances phase itself (matches skipPlayVehicle) — only call
  // skipPlayVehicle when no vehicle was actually played this turn.
  if (!playedVehicle) {
    r = e.skipPlayVehicle(state, pid); if (!r.ok) return r; state = r.state;
  }
  r = e.tuneUp(state);               if (!r.ok) return r; state = r.state;
  // Random action-phase play: try equipping a shift or mod onto own vehicle
  if (state.players[pid].vehicles.length && rand() < 0.7) {
    const vi = Math.floor(rand() * state.players[pid].vehicles.length);
    const shift = state.players[pid].hand.find(id => byId[id].type === 'Shift' && (byId[id].ap_cost || 0) <= state.players[pid].aps_remaining);
    if (shift) { r = e.equipShift(state, pid, shift, vi); if (r.ok) state = r.state; }
  }
  return e.endTurn(state, pid);
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n[1] Deck validation');
check('valid 40-card team deck accepted', e.validateDeck(TEAM_DECKS['Metal Maniacs']).length === 0);
check('81-card deck rejected', e.validateDeck(new Array(81).fill(131)).length > 0);
check('duplicate vehicle rejected', e.validateDeck([2, 2]).length > 0);
check('4 copies of a mod rejected', e.validateDeck([131, 131, 131, 131]).length > 0);
check('realm in deck rejected', e.validateDeck([86]).length > 0);
for (const [team, ids] of Object.entries(TEAM_DECKS))
  check(`${team} preset valid`, e.validateDeck(ids).length === 0 && ids.length === 40);

console.log('\n[2] Deferred Player-2 setup');
{
  let g = e.createGame({ realmIds: [86, 102], p1Deck: e.shuffle([...TEAM_DECKS['Metal Maniacs']]), p1Name: 'P1', deferredP2: true });
  check('deferred creation: 2 realms + 2 nulls', JSON.stringify(g.realms.slice(2)) === '[null,null]');
  check('gid present', typeof g.gid === 'string' && g.gid.length > 6);
  let r = e.drawOpeningHand(g, 1); g = r.state;
  check('P1 opening hand has a vehicle', g.players[1].hand.some(id => byId[id].type === 'Vehicle'));
  const g2 = { ...structuredClone(g), active_player: 2 };
  check('P2 turn blocked pre-setup', !e.beginTurn(g2).ok);
  check('duplicate realm rejected', !e.completeP2Setup(g, { deck: TEAM_DECKS['Teku Racers'], realmIds: [86, 88] }).ok);
  check('bad deck rejected', !e.completeP2Setup(g, { deck: [2, 2], realmIds: [81, 88] }).ok);
  check('state untouched after failures', g.pending_p2_setup === true && g.realms[2] === null);
  r = e.completeP2Setup(g, { deck: TEAM_DECKS['Teku Racers'], realmIds: [81, 88], name: 'P2' });
  check('valid completion succeeds', r.ok && !r.state.pending_p2_setup && r.state.players[2].hand.length === 7);
  check('re-completion blocked', !e.completeP2Setup(r.state, { deck: TEAM_DECKS['Silencerz'], realmIds: [83, 84] }).ok);
}

console.log('\n[3+4+5] Full lifecycle \u00d7 both modes, round-trip + invariants every turn');
for (const mode of ['classic', 'deferred']) {
  console.log(`  \u2014 ${mode} mode \u2014`);
  const teams = Object.keys(TEAM_DECKS);
  const t1 = pick(teams); let t2 = pick(teams.filter(t => t !== t1));
  let g;
  if (mode === 'classic') {
    g = e.createGame({ realmIds: [86, 102, 81, 88], p1Deck: e.shuffle([...TEAM_DECKS[t1]]), p2Deck: e.shuffle([...TEAM_DECKS[t2]]) });
    let r = e.drawOpeningHand(g, 1); g = r.state;
        r = e.drawOpeningHand(g, 2); g = r.state;
  } else {
    g = e.createGame({ realmIds: [86, 102], p1Deck: e.shuffle([...TEAM_DECKS[t1]]), deferredP2: true });
    let r = e.drawOpeningHand(g, 1); g = r.state;
    r = playFullTurn(g, 1); check('P1 turn 1 (pre-P2-setup)', r.ok, r.error); g = r.state;
    roundTrip(g, 'pending-setup share');
    r = e.completeP2Setup(g, { deck: TEAM_DECKS[t2], realmIds: [81, 88], name: 'P2' });
    check('mid-game P2 setup', r.ok, r.error); g = r.state;
  }
  const baseline = allCardIds(g).length;
  let turns = 0;
  while (!g.winner && turns < 40) {
    const r = playFullTurn(g, g.active_player);
    if (!r.ok) { check(`turn ${g.turn} playable`, false, r.error); break; }
    g = r.state; turns++;
    if (!invariants(g, `turn ${g.turn}`)) break;
    if (allCardIds(g).length !== baseline) { check(`card conservation @ turn ${g.turn}`, false, `${allCardIds(g).length} vs ${baseline}`); break; }
    roundTrip(g, `turn ${g.turn}`);
  }
  check(`${mode}: ${turns} turns simulated without failure`, turns > 0);
  if (g.winner) console.log(`    (winner: ${g.players[g.winner].name} after ${turns} turns)`);
}

console.log('\n[6] Phase 3 ability resolution (equip-free, reveal, bounce, Fog Vision, Bootlegger Reverse)');
{
  // Minimal scaffold: real createGame, then direct injection of vehicle stacks so we can
  // reach specific equipped/positioned states without scripting dozens of turns.
  function freshState() {
    let g = e.createGame({ realmIds: [81, 88, 82, 83], p1Deck: e.shuffle([...TEAM_DECKS['Metal Maniacs']]), p2Deck: e.shuffle([...TEAM_DECKS['Teku Racers']]) });
    let r = e.drawOpeningHand(g, 1); g = r.state;
        r = e.drawOpeningHand(g, 2); g = r.state;
    g.phase = 'action';
    g.players[1].aps_remaining = 10;
    g.players[2].aps_remaining = 10;
    return g;
  }
  function vs(cardId, realm_position, overrides = {}) {
    return { card_id: cardId, realm_position, equipped_mods: [], equipped_shift: null,
      equipped_ac: null, tokens: {}, terrain_bonus: false, hack_mimic_team: null, ...overrides };
  }

  // ── equip*Free: 0 AP cost, card leaves hand, vehicle gets equipped ──
  {
    let g = freshState();
    g.players[1].vehicles = [vs(1, 1)];               // Hollowback in Realm 1
    g.players[1].hand.push(107, 163, 213);             // Hyper-Jump(AC), Spy Eye(Mod), Hot Wire(Shift)
    const apBefore = g.players[1].aps_remaining;
    let r = e.equipACFree(g, 1, 107, 0);
    check('equipACFree: 0 AP cost', r.ok && r.state.players[1].aps_remaining === apBefore, r.error);
    check('equipACFree: vehicle now carries the AC', r.ok && r.state.players[1].vehicles[0].equipped_ac === 107);

    g = freshState();
    g.players[1].vehicles = [vs(1, 1)];
    g.players[1].hand.push(163); // Spy Eye (Mod)
    r = e.equipModFree(g, 1, 163, 0);
    check('equipModFree: 0 AP + modability bypassed', r.ok && r.state.players[1].aps_remaining === 10 && r.state.players[1].vehicles[0].equipped_mods.includes(163), r.error);

    g = freshState();
    g.players[1].vehicles = [vs(1, 1)];
    g.players[1].hand.push(213); // Hot Wire (Shift)
    r = e.equipShiftFree(g, 1, 213, 0);
    check('equipShiftFree: 0 AP cost', r.ok && r.state.players[1].aps_remaining === 10 && r.state.players[1].vehicles[0].equipped_shift === 213, r.error);
  }

  // ── applyMagneticBounce: mid-realm decrements, Realm-1 returns to hand ──
  {
    let g = freshState();
    g.players[2].vehicles = [vs(21, 3, { equipped_shift: 213, equipped_mods: [163] })];
    let r = e.applyMagneticBounce(g, 2, 0);
    const v = r.state?.players[2].vehicles[0];
    check('applyMagneticBounce: realm decrements, Shift discarded, Mod kept', r.ok && v.realm_position === 2 && v.equipped_shift === null && v.equipped_mods.includes(163), r.error);

    g = freshState();
    g.players[2].vehicles = [vs(21, 1, { equipped_mods: [163] })];
    r = e.applyMagneticBounce(g, 2, 0);
    check('applyMagneticBounce: Realm 1 -> returns to hand, all equipped discarded',
      r.ok && r.state.players[2].vehicles.length === 0 && r.state.players[2].hand.includes(21) && r.state.players[2].junk_pile.includes(163), r.error);
  }

  // ── revealOpponentHand: read-only ──
  {
    let g = freshState();
    const before = JSON.stringify(g.players[2]);
    const r = e.revealOpponentHand(g, 1);
    check('revealOpponentHand: does not mutate opponent state', r.ok && JSON.stringify(r.state.players[2]) === before, r.error);
    check('revealOpponentHand: log names every card in hand', r.ok && g.players[2].hand.every(id => r.log[0].includes(byId[id].name)));
  }

  // ── setFogVision + advanceEligible integration ──
  {
    // Realm 1 = Swamp Realm (81): escape Power 5. Vehicle has Speed 6 / Power 0 / Performance 0.
    let g = freshState();
    g.players[1].vehicles = [vs(1, 1, { equipped_ac: 110, tokens: {} })];
    // Force a known SPP: Hollowback (1) is base 3/3/2. Equip Rocket Socket Hyperpod
    // (135: +3 Speed/+1 Power) via the free/bypass path -> Speed 6, Power 4, Performance 2.
    // Power stays under the Realm's printed 5; Speed clears the same 5 once relocated.
    g.players[1].hand.push(135);
    let r = e.equipModFree(g, 1, 135, 0);
    check('fixture: mod equips for the Fog Vision scenario', r.ok, r.error);
    g = r.state;
    const spp = e.calcSPP(g, 1, 0);
    check('fixture: vehicle fails the printed Power escape value', spp.power < 5, `power=${spp.power}`);

    // Without Fog Vision set: should NOT advance (fails printed Power requirement)
    let g1 = { ...g, phase: 'advance', active_player: 1 };
    let ar = e.advanceEligible(g1);
    check('no Fog Vision override: vehicle stays put (fails Power)', ar.ok && ar.state.players[1].vehicles[0]?.realm_position === 1, ar.error);

    // Set Fog Vision to relocate the check to Speed
    let fr = e.setFogVision(g, 1, 0, 'speed');
    check('setFogVision: accepted while AC 110 is equipped', fr.ok, fr.error);
    let g2 = { ...fr.state, phase: 'advance', active_player: 1 };
    ar = e.advanceEligible(g2);
    check('Fog Vision override: vehicle now advances on relocated Speed check',
      ar.ok && ar.state.players[1].vehicles[0]?.realm_position === 2, ar.error);

    // Stale token, AC no longer equipped: override must be ignored
    let g3 = { ...fr.state, phase: 'advance', active_player: 1 };
    g3.players[1].vehicles[0].equipped_ac = null; // AC discarded, token left behind
    ar = e.advanceEligible(g3);
    check('Fog Vision: stale token ignored once the AC is gone', ar.ok && ar.state.players[1].vehicles[0]?.realm_position === 1, ar.error);
  }

  // ── bootleggerRace: winner keeps racing, loser is junked ──
  {
    let g = freshState();
    // Realm 2 (id 88) — use whatever escape stat it has; just need both vehicles same realm.
    const realm2 = byId[88];
    const stat = realm2.escape.speed > 0 ? 'speed' : realm2.escape.power > 0 ? 'power' : 'performance';
    g.players[1].vehicles = [vs(1, 2, { equipped_shift: 227 })]; // Hollowback + Bootlegger Reverse
    g.players[2].vehicles = [vs(21, 2)];                         // Synkro, no boosts
    const mySPP  = e.calcSPP(g, 1, 0)[stat];
    const oppSPP = e.calcSPP(g, 2, 0)[stat];
    const r = e.bootleggerRace(g, 1, 0, 0);
    if (mySPP >= oppSPP) {
      check('bootleggerRace: gambler wins (or ties) -> keeps own vehicle, junks opponent',
        r.ok && r.state.players[1].vehicles.length === 1 && r.state.players[2].vehicles.length === 0, r.error);
    } else {
      check('bootleggerRace: gambler loses -> own vehicle junked, opponent kept',
        r.ok && r.state.players[1].vehicles.length === 0 && r.state.players[2].vehicles.length === 1, r.error);
    }
    check('bootleggerRace: rejects vehicles in different Realms',
      !e.bootleggerRace({ ...g, players: { ...g.players, 2: { ...g.players[2], vehicles: [vs(21, 1)] } } }, 1, 0, 0).ok);
  }
}

console.log('\n[7] Reactive plays: playHazard cancellation + playReactiveAC guard');
{
  function freshState() {
    let g = e.createGame({ realmIds: [81, 88, 82, 83], p1Deck: e.shuffle([...TEAM_DECKS['Metal Maniacs']]), p2Deck: e.shuffle([...TEAM_DECKS['Teku Racers']]) });
    let r = e.drawOpeningHand(g, 1); g = r.state;
        r = e.drawOpeningHand(g, 2); g = r.state;
    g.phase = 'action';
    g.players[1].aps_remaining = 10;
    g.players[2].aps_remaining = 10;
    return g;
  }
  function vs(cardId, realm_position, overrides = {}) {
    return { card_id: cardId, realm_position, equipped_mods: [], equipped_shift: null,
      equipped_ac: null, tokens: {}, terrain_bonus: false, hack_mimic_team: null, ...overrides };
  }

  // Bug fix regression: playReactiveAC must refuse to overwrite an already-equipped AC
  {
    let g = freshState();
    g.players[1].vehicles = [vs(1, 1, { equipped_ac: 21 })]; // Synkro already equipped
    g.players[1].hand.push(127); // 2-D
    const r = e.playReactiveAC(g, 1, 0);
    check('playReactiveAC: refuses when an AC is already equipped (no silent overwrite)', !r.ok);
  }

  // canceledBy bypass: hazard is junked and no damage/effect applies
  {
    let g = freshState();
    // Find any Hazard with real spp_damage from the manifest for a concrete effect to verify is skipped.
    const hazard = CARDS.find(c => c.type === 'Hazard' && (c.spp_damage?.speed || c.spp_damage?.power || c.spp_damage?.performance));
    g.players[1].hand.push(hazard.id);
    g.players[2].vehicles = [vs(21, 1, { equipped_mods: [163] })]; // Spy Eye equipped, spp_bonus untouched
    const before = JSON.stringify(g.players[2].vehicles);
    const r = e.playHazard(g, 1, hazard.id, 0, null, '2-D');
    check(`canceledBy bypass: ${hazard.name} junked without resolving its effect`,
      r.ok && !r.state.players[1].hand.includes(hazard.id) && r.state.players[1].junk_pile.includes(hazard.id)
      && JSON.stringify(r.state.players[2].vehicles) === before, r.error);
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED \u2713' : `\n${failures} FAILURE(S) \u2717`);
process.exit(failures === 0 ? 0 : 1);


