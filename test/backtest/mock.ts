import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  tickToPrice,
  tickToSqrtPrice,
} from '../../src/math.js';

export const DECIMALS_WETH = 18;
export const DECIMALS_USDC = 6;

/* --- Pool fee of 0.05%, a quarter of which goes to the protocol. */
export const LP_FEE_RATE = 0.0005 * 0.75;

/* --- Taker fee on Hanji, the aggressiveFee of the market. */
export const HANJI_TAKER_FEE = 0.0001;

/* --- Wallet. Amounts are in each token's smallest units. */
export interface Wallet {
  weth: number;
  usdc: number;
}

export interface Swap {
  timestamp: number;
  block: number;
  amount0: number;
  amount1: number;
  sqrtPriceX96: number;
  liquidity: number;
  tick: number;
}

export interface Candle {
  timestamp: number;
  close: number;
}

/* --- One price level of the Hanji book: the quote and the size behind it. */
export interface BookLevel {
  price: number;
  size: number;
}

/*
--- One snapshot of the Hanji book, levels ordered best first.
--- Levels 1-4 are the aggregator's virtual liquidity and sit within a bp of
--- each other; the fifth is a real resting order percents away, never reached.
--- Snapshots are taken on a time grid, so one is minutes old at any moment:
--- the band is what they measure, the price level still comes from Binance.
*/
export interface Book {
  timestamp: number;
  block: number;
  bid: BookLevel[];
  ask: BookLevel[];
}

export interface Position {
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  sqrtLower: number;
  sqrtUpper: number;
  liquidity: number;
  feesUsd: number;
  fills: number;
  /*
  --- The best pool price reached inside our range.
  --- For the ask that is the highest: the further it went, the dearer we sold.
  --- For the bid it is the lowest. Kept as a square root and clamped to the
  --- range: beyond the bounds the position is fully converted and further
  --- movement no longer touches it.
  */
  poolExtreme: number;
}

export function sqrtFromX96(sqrtPriceX96: number): number {
  return sqrtPriceX96 / 2 ** 96;
}

export function priceFromSqrt(sqrtPrice: number): number {
  return sqrtPrice ** 2 * 10 ** (DECIMALS_WETH - DECIMALS_USDC);
}

/* --- Opens a position, taking from the wallet exactly what the pool would take. */
export function mint(
  wallet: Wallet,
  tickLower: number,
  tickUpper: number,
  sqrtPool: number,
): { position: Position; wallet: Wallet } {
  const sqrtLower = tickToSqrtPrice(tickLower);
  const sqrtUpper = tickToSqrtPrice(tickUpper);

  // token0 = WETH, token1 = USDC for this pair
  let liquidity = getLiquidityForAmounts(wallet.weth, wallet.usdc, sqrtLower, sqrtUpper, sqrtPool);
  let used = getAmountsForLiquidity(liquidity, sqrtLower, sqrtUpper, sqrtPool);

  // The round trip "amounts -> L -> amounts" goes through floats, so the way
  // back may ask for slightly more than we hold. Clamping the wallet alone is
  // wrong: the position would keep its old L, that is money out of nowhere.
  // Instead we shrink L itself down to what actually fits.
  const fit = Math.min(
    used.amount0 > 0 ? wallet.weth / used.amount0 : Infinity,
    used.amount1 > 0 ? wallet.usdc / used.amount1 : Infinity,
  );
  if (Number.isFinite(fit) && fit < 1) {
    liquidity *= fit;
    used = getAmountsForLiquidity(liquidity, sqrtLower, sqrtUpper, sqrtPool);
  }
  if (!Number.isFinite(liquidity) || liquidity < 0) liquidity = 0;

  // A position cannot be worth more than the wallet it came from.
  const price = priceFromSqrt(sqrtPool);
  const before = (wallet.weth / 1e18) * price + wallet.usdc / 1e6;
  const inside = (used.amount0 / 1e18) * price + used.amount1 / 1e6;
  if (inside > before * 1.0001 + 1e-6) {
    console.log(`MINT CREATED MONEY: had $${before.toFixed(2)}, put $${inside.toFixed(2)} into the position`);
    console.log(`  ticks [${tickLower},${tickUpper}]  sqrt ${sqrtLower} ${sqrtUpper}  pool ${sqrtPool}`);
    console.log(`  wallet weth=${wallet.weth.toExponential(3)} usdc=${wallet.usdc.toExponential(3)}`);
    console.log(`  L=${liquidity.toExponential(3)}  used0=${used.amount0.toExponential(3)} used1=${used.amount1.toExponential(3)}`);
    process.exit(1);
  }

  const left = (have: number, spent: number) => Math.max(0, have - spent);

  return {
    position: {
      tickLower,
      tickUpper,
      priceLower: tickToPrice(tickLower, DECIMALS_WETH, DECIMALS_USDC),
      priceUpper: tickToPrice(tickUpper, DECIMALS_WETH, DECIMALS_USDC),
      sqrtLower,
      sqrtUpper,
      liquidity,
      feesUsd: 0,
      fills: 0,
      poolExtreme: Math.min(Math.max(sqrtPool, sqrtLower), sqrtUpper),
    },
    wallet: { weth: left(wallet.weth, used.amount0), usdc: left(wallet.usdc, used.amount1) },
  };
}

