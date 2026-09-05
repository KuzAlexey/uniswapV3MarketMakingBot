// price = 1.0001^tick, so one tick is 0.01%. 

// sqrtPriceX96 is the square root
// of that price times 2^96. Both count in the tokens' smallest units, hence
// the decimals correction.

export function priceToTick(price: number, decimals0: number, decimals1: number): number {
  return Math.log(price / 10 ** (decimals0 - decimals1)) / Math.log(1.0001);
}

export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}

/* --- floor, not trunc: our ticks are negative and trunc rounds upwards. */
export function floorToSpacing(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

export function ceilToSpacing(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  return sqrtPrice ** 2 * 10 ** (decimals0 - decimals1);
}



// ####### liquidity #######
// A position is one number L plus two ticks; how many tokens that means
// depends on the price, which is why the same position holds different
// amounts over time while L never changes.

export function tickToSqrtPrice(tick: number): number {
  return 1.0001 ** (tick / 2);
}

export function sqrtPriceX96ToSqrtPrice(sqrtPriceX96: bigint): number {
  return Number(sqrtPriceX96) / 2 ** 96;
}

export interface TokenAmounts {
  amount0: number;
  amount1: number;
}

/* --- A pure function of the price, so fills never have to be added up. */
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
