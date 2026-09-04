import { findPool, openFeed, readPool, type PoolState, type Quote } from './api.js';
import { LOG_INTERVAL_MS, POOL_FEE } from './env.js';

/* --- Top of the Binance book. */
function logBinance(quote: Quote): void {
  console.log(
    `Binance  bid=${quote.bid.toFixed(2)}  ask=${quote.ask.toFixed(2)}  ` +
    `spread=${quote.spreadBps.toFixed(3)}bps  mid=${quote.mid.toFixed(2)}`
  );
}

/* --- Current state of the pool. */
function logPool(state: PoolState): void {
  console.log(
    `Pool     price=${state.price.toFixed(2)}  tick=${state.tick}  ` +
    `liquidity=${state.liquidity}  fee=${POOL_FEE / 10_000}%`
  );
}

async function main(): Promise<void> {
  const poolAddress = await findPool();
  console.log(`pool ${poolAddress}\n`);

  // Reading the pool costs a round trip while Binance sends several updates a
  // second, so ticks arriving too soon or during a pending read are skipped.
  let busy = false;
  let lastLoggedAt = 0;

  const closeFeed = openFeed((quote) => {
    if (busy || Date.now() - lastLoggedAt < LOG_INTERVAL_MS) return;
    busy = true;
    lastLoggedAt = Date.now();

    readPool(poolAddress)
      .then((state) => {
        logBinance(quote);
        logPool(state);
        console.log('─'.repeat(78));
      })
      .catch((err) => console.error(`pool error: ${err.shortMessage ?? err}`))
      .finally(() => { busy = false; });
  });

  process.on('SIGINT', () => {
    closeFeed();
    process.exit(0);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
