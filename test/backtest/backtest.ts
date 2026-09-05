// Replays the strategy over historical data. Two cursors: candles and swaps.
import { ceilToSpacing, floorToSpacing, priceToTick } from '../../src/math.js';
import {
  DECIMALS_USDC,
  DECIMALS_WETH,
  amounts,
  applySwap,
  close,
  hedge,
  mint,
  priceFromSqrt,
  sqrtFromX96,
  type Swap,
} from './mock.js';
import {
  GAS_BURN,
  GAS_MINT,
  HEDGE_BAND,
  POOL_ARBITRAGE_TRIGGER,
  PULL_FRACTION,
  RANGE_TICKS,
  SPREAD_TICKS,
  START_USDC,
  START_WETH,
  TICK_SPACING,
  newStats,
  type State,
} from './params.js';
import { readBook, readCandles, readSwaps } from './read_market_data.js';
import { logSummary } from './result_log.js';

// Read market data
const swaps = readSwaps(); // pool swaps during [START_DAY, END_DAY]
const candles = readCandles(); // Binance candles over the same period
const book = readBook(); // Hanji book snapshots, one a minute
let bookIndex = 0; // cursor into them; declared here because let is not hoisted

// Starting state
const state: State = {
  wallet: { weth: START_WETH, usdc: START_USDC },
  sqrtPool: sqrtFromX96(swaps[0]!.sqrtPriceX96),
  centerTick: 0, // geometric center of our quotes (~ the fair price at that moment)
};

// Counters, filled in during the run
const stats = newStats();



// ####### strategy #######


/*
--- Two one-sided quotes around the fair price, separated by 2 * SPREAD_TICKS.
--- mid - the fair price from Binance
*/
function plan(mid: number) {
  const midTick = tickOf(mid);
  const bidUpper = floorToSpacing(midTick - SPREAD_TICKS, TICK_SPACING);
  const askLower = ceilToSpacing(midTick + SPREAD_TICKS, TICK_SPACING);
  return {
    bid: { lower: bidUpper - RANGE_TICKS, upper: bidUpper },
    ask: { lower: askLower, upper: askLower + RANGE_TICKS },
  };
}

/*
--- Checks whether the fair price has drifted away from state.centerTick.
--- Distance, not boundary crossing: the price moving away from our quotes
--- needs a redeploy just as much as the price moving into them.
*/
function midMoved(mid: number): boolean {
  return Math.abs(tickOf(mid) - state.centerTick) > PULL_FRACTION * SPREAD_TICKS;
}

/*
--- Remembers the best price the pool reached inside our quotes.
--- For the ask that is the highest: the further it went, the dearer we sold.
*/
function updatePeakPrice(): void {
  const p = state.sqrtPool;
  const { bid, ask } = state;
  if (ask) ask.poolExtreme = Math.max(ask.poolExtreme, Math.min(p, ask.sqrtUpper));
  if (bid) bid.poolExtreme = Math.min(bid.poolExtreme, Math.max(p, bid.sqrtLower));
}

/*
--- The pool price has retraced from the best it reached.
--- Moving into a quote is good: the ask sold ETH above the market. But if the
--- price walks back the same way, the position buys that ETH back at the same
--- prices and the round trip nets to zero. Pulling on the retrace locks the sale.
---
--- tl,dr - guard from arbitrage
*/
function poolRetraced(): boolean {
  const p = state.sqrtPool;
  const { bid, ask } = state;
  if (ask && ask.poolExtreme > ask.sqrtLower && p < ask.poolExtreme &&
      ticksBetween(ask.poolExtreme, p) > POOL_ARBITRAGE_TRIGGER) return true;
  if (bid && bid.poolExtreme < bid.sqrtUpper && p > bid.poolExtreme &&
      ticksBetween(p, bid.poolExtreme) > POOL_ARBITRAGE_TRIGGER) return true;
  return false;
}

/*
--- Brings the wallet back to an even split when it has drifted too far.
--- Called with both quotes already closed, so the wallet holds everything and
--- the inventory is a plain number rather than a function of the pool price.
*/
function rebalance(ts: number, mid: number): void {
  const weth = state.wallet.weth / 1e18;
  const value = weth * mid + state.wallet.usdc / 1e6;
  if (value <= 0) return;

  // Measured as a share of the portfolio, so the band survives a change of
  // capital and stays comparable between runs.
  if (Math.abs((weth * mid) / value - 0.5) * 100 < HEDGE_BAND) return;

  const target = value / (2 * mid);
  const done = hedge(snapshotAt(ts), state.wallet, mid, (target - weth) * 1e18);
  state.wallet = done.wallet;
  stats.hedges += 1;
  stats.hedgeVolumeUsd += Math.abs(target - weth) * mid;
  stats.hedgeCostUsd += done.costUsd;
}

