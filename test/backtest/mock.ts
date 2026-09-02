// Структуры и операции над виртуальной позицией. Ничего не отправляется в сеть.
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  tickToPrice,
  tickToSqrtPrice,
} from '../../src/math.js';

export const DECIMALS_WETH = 18;
export const DECIMALS_USDC = 6;

/** Комиссия пула 0.05%, из которой четверть забирает протокол. */
export const LP_FEE_RATE = 0.0005 * 0.75;

/** Кошелёк. Суммы в минимальных единицах токенов. */
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
  /**
   * Самая выгодная цена пула, до которой он зашёл в наш диапазон.
   *
   * Для аска это максимум: чем выше зашёл, тем дороже мы продали. Для бида —
   * минимум. Отсчитывается в корнях цены и не выходит за границы диапазона:
   * дальше них позиция уже полностью сконвертирована и движение на неё
   * не влияет.
   */
  poolExtreme: number;
}

export function sqrtFromX96(sqrtPriceX96: number): number {
  return sqrtPriceX96 / 2 ** 96;
}

export function priceFromSqrt(sqrtPrice: number): number {
  return sqrtPrice ** 2 * 10 ** (DECIMALS_WETH - DECIMALS_USDC);
}

/** Открывает позицию, забирая из кошелька столько, сколько взял бы пул. */
export function mint(
  wallet: Wallet,
  tickLower: number,
  tickUpper: number,
  sqrtPool: number,
): { position: Position; wallet: Wallet } {
  const sqrtLower = tickToSqrtPrice(tickLower);
  const sqrtUpper = tickToSqrtPrice(tickUpper);

  // token0 = WETH, token1 = USDC для этой пары
  let liquidity = getLiquidityForAmounts(wallet.weth, wallet.usdc, sqrtLower, sqrtUpper, sqrtPool);
  let used = getAmountsForLiquidity(liquidity, sqrtLower, sqrtUpper, sqrtPool);

  // Круговой перевод "суммы -> L -> суммы" идёт через float, и обратный ход
  // может запросить чуть больше, чем есть. Просто обрезать кошелёк нельзя:
  // позиция осталась бы с прежней L, то есть с деньгами из ниоткуда. Вместо
  // этого ужимаем саму L до того, что реально влезает.
  const fit = Math.min(
    used.amount0 > 0 ? wallet.weth / used.amount0 : Infinity,
    used.amount1 > 0 ? wallet.usdc / used.amount1 : Infinity,
  );
  if (Number.isFinite(fit) && fit < 1) {
    liquidity *= fit;
    used = getAmountsForLiquidity(liquidity, sqrtLower, sqrtUpper, sqrtPool);
  }
  if (!Number.isFinite(liquidity) || liquidity < 0) liquidity = 0;

  // Позиция не может стоить больше, чем было в кошельке.
  const price = priceFromSqrt(sqrtPool);
  const before = (wallet.weth / 1e18) * price + wallet.usdc / 1e6;
  const inside = (used.amount0 / 1e18) * price + used.amount1 / 1e6;
  if (inside > before * 1.0001 + 1e-6) {
    console.log(`MINT СОЗДАЛ ДЕНЬГИ: было $${before.toFixed(2)}, в позицию ушло $${inside.toFixed(2)}`);
    console.log(`  тики [${tickLower},${tickUpper}]  sqrt ${sqrtLower} ${sqrtUpper}  pool ${sqrtPool}`);
    console.log(`  кошелёк weth=${wallet.weth.toExponential(3)} usdc=${wallet.usdc.toExponential(3)}`);
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

/** Состав позиции при текущей цене пула. */
export function amounts(position: Position, sqrtPool: number): Wallet {
  const a = getAmountsForLiquidity(position.liquidity, position.sqrtLower, position.sqrtUpper, sqrtPool);
  return { weth: a.amount0, usdc: a.amount1 };
}

/** Закрывает позицию, возвращая токены в кошелёк. Комиссии считаются отдельно. */
export function close(position: Position, wallet: Wallet, sqrtPool: number): Wallet {
  const held = amounts(position, sqrtPool);
  return { weth: wallet.weth + held.weth, usdc: wallet.usdc + held.usdc };
}

/** Начисляет комиссию за чужой своп, если он прошёл через диапазон позиции. */
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

/** Стоимость кошелька и позиции в долларах. */
export function valueUsd(wallet: Wallet, position: Position | undefined, sqrtPool: number): number {
  const held = position ? amounts(position, sqrtPool) : { weth: 0, usdc: 0 };
  const weth = (wallet.weth + held.weth) / 10 ** DECIMALS_WETH;
  const usdc = (wallet.usdc + held.usdc) / 10 ** DECIMALS_USDC;
  return weth * priceFromSqrt(sqrtPool) + usdc;
}
