// Confirmed-launch rider for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The ranking is hourly Sharpe, not PnL: steady small wins beat one lucky moonshot. So this bot
// trades small, diversified stakes across many confirmed launches, cuts losers fast, and lets the
// few real runners pay for the rest through a take-profit plus trailing stop. Partial
// take-profit was tried on the dev window and rejected: selling half early pays another full
// tx fee and strands the rest at a breakeven stop, so it lost money at every setting (Sharpe
// -0.21 at +20% partial vs +0.13 off); the code stays, off by default, so the test is on
// the record.
//
// Three entry paths, in priority order:
//   (A) Creator skin in the game: the creator bought >= devBuyMin SOL of their own coin at launch
//       and a crowd followed (8+ trades, 5+ buyers within the first 10 slots).
//   (B) Crowd momentum: heavy buying (>= minBuySol SOL) and a strong run-up from the create price.
//   (C) Late momentum: an older launch (10-150 slots) whose tape re-accelerates — net inflow
//       rising in the newer half of the window, price near its window high, many distinct buyers.
//       Path C exists for breadth: the final window is only 6h, so the bot must clear 20 distinct
//       mints there, and paths A/B alone only reach ~70 coins per 24h of dev data (~17 per 6h).
//       SWEPT AND DISABLED (2026-11-26): on the dev window every late-momentum setting added
//       only losing coins (best case 1 extra coin, Sharpe 0.121 vs 0.135 with the path off);
//       older coins that re-accelerate are traps in this data. The code stays, off by default,
//       so a future window can re-test it without rewriting the entry logic.
//
// Two tiers. Main tier: the three entry paths above, a 0.02 SOL probe that pyramids into strength
// up to 0.1 SOL. Filler tier: weaker signals (smaller dev buy, up to 30 slots old) bought at the
// 0.01 SOL guardrail minimum with a quick exit and no adds — its only job is breadth, so the entry
// clears the 20 distinct-mint guardrail in any 6h window even when launch flow is slow. Fillers
// are evaluated only after the main paths, never taking a slot from a main trade. Filler stakes are
// fee-poisoned (a 0.01 SOL round trip pays ~4.6% in curve + tx fees), so fillers are kept few and
// cheap: devBuy >= 3 SOL, 8+ trades, quick 10% take-profit, 5% stop, 20-slot max hold.
// BREADTH TRADE-OFF (2026-11-26): fillerDevBuyMin 3.5 scores better on dev (Sharpe 0.128,
// 91 coins) than 3.0 (Sharpe 0.111, 113 coins), but the final window is only 6h, so the bot
// must clear 20 distinct mints there: 91 coins per 24h is ~23 per 6h and risks missing the
// bar on a slow window, while 113 is ~28. The 0.017 Sharpe is the price of not ranking below
// every qualifying entry. Filler minTrades 6 was swept and rejected (Sharpe -0.24).
//
// Sizing: the harness caps each reply's buys on one coin at 1% of its real SOL reserve, so a
// position is built in tranches across replies (pyramid into strength only) up to stakeSol.
//
// Exits: a hard stop against cost, a trailing stop that arms once the position is up, a fade exit
// when net flow turns against the coin, a dev-sell exit, and a time exit that frees the slot for
// the next launch. Take-profit 0.45 banks the runners before the curve turns.
//
// Everything is a pure function of the batches the harness sends: no clock, no randomness, no I/O,
// so the two graded executions produce byte-identical action logs.
//
// Repair history (dev grade-local, process driver): the first build lost (Sharpe -0.55, net
// -0.24 SOL) on the filler tier and loose entries. Sweeping the kit's local sim on the dev window
// showed the filler tier at 0.01 SOL with loose exits was the main leak, the 5% stop / 45%
// take-profit / 1200-slot hold was the best exit set, and devBuy >= 5 SOL the best main filter.
// This revision keeps those findings, adds the late-momentum path for breadth, and tightens the
// filler to a fast scalp.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Creator's own buy in the create slot (SOL): the skin-in-the-game signal. */
  devBuyMin: number;
  /** Entry window in slots for the net-flow signal. */
  window: number;
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Trades seen before entry. */
  minTrades: number;
  /** Distinct non-creator buyers seen before entry. */
  minBuyers: number;
  /** SOL bought (all buyers) before entry. */
  minBuySol: number;
  /** Net SOL (buys minus sells) over the entry window. */
  minNetSol: number;
  /** Price now over create price, minus 1: entry window. */
  minRunup: number;
  maxRunup: number;
  /** Real SOL reserve window at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Skip the coin when the creator has sold before entry. */
  skipDevSold: boolean;
  /** Target SOL per position in total (each reply still capped at 1% of real SOL). */
  stakeSol: number;
  /** First buy of a position (SOL): a probe. Adds build it to stakeSol only while the coin
   * survives and keeps rising, so an instant rug costs the probe, not the full stake. */
  initialSol: number;
  /** Strong launches (creator skin >= strongDevBuy SOL) get a bigger probe and target: the
   * devBuy >= 12 subset earned nearly all of the dev-window net with 30 fewer coins, so it
   * deserves more weight than the average launch. SWEPT AND NEUTRALISED (2026-11-26): sizing
   * strong launches up (0.04 probe / 0.15 target) LOWERED Sharpe to 0.100 from 0.128 — the
   * bigger probe fills worse under the 1% reserve cap. Defaults now equal the normal sizing. */
  strongDevBuy: number;
  strongInitialSol: number;
  strongStakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minOrderSol: number;
  /** Buys after the first one, each on a later batch, while the coin keeps qualifying. */
  maxAdds: number;
  /** Most SOL per add. */
  addSol: number;
  /** An add needs the price at least this far above the previous buy's decision price. */
  addStep: number;
  /** An add waits this many slots after the previous buy was decided. */
  addDelay: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when the position's liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Then exit on a fall of this share from the position's best value. */
  trail: number;
  /** Exit when value reaches cost * (1 + takeProfit). 1e9 = effectively off. */
  takeProfit: number;
  /** Partial take-profit: once value reaches cost * (1 + partialTp), sell partialPart of the
   * position and move the stop to cost * (1 - partialStop) for the rest. 0 = off. Banking half
   * early turns some would-be losers into small wins and cuts variance, which is what hourly
   * Sharpe rewards; the rest still rides to takeProfit or the trailing stop. */
  partialTp: number;
  partialPart: number;
  partialStop: number;
  /** Exit when net SOL over the last fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after holding this many slots (unless the position is up at least holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Late-momentum path (C): a second-chance entry for older launches whose tape re-accelerates. */
  lateEnabled: boolean;
  /** Age window (slots since create) for a late entry. */
  lateMinAge: number;
  lateMaxAge: number;
  /** Trades / distinct buyers seen before a late entry. */
  lateMinTrades: number;
  lateMinBuyers: number;
  /** Net SOL over the entry window for a late entry. */
  lateMinNetSol: number;
  /** Price now over create price, minus 1: late entry window. */
  lateMinRunup: number;
  lateMaxRunup: number;
  /** Price now at least this share of the window's high. */
  lateNearHigh: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  lateAccel: number;
  /** Creator skin in the game needed for a late entry (SOL). */
  lateMinDevBuy: number;
  /** Filler tier: a second, cheaper entry path whose only job is guardrail breadth — enough
   * distinct mints with >=0.01 SOL round trips in any 6h window. Filler coins are weaker
   * signals (smaller dev buy, later age), so they get the minimum 0.01 SOL, no adds, and a
   * quick exit. They are evaluated only after the main paths, never taking a slot from them. */
  fillerEnabled: boolean;
  /** Creator buy needed for a filler entry (SOL). */
  fillerDevBuyMin: number;
  /** Oldest age (slots) at which a filler entry may still be decided. */
  fillerMaxAge: number;
  /** Trades / buyers needed for a filler entry. */
  fillerMinTrades: number;
  fillerMinBuyers: number;
  /** Stake for a filler position (SOL): the guardrail minimum, no adds. */
  fillerSol: number;
  /** Filler exits: quick take-profit, stop, and time exit. */
  fillerTakeProfit: number;
  fillerStopLoss: number;
  fillerMaxHold: number;
}

