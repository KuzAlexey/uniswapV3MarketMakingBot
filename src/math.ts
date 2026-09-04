// Pure tick and liquidity maths. No network, no config - safe to import anywhere.

// ####### price #######
// Uniswap keeps the price in two forms. A tick is a whole number with
// price = 1.0001^tick, so one tick is 0.01%; ranges are set in ticks, never in
// dollars. sqrtPriceX96 is the square root of the price times 2^96, which is
// how a chain with no fractions keeps precision. Both count in the tokens'
// smallest units, so the decimals have to be corrected for.

/* --- Human price to a tick. The result is fractional. */
export function priceToTick(price: number, decimals0: number, decimals1: number): number {
  return Math.log(price / 10 ** (decimals0 - decimals1)) / Math.log(1.0001);
}

/* --- And back. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}

/*
--- Rounds a tick down onto the grid. Math.floor, not Math.trunc: our ticks are
--- negative, and trunc rounds towards zero, giving a boundary the pool rejects.
*/
export function floorToSpacing(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

/* --- Mirror of floorToSpacing, for an upper edge. */
export function ceilToSpacing(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

/* --- Human price of the pool, from its stored square root. */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  return sqrtPrice ** 2 * 10 ** (decimals0 - decimals1);
}

// ####### liquidity #######
// A position is one number L plus two ticks. How many tokens that L means
// depends on where the price sits, which is why the same position holds
// different amounts over time while L never changes.
//
// Everything here is in the pool's raw units. bigint becomes number for the
// arithmetic: the last digits suffer, which is harmless for measurement but
// not acceptable for building a real transaction.

/* --- sqrt(1.0001^tick) is 1.0001^(tick/2), so no decimals are involved. */
export function tickToSqrtPrice(tick: number): number {
  return 1.0001 ** (tick / 2);
}

/* --- Square root of the raw price the pool is at now. */
export function sqrtPriceX96ToSqrtPrice(sqrtPriceX96: bigint): number {
  return Number(sqrtPriceX96) / 2 ** 96;
}

/* --- Both tokens of one position, in raw units. */
export interface TokenAmounts {
  amount0: number;
  amount1: number;
}

/*
--- What a position of size L holds at the given price.
--- Below the range it is all token0, having bought on the way down; above it,
--- all token1, having sold on the way up; inside, a mix. A pure function of
--- the price, so fills never have to be added up.
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

/*
--- The largest position the tokens allow. The pool needs both in a fixed
--- proportion, so whichever one we are short of decides the size and the
--- surplus of the other stays in the wallet.
*/
export function getLiquidityForAmounts(
  amount0: number,
  amount1: number,
  sqrtPriceLower: number,
  sqrtPriceUpper: number,
  sqrtPriceCurrent: number,
): number {
  const fromToken0 = (amount: number, sqrtLo: number, sqrtHi: number) =>
    (amount * (sqrtLo * sqrtHi)) / (sqrtHi - sqrtLo);
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
