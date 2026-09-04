// Reads .env once, however many files import this.
process.loadEnvFile();

/* --- No defaults on purpose: a bot quoting the wrong pool loses money quietly. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missed env name: ${name}`);
  return value;
}

// ####### network #######

/* --- anvil locally, a real Arbitrum node in production. */
export const POOL_RPC_URL = requireEnv('POOL_RPC_URL');

/* --- Signs our transactions. Whoever holds it controls the funds. */
export const PRIVATE_KEY = requireEnv('PRIVATE_KEY');



// ####### tokens and pool #######

/* --- Wrapped ether: plain ETH is not an ERC-20, so the pool holds WETH. */
export const WETH_ADDRESS = requireEnv('WETH');

/* --- Native USDC. The bridged USDC.e is a different token. */
export const USDC_ADDRESS = requireEnv('USDC');

/* --- Fee tier in hundredths of a bp: 500 = 0.05%. Each tier is its own pool. */
export const POOL_FEE = Number(requireEnv('POOL_FEE'));



// ####### binance #######

export const BINANCE_SOCKET = requireEnv('BINANCE_SOCKET');
export const BINANCE_SYMBOL = requireEnv('BINANCE_SYMBOL');

/*
--- Best bid and ask on every change. Not the trade stream: we need the price
--- we could trade at now, not the price of a trade that already happened.
*/
export const BINANCE_STREAM = 'bookTicker';

// ####### uniswap addresses #######
// Fixed by the protocol, so not in .env: nothing to choose here, only to
// mistype. Token addresses are configurable because picking them is a decision.

/* --- Knows the address of every pool, so changing POOL_FEE switches pools. */
export const FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

/*
--- The contract we talk to for liquidity. It wraps the pool's awkward
--- low-level interface, tracks what we own and gives an NFT as a receipt.
*/
export const POSITION_MANAGER_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

// ####### runtime #######

/* --- Binance sends ~9 updates a second, more than anyone can read. */
export const LOG_INTERVAL_MS = 1_000;

/*
--- Margin over the node's gas estimate. Unused gas is refunded, so guessing
--- high is cheap; guessing low means the transaction fails and the gas is lost.
*/
export const GAS_LIMIT_MARGIN_PERCENT = 130n;

/*
--- How far behind the head we read swap logs. The public Arbitrum node will
--- not serve the newest blocks: asking for the last 100 returns nothing, while
--- a window a few hundred back returns everything. An archive node needs ~0.
*/
export const SWAP_LOG_LAG_BLOCKS = 600;

/* --- How often the next window of logs is fetched. */
export const SWAP_POLL_MS = 15_000;