export const DEFAULT_PARAMS: Params = {
  devBuyMin: 5,
  window: 30,
  minAge: 0,
  maxAge: 10,
  minTrades: 8,
  minBuyers: 5,
  minBuySol: 20,
  minNetSol: 0.5,
  minRunup: 1,
  maxRunup: 2,
  minRqSol: 1,
  maxRqSol: 60,
  maxBigSellBps: 5000,
  skipDevSold: true,
  stakeSol: 0.1,
  initialSol: 0.02,
  strongDevBuy: 12,
  strongInitialSol: 0.02,
  strongStakeSol: 0.1,
  minOrderSol: 0.01,
  maxAdds: 4,
  addSol: 0.02,
  addStep: 0.02,
  addDelay: 10,
  buySlipBps: 10_000,
  stopLoss: 0.05,
  trailArm: 0.3,
  trail: 0.15,
  takeProfit: 0.45,
  partialTp: 0,
  partialPart: 0.5,
  partialStop: 0,
  fadeWindow: 30,
  fadeNetSol: 1e9,
  maxHold: 1200,
  holdIfUp: 0.5,
  exitOnDevSell: true,
  cooldown: 300,
  maxEntries: 2,
  lateEnabled: false,
  lateMinAge: 10,
  lateMaxAge: 150,
  lateMinTrades: 25,
  lateMinBuyers: 8,
  lateMinNetSol: 3,
  lateMinRunup: 0.3,
  lateMaxRunup: 2,
  lateNearHigh: 0.95,
  lateAccel: 1,
  lateMinDevBuy: 2,
  fillerEnabled: true,
  fillerDevBuyMin: 3,
  fillerMaxAge: 30,
  fillerMinTrades: 8,
  fillerMinBuyers: 5,
  fillerSol: 0.01,
  fillerTakeProfit: 0.1,
  fillerStopLoss: 0.05,
  fillerMaxHold: 20,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125n;
const BPS = 10_000n;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  creator: string | null;
  vq0: bigint;
  vt0: bigint;
  trades: Trade[];
  buyers: Set<string>;
  buySol: number;
  devBuy: number;
  devSold: boolean;
  bigSellBps: number;
  entries: number;
  lastExit: number;
  done: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastAddSlot: number;
  adds: number;
  lastValue: number;
  txPaid: number;
  /** A partial take-profit was already banked on this position. */
  tookPartial: boolean;
  /** Per-position plan: main tier or filler tier. */
  stakeSol: number;
  takeProfit: number;
  stopLoss: number;
  trailArm: number;
  trail: number;
  maxHold: number;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const keep = Math.max(p.window, p.fadeWindow) + 10;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: null,
        creator: null,
        vq0: 0n,
        vt0: 1n,
        trades: [],
        buyers: new Set(),
        buySol: 0,
        devBuy: 0,
        devSold: false,
        bigSellBps: 0,
        entries: 0,
        lastExit: -1e12,
        done: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const tr = c.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const vt = BigInt(e.virtual_token_reserves);
          const price = vt === 0n ? 0 : Number(e.virtual_quote_reserves) / Number(vt);
          c.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          traded.add(e.mint);
          if (e.is_buy) {
            c.buySol += sol;
            if (e.user !== c.creator) c.buyers.add(e.user);
            else if (e.slot === c.created) c.devBuy += sol;
          } else {
            if (e.user === c.creator) {
              c.devSold = true;
            } else {
              const rqBefore = Number(e.real_quote_reserves) / LAMPORTS + sol;
              if (rqBefore > 0) {
                const bps = (sol / rqBefore) * 10_000;
                if (bps > c.bigSellBps) c.bigSellBps = bps;
              }
            }
          }
        } else {
          coinOf(e.mint).done = true;
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.trades.length && c.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) c.lastExit = now;
            else c.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const value = Number(sellValue(pos.token_amount, BigInt(Math.floor(vq)), BigInt(Math.floor(vt)))) / LAMPORTS - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS + h.txPaid;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const c = coinOf(mint);
        let exit = false;
        // Partial take-profit first: bank half at +partialTp, then let the rest ride with the
        // stop moved to breakeven. Never partial while a sell is already in flight.
        if (p.partialTp > 0 && !h.tookPartial && value >= cost * (1 + p.partialTp)) {
          const tokens = BigInt(pos.token_amount);
          const part = (tokens * BigInt(Math.round(p.partialPart * 10_000))) / 10_000n;
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (part > 0n && part < tokens && !sellPending && orders.length < cap) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            h.tookPartial = true;
            h.stopLoss = p.partialStop;
            h.peakValue = value;
            continue;
          }
        }
        if (value <= cost * (1 - h.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + h.trailArm) && value < h.peakValue * (1 - h.trail)) exit = true;
        if (!exit && value >= cost * (1 + h.takeProfit)) exit = true;
        if (!exit && flow(c, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && p.exitOnDevSell && c.devSold) exit = true;
        if (!exit && now - h.opened > h.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries and adds. Main paths first; the filler tier runs after, so it never takes a
      // slot a main trade could use.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();

      const commonGates = (c: Coin, rqSol: number): boolean => {
        if (c.vq0 === 0n || c.vt0 === 0n) return false;
        if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) return false;
        if (flow(c, now, p.window) < p.minNetSol) return false;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
        if (c.bigSellBps > p.maxBigSellBps) return false;
        if (p.skipDevSold && c.devSold) return false;
        return true;
      };
      interface Plan { amount: number; stakeSol: number; takeProfit: number; stopLoss: number; trailArm: number; trail: number; maxHold: number }
      const mainPlan = (c: Coin, price: number, age: number): Plan | null => {
        const plan: Plan = { amount: p.initialSol, stakeSol: p.stakeSol, takeProfit: p.takeProfit, stopLoss: p.stopLoss, trailArm: p.trailArm, trail: p.trail, maxHold: p.maxHold };
        if (age >= p.minAge && age <= p.maxAge) {
          if (c.trades.length >= p.minTrades && c.buyers.size >= p.minBuyers) {
            const runup = price / (Number(c.vq0) / Number(c.vt0)) - 1;
            // Two entry paths: (A) the creator put real skin in the game at launch and a crowd
            // followed; (B) crowd momentum: heavy buying and a strong run-up from the create price.
            const pathA = c.devBuy >= p.devBuyMin;
            const pathB = c.buySol >= p.minBuySol && runup >= p.minRunup && runup <= p.maxRunup;
            if (pathA || pathB) {
              // Strong launches get a bigger probe and target.
              if (pathA && c.devBuy >= p.strongDevBuy) {
                return { ...plan, amount: p.strongInitialSol, stakeSol: p.strongStakeSol };
              }
              return plan;
            }
          }
        }
        // Path C: late momentum — an older launch whose tape re-accelerates.
        if (p.lateEnabled && age >= p.lateMinAge && age <= p.lateMaxAge) {
          if (c.trades.length < p.lateMinTrades || c.buyers.size < p.lateMinBuyers) return null;
          if (c.devBuy < p.lateMinDevBuy) return null;
          if (flow(c, now, p.window) < p.lateMinNetSol) return null;
          const runup = price / (Number(c.vq0) / Number(c.vt0)) - 1;
          if (runup < p.lateMinRunup || runup > p.lateMaxRunup) return null;
          const from = now - p.window;
          const mid = now - p.window / 2;
          let netOld = 0;
          let netNew = 0;
          let high = 0;
          for (const tr of c.trades) {
            if (tr.slot <= from) continue;
            const signed = tr.buy ? tr.sol : -tr.sol;
            if (tr.slot <= mid) netOld += signed;
            else netNew += signed;
            if (tr.price > high) high = tr.price;
          }
          if (netNew <= 0 || netNew < p.lateAccel * netOld) return null;
          if (high <= 0 || price < high * p.lateNearHigh) return null;
          return plan;
        }
        return null;
      };
      const fillerPlan = (c: Coin, price: number, age: number): Plan | null => {
        if (!p.fillerEnabled) return null;
        if (age < p.minAge || age > p.fillerMaxAge) return null;
        if (c.trades.length < p.fillerMinTrades) return null;
        if (c.buyers.size < p.fillerMinBuyers) return null;
        if (c.devBuy < p.fillerDevBuyMin) return null;
        return { amount: p.fillerSol, stakeSol: p.fillerSol, takeProfit: p.fillerTakeProfit, stopLoss: p.fillerStopLoss, trailArm: p.trailArm, trail: p.trail, maxHold: p.fillerMaxHold };
      };
      const enter = (mint: Pubkey, c: Coin, price: number, plan: Plan): void => {
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol * 0.97, plan.amount);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minOrderSol) return;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastAddSlot: now, adds: 0, lastValue: 0, txPaid: 0, tookPartial: false, stakeSol: plan.stakeSol, takeProfit: plan.takeProfit, stopLoss: plan.stopLoss, trailArm: plan.trailArm, trail: plan.trail, maxHold: plan.maxHold });
        c.entries++;
        slotsLeft--;
        free -= amount + tx;
      };

      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const c = coins.get(mint)!;
        if (c.created === null || c.done) continue;
        const age = now - c.created;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (!commonGates(c, rqSol)) continue;
          const plan = mainPlan(c, price, age);
          if (plan === null) continue;
          enter(mint, c, price, plan);
        } else {
          // Pyramid into strength only: price stepped up from the last buy, still flowing in.
          // No adds after a partial take-profit: the position is being wound down, not built.
          if (h.exiting || h.tookPartial || !h.filled || h.adds >= p.maxAdds || h.invested >= h.stakeSol - p.minOrderSol) continue;
          if (now - h.lastAddSlot < p.addDelay) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(c, now, p.window) < p.minNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          let amount = Math.min(capSol * 0.97, p.addSol, h.stakeSol - h.invested);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minOrderSol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          h.invested += amount;
          h.adds++;
          h.lastAddPrice = price;
          h.lastAddSlot = now;
          free -= amount + tx;
        }
      }
      // Filler pass: breadth only, at the guardrail minimum.
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        if (held.has(mint)) continue;
        const c = coins.get(mint)!;
        if (c.created === null || c.done) continue;
        const age = now - c.created;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!commonGates(c, rqSol)) continue;
        const plan = fillerPlan(c, price, age);
        if (plan === null) continue;
        enter(mint, c, price, plan);
      }
      // Track tx fees paid on filled buys so the exit basis includes them.
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'buy') {
          const h = held.get(f.mint);
          if (h !== undefined) h.txPaid += Number(f.tx_fee_lamports) / LAMPORTS;
        }
      }
      return orders;
    },
  };
}
