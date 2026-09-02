import { ethers } from 'ethers';
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  sqrtPriceX96ToPrice,
  tickToSqrtPrice,
} from './math.js';

export * from './math.js';
import WebSocket from 'ws';
import {
  BINANCE_SOCKET,
  BINANCE_STREAM,
  BINANCE_SYMBOL,
  FACTORY_ADDRESS,
  GAS_LIMIT_MARGIN_PERCENT,
  POOL_FEE,
  POOL_RPC_URL,
  POSITION_MANAGER_ADDRESS,
  SWAP_LOG_LAG_BLOCKS,
  SWAP_POLL_MS,
  PRIVATE_KEY,
  USDC_ADDRESS,
  WETH_ADDRESS,
} from './env.js';

// ---------------------------------------------------------------------------
// ABIs
//
// An ABI ("application binary interface") is the list of functions a contract
// has. Without it the library does not know how to encode our call into bytes.
// We only list the functions we actually use — the real ABIs are much longer.
// ---------------------------------------------------------------------------

const FACTORY_ABI = [
  // Returns the address of the pool for a token pair and a fee tier.
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

const POOL_ABI = [
  // slot0 is the pool's "current state" struct. The two fields we care about
  // are the current price (as a square root, see below) and the current tick.
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16,uint16,uint16,uint8,bool)',
  // Total liquidity of everyone whose price range covers the current price.
  'function liquidity() view returns (uint128)',
  // Range boundaries must be multiples of this number.
  'function tickSpacing() view returns (int24)',
  // The two tokens, ordered by their address (not by our preference).
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const ERC20_ABI = [
  // How many decimal places the token uses. WETH: 18, USDC: 6.
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  // Permission for another contract to move our tokens. Without it the
  // position manager cannot take our WETH and USDC.
  'function approve(address spender, uint256 amount) returns (bool)',
];

const POSITION_MANAGER_ABI = [
  // Opens a new position. Returns an NFT id that represents it.
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  // Reduces a position. Careful: this does NOT send tokens back, it only
  // updates the bookkeeping. collect() is what actually pays us.
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256,uint256)',
  // Sends us the tokens freed by decreaseLiquidity, plus any fees we earned.
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256,uint256)',
  // Destroys the empty NFT. Only works once liquidity and owed fees are zero.
  'function burn(uint256 tokenId) payable',
  // Runs several of the calls above inside ONE transaction, all or nothing.
  'function multicall(bytes[] data) payable returns (bytes[])',
  // Everything the contract knows about one position.
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)',
];

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** The provider is our connection to the blockchain. It can only read. */
export const provider = new ethers.JsonRpcProvider(POOL_RPC_URL);

/** The wallet holds our private key and can sign transactions (write). */
export const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/**
 * Every transaction carries a sequence number ("nonce") so the network can
 * order them. ethers normally asks the node for the next nonce, but it caches
 * that answer for a fraction of a second. On a fast chain two transactions
 * sent back to back would then reuse the same nonce and the second one fails.
 * NonceManager keeps the counter locally and avoids that.
 */
export const signer = new ethers.NonceManager(wallet);

const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider) as any;
const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, signer) as any;
const positionManagerInterface = new ethers.Interface(POSITION_MANAGER_ABI);

/** The largest number that fits in 128 bits. Used as "collect everything". */
const MAX_UINT128 = (1n << 128n) - 1n;

// ---------------------------------------------------------------------------
// Reading the pool
// ---------------------------------------------------------------------------

/** Everything we need to know about the pool at one moment in time. */
export interface PoolState {
  address: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tickSpacing: number;
  /** Current pool price in USDC per ETH, already converted for humans. */
  price: number;
  /**
   * True when WETH is token0.
   *
   * Uniswap sorts the two tokens by their address, so which one is "first" is
   * not our choice. For WETH/USDC on Arbitrum WETH wins, but on another pair
   * it could be the other way round — never hardcode this.
   */
  wethIsToken0: boolean;
  /** Decimals of each token, already resolved by name so callers need not care. */
  decimalsWeth: number;
  decimalsUsdc: number;
}

