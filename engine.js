/**
 * Hot Wheels AcceleRacers CCG — Game Engine
 * Pure ES-module, zero runtime dependencies.
 * All state is a plain JSON-serialisable object (GameState).
 *
 * Conventions
 * ──────────────────────────────────────────────────────
 *  - Every public function returns { ok, state, error, log }
 *    ok    : boolean – did the action succeed?
 *    state : new GameState (always a deep clone, original untouched)
 *    error : string | null
 *    log   : string[] – human-readable lines appended this action
 *
 *  - "pid" is always 1 or 2 (player index)
 *  - Card IDs are integers matching card_manifest.json
 *  - Vehicle stacks are identified by vehicleIndex (position in player.vehicles[])
 *  - Realm positions: 0 = not yet played, 1-4 = realms, 5 = finished
 */

// ─── IMPORTS (caller must supply CARDS + REALMS from manifest) ───────────────
// Usage:
//   import { createEngine } from './engine.js';
//   const engine = createEngine(cardManifest.cards);

export function createEngine(allCards) {

  // ── Lookup helpers ────────────────────────────────────────────────────────
  const byId    = id   => allCards.find(c => c.id === id);
  const isType  = (id, t) => byId(id)?.type === t;
  const isVehicle      = id => isType(id, 'Vehicle');
  const isRealm        = id => isType(id, 'Realm');
  const isMod          = id => isType(id, 'Mod');
  const isShift        = id => isType(id, 'Shift');
  const isAC           = id => isType(id, 'Accelecharger');
  const isHazard       = id => isType(id, 'Hazard');
  const card           = id => byId(id);

  // ── Deep clone helper ─────────────────────────────────────────────────────
  const clone = s => JSON.parse(JSON.stringify(s));

  // ── Log helper ────────────────────────────────────────────────────────────
  function appendLog(state, line) {
    state.log = state.log || [];
    state.log.push(`[T${state.turn}] ${line}`);
    // Keep last 200 lines to cap URL size
    if (state.log.length > 200) state.log = state.log.slice(-200);
  }

  function ok(state, logLines = []) {
    logLines.forEach(l => appendLog(state, l));
    return { ok: true, state, error: null, log: logLines };
  }

  function fail(state, error) {
    return { ok: false, state, error, log: [] };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // GAME STATE SCHEMA
  // ════════════════════════════════════════════════════════════════════════════
  /**
   * GameState {
   *   version       : number
   *   created       : ISO string
   *   turn          : number   (increments each time active player flips)
   *   phase         : 'draw' | 'advance' | 'play_vehicle' | 'tune_up' | 'action' | 'end_turn' | 'game_over'
   *   active_player : 1 | 2
   *   winner        : null | 1 | 2
   *   realms        : number[4]   card IDs of the 4 realm cards in play order
   *   restrictions  : {          per-realm flags set by Realm special rules
   *     no_shifts_realm_idx : number | null   (Fog Realm)
   *   }
   *   players : {
   *     1: PlayerState,
   *     2: PlayerState
   *   }
   *   pending_effects : Effect[]   hazards/abilities waiting to resolve
   *   log : string[]
   * }
   *
   * PlayerState {
   *   name         : string
   *   draw_pile    : number[]   card IDs (top = index 0)
   *   hand         : number[]
   *   junk_pile    : number[]
   *   vehicles     : VehicleStack[]
   *   played_vehicle_this_turn : boolean
   *   aps_remaining : number
   *   hand_limit   : number    (default 7; Technetium raises to 8 or 9)
   *   no_mods_next_turn : boolean    set by Wrecking Balls
   *   no_shifts_next_turn : boolean  set by Proto-Sharks
   *   limited_aps_next_turn : number | null  set by Chrome Globes
   * }
   *
   * VehicleStack {
   *   card_id       : number
   *   realm_position: 0-5   (0=hand/not played, 1-4=realm index, 5=finished)
   *   equipped_mods : number[]
   *   equipped_shift: number | null
   *   equipped_ac   : number | null
   *   tokens        : { [purpose]: number }
   *   terrain_bonus : boolean   (token on matching terrain icon)
   *   hack_mimic_team: string | null   (Hack Mimic override)
   * }
   *
   * Effect {
   *   type          : string
   *   source_card   : number
   *   target_player : 1 | 2
   *   target_vehicle_idx : number | null
   *   target_card   : number | null
   *   tokens_remaining : number | null
   *   data          : object   (flexible payload per effect type)
   * }
   */

  // ════════════════════════════════════════════════════════════════════════════
  // INITIALISATION
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * createGame — build a fresh GameState.
   * @param {object} opts
   *   opts.realmIds      number[4]  the four realm card IDs chosen for this game
   *   opts.p1Deck        number[]   card IDs in player 1's deck (shuffled by caller)
   *   opts.p2Deck        number[]   card IDs in player 2's deck (shuffled by caller)
   *   opts.p1Name        string
   *   opts.p2Name        string
   *   opts.firstPlayer   1 | 2      winner of coin toss goes first (Pole Position)
   */
  function createGame({ realmIds, p1Deck, p2Deck, p1Name = 'Player 1', p2Name = 'Player 2', firstPlayer = 1 }) {
    // Validate decks
    const deckErrors = validateDeck(p1Deck).concat(validateDeck(p2Deck));
    if (deckErrors.length) throw new Error('Invalid deck: ' + deckErrors.join('; '));
    if (realmIds.length !== 4) throw new Error('Must supply exactly 4 realm IDs');
    realmIds.forEach(id => { if (!isRealm(id)) throw new Error(`Card ${id} is not a Realm`); });

    const makePlayer = (name, deck) => ({
      name,
      draw_pile: [...deck],
      hand: [],
      junk_pile: [],
      vehicles: [],
      played_vehicle_this_turn: false,
      aps_remaining: 3,
      hand_limit: 7,
      no_mods_next_turn: false,
      no_shifts_next_turn: false,
      limited_aps_next_turn: null,
    });

    const state = {
      version: 1,
      created: new Date().toISOString(),
      turn: 1,
      phase: 'draw',
      active_player: firstPlayer,
      winner: null,
      realms: realmIds,
      restrictions: { no_shifts_realm_idx: null },
      players: { 1: makePlayer(p1Name, p1Deck), 2: makePlayer(p2Name, p2Deck) },
      pending_effects: [],
      log: [],
    };

    // Each player draws 7 cards (re-draw if no vehicle — handled by caller using drawOpeningHand)
    appendLog(state, `Game started. ${p1Name} vs ${p2Name}. ${firstPlayer === 1 ? p1Name : p2Name} has Pole Position.`);
    return state;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DECK VALIDATION
  // ════════════════════════════════════════════════════════════════════════════

  function validateDeck(deck) {
    const errors = [];
    if (deck.length > 80) errors.push(`Deck has ${deck.length} cards (max 80)`);
    const counts = {};
    for (const id of deck) {
      counts[id] = (counts[id] || 0) + 1;
      const c = card(id);
      if (!c) { errors.push(`Unknown card ID ${id}`); continue; }
      if (isRealm(id)) errors.push(`Realm card ${id} must not be in deck`);
      if ((isVehicle(id) || isAC(id)) && counts[id] > 1)
        errors.push(`${c.name} (id ${id}): max 1 copy`);
      if ((isMod(id) || isShift(id) || isHazard(id)) && counts[id] > 3)
        errors.push(`${c.name} (id ${id}): max 3 copies`);
    }
    return errors;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SHUFFLE
  // ════════════════════════════════════════════════════════════════════════════

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DRAWING
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * drawCard — draw 1 card from draw pile into hand (or lose if empty).
   * Called automatically at start of turn, or can be called for AP-cost draws.
   */
  function drawCard(stateIn, pid) {
    const s = clone(stateIn);
    const p = s.players[pid];
    if (p.draw_pile.length === 0) {
      s.winner = pid === 1 ? 2 : 1;
      s.phase = 'game_over';
      return ok(s, [`${p.name} cannot draw — draw pile empty. ${s.players[s.winner].name} wins!`]);
    }
    const drawn = p.draw_pile.shift();
    p.hand.push(drawn);
    return ok(s, [`${p.name} draws a card (hand: ${p.hand.length})`]);
  }

  /**
   * drawOpeningHand — draw 7; if no vehicle drawn, reshuffle and redraw.
   * Returns state after hand is set.
   */
  function drawOpeningHand(stateIn, pid) {
    let s = clone(stateIn);
    const p = s.players[pid];
    let attempts = 0;
    do {
      p.hand = [];
      p.draw_pile = shuffle([...p.draw_pile, ...p.hand]);
      for (let i = 0; i < 7; i++) {
        if (p.draw_pile.length === 0) break;
        p.hand.push(p.draw_pile.shift());
      }
      attempts++;
      if (attempts > 10) break; // safety
    } while (!p.hand.some(id => isVehicle(id)));
    appendLog(s, `${p.name} draws opening hand (${attempts > 1 ? attempts + ' attempts' : '1 draw'}).`);
    return { ok: true, state: s, error: null, log: [] };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SPP CALCULATION
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Returns { speed, power, performance } total for a vehicle stack,
   * including base vehicle + mods + shift + ac + terrain bonus.
   */
  function calcSPP(state, pid, vehicleIdx) {
    const vs  = state.players[pid].vehicles[vehicleIdx];
    const v   = card(vs.card_id);
    let sp = { speed: v.spp.speed, power: v.spp.power, performance: v.spp.performance };

    const addBonus = id => {
      const c = card(id);
      if (!c) return;
      const b = c.spp_bonus || c.spp_damage || {};
      sp.speed       += (b.speed       || 0);
      sp.power       += (b.power       || 0);
      sp.performance += (b.performance || 0);
    };

    vs.equipped_mods.forEach(addBonus);
    if (vs.equipped_shift) addBonus(vs.equipped_shift);
    if (vs.equipped_ac)    addBonus(vs.equipped_ac);

    // Folding Corners: each token on the AC adds +1 to each SPP
    if (vs.equipped_ac === 126 && vs.tokens['folding_corners']) {
      const t = vs.tokens['folding_corners'];
      sp.speed += t; sp.power += t; sp.performance += t;
    }

    // Terrain bonus: +1 to all if vehicle terrain matches realm terrain
    if (vs.terrain_bonus) {
      sp.speed += 1; sp.power += 1; sp.performance += 1;
    }

    return sp;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // TEAM BONUS AP
  // ════════════════════════════════════════════════════════════════════════════

  function calcTeamBonusAPs(state, pid) {
    const vehicles = state.players[pid].vehicles.filter(v => v.realm_position >= 1 && v.realm_position <= 4);
    const teamCounts = {};
    for (const vs of vehicles) {
      const c  = card(vs.card_id);
      const team = vs.hack_mimic_team || c.team;
      if (team) teamCounts[team] = (teamCounts[team] || 0) + 1;
    }
    // +1 AP per unique team that has 2 or more vehicles in play
    return Object.values(teamCounts).filter(n => n >= 2).length;
  }

  function calcTotalAPs(state, pid) {
    const p = state.players[pid];
    const base = 3;
    const teamBonus = calcTeamBonusAPs(state, pid);
    const limited = p.limited_aps_next_turn;
    if (limited !== null && limited !== undefined) return Math.min(base + teamBonus, limited);
    return base + teamBonus;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODABILITY CHECK
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Can modId be equipped on vehicleStack?
   * Returns true / false. Bypassed when "Modability rules DO NOT apply."
   */
  function canEquipMod(modId, vehicleStack, bypassModability = false) {
    if (bypassModability) return true;
    const m = card(modId);
    const v = card(vehicleStack.card_id);
    if (!m || !v) return false;

    // Team restrictions (Dragon Torch = MM only, etc.)
    if (m.restriction && m.restriction !== v.team) return false;

    // Modability icon match (at least one icon in common)
    const mIcons = m.modability || [];
    const vIcons = v.modability || [];
    if (mIcons.length === 0 || vIcons.length === 0) return true; // no icons = no restriction (pending data fill)
    return mIcons.some(i => vIcons.includes(i));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // TURN PHASES
  // ════════════════════════════════════════════════════════════════════════════

  /** beginTurn — resets AP, flags, moves to draw phase */
  function beginTurn(stateIn) {
    const s   = clone(stateIn);
    const pid = s.active_player;
    const p   = s.players[pid];

    // Apply any "next turn" restrictions set by opponent hazards
    p.aps_remaining = calcTotalAPs(s, pid);

    // Chrome Globes: limited APs this turn
    if (p.limited_aps_next_turn !== null) {
      appendLog(s, `${p.name} is limited to ${p.limited_aps_next_turn} APs this turn (Chrome Globes).`);
      p.aps_remaining = p.limited_aps_next_turn;
      p.limited_aps_next_turn = null;
    }

    p.played_vehicle_this_turn = false;
    s.phase = 'draw';
    return ok(s, [`=== Turn ${s.turn} — ${p.name}'s turn begins (${p.aps_remaining} APs) ===`]);
  }

  // ── PHASE 1: Draw ──────────────────────────────────────────────────────────
  function phaseDraw(stateIn) {
    if (stateIn.phase !== 'draw') return fail(stateIn, 'Not in draw phase');
    const s   = clone(stateIn);
    const pid = s.active_player;
    const result = drawCard(s, pid);
    if (!result.ok) return result;
    result.state.phase = 'advance';
    return result;
  }

  // ── PHASE 2: Advance ───────────────────────────────────────────────────────
  /**
   * advanceEligible — automatically advance all vehicles that meet/beat escape value.
   * Must be called by the client at the start of the advance phase.
   */
  function advanceEligible(stateIn) {
    if (stateIn.phase !== 'advance') return fail(stateIn, 'Not in advance phase');
    const s   = clone(stateIn);
    const pid = s.active_player;
    const p   = s.players[pid];
    const logs = [];

    // Check win condition immediately (handles pre-existing finished vehicles)
    const alreadyFinished = p.vehicles.filter(v => v.realm_position === 5).length;
    if (alreadyFinished >= 3) {
      s.winner = pid;
      s.phase  = 'game_over';
      return ok(s, [`${p.name} has 3 vehicles through all 4 Realms — WINS!`]);
    }

    for (let idx = 0; idx < p.vehicles.length; idx++) {
      const vs = p.vehicles[idx];
      if (vs.realm_position < 1 || vs.realm_position > 4) continue;
      const realmIdx = vs.realm_position - 1; // 0-based into s.realms
      const realm = card(s.realms[realmIdx]);
      if (!realm) continue;

      const spp  = calcSPP(s, pid, idx);
      const esc  = realm.escape;
      const meetsS = spp.speed       >= (esc.speed       || 0);
      const meetsP = spp.power       >= (esc.power       || 0);
      const meetsPf= spp.performance >= (esc.performance || 0);

      // Must meet the one non-zero escape value (Realms have exactly one non-zero)
      const mustMeet = [];
      if (esc.speed > 0)       mustMeet.push({ stat:'speed',       val: esc.speed,       has: spp.speed });
      if (esc.power > 0)       mustMeet.push({ stat:'power',       val: esc.power,       has: spp.power });
      if (esc.performance > 0) mustMeet.push({ stat:'performance', val: esc.performance, has: spp.performance });

      const canAdvance = mustMeet.every(m => m.has >= m.val);
      if (!canAdvance) continue;

      const vc = card(vs.card_id);
      logs.push(`${vc.name} advances from ${realm.name}!`);
      const result = _advanceVehicle(s, pid, idx);
      if (result.ok) {
        Object.assign(s, result.state); // merge
        // re-fetch updated vehicle after merge
      }
    }

    // Check win condition (includes any pre-existing finished vehicles)
    const finished = s.players[pid].vehicles.filter(v => v.realm_position === 5).length;
    if (finished >= 3) {
      s.winner = pid;
      s.phase  = 'game_over';
      logs.push(`${p.name} has moved 3 vehicles through all 4 Realms — WINS!`);
      return ok(s, logs);
    }

    s.phase = 'play_vehicle';
    return ok(s, logs);
  }

  /** Internal: advance a single vehicle stack one realm forward */
  function _advanceVehicle(stateIn, pid, vehicleIdx) {
    const s  = clone(stateIn);
    const p  = s.players[pid];
    const vs = p.vehicles[vehicleIdx];
    const vc = card(vs.card_id);
    const logs = [];

    const fromPos = vs.realm_position;
    const toPos   = fromPos + 1;

    // Junk Realm special: vehicles retain ALL mods when advancing out
    const fromRealmCard = fromPos >= 1 ? card(s.realms[fromPos - 1]) : null;
    const junkRealmActive = fromRealmCard?.name === 'JUNK REALM';

    if (toPos > 4) {
      // Exiting the 4th realm — vehicle is finished
      vs.realm_position = 5;
      // Discard all equipped cards
      _junkedEquipped(s, pid, vehicleIdx, true, true, true);
      logs.push(`${vc.name} exits the 4th Realm — finished!`);
      return ok(s, logs);
    }

    vs.realm_position = toPos;

    // Discard shifts and ACs unless special rule says otherwise
    const keepShifts = _vehicleKeepsShifts(vs);
    const keepAC     = false; // ACs always discarded on advance

    // Remove shift unless Hardened Underbelly or High Voltage / Hyper High Voltage
    if (!keepShifts) {
      if (vs.equipped_shift) {
        p.junk_pile.push(vs.equipped_shift);
        logs.push(`  → ${card(vs.equipped_shift)?.name} discarded (shift)`);
        vs.equipped_shift = null;
      }
    }
    // Remove AC
    if (vs.equipped_ac) {
      p.junk_pile.push(vs.equipped_ac);
      logs.push(`  → ${card(vs.equipped_ac)?.name} discarded (AC)`);
      vs.equipped_ac = null;
    }

    // Junk Realm: DO NOT remove mods
    if (!junkRealmActive) {
      // Mods stay — they are permanent (no action needed)
    }

    // Clear terrain bonus token (recalculated on tune-up)
    vs.terrain_bonus = false;
    // Clear tokens that were realm-specific effects
    // (effect tokens are managed by pending_effects, not here)

    // Check Fog Realm restriction on the new realm
    _applyRealmRestrictions(s);

    return ok(s, logs);
  }

  /** Does this vehicle keep its shift on advance? */
  function _vehicleKeepsShifts(vs) {
    // Card 23 High Voltage: keeps shifts advancing to SECOND realm only
    if (vs.card_id === 23 && vs.realm_position === 2) return true;
    // Card 33 Hyper High Voltage: NEVER discards shifts on ANY advance
    if (vs.card_id === 33) return true;
    // Hardened Underbelly (mod 166): keeps 1 shift on any advance
    if (vs.equipped_mods.includes(166) && vs.equipped_shift) return true;
    return false;
  }

  /** Discard equipped cards to junk pile */
  function _junkedEquipped(state, pid, vehicleIdx, mods, shift, ac) {
    const p  = state.players[pid];
    const vs = p.vehicles[vehicleIdx];
    if (mods) {
      p.junk_pile.push(...vs.equipped_mods);
      vs.equipped_mods = [];
    }
    if (shift && vs.equipped_shift) {
      p.junk_pile.push(vs.equipped_shift);
      vs.equipped_shift = null;
    }
    if (ac && vs.equipped_ac) {
      p.junk_pile.push(vs.equipped_ac);
      vs.equipped_ac = null;
    }
  }

  function _applyRealmRestrictions(state) {
    // Fog Realm (card 84): no new shifts in that realm
    state.restrictions.no_shifts_realm_idx = null;
    state.realms.forEach((rid, i) => {
      if (card(rid)?.name === 'FOG REALM') state.restrictions.no_shifts_realm_idx = i + 1; // 1-based realm position
    });
  }

  // ── PHASE 3: Play Vehicle ──────────────────────────────────────────────────
  /**
   * playVehicle — place one vehicle from hand into the first realm for free.
   */
  function playVehicle(stateIn, pid, cardId) {
    if (stateIn.phase !== 'play_vehicle') return fail(stateIn, 'Not in play_vehicle phase');
    if (stateIn.active_player !== pid)    return fail(stateIn, 'Not your turn');
    const s = clone(stateIn);
    const p = s.players[pid];

    if (p.played_vehicle_this_turn) return fail(s, 'Already played a Vehicle this turn');
    if (!p.hand.includes(cardId))   return fail(s, 'Card not in hand');
    if (!isVehicle(cardId))         return fail(s, 'Card is not a Vehicle');

    // Remove from hand
    p.hand.splice(p.hand.indexOf(cardId), 1);

    // Build vehicle stack
    const vs = {
      card_id: cardId,
      realm_position: 1,
      equipped_mods: [],
      equipped_shift: null,
      equipped_ac: null,
      tokens: {},
      terrain_bonus: false,
      hack_mimic_team: null,
    };
    p.vehicles.push(vs);
    p.played_vehicle_this_turn = true;
    const vehicleIdx = p.vehicles.length - 1;

    const logs = [`${p.name} plays ${card(cardId).name} into Realm 1.`];

    // ── On-play abilities ────────────────────────────────────────────────────
    const r = _triggerOnPlay(s, pid, vehicleIdx);
    if (r.ok) Object.assign(s, r.state);
    logs.push(...(r.log || []));

    return ok(s, logs);
  }

  /** skipPlayVehicle — pass the free vehicle play */
  function skipPlayVehicle(stateIn, pid) {
    if (stateIn.phase !== 'play_vehicle') return fail(stateIn, 'Not in play_vehicle phase');
    if (stateIn.active_player !== pid)    return fail(stateIn, 'Not your turn');
    const s = clone(stateIn);
    s.phase = 'tune_up';
    return ok(s, [`${s.players[pid].name} skips vehicle play.`]);
  }

  // ── PHASE 4: Tune Up ───────────────────────────────────────────────────────
  /**
   * tuneUp — resolve all token decrements, terrain bonuses, etc.
   * Must be called once per turn before action phase.
   */
  function tuneUp(stateIn) {
    if (stateIn.phase !== 'tune_up') return fail(stateIn, 'Not in tune_up phase');
    const s   = clone(stateIn);
    const pid = s.active_player;
    const p   = s.players[pid];
    const logs = [];

    // ── Terrain bonuses ──────────────────────────────────────────────────────
    for (let idx = 0; idx < p.vehicles.length; idx++) {
      const vs  = p.vehicles[idx];
      if (vs.realm_position < 1 || vs.realm_position > 4) continue;
      const realmCard = card(s.realms[vs.realm_position - 1]);
      const vCard     = card(vs.card_id);
      const realmT    = realmCard?.terrain || [];
      const vT        = (vCard?.terrain || []).concat(
        vs.equipped_mods.flatMap(m => card(m)?.terrain || []),
        vs.equipped_ac ? card(vs.equipped_ac)?.terrain || [] : []
      );
      const hasBonus = realmT.some(t => vT.includes(t));
      if (hasBonus && !vs.terrain_bonus) {
        vs.terrain_bonus = true;
        logs.push(`${vCard.name} gets +1 terrain bonus in ${realmCard.name}`);
      } else if (!hasBonus) {
        vs.terrain_bonus = false;
      }
    }

    // ── Process pending effects ──────────────────────────────────────────────
    const toRemove = [];
    for (let i = 0; i < s.pending_effects.length; i++) {
      const eff = s.pending_effects[i];
      // Only process effects targeting the ACTIVE player's vehicles during THEIR tune-up
      if (eff.target_player !== pid) continue;

      eff.tokens_remaining = (eff.tokens_remaining || 1) - 1;

      if (eff.tokens_remaining <= 0) {
        // Effect fires
        const r = _resolveEffect(s, eff);
        if (r.ok) { Object.assign(s, r.state); logs.push(...(r.log || [])); }
        toRemove.push(i);
      } else {
        logs.push(`${card(eff.source_card)?.name}: ${eff.tokens_remaining} turn(s) remaining.`);
      }
    }
    // Remove resolved effects (reverse order to preserve indices)
    toRemove.reverse().forEach(i => s.pending_effects.splice(i, 1));

    // ── Folding Corners tokens: add token if no APs were spent (handled client side via flag) ──
    // Client must call addFoldingCornersToken() if no APs were spent this turn

    s.phase = 'action';
    logs.push(`${p.name} tune-up complete.`);
    return ok(s, logs);
  }

  // ── PHASE 5: Action Phase ──────────────────────────────────────────────────
  // Players spend APs on:  equipShift, equipMod, equipAC, playHazard, drawExtra

  /**
   * equipShift — pay AP cost to equip a Shift card onto a vehicle.
   */
  function equipShift(stateIn, pid, cardId, vehicleIdx) {
    if (stateIn.phase !== 'action') return fail(stateIn, 'Not in action phase');
    if (stateIn.active_player !== pid) return fail(stateIn, 'Not your turn');
    const s = clone(stateIn);
    const p = s.players[pid];
    const vs = p.vehicles[vehicleIdx];
    if (!vs) return fail(s, 'Invalid vehicle index');
    if (!p.hand.includes(cardId)) return fail(s, 'Card not in hand');
    if (!isShift(cardId)) return fail(s, 'Not a Shift card');

    const c = card(cardId);
    const ap = c.ap_cost;

    // Fog Realm restriction
    if (s.restrictions.no_shifts_realm_idx === vs.realm_position)
      return fail(s, `No new Shift cards can be equipped in the Fog Realm`);

    if (p.no_shifts_next_turn) return fail(s, 'Proto-Sharks: cannot play Shift cards this turn');
    if (p.aps_remaining < ap) return fail(s, `Not enough APs (need ${ap}, have ${p.aps_remaining})`);

    // Discard old shift (replace)
    if (vs.equipped_shift) {
      p.junk_pile.push(vs.equipped_shift);
    }

    p.hand.splice(p.hand.indexOf(cardId), 1);
    vs.equipped_shift = cardId;
    p.aps_remaining  -= ap;

    const logs = [`${p.name} equips ${c.name} on ${card(vs.card_id).name} (${p.aps_remaining} APs left).`];

    // ── On-play ability triggers ─────────────────────────────────────────────
    const r = _triggerShiftOnPlay(s, pid, vehicleIdx, cardId);
    if (r.ok) { Object.assign(s, r.state); logs.push(...(r.log || [])); }

    return ok(s, logs);
  }

  /**
   * equipMod — pay AP cost to equip a Mod onto a vehicle.
   * @param {boolean} bypassModability  for Guts / Size Scaler / Junk Realm / Under the Hood
   */
  function equipMod(stateIn, pid, cardId, vehicleIdx, bypassModability = false) {
    if (stateIn.phase !== 'action') return fail(stateIn, 'Not in action phase');
    if (stateIn.active_player !== pid) return fail(stateIn, 'Not your turn');
    const s = clone(stateIn);
    const p = s.players[pid];
    const vs = p.vehicles[vehicleIdx];
    if (!vs) return fail(s, 'Invalid vehicle index');
    if (!p.hand.includes(cardId)) return fail(s, 'Card not in hand');
    if (!isMod(cardId)) return fail(s, 'Not a Mod card');
    if (p.no_mods_next_turn) return fail(s, 'Wrecking Balls: cannot play Mods this turn');

    const c  = card(cardId);
    const ap = c.ap_cost;

    // Junk Realm: bypass modability
    const inJunkRealm = card(s.realms[vs.realm_position - 1])?.name === 'JUNK REALM';
    const sizeScaler  = vs.equipped_ac === 130;
    const bypass      = bypassModability || inJunkRealm || sizeScaler;

    if (!canEquipMod(cardId, vs, bypass)) return fail(s, `Modability mismatch — cannot equip ${c.name}`);
    if (p.aps_remaining < ap) return fail(s, `Not enough APs (need ${ap}, have ${p.aps_remaining})`);

    p.hand.splice(p.hand.indexOf(cardId), 1);
    vs.equipped_mods.push(cardId);
    p.aps_remaining -= ap;

    const logs = [`${p.name} equips Mod ${c.name} on ${card(vs.card_id).name} (${p.aps_remaining} APs left).`];

    // ── On-play ability triggers ─────────────────────────────────────────────
    const r = _triggerModOnPlay(s, pid, vehicleIdx, cardId);
    if (r.ok) { Object.assign(s, r.state); logs.push(...(r.log || [])); }

    return ok(s, logs);
  }

  /**
   * equipAC — pay AP cost to equip an Accelecharger onto a vehicle.
   * Only one AC per vehicle allowed.
   */
  function equipAC(stateIn, pid, cardId, vehicleIdx) {
    if (stateIn.phase !== 'action') return fail(stateIn, 'Not in action phase');
    if (stateIn.active_player !== pid) return fail(stateIn, 'Not your turn');
    const s = clone(stateIn);
    const p = s.players[pid];
    const vs = p.vehicles[vehicleIdx];
    if (!vs) return fail(s, 'Invalid vehicle index');
    if (!p.hand.includes(cardId)) return fail(s, 'Card not in hand');
    if (!isAC(cardId)) return fail(s, 'Not an Accelecharger card');
    if (vs.equipped_ac !== null) return fail(s, 'Vehicle already has an Accelecharger equipped');

    const c  = card(cardId);
    const ap = c.ap_cost;
    if (p.aps_remaining < ap) return fail(s, `Not enough APs (need ${ap}, have ${p.aps_remaining})`);

    // 2-D (id 127) is 0 AP and is played reactively — handled by playReactiveAC
    p.hand.splice(p.hand.indexOf(cardId), 1);
    vs.equipped_ac = cardId;
    p.aps_remaining -= ap;

    const logs = [`${p.name} equips Accelecharger ${c.name} on ${card(vs.card_id).name} (${p.aps_remaining} APs left).`];

    // ── On-play triggers ─────────────────────────────────────────────────────
    const r = _triggerACOnPlay(s, pid, vehicleIdx, cardId);
    if (r.ok) { Object.assign(s, r.state); logs.push(...(r.log || [])); }

    return ok(s, logs);
  }

  /**
   * playHazard — play a Hazard card against an opponent's Shift or Mod.
   * @param {number} targetVehicleIdx  index in opponent's vehicles[]
   * @param {number} targetCardId      the specific Mod or Shift to target (null for special hazards)
   */
  function playHazard(stateIn, pid, cardId, targetVehicleIdx, targetCardId = null) {
    if (stateIn.phase !== 'action') return fail(stateIn, 'Not in action phase');
    if (stateIn.active_player !== pid) return fail(stateIn, 'Not your turn');
    const s   = clone(stateIn);
    const p   = s.players[pid];
    const opp = pid === 1 ? 2 : 1;
    if (!p.hand.includes(cardId)) return fail(s, 'Card not in hand');
    if (!isHazard(cardId))        return fail(s, 'Not a Hazard card');

    const c  = card(cardId);
    const ap = c.ap_cost;
    if (p.aps_remaining < ap) return fail(s, `Not enough APs (need ${ap}, have ${p.aps_remaining})`);

    const oppVehicle = s.players[opp].vehicles[targetVehicleIdx];
    if (!oppVehicle && !_isSpecialHazard(cardId)) return fail(s, 'Invalid target vehicle');

    // Check Sprout Road AC protection
    if (oppVehicle?.equipped_ac === 106) {
      p.hand.splice(p.hand.indexOf(cardId), 1);
      p.junk_pile.push(cardId);
      p.aps_remaining -= ap;
      return ok(s, [`${c.name} cancelled by Sprout Road on ${card(oppVehicle.card_id).name}!`]);
    }
    // All or Nothing shift protection
    if (oppVehicle?.equipped_shift === 217 && oppVehicle?.tokens?.all_or_nothing > 0) {
      p.hand.splice(p.hand.indexOf(cardId), 1);
      p.junk_pile.push(cardId);
      p.aps_remaining -= ap;
      return ok(s, [`${c.name} blocked by All or Nothing on ${card(oppVehicle.card_id).name}!`]);
    }
    // Battering Bubble AC protection (AC 118)
    if (oppVehicle?.equipped_ac === 118) {
      p.hand.splice(p.hand.indexOf(cardId), 1);
      p.junk_pile.push(cardId);
      p.aps_remaining -= ap;
      return ok(s, [`${c.name} cancelled by Battering Bubble on ${card(oppVehicle.card_id).name}!`]);
    }

    p.hand.splice(p.hand.indexOf(cardId), 1);
    p.aps_remaining -= ap;

    const logs = [`${p.name} plays Hazard ${c.name} against ${s.players[opp].name}!`];
    const r = _resolveHazard(s, pid, opp, cardId, targetVehicleIdx, targetCardId);
    if (r.ok) { Object.assign(s, r.state); logs.push(...(r.log || [])); }

    p.junk_pile.push(cardId);
    return ok(s, logs);
  }

  /** drawExtra — spend 1 AP to draw 1 extra card (up to total APs available) */
  function drawExtra(stateIn, pid) {
    if (stateIn.phase !== 'action') return fail(stateIn, 'Not in action phase');
    if (stateIn.active_player !== pid) return fail(stateIn, 'Not your turn');
    const s = clone(stateIn);
    const p = s.players[pid];
    if (p.aps_remaining < 1) return fail(s, 'No APs remaining');
    p.aps_remaining -= 1;
    return drawCard(s, pid);
  }

  // ── PHASE 6: End Turn ──────────────────────────────────────────────────────
  function endTurn(stateIn, pid) {
    if (stateIn.phase !== 'action') return fail(stateIn, 'Not in action phase');
    if (stateIn.active_player !== pid) return fail(stateIn, 'Not your turn');
    const s = clone(stateIn);
    const p = s.players[pid];
    const logs = [];

    // Discard down to hand limit
    while (p.hand.length > p.hand_limit) {
      const discarded = p.hand.pop();
      p.junk_pile.push(discarded);
      logs.push(`${p.name} discards ${card(discarded)?.name} (over hand limit).`);
    }

    // Clear one-turn flags
    p.no_mods_next_turn   = false;
    p.no_shifts_next_turn = false;

    // Swap active player
    s.active_player = pid === 1 ? 2 : 1;
    s.turn += 1;
    s.phase = 'draw';

    logs.push(`${p.name} ends turn.`);
    return ok(s, logs);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // HAZARD RESOLUTION
  // ════════════════════════════════════════════════════════════════════════════

  function _isSpecialHazard(cardId) {
    // Hazards that target all vehicles or swap positions (no single target vehicle)
    return [179,185,188,193,196,198].includes(cardId);
  }

  function _resolveHazard(state, pid, oppPid, hazardId, targetVehicleIdx, targetCardId) {
    const s    = clone(state);
    const opp  = s.players[oppPid];
    const logs = [];
    const vs   = opp.vehicles[targetVehicleIdx];
    const hc   = card(hazardId);

    // Validate target card if needed
    const targetIsShift = targetCardId && vs && isShift(targetCardId);
    const targetIsMod   = targetCardId && vs && isMod(targetCardId);

    // ── SPP damage hazards ───────────────────────────────────────────────────
    const dmg = hc.spp_damage || {};
    if (targetCardId && vs) {
      // SPP damage: if any window that has a non-zero bonus is reduced to 0 or below, junk the card
      const _applyDmg = (bonus) => {
        return ['speed','power','performance'].some(stat => {
          const bonusVal = bonus[stat] || 0;
          const dmgVal   = dmg[stat]   || 0;
          return bonusVal !== 0 && (bonusVal + dmgVal) <= 0;
        });
      };
      if (targetIsShift && vs.equipped_shift === targetCardId) {
        const tc = card(targetCardId);
        if (_applyDmg(tc.spp_bonus || {})) {
          opp.junk_pile.push(targetCardId);
          vs.equipped_shift = null;
          logs.push(`${hc.name} destroys ${tc.name}!`);
        } else {
          logs.push(`${hc.name} damages ${tc.name} but it survives.`);
        }
      } else if (targetIsMod) {
        const modIdx = vs.equipped_mods.indexOf(targetCardId);
        if (modIdx >= 0) {
          const tc = card(targetCardId);
          if (_applyDmg(tc.spp_bonus || {})) {
            opp.junk_pile.push(targetCardId);
            vs.equipped_mods.splice(modIdx, 1);
            logs.push(`${hc.name} destroys ${tc.name}!`);
          } else {
            logs.push(`${hc.name} damages ${tc.name} but it survives.`);
          }
        }
      }
    }

    // ── Special effect hazards (by ID) ───────────────────────────────────────
    switch (hazardId) {
      case 171: // Moss Gorillas — remove ALL mods
        if (vs) {
          opp.junk_pile.push(...vs.equipped_mods);
          const removed = vs.equipped_mods.map(m => card(m)?.name).join(', ');
          vs.equipped_mods = [];
          logs.push(`Moss Gorillas strips all Mods from ${card(vs.card_id).name}: ${removed}`);
        }
        break;
      case 174: // Mutant Vulture — remove one AC from target vehicle
        if (vs?.equipped_ac) {
          opp.junk_pile.push(vs.equipped_ac);
          logs.push(`Mutant Vulture removes ${card(vs.equipped_ac).name}!`);
          vs.equipped_ac = null;
        }
        break;
      case 175: // Rockslide — cancel terrain bonus
        if (vs) { vs.terrain_bonus = false; logs.push(`Rockslide cancels terrain bonus on ${card(vs.card_id).name}.`); }
        break;
      case 177: // Molten River — OVERHEAT: 4-token mod timer
        if (vs && targetCardId) {
          s.pending_effects.push({ type:'overheat', source_card:177, target_player:oppPid,
            target_vehicle_idx:targetVehicleIdx, target_card:targetCardId, tokens_remaining:4 });
          logs.push(`Molten River: ${card(targetCardId)?.name} will be destroyed in 4 turns.`);
        }
        break;
      case 179: // Ice Shrapnel — remove ALL RACE MODS from ALL opponent vehicles
        for (const v of opp.vehicles) {
          const raceMods = v.equipped_mods.filter(m => (card(m)?.modability||[]).includes('Race'));
          raceMods.forEach(m => { v.equipped_mods.splice(v.equipped_mods.indexOf(m),1); opp.junk_pile.push(m); });
          if (raceMods.length) logs.push(`Ice Shrapnel strips race mods from ${card(v.card_id).name}.`);
        }
        break;
      case 181: // Wrecking Balls — opponent can't play Mods next turn
        opp.no_mods_next_turn = true;
        logs.push(`Wrecking Balls: ${opp.name} cannot play Mods on their next turn.`);
        break;
      case 184: // Proto-Sharks — opponent can't play Shifts next turn
        opp.no_shifts_next_turn = true;
        logs.push(`Proto-Sharks: ${opp.name} cannot play Shift cards on their next turn.`);
        break;
      case 185: // Tsunami — remove ALL STREET MODS
        for (const v of opp.vehicles) {
          const streetMods = v.equipped_mods.filter(m => (card(m)?.modability||[]).includes('Street'));
          streetMods.forEach(m => { v.equipped_mods.splice(v.equipped_mods.indexOf(m),1); opp.junk_pile.push(m); });
          if (streetMods.length) logs.push(`Tsunami strips street mods from ${card(v.card_id).name}.`);
        }
        break;
      case 188: // Chrome Globes — opponent limited to 3 APs next turn
        opp.limited_aps_next_turn = 3;
        logs.push(`Chrome Globes: ${opp.name} is limited to 3 APs on their next turn.`);
        break;
      case 192: // Electric Fry — remove 1 AC from target vehicle
        if (vs?.equipped_ac) { opp.junk_pile.push(vs.equipped_ac); logs.push(`Electric Fry removes ${card(vs.equipped_ac).name}.`); vs.equipped_ac=null; }
        break;
      case 193: // Magnetic Bounce — send vehicle back 1 realm
        if (vs) { _sendVehicleBack(s, oppPid, targetVehicleIdx, logs); }
        break;
      case 196: // Sweeper Strike — remove entire vehicle stack to junk
        if (vs) {
          opp.junk_pile.push(vs.card_id, ...vs.equipped_mods);
          if (vs.equipped_shift) opp.junk_pile.push(vs.equipped_shift);
          if (vs.equipped_ac)    opp.junk_pile.push(vs.equipped_ac);
          logs.push(`Sweeper Strike destroys ${card(vs.card_id).name} entirely!`);
          opp.vehicles.splice(targetVehicleIdx, 1);
        }
        break;
      case 197: // Acceleron Virus — remove AC with AP cost ≤ 3
        if (vs?.equipped_ac && (card(vs.equipped_ac)?.ap_cost||0) <= 3) {
          opp.junk_pile.push(vs.equipped_ac); logs.push(`Acceleron Virus removes ${card(vs.equipped_ac).name}.`); vs.equipped_ac=null;
        }
        break;
      case 198: // Tornado Vortex — swap 2 opponent vehicles' realm positions
        // Requires targetVehicleIdx + data.secondVehicleIdx from caller
        // Handled as separate action: swapVehiclePositions()
        logs.push(`Tornado Vortex: swap positions of two vehicles (resolve via swapVehiclePositions).`);
        break;
      case 201: // Acid Bath — destroy vehicle in 4 turns
        if (vs) {
          s.pending_effects.push({ type:'acid_bath', source_card:201, target_player:oppPid,
            target_vehicle_idx:targetVehicleIdx, tokens_remaining:4 });
          logs.push(`Acid Bath: ${card(vs.card_id).name} will be destroyed in 4 turns.`);
        }
        break;
      case 204: // Forest Inferno — look at hand, opponent discards 1
        logs.push(`Forest Inferno: ${opp.name} must discard 1 card (resolve via forceDiscard).`);
        s.pending_effects.push({ type:'force_discard', source_card:204, target_player:oppPid, tokens_remaining:0 });
        break;
      case 206: // Blown Hydrant — remove 1 Mod of your choice
        // Resolved by caller via removeMod()
        logs.push(`Blown Hydrant: remove 1 Mod from ${vs ? card(vs.card_id).name : 'target'} (resolve via removeMod).`);
        break;
      case 209: // Escher's World — remove 1 Shift from target vehicle
        if (vs?.equipped_shift) { opp.junk_pile.push(vs.equipped_shift); logs.push(`Escher's World removes ${card(vs.equipped_shift).name}.`); vs.equipped_shift=null; }
        break;
      default:
        // Pure SPP damage — already handled above
        break;
    }

    return ok(s, logs);
  }

  function _sendVehicleBack(state, pid, vehicleIdx, logs=[]) {
    const p  = state.players[pid];
    const vs = p.vehicles[vehicleIdx];
    const vc = card(vs.card_id);
    if (vs.realm_position === 1) {
      // Return to hand, discard ALL equipped
      p.junk_pile.push(...vs.equipped_mods);
      if (vs.equipped_shift) p.junk_pile.push(vs.equipped_shift);
      if (vs.equipped_ac)    p.junk_pile.push(vs.equipped_ac);
      p.hand.push(vs.card_id);
      p.vehicles.splice(vehicleIdx, 1);
      logs.push(`${vc.name} is sent back to ${p.name}'s hand (was in Realm 1).`);
    } else {
      vs.realm_position -= 1;
      // Discard shifts and ACs, keep mods
      if (vs.equipped_shift) { p.junk_pile.push(vs.equipped_shift); vs.equipped_shift=null; }
      if (vs.equipped_ac)    { p.junk_pile.push(vs.equipped_ac);    vs.equipped_ac=null; }
      logs.push(`${vc.name} is sent back 1 Realm (now in Realm ${vs.realm_position}).`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT RESOLUTION
  // ════════════════════════════════════════════════════════════════════════════

  function _resolveEffect(state, eff) {
    const s    = clone(state);
    const logs = [];
    const p    = s.players[eff.target_player];

    switch (eff.type) {
      case 'overheat': { // Molten River
        const vs = p.vehicles[eff.target_vehicle_idx];
        if (vs) {
          const modIdx = vs.equipped_mods.indexOf(eff.target_card);
          if (modIdx >= 0) {
            p.junk_pile.push(eff.target_card);
            vs.equipped_mods.splice(modIdx, 1);
            logs.push(`Molten River: ${card(eff.target_card)?.name} is destroyed!`);
          }
        }
        break;
      }
      case 'acid_bath': { // Acid Bath
        const vs = p.vehicles[eff.target_vehicle_idx];
        if (vs) {
          p.junk_pile.push(vs.card_id, ...vs.equipped_mods);
          if (vs.equipped_shift) p.junk_pile.push(vs.equipped_shift);
          if (vs.equipped_ac)    p.junk_pile.push(vs.equipped_ac);
          logs.push(`Acid Bath: ${card(vs.card_id)?.name} is destroyed!`);
          p.vehicles.splice(eff.target_vehicle_idx, 1);
        }
        break;
      }
      case 'force_discard': // Forest Inferno — trigger in UI
        logs.push(`Forest Inferno: ${p.name} must discard 1 card.`);
        break;
    }
    return ok(s, logs);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ON-PLAY ABILITY TRIGGERS
  // ════════════════════════════════════════════════════════════════════════════

  function _triggerOnPlay(state, pid, vehicleIdx) {
    const s  = clone(state);
    const p  = s.players[pid];
    const vs = p.vehicles[vehicleIdx];
    const logs = [];

    switch (vs.card_id) {
      case 1:  // Hollowback™ — return 1 Mod from junk to hand
        logs.push(`Hollowback: salvage 1 Mod from junk pile (resolve via salvageMod).`);
        break;
      case 11: // Torqued Hollowback™ — pay 1 AP per Mod salvaged
        logs.push(`Torqued Hollowback: may spend 1 AP per Mod salvaged from junk (resolve via salvageMod).`);
        break;
      case 23: // High Voltage — note for realm 2 shift retention
        logs.push(`High Voltage: will retain Shift cards when advancing to Realm 2.`);
        break;
      case 26: // Spectyte — return 1 Mod with any number in Speed window from junk
        logs.push(`SpecTyte: salvage 1 Mod with a Speed bonus from junk (resolve via salvageMod).`);
        break;
      case 36: // Hyper Spectyte
        logs.push(`Hyper SpecTyte: salvage 1 Mod from junk (resolve via salvageMod).`);
        break;
      case 45: // Accelium — return 1 Mod with any number in Performance window from junk
        logs.push(`Accelium: salvage 1 Mod with a Performance bonus from junk (resolve via salvageMod).`);
        break;
      case 55: // Vectra Accelium
        logs.push(`Vectra Accelium: salvage any 1 Mod from junk (resolve via salvageMod).`);
        break;
      case 50: // Technetium
        p.hand_limit = 8;
        logs.push(`Technetium: hand limit raised to 8.`);
        break;
      case 60: // Vectra Technetium
        p.hand_limit = 9;
        logs.push(`Vectra Technetium: hand limit raised to 9.`);
        break;
      case 63: // RD03 — salvage 1 Hazard from junk
        logs.push(`RD03: salvage 1 Hazard from junk (resolve via salvageCard).`);
        break;
      case 64: // RD04 — salvage 1 Mod with Power bonus from junk
        logs.push(`RD04: salvage 1 Mod with a Power bonus from junk (resolve via salvageMod).`);
        break;
      case 73: // RD03.v2 — salvage 2 Hazards from junk
        logs.push(`RD03.v2: salvage 2 Hazard cards from junk (resolve via salvageCard x2).`);
        break;
      case 74: // RD04.v2 — salvage any 1 Mod from junk
        logs.push(`RD04.v2: salvage any 1 Mod from junk (resolve via salvageMod).`);
        break;
    }
    return ok(s, logs);
  }

  function _triggerShiftOnPlay(state, pid, vehicleIdx, cardId) {
    const s  = clone(state);
    const p  = s.players[pid];
    const vs = p.vehicles[vehicleIdx];
    const opp = pid === 1 ? 2 : 1;
    const logs = [];

    switch (cardId) {
      case 213: // Hot Wire — transfer 1 Mod between your vehicles
        logs.push(`Hot Wire: transfer 1 Mod between your vehicles (resolve via transferMod).`);
        break;
      case 217: // All or Nothing — mark with 4 tokens
        vs.tokens['all_or_nothing'] = 4;
        logs.push(`All or Nothing: 4 protection tokens placed. Vehicle must advance in 4 turns or be junked.`);
        break;
      case 218: // Rev Matching — equip 1 AC for free
        logs.push(`Rev Matching: equip 1 Accelecharger for free on any vehicle (resolve via equipACFree).`);
        break;
      case 220: // Buckle Up — return 1 Vehicle from junk to Realm 1
        logs.push(`Buckle Up: return 1 Vehicle from junk pile to Realm 1 (resolve via salvageVehicle).`);
        break;
      case 221: // Wrong Way — +3/3/3 SPP (handled by calcSPP)
        logs.push(`Wrong Way equipped — +3 Speed, +3 Power, +3 Performance.`);
        break;
      case 222: // Guts — equip 1 Mod for free, bypass modability
        logs.push(`Guts: equip 1 Mod for free on this vehicle, modability bypassed (resolve via equipModFree).`);
        break;
      case 225: // Draft & Pass — swap 2 same-team vehicle positions
        logs.push(`Draft & Pass: swap 2 same-team vehicles (resolve via swapVehiclePositions).`);
        break;
      case 227: // Bootlegger Reverse — gamble with opponent vehicle in same realm
        logs.push(`Bootlegger Reverse: race to next realm vs an opposing vehicle in this realm (resolve via bootleggerRace).`);
        break;
      case 229: // Home Track Advantage — swap 2 realm cards
        logs.push(`Home Track Advantage: swap 2 Realm cards on the table (resolve via swapRealms).`);
        break;
      case 231: // Hack Mimic — change team allegiance
        logs.push(`Hack Mimic: choose team allegiance for this vehicle (resolve via setHackMimic).`);
        break;
      case 232: // Shortcut — return 1 Shift from junk to hand
        logs.push(`Shortcut: return 1 Shift from junk pile to hand (resolve via salvageShift).`);
        break;
      case 239: // Under the Hood — place 1 Mod for free, bypass modability
        logs.push(`Under the Hood: equip 1 Mod for free on any vehicle, modability bypassed (resolve via equipModFree).`);
        break;
    }
    return ok(s, logs);
  }

  function _triggerModOnPlay(state, pid, vehicleIdx, cardId) {
    const s    = clone(state);
    const p    = s.players[pid];
    const logs = [];

    switch (cardId) {
      case 152: // Armored Plow — handled in hazard resolution check
        logs.push(`Armored Plow: Hazards of 2 AP or less are cancelled for this vehicle.`);
        break;
      case 153: // Suspension Enhancers — send opposing vehicle back (UI must select target)
        logs.push(`Suspension Enhancers: send 1 opposing vehicle back 1 Realm (resolve via applyMagneticBounce).`);
        break;
      case 154: // Strato-Thruster — auto-advance at start of next turn
        s.pending_effects.push({ type:'strato_thruster', source_card:154, target_player:pid,
          target_vehicle_idx:vehicleIdx, tokens_remaining:1 });
        logs.push(`Strato-Thruster: ${card(s.players[pid].vehicles[vehicleIdx].card_id).name} will auto-advance next turn!`);
        break;
      case 157: // Jump Jets — draw 1 extra card
        { const r = drawCard(s, pid); if (r.ok) { Object.assign(s, r.state); logs.push(`Jump Jets: drew 1 extra card.`); } }
        break;
      case 162: // Shell Skin — 2 hazard protection tokens
        s.players[pid].vehicles[vehicleIdx].tokens['shell_skin'] = 2;
        logs.push(`Shell Skin: 2 protection tokens placed.`);
        break;
      case 163: // Spy Eye — look at opponent's hand
        logs.push(`Spy Eye: look at opponent's hand (resolve via revealOpponentHand).`);
        break;
      case 164: // Air Refresher — return any 1 card from junk to hand
        logs.push(`Air Refresher: return 1 card from junk pile to hand (resolve via salvageAny).`);
        break;
      case 166: // Hardened Underbelly — retain 1 shift on advance (handled in _advanceVehicle)
        logs.push(`Hardened Underbelly: this vehicle will retain its Shift on next advance.`);
        break;
    }
    return ok(s, logs);
  }

  function _triggerACOnPlay(state, pid, vehicleIdx, cardId) {
    const s    = clone(state);
    const p    = s.players[pid];
    const logs = [];

    switch (cardId) {
      case 110: // Fog Vision — relocate Escape Value (UI handles)
        logs.push(`Fog Vision: you may relocate the SPP Escape Value for this Realm (resolve via setFogVision).`);
        break;
      case 113: // Undistort — look at opponent's hand
        logs.push(`Undistort: look at opponent's hand (resolve via revealOpponentHand).`);
        break;
      case 114: // Night Sight — draw 2 extra cards for free
        { const r1 = drawCard(s, pid); if (r1.ok) Object.assign(s, r1.state);
          const r2 = drawCard(s, pid); if (r2.ok) Object.assign(s, r2.state);
          logs.push(`Night Sight: drew 2 extra cards.`); }
        break;
      case 117: // Navigator — equip 1 Shift for free on any vehicle
        logs.push(`Navigator: equip 1 Shift card for free on any vehicle (resolve via equipShiftFree).`);
        break;
      case 121: // Phantom Form — return 1 Shift from junk to hand
        logs.push(`Phantom Form: return 1 Shift from junk pile to hand (resolve via salvageShift).`);
        break;
      case 126: // Folding Corners — token mechanic (tracked in tuneUp)
        vs.tokens = vs.tokens || {};
        vs.tokens['folding_corners'] = 0;
        logs.push(`Folding Corners: tokens will accumulate each turn no APs are spent.`);
        break;
      case 129: // Teleport — 3-turn Hazard immunity
        s.players[pid].vehicles[vehicleIdx].tokens['teleport'] = 3;
        logs.push(`Teleport: 3 hazard-immunity tokens placed.`);
        break;
    }

    const vs = s.players[pid].vehicles[vehicleIdx];  // re-fetch after possible mutations
    return ok(s, logs);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // REACTIVE / FREE ACTIONS (called by UI in response to prompts)
  // ════════════════════════════════════════════════════════════════════════════

  /** salvageMod — move a Mod from junk pile to hand */
  function salvageMod(stateIn, pid, modCardId, filter = null) {
    const s = clone(stateIn);
    const p = s.players[pid];
    const idx = p.junk_pile.lastIndexOf(modCardId);
    if (idx < 0) return fail(s, 'Card not in junk pile');
    if (!isMod(modCardId)) return fail(s, 'Not a Mod card');
    if (filter) {
      const c = card(modCardId);
      const bonus = c.spp_bonus || {};
      if (filter === 'speed' && !(bonus.speed > 0)) return fail(s, 'Mod has no Speed bonus');
      if (filter === 'power' && !(bonus.power > 0)) return fail(s, 'Mod has no Power bonus');
      if (filter === 'performance' && !(bonus.performance > 0)) return fail(s, 'Mod has no Performance bonus');
    }
    p.junk_pile.splice(idx, 1);
    p.hand.push(modCardId);
    return ok(s, [`${p.name} salvages ${card(modCardId).name} from junk pile.`]);
  }

  /** salvageCard — move any card by type from junk to hand */
  function salvageCard(stateIn, pid, cardId, requiredType = null) {
    const s = clone(stateIn);
    const p = s.players[pid];
    const idx = p.junk_pile.lastIndexOf(cardId);
    if (idx < 0) return fail(s, 'Card not in junk pile');
    if (requiredType && card(cardId)?.type !== requiredType) return fail(s, `Must salvage a ${requiredType}`);
    p.junk_pile.splice(idx, 1);
    p.hand.push(cardId);
    return ok(s, [`${p.name} salvages ${card(cardId)?.name} from junk pile.`]);
  }

  /** salvageVehicle — return Vehicle from junk to Realm 1 (Buckle Up) */
  function salvageVehicle(stateIn, pid, cardId) {
    const s = clone(stateIn);
    const p = s.players[pid];
    const idx = p.junk_pile.lastIndexOf(cardId);
    if (idx < 0) return fail(s, 'Card not in junk pile');
    if (!isVehicle(cardId)) return fail(s, 'Not a Vehicle');
    p.junk_pile.splice(idx, 1);
    p.vehicles.push({ card_id:cardId, realm_position:1, equipped_mods:[], equipped_shift:null, equipped_ac:null, tokens:{}, terrain_bonus:false, hack_mimic_team:null });
    return ok(s, [`${p.name} returns ${card(cardId).name} from junk to Realm 1 (Buckle Up).`]);
  }

  /** transferMod — move a Mod between two of your in-play vehicles (Hot Wire) */
  function transferMod(stateIn, pid, modCardId, fromVehicleIdx, toVehicleIdx, bypassModability = false) {
    const s  = clone(stateIn);
    const p  = s.players[pid];
    const from = p.vehicles[fromVehicleIdx];
    const to   = p.vehicles[toVehicleIdx];
    if (!from || !to) return fail(s, 'Invalid vehicle index');
    const modIdx = from.equipped_mods.indexOf(modCardId);
    if (modIdx < 0) return fail(s, 'Mod not equipped on source vehicle');
    if (!canEquipMod(modCardId, to, bypassModability)) return fail(s, 'Modability mismatch on target vehicle');
    from.equipped_mods.splice(modIdx, 1);
    to.equipped_mods.push(modCardId);
    return ok(s, [`${p.name} transfers ${card(modCardId).name} from ${card(from.card_id).name} to ${card(to.card_id).name}.`]);
  }

  /** swapVehiclePositions — swap realm positions of two vehicles */
  function swapVehiclePositions(stateIn, pid, vehicleIdxA, vehicleIdxB) {
    const s = clone(stateIn);
    const p = s.players[pid];
    const a = p.vehicles[vehicleIdxA];
    const b = p.vehicles[vehicleIdxB];
    if (!a || !b) return fail(s, 'Invalid vehicle index');
    const posA = a.realm_position;
    a.realm_position = b.realm_position;
    b.realm_position = posA;
    // Discard shifts and ACs on both (they travel equipped as-is per Tornado Vortex, but Draft&Pass unequips)
    return ok(s, [`Swapped positions of ${card(a.card_id).name} and ${card(b.card_id).name}.`]);
  }

  /** swapRealms — swap 2 Realm cards on the table (Home Track Advantage) */
  function swapRealms(stateIn, realmIdxA, realmIdxB) {
    const s = clone(stateIn);
    if (realmIdxA < 0 || realmIdxA > 3 || realmIdxB < 0 || realmIdxB > 3) return fail(s, 'Invalid realm index');
    [s.realms[realmIdxA], s.realms[realmIdxB]] = [s.realms[realmIdxB], s.realms[realmIdxA]];
    _applyRealmRestrictions(s);
    return ok(s, [`Realms ${realmIdxA+1} and ${realmIdxB+1} swapped.`]);
  }

  /** forceDiscard — opponent discards 1 card of their choice (Forest Inferno) */
  function forceDiscard(stateIn, pid, cardId) {
    const s = clone(stateIn);
    const p = s.players[pid];
    const idx = p.hand.indexOf(cardId);
    if (idx < 0) return fail(s, 'Card not in hand');
    p.hand.splice(idx, 1);
    p.junk_pile.push(cardId);
    return ok(s, [`${p.name} discards ${card(cardId)?.name} (Forest Inferno).`]);
  }

  /** setHackMimic — set team override for a vehicle (Hack Mimic shift) */
  function setHackMimic(stateIn, pid, vehicleIdx, teamName) {
    const s = clone(stateIn);
    const valid = ['Metal Maniacs','Teku Racers','Silencerz','Racing Drones'];
    if (!valid.includes(teamName)) return fail(s, 'Invalid team name');
    s.players[pid].vehicles[vehicleIdx].hack_mimic_team = teamName;
    return ok(s, [`${card(s.players[pid].vehicles[vehicleIdx].card_id).name} now counts as ${teamName} (Hack Mimic).`]);
  }

  /** playReactiveAC — play 2-D (card 127) reactively to cancel a Hazard */
  function playReactiveAC(stateIn, pid, vehicleIdx) {
    const s  = clone(stateIn);
    const p  = s.players[pid];
    const vs = p.vehicles[vehicleIdx];
    if (!vs) return fail(s, 'Invalid vehicle index');
    const idx = p.hand.indexOf(127);
    if (idx < 0) return fail(s, '2-D not in hand');
    p.hand.splice(idx, 1);
    vs.equipped_ac = 127;
    return ok(s, [`${p.name} plays 2-D to cancel the Hazard!`]);
  }

  /** playDodgingDisaster — play card 238 reactively to cancel one Hazard */
  function playDodgingDisaster(stateIn, pid) {
    const s = clone(stateIn);
    const p = s.players[pid];
    const idx = p.hand.indexOf(238);
    if (idx < 0) return fail(s, 'Dodging Disaster not in hand');
    p.hand.splice(idx, 1);
    p.junk_pile.push(238);
    return ok(s, [`${p.name} plays Dodging Disaster — Hazard cancelled!`]);
  }

  /** junkAsphaltAnchor — use Asphalt Anchor (mod 140) to cancel a Hazard */
  function junkAsphaltAnchor(stateIn, pid, vehicleIdx) {
    const s  = clone(stateIn);
    const p  = s.players[pid];
    const vs = p.vehicles[vehicleIdx];
    if (!vs) return fail(s, 'Invalid vehicle index');
    const modIdx = vs.equipped_mods.indexOf(140);
    if (modIdx < 0) return fail(s, 'Asphalt Anchor not equipped on vehicle');
    vs.equipped_mods.splice(modIdx, 1);
    p.junk_pile.push(140);
    return ok(s, [`${p.name} junks Asphalt Anchor to cancel the Hazard!`]);
  }

  /** addFoldingCornersToken — call if active player spent no APs this turn */
  function addFoldingCornersToken(stateIn, pid, vehicleIdx) {
    const s  = clone(stateIn);
    const vs = s.players[pid].vehicles[vehicleIdx];
    if (!vs || vs.equipped_ac !== 126) return fail(s, 'Folding Corners not equipped');
    vs.tokens['folding_corners'] = (vs.tokens['folding_corners'] || 0) + 1;
    return ok(s, [`Folding Corners: +1 token (total ${vs.tokens['folding_corners']}) on ${card(vs.card_id).name}.`]);
  }

  /** removeAllOrNothingToken — call during tune-up for vehicles with All or Nothing */
  function removeAllOrNothingToken(stateIn, pid, vehicleIdx) {
    const s  = clone(stateIn);
    const vs = s.players[pid].vehicles[vehicleIdx];
    if (!vs || !vs.tokens['all_or_nothing']) return fail(s, 'All or Nothing not active');
    vs.tokens['all_or_nothing'] -= 1;
    const logs = [`All or Nothing: ${vs.tokens['all_or_nothing']} turn(s) left on ${card(vs.card_id).name}.`];
    if (vs.tokens['all_or_nothing'] <= 0 && vs.realm_position >= 1 && vs.realm_position <= 4) {
      // Check if vehicle has not advanced — if still in same realm, junk it
      const p = s.players[pid];
      p.junk_pile.push(vs.card_id, ...vs.equipped_mods);
      if (vs.equipped_shift) p.junk_pile.push(vs.equipped_shift);
      if (vs.equipped_ac)    p.junk_pile.push(vs.equipped_ac);
      logs.push(`All or Nothing expired — ${card(vs.card_id).name} is junked!`);
      p.vehicles.splice(vehicleIdx, 1);
    }
    return ok(s, logs);
  }

  /** removeMod — manually remove a mod from a vehicle (Blown Hydrant, etc.) */
  function removeMod(stateIn, pid, vehicleIdx, modCardId) {
    const s  = clone(stateIn);
    const p  = s.players[pid];
    const vs = p.vehicles[vehicleIdx];
    if (!vs) return fail(s, 'Invalid vehicle index');
    const modIdx = vs.equipped_mods.indexOf(modCardId);
    if (modIdx < 0) return fail(s, 'Mod not on vehicle');
    vs.equipped_mods.splice(modIdx, 1);
    p.junk_pile.push(modCardId);
    return ok(s, [`${card(modCardId)?.name} removed from ${card(vs.card_id)?.name} to junk pile.`]);
  }

  /** pickLine — sacrifice one vehicle to advance another (Pick a Line shift #211) */
  function pickLine(stateIn, pid, sacrificeVehicleIdx, advanceVehicleIdx) {
    const s  = clone(stateIn);
    const p  = s.players[pid];
    const sac = p.vehicles[sacrificeVehicleIdx];
    const adv = p.vehicles[advanceVehicleIdx];
    if (!sac || !adv) return fail(s, 'Invalid vehicle index');
    if (sac.realm_position !== adv.realm_position) return fail(s, 'Both vehicles must be in the same Realm');
    const logs = [`Pick a Line: sacrificing ${card(sac.card_id).name} to advance ${card(adv.card_id).name}!`];
    // Junk sacrifice
    p.junk_pile.push(sac.card_id, ...sac.equipped_mods);
    if (sac.equipped_shift) p.junk_pile.push(sac.equipped_shift);
    if (sac.equipped_ac)    p.junk_pile.push(sac.equipped_ac);
    p.vehicles.splice(sacrificeVehicleIdx, 1);
    // Recalculate advanceVehicleIdx if needed
    const newAdvIdx = advanceVehicleIdx > sacrificeVehicleIdx ? advanceVehicleIdx - 1 : advanceVehicleIdx;
    const r = _advanceVehicle(s, pid, newAdvIdx);
    if (r.ok) { Object.assign(s, r.state); logs.push(...(r.log || [])); }
    return ok(s, logs);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STATE ENCODE / DECODE (URL-safe base64 using lz-string)
  // ════════════════════════════════════════════════════════════════════════════
  // lz-string must be available globally or imported separately.
  // In browser: import LZString from 'https://cdn.jsdelivr.net/npm/lz-string@1.5.0/+esm'

  function encodeState(state) {
    const json = JSON.stringify(state);
    if (typeof LZString !== 'undefined') {
      return LZString.compressToEncodedURIComponent(json);
    }
    // Fallback: btoa (no compression, larger URL)
    return btoa(encodeURIComponent(json));
  }

  function decodeState(encoded) {
    try {
      if (typeof LZString !== 'undefined') {
        return JSON.parse(LZString.decompressFromEncodedURIComponent(encoded));
      }
      return JSON.parse(decodeURIComponent(atob(encoded)));
    } catch {
      return null;
    }
  }

  function getShareURL(state, baseURL = window.location.origin + window.location.pathname) {
    return `${baseURL}#${encodeState(state)}`;
  }

  function loadStateFromURL() {
    const hash = window.location.hash.slice(1);
    if (!hash) return null;
    return decodeState(hash);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════════════════════

  return {
    // Setup
    createGame,
    validateDeck,
    shuffle,
    drawOpeningHand,

    // Turn flow (must be called in order)
    beginTurn,
    phaseDraw,
    advanceEligible,
    playVehicle,
    skipPlayVehicle,
    tuneUp,
    endTurn,

    // Action phase
    equipShift,
    equipMod,
    equipAC,
    playHazard,
    drawExtra,

    // Reactive (0-AP responses to opponent plays)
    playReactiveAC,
    playDodgingDisaster,
    junkAsphaltAnchor,

    // Ability resolution (called by UI in response to log prompts)
    salvageMod,
    salvageCard,
    salvageVehicle,
    transferMod,
    swapVehiclePositions,
    swapRealms,
    forceDiscard,
    setHackMimic,
    pickLine,
    removeMod,
    addFoldingCornersToken,
    removeAllOrNothingToken,

    // Calculated values (read-only)
    calcSPP,
    calcTotalAPs,
    calcTeamBonusAPs,
    canEquipMod,

    // State encode/decode
    encodeState,
    decodeState,
    getShareURL,
    loadStateFromURL,
  };
}
