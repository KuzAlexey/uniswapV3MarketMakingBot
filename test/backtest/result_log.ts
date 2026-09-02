// Technical file for logs
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

/*
--- Prints the run summary.
*/
export function logSummary(stats: Stats, finalWallet: Wallet, startSqrt: number, endSqrt: number): void {
  const gas = stats.burns * GAS_BURN + stats.mints * GAS_MINT;
  const t = stats.byTrigger;
  const redeploys = t.midMoved + t.poolRetraced + t.noPosition;
  const share = (v: number) => `${((v / (redeploys || 1)) * 100).toFixed(0)}%`;

  console.log(`params          spread ${SPREAD_TICKS}, width ${RANGE_TICKS}, pull ${PULL_FRACTION}`);
  console.log('');
  const filled = stats.fillsInward + stats.fillsBack;
  const part = (v: number) => `${((v / (filled || 1)) * 100).toFixed(0)}%`;
  console.log(`swaps           ${stats.swapsSeen.toLocaleString()}, touched our quotes ${stats.swapsFilled.toLocaleString()}`);
  console.log(`  inward        ${stats.fillsInward.toLocaleString().padStart(6)}  ${part(stats.fillsInward)}   sold dearer / bought cheaper`);
  console.log(`  back          ${stats.fillsBack.toLocaleString().padStart(6)}  ${part(stats.fillsBack)}   bought back what we sold, same prices`);
  console.log(`fees            $${stats.feesTotalUsd.toFixed(2)}`);
  console.log(`gas             $${gas.toFixed(2)}   (${stats.burns.toLocaleString()} burns + ${stats.mints.toLocaleString()} mints)`);
  console.log('');
  console.log(`redeploys       ${redeploys.toLocaleString()}`);
  console.log(`  Binance moved     ${t.midMoved.toLocaleString().padStart(6)}  ${share(t.midMoved)}`);
  console.log(`  pool retraced     ${t.poolRetraced.toLocaleString().padStart(6)}  ${share(t.poolRetraced)}`);
  console.log(`  no quotes up      ${t.noPosition.toLocaleString().padStart(6)}  ${share(t.noPosition)}`);

  const startPrice = priceFromSqrt(startSqrt);
  const endPrice = priceFromSqrt(endSqrt);
  const start: Wallet = { weth: START_WETH, usdc: START_USDC };
  console.log('');
  console.log(`wallet before   ${tokens(start)}  =  $${valueUsd(start, startPrice).toFixed(2)}  at $${startPrice.toFixed(2)}`);
  console.log(`wallet after    ${tokens(finalWallet)}  =  $${valueUsd(finalWallet, endPrice).toFixed(2)}  at $${endPrice.toFixed(2)}`);
}
