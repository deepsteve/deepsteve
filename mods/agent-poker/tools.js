const { z } = require('zod');

// ═══════════════════════════════════════════════════════════════════════════════
// Card & Deck
// ═══════════════════════════════════════════════════════════════════════════════

const SUITS = ['h', 'd', 'c', 's'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J, 12=Q, 13=K, 14=A

function rankName(r) {
  if (r <= 10) return String(r);
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r];
}

function suitSymbol(s) {
  return { h: '\u2665', d: '\u2666', c: '\u2663', s: '\u2660' }[s];
}

function cardStr(c) {
  return `${rankName(c.rank)}${suitSymbol(c.suit)}`;
}

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hand Evaluation — best 5 of 7 cards
// ═══════════════════════════════════════════════════════════════════════════════

function evaluate(cards) {
  // Generate all 5-card combos from 7 cards
  const combos = [];
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++)
      for (let k = j + 1; k < cards.length; k++)
        for (let l = k + 1; l < cards.length; l++)
          for (let m = l + 1; m < cards.length; m++)
            combos.push([cards[i], cards[j], cards[k], cards[l], cards[m]]);

  let best = null;
  for (const hand of combos) {
    const score = scoreHand(hand);
    if (!best || compareScores(score, best) > 0) best = score;
  }
  return best;
}

function scoreHand(hand) {
  const ranks = hand.map(c => c.rank).sort((a, b) => b - a);
  const suits = hand.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  // Check straight (including A-low: A,2,3,4,5)
  let isStraight = false;
  let straightHigh = 0;
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) {
      isStraight = true;
      straightHigh = unique[0];
    } else if (unique[0] === 14 && unique[1] === 5) {
      // A-2-3-4-5 (wheel)
      isStraight = true;
      straightHigh = 5;
    }
  }

  // Count ranks
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (isFlush && isStraight) {
    return { tier: straightHigh === 14 ? 10 : 9, kickers: [straightHigh] }; // Royal/Straight flush
  }
  if (groups[0].count === 4) {
    return { tier: 8, kickers: [groups[0].rank, groups[1].rank] }; // Four of a kind
  }
  if (groups[0].count === 3 && groups[1].count === 2) {
    return { tier: 7, kickers: [groups[0].rank, groups[1].rank] }; // Full house
  }
  if (isFlush) {
    return { tier: 6, kickers: ranks }; // Flush
  }
  if (isStraight) {
    return { tier: 5, kickers: [straightHigh] }; // Straight
  }
  if (groups[0].count === 3) {
    const k = ranks.filter(r => r !== groups[0].rank).sort((a, b) => b - a);
    return { tier: 4, kickers: [groups[0].rank, ...k] }; // Three of a kind
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairs = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
    const k = ranks.find(r => r !== pairs[0] && r !== pairs[1]);
    return { tier: 3, kickers: [...pairs, k] }; // Two pair
  }
  if (groups[0].count === 2) {
    const k = ranks.filter(r => r !== groups[0].rank).sort((a, b) => b - a);
    return { tier: 2, kickers: [groups[0].rank, ...k] }; // Pair
  }
  return { tier: 1, kickers: ranks }; // High card
}

function compareScores(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const ak = a.kickers[i] || 0, bk = b.kickers[i] || 0;
    if (ak !== bk) return ak - bk;
  }
  return 0;
}

