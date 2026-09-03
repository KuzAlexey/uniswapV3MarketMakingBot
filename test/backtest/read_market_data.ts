// Technical csv reader
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Book, Candle, Swap } from './mock.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

function readCsv(file: string): Record<string, string>[] {
  // Python's csv writer ends lines with \r\n, so the last cell of every row
  // keeps a trailing \r and parses as NaN unless it is stripped here.
  const lines = readFileSync(join(DATA, file), 'utf8').trim().split(/\r?\n/);
  const head = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(head.map((key, i) => [key, cells[i]!]));
  });
}

/* --- Pool swaps, ordered by time. */
export function readSwaps(): Swap[] {
  return readCsv('pool_swaps.csv').map((r) => ({
    timestamp: Number(r.timestamp),
    block: Number(r.block),
    amount0: Number(r.amount0),
    amount1: Number(r.amount1),
    sqrtPriceX96: Number(r.sqrt_price_x96),
    liquidity: Number(r.liquidity),
    tick: Number(r.tick),
  }));
}

/*
--- Per-second Binance candles. We take close as the fair price: the archive
--- has no order book, and close differs from the true mid by at most half the
--- Binance spread, which is 0.02 bps.
*/
export function readCandles(): Candle[] {
  return readCsv('binance_candles.csv').map((r) => ({
    timestamp: Number(r.timestamp),
    close: Number(r.close),
  }));
}

/*
--- Hanji book snapshots. Every row holds one level, so ten of them make one
--- snapshot; levels are placed by their number rather than by row order.
*/
export function readBook(): Book[] {
  const byTime = new Map<number, Book>();
  for (const r of readCsv('hanji_book.csv')) {
    const timestamp = Number(r.timestamp);
    let book = byTime.get(timestamp);
    if (!book) {
      book = { timestamp, block: Number(r.block), bid: [], ask: [] };
      byTime.set(timestamp, book);
    }
    const side = r.side === 'ask' ? book.ask : book.bid;
    side[Number(r.level) - 1] = { price: Number(r.price), size: Number(r.size) };
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}
