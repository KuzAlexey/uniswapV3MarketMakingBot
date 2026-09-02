// Loads variables from the .env file into process.env.
// Doing it here means it happens exactly once, no matter how many
// files import this module.
process.loadEnvFile();

/**
 * Reads a variable from .env and refuses to continue if it is missing.
 * We deliberately do NOT provide default values: a bot that silently
 * runs with the wrong pool or the wrong symbol loses money quietly.
 * Better to crash on startup with a clear message.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missed env name: ${name}`);
  return value;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * Where we send blockchain requests.
 * Locally this points at anvil (a copy of Arbitrum running on your machine),
 * in production it would point at a real Arbitrum node.
 */
export const POOL_RPC_URL = requireEnv('POOL_RPC_URL');

/** The key that signs our transactions. Whoever holds it controls the funds. */
export const PRIVATE_KEY = requireEnv('PRIVATE_KEY');

// ---------------------------------------------------------------------------
// Tokens and pool
// ---------------------------------------------------------------------------

/**
 * WETH = "Wrapped Ether". Plain ETH is the network's own currency and does not
 * follow the ERC-20 token standard, so Uniswap cannot handle it directly.
 * WETH is a contract that swaps ETH for an ERC-20 token 1:1, forever.
 * The pool holds WETH, never ETH.
 */
export const WETH_ADDRESS = requireEnv('WETH');

/** USDC on Arbitrum. Note: the bridged version (USDC.e) is a DIFFERENT token. */
export const USDC_ADDRESS = requireEnv('USDC');

/**
 * Which fee tier of the ETH/USDC pool we trade in.
 * Stored as hundredths of a basis point: 500 means 0.05%.
 * The same token pair has several pools, one per fee tier, and they are
 * completely separate contracts with their own price and liquidity.
 */
export const POOL_FEE = Number(requireEnv('POOL_FEE'));

// ---------------------------------------------------------------------------
// Binance
// ---------------------------------------------------------------------------

/** Base WebSocket URL. This mirror serves market data only — no API key needed. */
export const BINANCE_SOCKET = requireEnv('BINANCE_SOCKET');

/** Trading pair in Binance notation, e.g. "ethusdc". */
export const BINANCE_SYMBOL = requireEnv('BINANCE_SYMBOL');

/**
 * Which Binance stream we subscribe to.
 * "bookTicker" pushes the best buy and best sell price on every change.
 * We use it instead of the "trade" stream because we need the price we could
 * trade at right now, not the price of a trade that already happened.
 */
export const BINANCE_STREAM = 'bookTicker';

// ---------------------------------------------------------------------------
// Uniswap contract addresses
//
// These are NOT in .env on purpose. They are fixed by the protocol: there is
// nothing to configure, you can only type them in wrong. Token addresses live
// in .env because choosing them is a real decision (which market to trade).
// ---------------------------------------------------------------------------

/**
 * The Factory knows the address of every pool.
 * We ask it for the pool instead of hardcoding an address, so that changing
 * POOL_FEE in .env automatically switches us to a different pool.
 */
export const FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

/**
 * The NonfungiblePositionManager ("position manager") is the contract we
 * actually talk to when we add or remove liquidity.
 *
 * The pool itself has a low-level interface that is awkward to call directly.
 * The position manager wraps it: it moves our tokens, tracks what we own,
 * keeps count of the fees we earned, and gives us an NFT as a receipt.
 */
export const POSITION_MANAGER_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

// ---------------------------------------------------------------------------
// Strategy parameters
//
// These decide how the bot behaves. They are the numbers the backtest will
// tune, so keep them together and easy to find.
// ---------------------------------------------------------------------------

/**
 * Width of the price range we place, measured in ticks.
 * A tick is the smallest price step Uniswap knows: one tick = 0.01%.
 * Narrower range = larger share of the trading fees, but the price leaves it
 * sooner and we have to redeploy more often.
 */
export const RANGE_TICKS = 10;

/** How much WETH we are willing to put into one position (in wei). */
export const AMOUNT_WETH = 50_000_000_000_000_000n; // 0.05 WETH

/** How much USDC we are willing to put in (USDC has 6 decimals, so 50e6 = $50). */
export const AMOUNT_USDC = 50_000_000n; // 50 USDC

/** How often the main loop runs, in milliseconds. */
export const POLL_MS = 3_000;

/**
 * Minimum gap between printed blocks, in milliseconds.
 * Binance sends about nine updates per second, which is far more than a human
 * can read and far more often than the pool state actually changes.
 */
export const LOG_INTERVAL_MS = 1_000;

/**
 * If the newest Binance price is older than this, we do not trade.
 * A frozen price feed is worse than no feed: we would keep quoting at a price
 * the market has already left, and arbitrage traders would take our money.
 */
export const MAX_QUOTE_AGE_MS = 5_000;

/**
 * Gas is paid per unit of computation. We ask the node to estimate how much a
 * transaction needs, then add this safety margin, because the chain state can
 * change between the estimate and the actual execution.
 * Unused gas is refunded, so overestimating is cheap; underestimating means
 * the transaction fails and the gas is lost.
 */
export const GAS_LIMIT_MARGIN_PERCENT = 130n;

// ---------------------------------------------------------------------------
// Shadow mode
//
// Shadow mode runs the strategy without touching the blockchain: the position
// lives in memory only. It reads the real Arbitrum pool and the real Binance
// feed, listens to other people's swaps, and works out how much we would have
// earned. No private key, no gas, no fork — and therefore nothing to lose.
// ---------------------------------------------------------------------------

/** Starting virtual inventory, in wei (1 WETH = 10^18 wei). */
export const SHADOW_START_WETH = 1_000_000_000_000_000_000n; // 1 WETH

/** Starting virtual inventory, in USDC units (1 USDC = 10^6). */
export const SHADOW_START_USDC = 2_500_000_000n; // 2500 USDC

/**
 * Width of the virtual range, in ticks.
 * Must be an even multiple of tickSpacing so that a range centred on a grid
 * point has both edges on the grid too. Keeping it constant matters: the width
 * drives our liquidity, and through it both the fee income and the arbitrage
 * loss. A width that wobbles makes runs impossible to compare.
 */
export const SHADOW_RANGE_TICKS = 20;

/** How often the virtual position is torn down and placed again. */
export const SHADOW_REBALANCE_MS = 60_000;

/**
 * Share of the swap fee that reaches liquidity providers.
 * Uniswap governance switched a protocol fee on for this pool: slot0 reports
 * feeProtocol = 68 = 0x44, meaning a quarter of every fee goes to the protocol.
 * So out of the 0.05% a trader pays we actually receive 0.0375%.
 */
export const LP_FEE_SHARE = 0.75;

/**
 * What one full redeploy (close + reopen) would cost in gas, in dollars.
 * Measured on Arbitrum at ~0.02 gwei. We never spend it in shadow mode, but we
 * subtract it so the result is comparable with real trading.
 */
export const GAS_COST_PER_CYCLE_USD = 0.042;

/**
 * How far behind the chain head we read swap logs, in blocks.
 *
 * The public Arbitrum node does not serve logs for the newest blocks reliably:
 * asking for the last 100 blocks returns nothing, while a window ending a few
 * hundred blocks back returns everything. So we deliberately stay behind, and
 * accept that fees are credited a couple of minutes late. An archive node
 * (Alchemy, Infura) does not need this and the value can drop to a few blocks.
 */
export const SWAP_LOG_LAG_BLOCKS = 600;

/** How often we fetch the next window of swap logs. */
export const SWAP_POLL_MS = 15_000;