function handName(score) {
  return [
    '', 'High Card', 'Pair', 'Two Pair', 'Three of a Kind',
    'Straight', 'Flush', 'Full House', 'Four of a Kind',
    'Straight Flush', 'Royal Flush',
  ][score.tier];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Game State
// ═══════════════════════════════════════════════════════════════════════════════

const PLAYER_NAMES = ['Ace', 'Maverick', 'Blaze', 'Shadow'];
const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

let game = null;
let broadcastFn = null;
let logFn = (...args) => {};

function broadcastState() {
  if (broadcastFn) broadcastFn({ type: 'poker-state', state: getPublicState() });
}

function getPublicState() {
  if (!game) return { phase: 'IDLE' };
  return {
    phase: game.phase,
    handNumber: game.handNumber,
    communityCards: game.communityCards.map(cardStr),
    pot: game.pot,
    currentBet: game.currentBet,
    activePlayerIdx: game.activePlayerIdx,
    dealerIdx: game.dealerIdx,
    players: game.players.map((p, i) => ({
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      eliminated: p.eliminated,
      hand: game.phase === 'SHOWDOWN' && !p.folded ? p.hand.map(cardStr) : null,
      handRank: game.phase === 'SHOWDOWN' && !p.folded && game.communityCards.length === 5
        ? handName(evaluate([...p.hand, ...game.communityCards]))
        : null,
      isActive: i === game.activePlayerIdx,
    })),
    reasoning: game.reasoning, // chain-of-thought log
    tableTalk: game.tableTalk,
    winners: game.winners || null,
    log: game.actionLog.slice(-20),
  };
}

function createGame() {
  game = {
    phase: 'WAITING', // WAITING → PRE_FLOP → FLOP → TURN → RIVER → SHOWDOWN → HAND_OVER
    handNumber: 0,
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    activePlayerIdx: -1,
    dealerIdx: -1,
    players: PLAYER_NAMES.map(name => ({
      name,
      chips: STARTING_CHIPS,
      hand: [],
      bet: 0,
      folded: false,
      allIn: false,
      eliminated: false,
      hasActed: false,
    })),
    reasoning: [],   // { player, text, timestamp }
    tableTalk: [],   // { player, text, timestamp }
    actionLog: [],   // { text, timestamp }
    winners: null,
    lastActionTime: Date.now(),
  };
  return game;
}

function addLog(text) {
  if (!game) return;
  game.actionLog.push({ text, timestamp: Date.now() });
  logFn(`[poker] ${text}`);
}

function addReasoning(player, text) {
  if (!game) return;
  game.reasoning.push({ player, text, timestamp: Date.now() });
  // Keep last 30
  if (game.reasoning.length > 30) game.reasoning = game.reasoning.slice(-30);
}

function addTableTalk(player, text) {
  if (!game) return;
  game.tableTalk.push({ player, text, timestamp: Date.now() });
  if (game.tableTalk.length > 50) game.tableTalk = game.tableTalk.slice(-50);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Game Logic
// ═══════════════════════════════════════════════════════════════════════════════

function activePlayers() {
  return game.players.filter(p => !p.folded && !p.eliminated);
}

function activeNonAllIn() {
  return game.players.filter(p => !p.folded && !p.eliminated && !p.allIn);
}

function nextActiveIdx(from) {
  for (let i = 1; i <= game.players.length; i++) {
    const idx = (from + i) % game.players.length;
    const p = game.players[idx];
    if (!p.folded && !p.eliminated && !p.allIn) return idx;
  }
  return -1;
}

function dealNewHand() {
  // Check for eliminated players
  game.players.forEach(p => {
    if (p.chips <= 0 && !p.eliminated) {
      p.eliminated = true;
      addLog(`${p.name} is eliminated!`);
    }
  });

  const alive = game.players.filter(p => !p.eliminated);
  if (alive.length <= 1) {
    game.phase = 'GAME_OVER';
    game.winners = alive.map(p => p.name);
    addLog(`Game over! ${alive[0]?.name || 'Nobody'} wins!`);
    broadcastState();
    return;
  }

  game.handNumber++;
  game.deck = shuffle(makeDeck());
  game.communityCards = [];
  game.pot = 0;
  game.currentBet = 0;
  game.winners = null;

  // Reset player state
  game.players.forEach(p => {
    p.hand = [];
    p.bet = 0;
    p.folded = p.eliminated;
    p.allIn = false;
    p.hasActed = false;
  });

  // Advance dealer
  do {
    game.dealerIdx = (game.dealerIdx + 1) % game.players.length;
  } while (game.players[game.dealerIdx].eliminated);

  // Deal 2 cards to each active player
  for (let round = 0; round < 2; round++) {
    for (const p of game.players) {
      if (!p.eliminated) p.hand.push(game.deck.pop());
    }
  }

  addLog(`--- Hand #${game.handNumber} ---`);
  addLog(`${game.players[game.dealerIdx].name} is the dealer`);

  // Post blinds
  const sbIdx = nextActiveIdx(game.dealerIdx);
  const bbIdx = nextActiveIdx(sbIdx);
  postBlind(sbIdx, SMALL_BLIND, 'small blind');
  postBlind(bbIdx, BIG_BLIND, 'big blind');

  game.currentBet = BIG_BLIND;
  game.phase = 'PRE_FLOP';
  game.activePlayerIdx = nextActiveIdx(bbIdx);
  game.lastActionTime = Date.now();

  // Reset hasActed for betting round
  game.players.forEach(p => { p.hasActed = false; });
  // BB has already acted in a sense, but gets option to raise
  // SB and BB should still act
  game.players[sbIdx].hasActed = false;
  game.players[bbIdx].hasActed = false;

  broadcastState();
}

function postBlind(idx, amount, label) {
  const p = game.players[idx];
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet = actual;
  game.pot += actual;
  if (p.chips === 0) p.allIn = true;
  addLog(`${p.name} posts ${label}: ${actual}`);
}

function getAvailableActions(playerIdx) {
  if (game.activePlayerIdx !== playerIdx) return [];
  const p = game.players[playerIdx];
  if (p.folded || p.eliminated || p.allIn) return [];

  const actions = ['fold'];
  const toCall = game.currentBet - p.bet;

  if (toCall === 0) {
    actions.push('check');
  } else {
    actions.push('call');
  }

  if (p.chips > toCall) {
    actions.push('raise');
  }

  actions.push('all_in');
  return actions;
}

function processAction(playerIdx, action, amount) {
  const p = game.players[playerIdx];
  const toCall = game.currentBet - p.bet;

  switch (action) {
    case 'fold':
      p.folded = true;
      addLog(`${p.name} folds`);
      break;

    case 'check':
      if (toCall > 0) return 'Cannot check, must call or raise';
      addLog(`${p.name} checks`);
      break;

    case 'call': {
      const callAmt = Math.min(toCall, p.chips);
      p.chips -= callAmt;
      p.bet += callAmt;
      game.pot += callAmt;
      if (p.chips === 0) p.allIn = true;
      addLog(`${p.name} calls ${callAmt}`);
      break;
    }

    case 'raise': {
      const minRaise = game.currentBet + BIG_BLIND;
      let raiseTotal = amount || minRaise;
      if (raiseTotal < minRaise) raiseTotal = minRaise;
      const needed = raiseTotal - p.bet;
      if (needed >= p.chips) {
        // All-in
        const allInAmt = p.chips;
        game.pot += allInAmt;
        p.bet += allInAmt;
        p.chips = 0;
        p.allIn = true;
        game.currentBet = Math.max(game.currentBet, p.bet);
        addLog(`${p.name} raises all-in to ${p.bet}`);
      } else {
        p.chips -= needed;
        p.bet = raiseTotal;
        game.pot += needed;
        game.currentBet = raiseTotal;
        addLog(`${p.name} raises to ${raiseTotal}`);
      }
      // Reset hasActed for others since there's a raise
      game.players.forEach((op, i) => {
        if (i !== playerIdx && !op.folded && !op.eliminated && !op.allIn) {
          op.hasActed = false;
        }
      });
      break;
    }

    case 'all_in': {
      const allInAmt = p.chips;
      game.pot += allInAmt;
      p.bet += allInAmt;
      p.chips = 0;
      p.allIn = true;
      if (p.bet > game.currentBet) {
        game.currentBet = p.bet;
        // Reset hasActed for others
        game.players.forEach((op, i) => {
          if (i !== playerIdx && !op.folded && !op.eliminated && !op.allIn) {
            op.hasActed = false;
          }
        });
      }
      addLog(`${p.name} goes all-in for ${allInAmt}`);
      break;
    }

    default:
      return `Unknown action: ${action}`;
  }

  p.hasActed = true;
  game.lastActionTime = Date.now();

  // Check if only one player left
  const active = activePlayers();
  if (active.length === 1) {
    game.winners = [active[0].name];
    active[0].chips += game.pot;
    addLog(`${active[0].name} wins ${game.pot} (everyone else folded)`);
    game.pot = 0;
    game.phase = 'HAND_OVER';
    broadcastState();
    return null;
  }

  // Check if betting round is over
  if (isBettingRoundOver()) {
    advancePhase();
  } else {
    game.activePlayerIdx = nextActiveIdx(playerIdx);
  }

  broadcastState();
  return null;
}

function isBettingRoundOver() {
  const eligible = game.players.filter(p => !p.folded && !p.eliminated && !p.allIn);
  if (eligible.length === 0) return true;
  return eligible.every(p => p.hasActed && p.bet === game.currentBet);
}

function advancePhase() {
  // Reset for next betting round
  game.players.forEach(p => {
    p.bet = 0;
    p.hasActed = false;
  });
  game.currentBet = 0;

  const canBet = activeNonAllIn().length >= 2;

  switch (game.phase) {
    case 'PRE_FLOP':
      game.communityCards.push(game.deck.pop(), game.deck.pop(), game.deck.pop());
      game.phase = 'FLOP';
      addLog(`Flop: ${game.communityCards.map(cardStr).join(' ')}`);
      break;
    case 'FLOP':
      game.communityCards.push(game.deck.pop());
      game.phase = 'TURN';
      addLog(`Turn: ${cardStr(game.communityCards[3])}`);
      break;
    case 'TURN':
      game.communityCards.push(game.deck.pop());
      game.phase = 'RIVER';
      addLog(`River: ${cardStr(game.communityCards[4])}`);
      break;
    case 'RIVER':
      doShowdown();
      return;
  }

  if (!canBet || activeNonAllIn().length < 2) {
    // Skip betting — run remaining cards
    advancePhase();
    return;
  }

  // Set active player to first after dealer
  game.activePlayerIdx = nextActiveIdx(game.dealerIdx);
  broadcastState();
}

function doShowdown() {
  game.phase = 'SHOWDOWN';
  const contenders = activePlayers();

  addLog('=== Showdown ===');
  let bestScore = null;
  let winners = [];

  for (const p of contenders) {
    const allCards = [...p.hand, ...game.communityCards];
    const score = evaluate(allCards);
    const name = handName(score);
    addLog(`${p.name}: ${p.hand.map(cardStr).join(' ')} — ${name}`);

    if (!bestScore || compareScores(score, bestScore) > 0) {
      bestScore = score;
      winners = [p];
    } else if (compareScores(score, bestScore) === 0) {
      winners.push(p);
    }
  }

  const share = Math.floor(game.pot / winners.length);
  const remainder = game.pot - share * winners.length;
  winners.forEach((w, i) => {
    w.chips += share + (i === 0 ? remainder : 0);
  });

  game.winners = winners.map(w => w.name);
  const winText = winners.length === 1
    ? `${winners[0].name} wins ${game.pot} with ${handName(bestScore)}!`
    : `Split pot (${share} each): ${winners.map(w => w.name).join(', ')} — ${handName(bestScore)}`;
  addLog(winText);
  game.pot = 0;
  game.phase = 'HAND_OVER';
  broadcastState();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MCP Tools
// ═══════════════════════════════════════════════════════════════════════════════

function init(context) {
  broadcastFn = context.broadcast;
  logFn = context.log || ((...args) => {});

  return {
    get_poker_state: {
      description: [
        'Get the current poker game state from your perspective.',
        'Returns your hole cards (private), community cards, pot, chip stacks,',
        'whose turn it is, and available actions if it\'s your turn.',
        'Call this in a loop to follow the game. If it\'s not your turn, sleep 3 seconds and poll again.',
      ].join(' '),
      schema: {
        player_name: z.string().describe('Your player name at the table (Ace, Maverick, Blaze, or Shadow)'),
      },
      handler: async ({ player_name }) => {
        if (!game || game.phase === 'IDLE') {
          return { content: [{ type: 'text', text: 'No game in progress. Waiting for game to start.' }] };
        }

        const pIdx = game.players.findIndex(p => p.name === player_name);
        if (pIdx === -1) {
          return { content: [{ type: 'text', text: `Player "${player_name}" not found. Valid names: ${PLAYER_NAMES.join(', ')}` }] };
        }

        const p = game.players[pIdx];
        const actions = getAvailableActions(pIdx);

        const state = {
          phase: game.phase,
          hand_number: game.handNumber,
          your_hand: p.hand.map(cardStr),
          community_cards: game.communityCards.map(cardStr),
          pot: game.pot,
          current_bet: game.currentBet,
          your_chips: p.chips,
          your_current_bet: p.bet,
          your_turn: game.activePlayerIdx === pIdx,
          available_actions: actions,
          to_call: Math.max(0, game.currentBet - p.bet),
          min_raise: game.currentBet + BIG_BLIND,
          players: game.players.map((op, i) => ({
            name: op.name,
            chips: op.chips,
            bet: op.bet,
            folded: op.folded,
            all_in: op.allIn,
            eliminated: op.eliminated,
            is_dealer: i === game.dealerIdx,
            is_active: i === game.activePlayerIdx,
          })),
          recent_actions: game.actionLog.slice(-8).map(l => l.text),
        };

        if (game.phase === 'HAND_OVER' || game.phase === 'SHOWDOWN') {
          state.winners = game.winners;
          state.showdown_hands = game.players
            .filter(op => !op.folded && !op.eliminated)
            .map(op => ({
              name: op.name,
              hand: op.hand.map(cardStr),
              rank: game.communityCards.length === 5 ? handName(evaluate([...op.hand, ...game.communityCards])) : null,
            }));
        }

        if (game.phase === 'GAME_OVER') {
          state.game_over = true;
          state.final_winner = game.winners;
        }

        return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
      },
    },

    poker_action: {
      description: [
        'Take a poker action when it\'s your turn.',
        'Actions: fold, check, call, raise (with amount), all_in.',
        'Include your reasoning (chain-of-thought) — the spectator can see it.',
        'Optionally include table_talk for what you say out loud to other players.',
      ].join(' '),
      schema: {
        player_name: z.string().describe('Your player name (Ace, Maverick, Blaze, or Shadow)'),
        action: z.enum(['fold', 'check', 'call', 'raise', 'all_in']).describe('The action to take'),
        amount: z.number().optional().describe('Raise amount (total bet, not additional). Required for raise.'),
        reasoning: z.string().describe('Your chain-of-thought reasoning for this action (visible to spectator)'),
        table_talk: z.string().optional().describe('What you say out loud to the table (other players can see this)'),
      },
      handler: async ({ player_name, action, amount, reasoning, table_talk }) => {
        if (!game || game.phase === 'IDLE' || game.phase === 'WAITING') {
          return { content: [{ type: 'text', text: 'No active hand. Wait for the next deal.' }] };
        }

        if (game.phase === 'HAND_OVER' || game.phase === 'SHOWDOWN' || game.phase === 'GAME_OVER') {
          return { content: [{ type: 'text', text: `Hand is over. Wait for next hand. Winners: ${(game.winners || []).join(', ')}` }] };
        }

        const pIdx = game.players.findIndex(p => p.name === player_name);
        if (pIdx === -1) {
          return { content: [{ type: 'text', text: `Player "${player_name}" not found.` }] };
        }

        if (game.activePlayerIdx !== pIdx) {
          const activePlayer = game.players[game.activePlayerIdx];
          return { content: [{ type: 'text', text: `Not your turn. Waiting for ${activePlayer?.name || 'unknown'}. Sleep 3 seconds and call get_poker_state again.` }] };
        }

        // Record reasoning and table talk
        if (reasoning) addReasoning(player_name, reasoning);
        if (table_talk) addTableTalk(player_name, table_talk);

        const error = processAction(pIdx, action, amount);
        if (error) {
          return { content: [{ type: 'text', text: `Action failed: ${error}` }] };
        }

        return { content: [{ type: 'text', text: `Action "${action}" accepted. Call get_poker_state to see the updated state.` }] };
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REST API for the browser UI
// ═══════════════════════════════════════════════════════════════════════════════

function registerRoutes(app, context) {
  broadcastFn = context.broadcast;
  logFn = context.log || ((...args) => {});

  // Get full public state
  app.get('/api/poker/state', (req, res) => {
    res.json(getPublicState());
  });

  // Start a new game
  app.post('/api/poker/start', (req, res) => {
    createGame();
    addLog('Game created. Waiting for agents...');
    broadcastState();
    res.json({ ok: true });
  });

  // Deal a new hand (called by UI after HAND_OVER)
  app.post('/api/poker/deal', (req, res) => {
    if (!game) {
      res.status(400).json({ error: 'No game. Start one first.' });
      return;
    }
    dealNewHand();
    res.json({ ok: true });
  });

  // Reset game
  app.post('/api/poker/reset', (req, res) => {
    game = null;
    broadcastState();
    res.json({ ok: true });
  });
}

module.exports = { init, registerRoutes };