/**
 * Asks the factory which pool holds our pair at our fee tier.
 * A zero address means no such pool exists.
 */
export async function findPool(): Promise<string> {
  const address: string = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, POOL_FEE);
  if (address === ethers.ZeroAddress) throw new Error(`no pool for fee tier ${POOL_FEE}`);
  return address;
}

/**
 * Reads the pool's current state.
 * Requests are sent in parallel so one round trip covers all of them.
 */
export async function readPool(address: string): Promise<PoolState> {
  const pool = new ethers.Contract(address, POOL_ABI, provider) as any;

  const [slot0, liquidity, tickSpacing, token0, token1] = await Promise.all([
    pool.slot0(), pool.liquidity(), pool.tickSpacing(), pool.token0(), pool.token1(),
  ]);

  // Decimals never change, so we ask the tokens only once.
  const [decimals0, decimals1] = await readDecimals(token0, token1);

  const d0 = Number(decimals0);
  const d1 = Number(decimals1);
  const rawPrice = sqrtPriceX96ToPrice(slot0.sqrtPriceX96, d0, d1);
  const wethIsToken0 = token0.toLowerCase() === WETH_ADDRESS.toLowerCase();

  return {
    address,
    token0,
    token1,
    decimals0: d0,
    decimals1: d1,
    sqrtPriceX96: slot0.sqrtPriceX96,
    tick: Number(slot0.tick),
    liquidity,
    tickSpacing: Number(tickSpacing),
    // The formula always yields "token1 per token0". If WETH happens to be
    // token1 we have to flip it to get USDC per ETH.
    price: wethIsToken0 ? rawPrice : 1 / rawPrice,
    wethIsToken0,
    decimalsWeth: wethIsToken0 ? d0 : d1,
    decimalsUsdc: wethIsToken0 ? d1 : d0,
  };
}

const decimalsCache = new Map<string, number>();

/** Reads (and remembers) how many decimal places each token uses. */
async function readDecimals(token0: string, token1: string): Promise<[number, number]> {
  for (const address of [token0, token1]) {
    if (decimalsCache.has(address)) continue;
    const token = new ethers.Contract(address, ERC20_ABI, provider) as any;
    decimalsCache.set(address, Number(await token.decimals()));
  }
  return [decimalsCache.get(token0)!, decimalsCache.get(token1)!];
}

/** How many of a token we hold. The result is in the token's smallest units. */
export async function getBalance(tokenAddress: string): Promise<bigint> {
  return (new ethers.Contract(tokenAddress, ERC20_ABI, provider) as any).balanceOf(wallet.address);
}

// ---------------------------------------------------------------------------
// Managing positions
// ---------------------------------------------------------------------------

/**
 * Lets the position manager move our tokens.
 * Required once before the first mint: contracts cannot take your tokens
 * without permission. We approve an unlimited amount so we only pay for this
 * transaction once instead of before every position.
 */
export async function approveTokens(): Promise<void> {
  for (const tokenAddress of [WETH_ADDRESS, USDC_ADDRESS]) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer) as any;
    await (await token.approve(POSITION_MANAGER_ADDRESS, ethers.MaxUint256)).wait();
  }
}

export interface MintResult {
  tokenId: bigint;
  gasUsed: bigint;
  /**
   * How much the pool actually took from us, in each token's smallest units
   * (WETH counts in wei, USDC in millionths).
   *
   * This is usually LESS than what we offered. The pool works out the exact
   * proportion it needs from where the price sits inside our range and takes
   * only that; whichever token runs out first caps the size of the position.
   *
   * Named by token rather than by "0" and "1" on purpose: the numeric order
   * depends on addresses and is easy to mix up.
   */
  spentWeth: bigint;
  spentUsdc: bigint;
}

