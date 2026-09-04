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

// ####### abis #######
// The list of functions a contract has, without which the call cannot be
// encoded. Only what we use - the real ABIs are far longer.

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

const POOL_ABI = [
  // The pool's current state. We need the price and the tick out of it.
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16,uint16,uint16,uint8,bool)',
  // Liquidity of everyone whose range covers the current price.
  'function liquidity() view returns (uint128)',
  // Range boundaries must be multiples of this.
  'function tickSpacing() view returns (int24)',
  // Ordered by address, not by our preference.
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  // Without this the position manager cannot take our tokens.
  'function approve(address spender, uint256 amount) returns (bool)',
];

const POSITION_MANAGER_ABI = [
  // Opens a position, returns the NFT id representing it.
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  // Bookkeeping only - it sends nothing back. collect() is what pays us.
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256,uint256)',
  // Sends the freed tokens plus the fees earned.
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256,uint256)',
  // Only works once liquidity and owed fees are zero.
  'function burn(uint256 tokenId) payable',
  // Several of the above in one transaction, all or nothing.
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)',
];

// ####### connection #######

/* --- Reads the chain. */
export const provider = new ethers.JsonRpcProvider(POOL_RPC_URL);

/* --- Holds the key and signs. */
export const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/*
--- Every transaction carries a nonce so the network can order them. ethers
--- asks the node for the next one but caches the answer briefly, so on a fast
--- chain two transactions sent back to back reuse it and the second fails.
--- NonceManager counts locally instead.
*/
export const signer = new ethers.NonceManager(wallet);

const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider) as any;
const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, signer) as any;
const positionManagerInterface = new ethers.Interface(POSITION_MANAGER_ABI);
const MAX_UINT128 = (1n << 128n) - 1n;

// ####### reading the pool #######

/* --- The pool at one moment in time. */
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
  /* --- USDC per ETH, already converted. */
  price: number;
  wethIsToken0: boolean;
  /* --- Decimals resolved by name, so callers need not care about 0/1 order. */
  decimalsWeth: number;
  decimalsUsdc: number;
}

/* --- Which pool holds our pair at our fee tier. Zero address means none. */
export async function findPool(): Promise<string> {
  const address: string = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, POOL_FEE);
  if (address === ethers.ZeroAddress) throw new Error(`no pool for fee tier ${POOL_FEE}`);
  return address;
}

/* --- Reads the pool. Requests go in parallel, so one round trip covers all. */
export async function readPool(address: string): Promise<PoolState> {
  const pool = new ethers.Contract(address, POOL_ABI, provider) as any;

  const [slot0, liquidity, tickSpacing, token0, token1] = await Promise.all([
    pool.slot0(), pool.liquidity(), pool.tickSpacing(), pool.token0(), pool.token1(),
  ]);

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
    // The formula yields token1 per token0; flip it if WETH is token1.
    price: wethIsToken0 ? rawPrice : 1 / rawPrice,
    wethIsToken0,
    decimalsWeth: wethIsToken0 ? d0 : d1,
    decimalsUsdc: wethIsToken0 ? d1 : d0,
  };
}

const decimalsCache = new Map<string, number>();

/* --- Decimals never change, so each token is asked once. */
async function readDecimals(token0: string, token1: string): Promise<[number, number]> {
  for (const address of [token0, token1]) {
    if (decimalsCache.has(address)) continue;
    const token = new ethers.Contract(address, ERC20_ABI, provider) as any;
    decimalsCache.set(address, Number(await token.decimals()));
  }
  return [decimalsCache.get(token0)!, decimalsCache.get(token1)!];
}

/* --- Balance in the token's smallest units. */
export async function getBalance(tokenAddress: string): Promise<bigint> {
  return (new ethers.Contract(tokenAddress, ERC20_ABI, provider) as any).balanceOf(wallet.address);
}

// ####### positions #######

/*
--- Lets the position manager move our tokens. Needed once before the first
--- mint. Unlimited, so we pay for it once rather than before every position.
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
  /*
  --- What the pool actually took, usually less than offered. Named by token
  --- rather than 0/1, because that order depends on addresses and is easy to
  --- mix up.
  */
  spentWeth: bigint;
  spentUsdc: bigint;
}

