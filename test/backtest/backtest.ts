// Прогон стратегии по историческим данным. Два указателя: свечи и свопы.
import { ceilToSpacing, floorToSpacing, priceToTick } from '../../src/math.js';
import {
  DECIMALS_USDC,
  DECIMALS_WETH,
  applySwap,
  close,
  mint,
  priceFromSqrt,
  sqrtFromX96,
  type Swap,
} from './mock.js';
import {
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
import { readCandles, readSwaps } from './read_market_data.js';
import { logSummary } from './result_log.js';

// Read market-data
const swaps = readSwaps(); // swaps during [time_start, time_end]
const candles = readCandles(); // candles during [time_start, time_end]

// start position
const state: State = {
  wallet: { weth: START_WETH, usdc: START_USDC },
  sqrtPool: sqrtFromX96(swaps[0]!.sqrtPriceX96),
  centerTick: 0, // geometry center of our positions (~ fair price on that moment)
};

// statistic (calculating during execution)
const stats = newStats();



// ####### strategy #######


/*
--- Two one-side positions around the fair price.
--- mid - fair price from Binance  
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
--- Check if current price deviated from state.center
 */
function midMoved(mid: number): boolean {
  return Math.abs(tickOf(mid) - state.centerTick) > PULL_FRACTION * SPREAD_TICKS;
}

/** Запоминает, до какой выгодной цены дошёл пул внутри наших котировок. */
function trackExtreme(): void {
  const p = state.sqrtPool;
  const { bid, ask } = state;
  if (ask) ask.poolExtreme = Math.max(ask.poolExtreme, Math.min(p, ask.sqrtUpper));
  if (bid) bid.poolExtreme = Math.min(bid.poolExtreme, Math.max(p, bid.sqrtLower));
}

/**
 * Цена пула откатилась от лучшей достигнутой.
 *
 * Заход цены в котировку выгоден: аск продал ETH выше рынка. Но если цена
 * пойдёт обратно тем же путём, позиция откупит проданное по тем же ценам и
 * круг закроется в ноль. Снявшись на откате, мы фиксируем продажу.
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

function redeploy(mid: number, trigger: keyof typeof stats.byTrigger): void {
  const range = plan(mid);

  // Сетка может округлить новые границы к тем же тикам — тогда перевыставление
  // ничего не изменит, а газ спишется. Проверяем ДО закрытия: выйти после него,
  // не открыв заново, значит оставить токены и в кошельке, и в позиции сразу.
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

  // Сторона выставляется, только если лежит целиком по свою сторону от цены
  // пула. Плюс отбрасываем нулевую ликвидность: контракт требует amount > 0,
  // такая транзакция откатится, а газ за откат не возвращается.
  const poolTick = tickOf(priceFromSqrt(state.sqrtPool));
  const place = (lower: number, upper: number) => {
    const opened = mint(state.wallet, lower, upper, state.sqrtPool);
    if (opened.position.liquidity <= 0) return undefined;
    state.wallet = opened.wallet;
    stats.mints += 1;
    return opened.position;
  };

  if (range.bid.upper <= poolTick) state.bid = place(range.bid.lower, range.bid.upper);
  if (range.ask.lower >= poolTick) state.ask = place(range.ask.lower, range.ask.upper);

  if (state.bid || state.ask) stats.byTrigger[trigger] += 1;
  state.centerTick = tickOf(mid);
}

// --- прогон ---

let swapIndex = 0;
let lastMid = candles[0]!.close;
let backFillHere = false, missedPulls = 0, caughtPulls = 0;

for (const candle of candles) {
  // Догоняем свопы до текущей секунды, начисляя комиссии живым позициям.
  while (swapIndex < swaps.length && swaps[swapIndex]!.timestamp <= candle.timestamp) {
    const swap: Swap = swaps[swapIndex]!;
    const before = state.sqrtPool;
    state.sqrtPool = sqrtFromX96(swap.sqrtPriceX96);
    stats.swapsSeen += 1;

    const rising = state.sqrtPool > before;
    let filled = false;
    if (state.bid && applySwap(state.bid, swap, before)) {
      filled = true;
      // Для бида вглубь — это вниз: покупаем всё дешевле.
      if (rising) { stats.fillsBack += 1; backFillHere = true; } else stats.fillsInward += 1;
    }
    if (state.ask && applySwap(state.ask, swap, before)) {
      filled = true;
      // Для аска вглубь — это вверх: продаём всё дороже.
      if (rising) stats.fillsInward += 1; else { stats.fillsBack += 1; backFillHere = true; }
    }
    if (filled) stats.swapsFilled += 1;

    trackExtreme();
    const retraced = poolRetraced();
    if (backFillHere && !retraced) missedPulls += 1;
    if (backFillHere && retraced) caughtPulls += 1;
    backFillHere = false;
    if (retraced) redeploy(lastMid, 'poolRetraced');
    swapIndex += 1;
  }

  lastMid = candle.close;
  if (!state.bid && !state.ask) redeploy(candle.close, 'noPosition');
  else if (midMoved(candle.close)) redeploy(candle.close, 'midMoved');
}

// Закрываем всё, что осталось открытым, чтобы сравнить кошельки целиком.
let finalWallet = state.wallet;
for (const side of [state.bid, state.ask]) {
  if (!side) continue;
  stats.feesTotalUsd += side.feesUsd;
  finalWallet = close(side, finalWallet, state.sqrtPool);
}

console.log(`возвратных исполнений: поймано ${caughtPulls}, пропущено ${missedPulls}`);
logSummary(stats, finalWallet, sqrtFromX96(swaps[0]!.sqrtPriceX96), state.sqrtPool);


// helpers
const tickOf = (price: number) => priceToTick(price, DECIMALS_WETH, DECIMALS_USDC);
const ticksBetween = (a: number, b: number) => Math.abs((2 * Math.log(a / b)) / Math.log(1.0001)); // ticks beetwen prices (in pool)
