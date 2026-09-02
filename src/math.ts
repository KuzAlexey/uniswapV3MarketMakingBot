// Pure tick and liquidity maths. No network, no config — safe to import anywhere.

// ---------------------------------------------------------------------------
// Price maths
//
// Uniswap stores the price in two unusual forms, and both need converting.
//
//   tick          a whole number. price = 1.0001 ^ tick, so one tick = 0.01%.
//                 Ranges are defined with ticks, never with dollars.
//
//   sqrtPriceX96  the square root of the price, multiplied by 2^96 to keep
//                 precision without decimals (the blockchain has no fractions).
//
// Both express the price in the smallest units of each token, so we also have
// to correct for the decimals: WETH counts in 10^-18, USDC in 10^-6.
// ---------------------------------------------------------------------------

/** Turns a human price like 2500.13 into a tick. The result is fractional. */
export function priceToTick(price: number, decimals0: number, decimals1: number): number {
  return Math.log(price / 10 ** (decimals0 - decimals1)) / Math.log(1.0001);
}

/** Turns a tick back into a human price like 2500.13. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}

/**
 * Rounds a tick DOWN to a valid range boundary.
 * Math.floor is essential here: our ticks are negative, and Math.trunc would
 * round towards zero, i.e. upwards, giving a boundary the pool rejects.
 */
export function floorToSpacing(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

/**
 * Rounds a tick UP to a valid range boundary.
 * Mirror of floorToSpacing. Use it for the upper edge of a range, or for the
 * lower edge when you want the range to start strictly above a given price.
 */
export function ceilToSpacing(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

/** Human price of the pool right now, taken from its stored square root. */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  return sqrtPrice ** 2 * 10 ** (decimals0 - decimals1);
}

// ---------------------------------------------------------------------------
// Liquidity maths
//
// A position is described by one number, its "liquidity" L, plus the two ticks
// that bound it. How many tokens that L corresponds to depends on where the
// current price sits inside the range — that is why the same position holds
// different amounts at different times without L ever changing.
//
// Everything here works in the pool's own raw units: sqrt(price) as the pool
// stores it, and token amounts in their smallest units (wei, USDC millionths).
// We convert bigint to number for the arithmetic. That costs a little accuracy
// in the last digits, which is harmless for measurement but would not be
// acceptable for building a real transaction.
// ---------------------------------------------------------------------------

/**
 * Square root of the raw price at a given tick.
 * sqrt(1.0001 ^ tick) is just 1.0001 ^ (tick / 2), so no decimals are involved.
 */
export function tickToSqrtPrice(tick: number): number {
  return 1.0001 ** (tick / 2);
}

/** Square root of the raw price the pool is at right now. */
export function sqrtPriceX96ToSqrtPrice(sqrtPriceX96: bigint): number {
  return Number(sqrtPriceX96) / 2 ** 96;
}

/** Amounts of token0 and token1, in raw units, for one position. */
export interface TokenAmounts {
  amount0: number;
  amount1: number;
}

/**
 * How much of each token a position of size L holds at the given price.
 *
 * Three cases, and they are the whole story of a Uniswap position:
 *   price below the range  the position is entirely token0 — it has spent all
 *                          its token1 buying token0 on the way down
 *   price above the range  entirely token1 — it has sold all its token0
 *   price inside           a mix, and the split depends on how far through the
 *                          range the price has travelled
 *
 * Note that this is a pure function of the price: we never have to add up
 * individual fills to know what the position holds.
 */
export function getAmountsForLiquidity(
  liquidity: number,
  sqrtPriceLower: number,
  sqrtPriceUpper: number,
  sqrtPriceCurrent: number,
): TokenAmounts {
  if (sqrtPriceCurrent <= sqrtPriceLower) {
    return {
      amount0: liquidity * (1 / sqrtPriceLower - 1 / sqrtPriceUpper),
      amount1: 0,
    };
  }
  if (sqrtPriceCurrent >= sqrtPriceUpper) {
    return {
      amount0: 0,
      amount1: liquidity * (sqrtPriceUpper - sqrtPriceLower),
    };
  }
  return {
    amount0: liquidity * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper),
    amount1: liquidity * (sqrtPriceCurrent - sqrtPriceLower),
  };
}

/**
 * The largest position we can open with the tokens we have.
 *
 * Each token on its own would support some amount of liquidity. The pool takes
 * the smaller of the two, because it needs both in a fixed proportion — so
 * whichever token we are short of decides the size, and the surplus of the
 * other one simply stays in the wallet.
 */
export function getLiquidityForAmounts(
  amount0: number,
  amount1: number,
  sqrtPriceLower: number,
  sqrtPriceUpper: number,
  sqrtPriceCurrent: number,
): number {
  // Liquidity that a given amount of token0 supports over a price span.
  const fromToken0 = (amount: number, sqrtLo: number, sqrtHi: number) =>
    (amount * (sqrtLo * sqrtHi)) / (sqrtHi - sqrtLo);
  // Same for token1.
  const fromToken1 = (amount: number, sqrtLo: number, sqrtHi: number) =>
    amount / (sqrtHi - sqrtLo);

  if (sqrtPriceCurrent <= sqrtPriceLower) {
    return fromToken0(amount0, sqrtPriceLower, sqrtPriceUpper);
  }
  if (sqrtPriceCurrent >= sqrtPriceUpper) {
    return fromToken1(amount1, sqrtPriceLower, sqrtPriceUpper);
  }
  return Math.min(
    fromToken0(amount0, sqrtPriceCurrent, sqrtPriceUpper),
    fromToken1(amount1, sqrtPriceLower, sqrtPriceCurrent),
  );
}