/* --- What the position holds at the current pool price. */
export function amounts(position: Position, sqrtPool: number): Wallet {
  const a = getAmountsForLiquidity(position.liquidity, position.sqrtLower, position.sqrtUpper, sqrtPool);
  return { weth: a.amount0, usdc: a.amount1 };
}

/*
--- Closes a position and returns its tokens to the wallet.
--- Fees are deliberately left out: they are tracked as a dollar value by the
--- caller, and a dollar figure cannot be added to a token balance.
*/
export function close(position: Position, wallet: Wallet, sqrtPool: number): Wallet {
  const held = amounts(position, sqrtPool);
  return { weth: wallet.weth + held.weth, usdc: wallet.usdc + held.usdc };
}

/*
--- Credits the fee from someone else's swap if it crossed our range.
--- Returns true when the swap actually touched us.
*/
export function applySwap(position: Position, swap: Swap, sqrtBefore: number): boolean {
  const sqrtAfter = sqrtFromX96(swap.sqrtPriceX96);
  const from = Math.min(sqrtBefore, sqrtAfter);
  const to = Math.max(sqrtBefore, sqrtAfter);

  const low = Math.max(from, position.sqrtLower);
  const high = Math.min(to, position.sqrtUpper);
  if (high <= low) return false;

  const volumeUsd = (swap.liquidity * (high - low)) / 10 ** DECIMALS_USDC;
  const share = position.liquidity / (swap.liquidity + position.liquidity);

  position.feesUsd += volumeUsd * share * LP_FEE_RATE;
  position.fills += 1;
  return true;
}

/* --- Dollar value of the wallet plus an optional position. */
export function valueUsd(wallet: Wallet, position: Position | undefined, sqrtPool: number): number {
  const held = position ? amounts(position, sqrtPool) : { weth: 0, usdc: 0 };
  const weth = (wallet.weth + held.weth) / 10 ** DECIMALS_WETH;
  const usdc = (wallet.usdc + held.usdc) / 10 ** DECIMALS_USDC;
  return weth * priceFromSqrt(sqrtPool) + usdc;
}

/*
--- A taker swap on Hanji. deltaWeth > 0 buys ETH for USDC, < 0 sells it.
--- The level of the price comes from Binance, the book only says how far the
--- sides stand from it: over the minute between snapshots the price drifts by
--- 2.28 bps while the spread moves by 0.03.
*/
export function hedge(
  book: Book,
  wallet: Wallet,
  fairPrice: number,
  deltaWeth: number,
): { wallet: Wallet; costUsd: number } {
  // Both in USDC per ETH, so they add to the fair price directly.
  const half = (book.ask[0]!.price - book.bid[0]!.price) / 2;
  const fee = fairPrice * HANJI_TAKER_FEE;
  const exec = deltaWeth > 0 ? fairPrice + half + fee : fairPrice - half - fee;

  // No cap on the size: reaching a 50/50 target never asks for more than the
  // wallet holds, and Hanji has no short to guard against anyway.
  const weth = deltaWeth / 1e18;
  return {
    wallet: { weth: wallet.weth + deltaWeth, usdc: wallet.usdc - weth * exec * 1e6 },
    costUsd: Math.abs(weth) * (half + fee),
  };
}
