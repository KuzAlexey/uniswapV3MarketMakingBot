// Параметры стратегии и состояние прогона. Значения читаются из .env рядом.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Position, Wallet } from './mock.js';

process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '.env'));

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

// --- параметры ---

/** Отступ котировки от справедливой цены, в тиках. */
export const SPREAD_TICKS = num('SPREAD_TICKS', 20);

/** Ширина каждой котировки, в тиках. */
export const RANGE_TICKS = num('RANGE_TICKS', 10);

/** Доля отступа, при которой снимаемся, не дожидаясь исполнения. */
export const PULL_FRACTION = num('PULL_FRACTION', 0.7);

/**
 * Откат цены пула от лучшей достигнутой, в тиках, после которого снимаемся.
 *
 * Заход цены в нашу котировку — это выгодное исполнение: аск продал ETH выше
 * рынка. Но если цена пойдёт обратно тем же путём, позиция откупит проданное
 * по тем же ценам, и круг закроется в ноль. Снявшись на откате, мы фиксируем
 * продажу и откупаем уже через бид, внизу — забирая весь зазор.
 *
 * Большое значение выключает триггер.
 */
export const POOL_ARBITRAGE_TRIGGER = num('POOL_ARBITRAGE_TRIGGER', 5);

/** Шаг сетки пула: границы позиций обязаны быть ему кратны. */
export const TICK_SPACING = 10;

/** Стартовый кошелёк, в минимальных единицах токенов. */
export const START_WETH = num('START_WETH', 1) * 1e18;
export const START_USDC = num('START_USDC', 2500) * 1e6;

/** Стоимость одной операции на Arbitrum, в долларах. */
export const GAS_BURN = num('GAS_BURN', 0.015);
export const GAS_MINT = num('GAS_MINT', 0.020);

/** Доля объёма, достающаяся нам: 0.05% минус четверть протоколу. */
export const LP_FEE_RATE = (num('POOL_FEE', 500) / 1_000_000) * num('LP_FEE_SHARE', 0.75);

// --- состояние прогона ---

/** Всё, что меняется по ходу симуляции. */
export interface State {
  wallet: Wallet;
  bid?: Position;
  ask?: Position;
  /** Цена пула в виде корня, обновляется каждым свопом. */
  sqrtPool: number;
  /** Тик, от которого отсчитаны текущие котировки. */
  centerTick: number;
}

/** Счётчики для итогового отчёта. */
export interface Stats {
  swapsSeen: number;
  swapsFilled: number;
  /**
   * Исполнения по направлению движения цены внутри котировки.
   *
   * Вглубь — цена идёт дальше в диапазон: аск продаёт ETH всё дороже, бид
   * покупает всё дешевле. Это заработок.
   *
   * Обратно — цена возвращается тем же путём: аск откупает проданное, бид
   * продаёт купленное, по тем же ценам. Круг закрывается в ноль, остаются
   * только комиссии.
   */
  fillsInward: number;
  fillsBack: number;
  feesTotalUsd: number;
  /** Операции на цепочке — по ним считается газ. */
  burns: number;
  mints: number;
  /** Перевыставления в разрезе того, что их вызвало. */
  byTrigger: {
    /** Справедливая цена ушла от центра котировок. */
    midMoved: number;
    /** Цена пула откатилась от лучшей достигнутой. */
    poolRetraced: number;
    /** Котировок не было — первое выставление или после пропуска. */
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
