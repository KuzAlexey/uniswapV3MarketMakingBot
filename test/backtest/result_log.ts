// Итог прогона.
import { DECIMALS_USDC, DECIMALS_WETH, priceFromSqrt, type Wallet } from './mock.js';
import {
  GAS_BURN,
  GAS_MINT,
  PULL_FRACTION,
  RANGE_TICKS,
  SPREAD_TICKS,
  START_USDC,
  START_WETH,
  type Stats,
} from './params.js';

const tokens = (w: Wallet) =>
  `${(w.weth / 10 ** DECIMALS_WETH).toFixed(4)} WETH + ${(w.usdc / 10 ** DECIMALS_USDC).toFixed(2)} USDC`;

const valueUsd = (w: Wallet, price: number) =>
  (w.weth / 10 ** DECIMALS_WETH) * price + w.usdc / 10 ** DECIMALS_USDC;

/**
 * @param finalWallet кошелёк после закрытия всех позиций
 * @param startSqrt   корень цены пула на первом свопе
 * @param endSqrt     корень цены пула на последнем
 */
export function logSummary(stats: Stats, finalWallet: Wallet, startSqrt: number, endSqrt: number): void {
  const gas = stats.burns * GAS_BURN + stats.mints * GAS_MINT;
  const t = stats.byTrigger;
  const redeploys = t.midMoved + t.poolRetraced + t.noPosition;
  const share = (v: number) => `${((v / (redeploys || 1)) * 100).toFixed(0)}%`;

  console.log(`параметры       spread ${SPREAD_TICKS}, ширина ${RANGE_TICKS}, порог ${PULL_FRACTION}`);
  console.log('');
  const filled = stats.fillsInward + stats.fillsBack;
  const part = (v: number) => `${((v / (filled || 1)) * 100).toFixed(0)}%`;
  console.log(`свопов          ${stats.swapsSeen.toLocaleString()}, задели наши котировки ${stats.swapsFilled.toLocaleString()}`);
  console.log(`  вглубь        ${stats.fillsInward.toLocaleString().padStart(6)}  ${part(stats.fillsInward)}   продаём дороже / покупаем дешевле`);
  console.log(`  обратно       ${stats.fillsBack.toLocaleString().padStart(6)}  ${part(stats.fillsBack)}   откупаем проданное по тем же ценам`);
  console.log(`комиссии        $${stats.feesTotalUsd.toFixed(2)}`);
  console.log(`газ             $${gas.toFixed(2)}   (${stats.burns.toLocaleString()} снятий + ${stats.mints.toLocaleString()} выставлений)`);
  console.log('');
  console.log(`перевыставлений ${redeploys.toLocaleString()}`);
  console.log(`  ушла цена Binance   ${t.midMoved.toLocaleString().padStart(6)}  ${share(t.midMoved)}`);
  console.log(`  откат цены пула     ${t.poolRetraced.toLocaleString().padStart(6)}  ${share(t.poolRetraced)}`);
  console.log(`  не было котировок   ${t.noPosition.toLocaleString().padStart(6)}  ${share(t.noPosition)}`);

  const startPrice = priceFromSqrt(startSqrt);
  const endPrice = priceFromSqrt(endSqrt);
  const start: Wallet = { weth: START_WETH, usdc: START_USDC };
  console.log('');
  console.log(`кошелёк до      ${tokens(start)}  =  $${valueUsd(start, startPrice).toFixed(2)}  при $${startPrice.toFixed(2)}`);
  console.log(`кошелёк после   ${tokens(finalWallet)}  =  $${valueUsd(finalWallet, endPrice).toFixed(2)}  при $${endPrice.toFixed(2)}`);
}