/**
 * Opens a new liquidity position between two ticks.
 *
 * @param state
 *   A snapshot of the pool taken with readPool(). We need it for the token
 *   addresses, for their decimals, and to know which token the pool calls
 *   "first" — that order is decided by address and we must follow it.
 *
 * @param tickLower
 *   Lower edge of our price range, as a tick (price = 1.0001 ^ tick).
 *   Must be a multiple of state.tickSpacing or the transaction reverts;
 *   use floorToSpacing() to snap a computed tick onto the grid.
 *   Below this price our position is fully converted into WETH.
 *
 * @param tickUpper
 *   Upper edge, same rules, and strictly greater than tickLower.
 *   Above this price the position is fully converted into USDC.
 *   The distance between the two ticks is the width of the range: narrower
 *   means a bigger share of the trading fees but the price leaves it sooner.
 *
 * @param amountWethDesired
 *   The most WETH we are willing to put in, in wei (1 WETH = 10^18 wei).
 *   A ceiling, not an exact amount — see the note below.
 *
 * @param amountUsdcDesired
 *   The most USDC we are willing to put in, in millionths (1 USDC = 10^6).
 *
 * The two amounts are a ceiling because the pool decides the proportion, not
 * us. It works out what it needs from where the current price sits inside our
 * range, takes only that, and leaves the rest in the wallet. Whichever token
 * runs out first caps the size of the position. If the range lies entirely
 * above the current price only WETH is taken; entirely below, only USDC.
 */
export async function mintPosition(
  state: PoolState,
  tickLower: number,
  tickUpper: number,
  amountWethDesired: bigint,
  amountUsdcDesired: bigint,
): Promise<MintResult> {
  // Translate our token names into the pool's own 0/1 order.
  const amount0Desired = state.wethIsToken0 ? amountWethDesired : amountUsdcDesired;
  const amount1Desired = state.wethIsToken0 ? amountUsdcDesired : amountWethDesired;

  const params = [
    state.token0,
    state.token1,
    POOL_FEE,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    // Minimum we accept. Zero disables the protection, which is fine on a
    // local fork but must be set on a real network: the price can move
    // between our decision and the transaction being executed.
    0n,
    0n,
    wallet.address,
    // The transaction is rejected after this timestamp. Protects us from a
    // transaction that hangs and executes much later at a different price.
    Math.floor(Date.now() / 1000) + 600,
  ];

  // A "static call" runs the transaction on the node without sending it.
  // If something is wrong we learn the reason here, before spending gas.
  await positionManager.mint.staticCall(params, { from: wallet.address });

  const estimated = await positionManager.mint.estimateGas(params);
  const gasLimit = (estimated * GAS_LIMIT_MARGIN_PERCENT) / 100n;

  const before0 = await getBalance(state.token0);
  const before1 = await getBalance(state.token1);

  const receipt = await (await positionManager.mint(params, { gasLimit })).wait();

  const spent0 = before0 - (await getBalance(state.token0));
  const spent1 = before1 - (await getBalance(state.token1));

  return {
    tokenId: extractTokenId(receipt),
    gasUsed: receipt.gasUsed,
    spentWeth: state.wethIsToken0 ? spent0 : spent1,
    spentUsdc: state.wethIsToken0 ? spent1 : spent0,
  };
}

export interface BurnResult {
  gasUsed: bigint;
  /**
   * How much came back to the wallet, trading fees included.
   * The split between the two tokens depends on where the price ended up:
   * above our range everything comes back as USDC, below it as WETH.
   */
  receivedWeth: bigint;
  receivedUsdc: bigint;
}

/**
 * Closes a position completely and destroys its NFT.
 *
 * Three separate calls are needed and the order matters:
 *   decreaseLiquidity  converts our liquidity into "owed tokens" — nothing
 *                      reaches the wallet yet, which surprises everyone once
 *   collect            actually sends those tokens plus the earned fees
 *   burn               deletes the now-empty NFT
 *
 * We send them through multicall so they land in one transaction. That is
 * cheaper, and more importantly it is atomic: we can never end up half closed.
 */