/*
--- Opens a position between two ticks.
---
--- Both ticks must be multiples of state.tickSpacing or the call reverts, and
--- tickUpper must be the greater. Below tickLower the position is all WETH,
--- above tickUpper all USDC.
---
--- The two amounts are a ceiling, not an exact amount: the pool works out the
--- proportion it needs from where the price sits in the range and takes only
--- that, so whichever token runs out first caps the size.
*/
export async function mintPosition(
  state: PoolState,
  tickLower: number,
  tickUpper: number,
  amountWethDesired: bigint,
  amountUsdcDesired: bigint,
): Promise<MintResult> {
  // Our token names into the pool's own 0/1 order.
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
    // Slippage floor. Zero is fine on a local fork, but must be set on a real
    // network: the price moves between our decision and execution.
    0n,
    0n,
    wallet.address,
    // Rejected after this timestamp, so a hung transaction cannot execute
    // much later at a different price.
    Math.floor(Date.now() / 1000) + 600,
  ];

  // Runs on the node without sending: we learn the reason before spending gas.
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
  /*
  --- What came back, fees included. The split depends on where the price
  --- ended: above our range it is all USDC, below it all WETH.
  */
  receivedWeth: bigint;
  receivedUsdc: bigint;
}

/*
--- Closes a position and destroys its NFT. Three calls, order matters:
--- decreaseLiquidity turns liquidity into owed tokens and sends nothing,
--- collect pays those out with the fees, burn deletes the empty NFT.
--- Sent through multicall so they are one atomic transaction - we can never
--- end up half closed.
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

/* --- Zero means the position is empty. */
export async function getPositionLiquidity(tokenId: bigint): Promise<bigint> {
  return (await positionManager.positions(tokenId)).liquidity;
}

/*
--- Digs the new NFT id out of the receipt. Creating an NFT emits
--- Transfer(from = zero address, to = us, tokenId); that is the log we want.
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

/*
--- Translates one confusing error. The public Arbitrum node is not an archive
--- node and drops the state of older blocks, so a fork left running for an
--- hour starts asking for state that is gone and every call fails meaninglessly.
*/
export function explainError(err: unknown): string {
  const text = JSON.stringify(err instanceof Error ? err.message : err);
  if (text.includes('missing trie node') || text.includes('missing revert data')) {
    return 'fork is stale — the public node dropped that state. Restart anvil (npm run fork) or use an archive node';
  }
  return (err as any)?.shortMessage ?? String(err);
}

// ####### binance feed #######

/* --- Raw bookTicker message. Binance sends every number as a string. */
interface BookTickerMessage {
  u: number; // update id, always increasing
  s: string; // symbol
  b: string; // best bid price
  B: string; // amount at the bid
  a: string; // best ask price
  A: string; // amount at the ask
}

/* --- Top of the Binance book at one moment. */
export interface Quote {
  symbol: string;
  /* --- Highest anyone will pay for ETH now. */
  bid: number;
  /* --- Lowest anyone will sell it for now. */
  ask: number;
  bidSize: number;
  askSize: number;
  /* --- Fairest single estimate of the price. */
  mid: number;
  /* --- Distance between the two, in bp. */
  spreadBps: number;
  updateId: number;
  receivedAt: number;
}

/* --- Calls back on every change of the best prices. */
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
    // A broken frame must not crash the bot.
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return;
    // Messages can arrive out of order.
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

// ####### other people's swaps #######

/* --- One trade someone else made against the pool. */
export interface SwapEvent {
  /* --- Signed: positive went into the pool, negative came out. */
  amount0: bigint;
  amount1: bigint;
  /* --- Price AFTER the swap, as the pool stores it. */
  sqrtPriceX96: bigint;
  /* --- Active liquidity AFTER the swap, so our share of the fee is known
  --- without reconstructing the whole book. */
  liquidity: bigint;
  /* --- Tick AFTER the swap. */
  tick: number;
  blockNumber: number;
  /* --- Unique together with the block. */
  logIndex: number;
}

const POOL_SWAP_ABI = [
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
];

/*
--- Calls back on every swap anyone makes against the pool, which is what lets
--- us tell whether a trade would have gone through our range.
--- Returns a function that stops the subscription.
*/
export function watchSwaps(poolAddress: string, onSwap: (swap: SwapEvent) => void): () => void {
  const iface = new ethers.Interface(POOL_SWAP_ABI);
  const topic = iface.getEvent('Swap')!.topicHash;

  let lastProcessed = 0;
  let running = false;

  const poll = async (): Promise<void> => {
    if (running) return; // a slow request must not overlap the next tick
    running = true;
    try {
      const head = await provider.getBlockNumber();
      const upTo = head - SWAP_LOG_LAG_BLOCKS;

      // First run starts here rather than replaying the whole history.
      if (lastProcessed === 0) { lastProcessed = upTo - 1; }
      if (upTo <= lastProcessed) return;

      const logs = await provider.getLogs({
        address: poolAddress,
        topics: [topic],
        fromBlock: lastProcessed + 1,
        toBlock: upTo,
      });

      // Each swap's price is the starting point of the next, so handing them
      // over shuffled would invent volume.
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
