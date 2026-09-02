// Чтение выгруженных данных из test/data.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, Swap } from './mock.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

function readCsv(file: string): Record<string, string>[] {
  const lines = readFileSync(join(DATA, file), 'utf8').trim().split('\n');
  const head = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(head.map((key, i) => [key, cells[i]!]));
  });
}

/** Сделки пула, отсортированы по времени. */
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

/** Посекундные свечи Binance. close берём как справедливую цену. */
export function readCandles(): Candle[] {
  return readCsv('binance_candles.csv').map((r) => ({
    timestamp: Number(r.timestamp),
    close: Number(r.close),
  }));
}