export async function closePosition(tokenId: bigint, state: PoolState): Promise<BurnResult> {
  const position = await positionManager.positions(tokenId);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const calls = [
    positionManagerInterface.encodeFunctionData('decreaseLiquidity', [
      [tokenId, position.liquidity, 0n, 0n, deadline],
    ]),
    positionManagerInterface.encodeFunctionData('collect', [
      [tokenId, wallet.address, MAX_UINT128, MAX_UINT128],
    ]),
    positionManagerInterface.encodeFunctionData('burn', [tokenId]),
  ];

  const before0 = await getBalance(state.token0);
  const before1 = await getBalance(state.token1);

  const receipt = await (await positionManager.multicall(calls)).wait();

  const received0 = (await getBalance(state.token0)) - before0;
  const received1 = (await getBalance(state.token1)) - before1;

  return {
    gasUsed: receipt.gasUsed,
    receivedWeth: state.wethIsToken0 ? received0 : received1,
    receivedUsdc: state.wethIsToken0 ? received1 : received0,
  };
}

/** How much liquidity a position still has. Zero means it is empty. */
export async function getPositionLiquidity(tokenId: bigint): Promise<bigint> {
  return (await positionManager.positions(tokenId)).liquidity;
}

/**
 * Digs the new NFT id out of the transaction receipt.
 *
 * A receipt contains "logs" — events the contracts emitted. Creating an NFT
 * emits Transfer(from = zero address, to = us, tokenId). We look for that one.
 */
function extractTokenId(receipt: ethers.TransactionReceipt): bigint {
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  for (const entry of receipt.logs) {
    if (entry.address.toLowerCase() !== POSITION_MANAGER_ADDRESS.toLowerCase()) continue;
    if (entry.topics[0] !== transferTopic) continue;
    if (BigInt(entry.topics[1]!) !== 0n) continue; // minted, not transferred
    return BigInt(entry.topics[3]!);
  }
  throw new Error('tokenId not found in receipt');
}

/**
 * Turns a confusing low-level error into something readable.
 * The public Arbitrum node is not an "archive" node: it deletes the state of
 * older blocks. A fork left running for an hour starts asking for state that
 * no longer exists, and every call fails with a meaningless message.
 */
export function explainError(err: unknown): string {
  const text = JSON.stringify(err instanceof Error ? err.message : err);
  if (text.includes('missing trie node') || text.includes('missing revert data')) {
    return 'fork is stale — the public node dropped that state. Restart anvil (npm run fork) or use an archive node';
  }
  return (err as any)?.shortMessage ?? String(err);
}

// ---------------------------------------------------------------------------
// Binance price feed
// ---------------------------------------------------------------------------

/** Raw shape of a bookTicker message. Binance sends all numbers as strings. */
interface BookTickerMessage {
  u: number; // update id, always increasing
  s: string; // symbol, e.g. ETHUSDC
  b: string; // best bid price
  B: string; // amount available at the bid
  a: string; // best ask price
  A: string; // amount available at the ask
}

/** One snapshot of the top of Binance's order book. */
export interface Quote {
  symbol: string;
  /** Highest price someone is willing to pay for ETH right now. */
  bid: number;
  /** Lowest price someone is willing to sell ETH for right now. */
  ask: number;
  bidSize: number;
  askSize: number;
  /** Middle of bid and ask. The fairest single estimate of the price. */
  mid: number;
  /** Distance between bid and ask, in basis points (1 bp = 0.01%). */
  spreadBps: number;
  updateId: number;
  receivedAt: number;
}

/**
 * Subscribes to Binance and calls back on every change of the best prices.
 *
 * We use the "bookTicker" stream rather than the trade stream because we need
 * the price we could trade at right now, not the price of a trade that has
 * already happened.
 */
