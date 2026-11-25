// Confirmed-launch rider: a paper-trading bot for the pump.fun Sharpe sprint
// (u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
//
// The grader runs `node /bot/main.ts` on Node 22. The strategy lives in strategy.ts and the
// SDK shim is vendored byte for byte from the kit's sdk/ts/makefun-bot.ts.
//
// What it does, in one line: buy only launches that have already proven demand (creator skin
// in the game plus a real crowd, or heavy crowd momentum), size small, pyramid into strength,
// cut losers at -5%, bank runners at +45%, and keep a cheap filler tier running so the entry
// clears the 20 distinct-mint guardrail in any 6h window. The ranking is hourly Sharpe, so
// steady small wins beat one lucky moonshot; everything here is tuned for that on the dev
// window with the kit's local grader (see the sweep notes in strategy.ts).
//
// Deterministic by construction: no clock, no randomness, no I/O, no network at runtime.
// Stdlib only, plus the vendored shim. Capital is the harness's 10 SOL paper account; the bot
// never holds more than 5 positions and never shorts or uses leverage (the harness forbids both).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Hand the tuned strategy to the shim, which owns the harness wire protocol:
// one reply per batch, orders decided purely from the batches the harness sends.
await runBot(createStrategy(DEFAULT_PARAMS));