function redeploy(ts: number, mid: number, trigger: keyof typeof stats.byTrigger): void {
  const range = plan(mid);

  // The grid may round the new bounds to the same ticks, so the redeploy would
  // change nothing and still cost gas. Checked BEFORE closing: returning after
  // that without reopening would leave the tokens in the wallet and in the
  // position at once.
  if (state.bid && state.ask &&
      range.bid.upper === state.bid.tickUpper && range.ask.lower === state.ask.tickLower) {
    state.centerTick = tickOf(mid);
    return;
  }

  for (const side of [state.bid, state.ask]) {
    if (!side) continue;
    stats.feesTotalUsd += side.feesUsd;
    state.wallet = close(side, state.wallet, state.sqrtPool);
    stats.burns += 1;
  }
  state.bid = state.ask = undefined;

  rebalance(ts, mid);

  // A side is placed only if it sits entirely on its own side of the pool price.
  // Zero liquidity is dropped as well: the contract requires amount > 0, such a
  // transaction reverts, and gas spent on a revert is not refunded.
  const poolTick = tickOf(priceFromSqrt(state.sqrtPool));
  const place = (lower: number, upper: number) => {
    const opened = mint(state.wallet, lower, upper, state.sqrtPool);
    if (opened.position.liquidity <= 0) return undefined;
    state.wallet = opened.wallet;
    stats.mints += 1;
    return opened.position;
  };

  // don't place position if it has arbitrage effect
  if (range.bid.upper <= poolTick) state.bid = place(range.bid.lower, range.bid.upper);
  if (range.ask.lower >= poolTick) state.ask = place(range.ask.lower, range.ask.upper);

  if (state.bid || state.ask) stats.byTrigger[trigger] += 1;
  state.centerTick = tickOf(mid);
}

// ####### run strategy #######
// In this backtest we have two pointers
// first pointer - candles (second)
// second pointer - swaps

let swapIndex = 0;
let lastMid = candles[0]!.close;
// Curve starts at the untouched wallet, so the first mint's gas lands in the
// first increment instead of disappearing into the baseline.
let prevPrice = candles[0]!.close;
let prevDelta = START_WETH / 1e18;
let prevValue = prevDelta * prevPrice + START_USDC / 1e6;

for (const candle of candles) {
  // Catch up on swaps up to this second, crediting fees to the live quotes.
  while (swapIndex < swaps.length && swaps[swapIndex]!.timestamp <= candle.timestamp) {
    const swap: Swap = swaps[swapIndex]!;
    const before = state.sqrtPool;
    state.sqrtPool = sqrtFromX96(swap.sqrtPriceX96);
    stats.swapsSeen += 1;

    const rising = state.sqrtPool > before;
    let filled = false;
    if (state.bid && applySwap(state.bid, swap, before)) {
      filled = true;
      // Inward for the bid means downward: we buy ever cheaper.
      if (rising) stats.fillsBack += 1;
      else stats.fillsInward += 1;
    }
    if (state.ask && applySwap(state.ask, swap, before)) {
      filled = true;
      // Inward for the ask means upward: we sell ever dearer.
      if (rising) stats.fillsInward += 1;
      else stats.fillsBack += 1;
    }
    if (filled) stats.swapsFilled += 1;

    updatePeakPrice();
    if (poolRetraced()) redeploy(swap.timestamp, lastMid, 'poolRetraced');
    swapIndex += 1;
  }

  lastMid = candle.close;
  if (!state.bid && !state.ask) redeploy(candle.timestamp, candle.close, 'noPosition');
  else if (midMoved(candle.close)) redeploy(candle.timestamp, candle.close, 'midMoved');

  // Holding ETH while it rises is not skill, so the move on the exposure we
  // were carrying is taken out. What is left is fees and spread less costs.
  const { valueUsd, deltaWeth } = portfolio(candle.close);
  stats.hedgedPnlUsd += valueUsd - prevValue - prevDelta * (candle.close - prevPrice);
  prevValue = valueUsd;
  prevDelta = deltaWeth;
  prevPrice = candle.close;
}

let finalWallet = state.wallet;
for (const side of [state.bid, state.ask]) {
  if (!side) continue;
  stats.feesTotalUsd += side.feesUsd;
  finalWallet = close(side, finalWallet, state.sqrtPool);
}

logSummary(stats, finalWallet, sqrtFromX96(swaps[0]!.sqrtPriceX96), state.sqrtPool);


// ####### helpers #######

/*
--- Portfolio value at the fair price, and how much ETH it is exposed to.
--- A position's composition follows the pool price, its worth the fair one.
--- Fees earned but not yet banked count too, otherwise the curve jumps every
--- time a side is closed.
*/
function portfolio(mid: number): { valueUsd: number; deltaWeth: number } {
  let weth = state.wallet.weth;
  let usdc = state.wallet.usdc;
  let fees = stats.feesTotalUsd;
  for (const side of [state.bid, state.ask]) {
    if (!side) continue;
    const held = amounts(side, state.sqrtPool);
    weth += held.weth;
    usdc += held.usdc;
    fees += side.feesUsd;
  }
  const eth = weth / 1e18;
  const gas = stats.burns * GAS_BURN + stats.mints * GAS_MINT;
  return {
    valueUsd: eth * mid + usdc / 1e6 + fees - gas - stats.hedgeCostUsd,
    deltaWeth: eth,
  };
}
function tickOf(price: number): number {
  return priceToTick(price, DECIMALS_WETH, DECIMALS_USDC);
}

/*
--- Last book snapshot no later than ts. Time only moves forward in the run,
--- so the cursor walks alongside it instead of searching from scratch.
*/
function snapshotAt(ts: number) {
  while (bookIndex + 1 < book.length && book[bookIndex + 1]!.timestamp <= ts) bookIndex += 1;
  return book[bookIndex]!;
}

function ticksBetween(a: number, b: number): number {
  return Math.abs((2 * Math.log(a / b)) / Math.log(1.0001)); // distance between two pool prices, in ticks
}