export function openFeed(onQuote: (quote: Quote) => void): () => void {
  const url = `${BINANCE_SOCKET}${BINANCE_SYMBOL}@${BINANCE_STREAM}`;
  const socket = new WebSocket(url);
  let lastUpdateId = -1;

  socket.on('open', () => console.log(`connected to ${url}`));
  socket.on('error', (err) => console.error(`feed error: ${err.message}`));
  socket.on('close', (code) => console.log(`feed closed: ${code}`));

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as BookTickerMessage;

    const bid = Number(message.b);
    const ask = Number(message.a);
    // Sanity checks: a broken frame must not crash the bot.
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return;
    // Messages can arrive out of order; ignore anything older than what we have.
    if (message.u <= lastUpdateId) return;
    lastUpdateId = message.u;

    const mid = (bid + ask) / 2;
    onQuote({
      symbol: message.s,
      bid,
      ask,
      bidSize: Number(message.B),
      askSize: Number(message.A),
      mid,
      spreadBps: ((ask - bid) / mid) * 10_000,
      updateId: message.u,
      receivedAt: Date.now(),
    });
  });

  return () => socket.close();
}

// ---------------------------------------------------------------------------
// Watching other people's swaps
// ---------------------------------------------------------------------------

/** One trade someone else made against the pool. */
export interface SwapEvent {
  /** Signed: positive means the token went into the pool, negative means out. */
  amount0: bigint;
  amount1: bigint;
  /** Price AFTER the swap, as the pool stores it. */
  sqrtPriceX96: bigint;
  /** Active liquidity AFTER the swap — everyone whose range covers the price. */
  liquidity: bigint;
  /** Tick AFTER the swap. */
  tick: number;
  blockNumber: number;
  /** Position of the event inside its block. Together with the block it is unique. */
  logIndex: number;
}

const POOL_SWAP_ABI = [
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
];

/**
 * Calls back on every swap made against the pool by anyone.
 *
 * This is what makes shadow mode meaningful: we see the real order flow and can
 * tell whether a trade would have gone through our imaginary range. The
 * `liquidity` field even tells us how much competing liquidity was present, so
 * we can work out our share of the fee without reconstructing the whole book.
 *
 * Returns a function that stops the subscription.
 */
export function watchSwaps(poolAddress: string, onSwap: (swap: SwapEvent) => void): () => void {
  const iface = new ethers.Interface(POOL_SWAP_ABI);
  const topic = iface.getEvent('Swap')!.topicHash;

  // The last block we have already handed to the caller.
  let lastProcessed = 0;
  let running = false;

  const poll = async (): Promise<void> => {
    if (running) return; // a slow request must not overlap the next tick
    running = true;
    try {
      const head = await provider.getBlockNumber();
      const upTo = head - SWAP_LOG_LAG_BLOCKS;

      // First run: start here rather than replaying the whole history.
      if (lastProcessed === 0) { lastProcessed = upTo - 1; }
      if (upTo <= lastProcessed) return;

      const logs = await provider.getLogs({
        address: poolAddress,
        topics: [topic],
        fromBlock: lastProcessed + 1,
        toBlock: upTo,
      });

      // Chronological order matters: each swap's price is the starting point
      // for the next one, so handing them over shuffled would invent volume.
      logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

      for (const log of logs) {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        onSwap({
          amount0: parsed.args.amount0,
          amount1: parsed.args.amount1,
          sqrtPriceX96: parsed.args.sqrtPriceX96,
          liquidity: parsed.args.liquidity,
          tick: Number(parsed.args.tick),
          blockNumber: log.blockNumber,
          logIndex: log.index,
        });
      }

      lastProcessed = upTo;
    } finally {
      running = false;
    }
  };

  void poll();
  const timer = setInterval(() => { void poll().catch(() => {}); }, SWAP_POLL_MS);
  return () => clearInterval(timer);
}
