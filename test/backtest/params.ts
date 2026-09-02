// Strategy parameters and run state. Values are read from the .env next to it.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Position, Wallet } from './mock.js';

process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '.env'));

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

// ####### parameters #######

/* --- Gap between a quote and the fair price, in ticks. */
export const SPREAD_TICKS = num('SPREAD_TICKS', 20);

/* --- Width of each quote, in ticks. */
export const RANGE_TICKS = num('RANGE_TICKS', 10);

/* --- Fraction of the gap at which we pull, without waiting to be filled. */
export const PULL_FRACTION = num('PULL_FRACTION', 0.7);

/*
--- Retrace of the pool price from its best, in ticks, after which we pull.
--- Moving into a quote is a good fill: the ask sold ETH above the market. But
--- if the price walks back the same way, the position buys that ETH back at the
--- same prices and the round trip nets to zero. Pulling on the retrace locks the
--- sale, and we buy back lower through the bid instead - taking the whole gap.
--- A large value turns the trigger off.
*/
export const POOL_ARBITRAGE_TRIGGER = num('POOL_ARBITRAGE_TRIGGER', 5);

/* --- Pool grid step: position bounds must be multiples of it. */
export const TICK_SPACING = 10;

/* --- Starting wallet, in each token's smallest units. */
export const START_WETH = num('START_WETH', 1) * 1e18;
export const START_USDC = num('START_USDC', 2500) * 1e6;

/* --- Cost of a single on-chain operation on Arbitrum, in dollars. */
export const GAS_BURN = num('GAS_BURN', 0.015);
export const GAS_MINT = num('GAS_MINT', 0.020);

/* --- Share of volume that reaches us: 0.05% less a quarter to the protocol. */
export const LP_FEE_RATE = (num('POOL_FEE', 500) / 1_000_000) * num('LP_FEE_SHARE', 0.75);




// ####### run state #######

/* --- Everything that changes as the simulation runs. */
export interface State {
  wallet: Wallet;
  bid?: Position;
  ask?: Position;
  /* --- Pool price as a square root, updated by every swap. */
  sqrtPool: number;
  /* --- The tick the current quotes were measured from. */
  centerTick: number;
}

/* --- Counters for the final report. */
export interface Stats {
  swapsSeen: number;
  swapsFilled: number;
  /*
  --- Fills by the direction the price moved inside a quote.
  --- Inward: the price goes deeper into the range, so the ask sells ETH ever
  --- dearer and the bid buys ever cheaper. This is where the money is made.
  --- Back: the price returns the same way, so the ask buys back what it sold
  --- and the bid sells what it bought, at the same prices. The round trip nets
  --- to zero and only the fees remain.
  */
  fillsInward: number;
  fillsBack: number;
  feesTotalUsd: number;
  /* --- On-chain operations; gas is derived from these. */
  burns: number;
  mints: number;
  /* --- Redeploys broken down by what triggered them. */
  byTrigger: {
    /* --- The fair price drifted away from the center of our quotes. */
    midMoved: number;
    /* --- The pool price retraced from its best. */
    poolRetraced: number;
    /* --- No quotes were up: the first placement, or after a skip. */
    noPosition: number;
  };
}

export function newStats(): Stats {
  return {
    swapsSeen: 0, swapsFilled: 0, fillsInward: 0, fillsBack: 0, feesTotalUsd: 0,
    burns: 0, mints: 0,
    byTrigger: { midMoved: 0, poolRetraced: 0, noPosition: 0 },
  };
}
