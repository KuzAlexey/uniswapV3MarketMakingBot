process.loadEnvFile();

/* --- No defaults: a bot quoting the wrong pool loses money quietly. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missed env name: ${name}`);
  return value;
}

// ####### network #######

export const POOL_RPC_URL = requireEnv('POOL_RPC_URL');
export const PRIVATE_KEY = requireEnv('PRIVATE_KEY');

// ####### tokens and pool #######

export const WETH_ADDRESS = requireEnv('WETH');

/* --- Native USDC. The bridged USDC.e is a different token. */
export const USDC_ADDRESS = requireEnv('USDC');

/* --- Hundredths of a bp: 500 = 0.05%. Each tier is its own pool. */
export const POOL_FEE = Number(requireEnv('POOL_FEE'));

// ####### binance #######

export const BINANCE_SOCKET = requireEnv('BINANCE_SOCKET');
export const BINANCE_SYMBOL = requireEnv('BINANCE_SYMBOL');

/* --- Not the trade stream: we need the price we could trade at now. */
export const BINANCE_STREAM = 'bookTicker';

// ####### uniswap addresses #######

export const FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
export const POSITION_MANAGER_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

// ####### runtime #######

export const LOG_INTERVAL_MS = 1_000;

/* --- Unused gas is refunded (it it upper bound) */
export const GAS_LIMIT_MARGIN_PERCENT = 130n;

/*
--- The public Arbitrum node will not serve logs for the newest blocks.
*/
export const SWAP_LOG_LAG_BLOCKS = 600;

export const SWAP_POLL_MS = 15_000;
