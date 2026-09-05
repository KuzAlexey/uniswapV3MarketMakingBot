# Uniswap v3 market-making bot

A market-making bot for the **ETH/USDC 0.05% pool on Arbitrum**. It reads the
live price from Binance, places two one-sided liquidity ranges around it, and
keeps its inventory balanced with swaps on the **Hanji** order book.

The one idea behind it: **never leave an arbitrage opportunity on the table.**
The bot quotes only at prices that are better for it than the fair price, and it
pulls its liquidity as soon as the pool price turns around and starts taking
that edge back.

Written in **TypeScript**. The backtest replays one real week of data:
112,279 pool swaps, 604,800 Binance candles, 100,800 order-book snapshots.

---

## File structure

```
src/                       the live bot
    bot.ts                 entry point: read Binance, read the pool, print
    api.ts                 chain and Binance: pool state, mint, burn, swap feed
    math.ts                tick and liquidity maths, no network
    env.ts                 configuration from .env

test/
    data/                  market data
        download.py        writes the three CSV files below
        pool_swaps.csv     every Swap event of the pool
        binance_candles.csv  per-second candles, the fair price
        hanji_book.csv     order-book snapshots, one a minute
        .env               which period and which market to download

    backtest/              replaying the strategy
        backtest.ts        the run loop and the strategy itself
        mock.ts            a position in memory: mint, close, fees, hedge
        params.ts          strategy parameters and run state
        read_market_data.ts  CSV reader
        result_log.ts      the summary, human or JSON
        .env               the parameters

    analytics/
        backtest.ipynb     parameter sweeps and a grid search
        results/           the search output
```

---

## The strategy

### 1. When does an arbitrage opportunity appear?

A Uniswap position does not quote one price. It quotes a whole range, and it
trades along it as the price moves through.

If the price travels from $P_1$ to $P_2$ inside our range, the position gives up

$$\Delta x = \frac{L\left(\sqrt{P_2} - \sqrt{P_1}\right)}{\sqrt{P_1}\sqrt{P_2}}
\qquad\text{and receives}\qquad
\Delta y = L\left(\sqrt{P_2} - \sqrt{P_1}\right)$$

Divide one by the other and $L$ cancels:

$$P_{\text{exec}} = \frac{\Delta y}{\Delta x} = \sqrt{P_1 P_2}$$

**The price we actually trade at is the geometric mean of the two ends of the
segment.** It does not depend on how big our position is.

Now put a range straddling the fair price. Then $P_1 < P_{\text{fair}} < P_2$,
so $P_{\text{exec}} \approx P_{\text{fair}}$: we sell at fair value and buy at
fair value. We earn the 0.0375% pool fee and nothing else, while an arbitrageur
takes everything else the price move was worth.

**That is the arbitrage opportunity: liquidity sitting at or near the fair
price.** Anyone can trade against it at a price they would have got anyway, so
the whole gain of the move goes to them.

### 2. Which positions lose money

Being filled is not the problem. The problem is being filled *twice*.

Say we hold an ask on $[p_a, p_b]$, entirely above the fair price. The pool
price wanders up into it and we sell ETH at

$$P_{\text{exec}} = \sqrt{p_a P_2} > P_{\text{fair}}$$

Good: we sold above fair value.

But the pool price is not the fair price — it is pulled back towards fair by
arbitrageurs. When it comes back down through the same range, **our own
position buys that ETH back**, along the same curve, at the same geometric
mean. The two trades cancel:

$$\underbrace{\sqrt{p_a P_2}}_{\text{sold at}} \;=\; \underbrace{\sqrt{p_a P_2}}_{\text{bought back at}}
\qquad\Longrightarrow\qquad \text{profit} = 0$$

All that is left is the pool fee. The spread we earned on the way in is handed
straight back on the way out.

So the position that loses money is **the one still standing when the pool price
turns around**. Not the one that got filled — the one that got filled and then
un-filled.

### 3. What we do about it

Two rules follow directly.

**Never quote across the fair price.** Both ranges stay a gap away from it, so
there is nothing for an arbitrageur to trade against at fair value.

**Pull the position when the pool price reverses.** We remember the deepest
point the pool price reached inside each live range. When it retraces from that
point by more than a threshold, we close the position before it can be unwound.
The sale stays locked in, and we buy the ETH back lower through the other side
instead — capturing the whole gap rather than zero.

### 4. How we place the quotes

Two separate one-sided ranges around the Binance mid, each held back by a gap of
`SPREAD_TICKS`:

```
   price
     ▲
     │   ┌──────────────────────────┐
     │   │  ASK   [aL , aL + RANGE] │   holds ETH, sells as the price rises
     │   └──────────────────────────┘
     │              ▲
     │              │  gap = SPREAD_TICKS   (no liquidity here)
     │              ▼
  ═══╪═════════  FAIR PRICE  ═══════════   Binance mid
     │              ▲
     │              │  gap = SPREAD_TICKS   (no liquidity here)
     │              ▼
     │   ┌──────────────────────────┐
     │   │  BID   [bU - RANGE , bU] │   holds USDC, buys as the price falls
     │   └──────────────────────────┘
     │
```

The bounds must land on the pool's tick grid, and the rounding always goes
**outward**, so the gap is never accidentally made smaller:

$$b_U = \text{floorToSpacing}\left(t_{\text{mid}} - \text{SPREAD}\right)
\qquad
a_L = \text{ceilToSpacing}\left(t_{\text{mid}} + \text{SPREAD}\right)$$

Because neither range covers the current price, each one is funded by a single
token — the ask by ETH alone, the bid by USDC alone. That makes them exactly
like two resting limit orders, expressed as curves.

**What we earn per fill.** With a gap of $s$ ticks and a width of $w$ ticks, a
fully-filled ask executes at

$$P_{\text{exec}} = P_{\text{fair}} \cdot 1.0001^{\,s + w/2}$$

With `SPREAD_TICKS = 30` and `RANGE_TICKS = 10` that is 35 ticks above fair, so
**35 basis points**, plus the 3.75 bp pool fee on top. The gap is where the
money is; the fee is a bonus.

**Hedging.** Every fill leaves the wallet lopsided — the ask turns ETH into
USDC, the bid does the reverse. Both quotes are the same width, so they need the
same value on each side; a lopsided wallet places one of them thin, or not at
all. After closing and before placing again, if the ETH share has drifted more
than `HEDGE_BAND` from 50%, the bot swaps back to an even split on Hanji.

---

## Parameters

All in `test/backtest/.env`.

| Parameter | What it controls |
|---|---|
| `SPREAD_TICKS` | Gap between the fair price and each quote. This is the edge we earn per fill. Wider means fewer fills but more per fill. |
| `RANGE_TICKS` | Width of each quote. Liquidity is inversely proportional to width, so a wider range is a thinner position: $L \propto 1/\text{width}$. |
| `PULL_FRACTION` | How far the fair price may drift, as a fraction of `SPREAD_TICKS`, before we redeploy. Lower means we chase the price harder and pay more gas. |
| `POOL_ARBITRAGE_TRIGGER` | How far the pool price may retrace from its best point inside our range before we pull. This is rule 2 of section 3. A large value turns it off. |
| `HEDGE_BAND` | How far the ETH share of the wallet may drift from 50% before we rebalance on Hanji. `100` turns hedging off. |
| `START_WETH`, `START_USDC` | Starting wallet. |
| `GAS_BURN`, `GAS_MINT` | Cost of one on-chain operation on Arbitrum, in dollars. |
| `POOL_FEE`, `LP_FEE_SHARE` | Pool fee tier and the share reaching providers. This pool has the protocol fee switched on (`feeProtocol = 68`), so of the 0.05% a trader pays we receive 0.0375%. |

### What the search found

324 combinations were run over the same week. Three parameters show a clean
trend, and all three say the same thing: **trade less often.** Average net by
value:

```
SPREAD_TICKS    20: -36.0    30: -13.4    50: -6.9    80: -1.7
RANGE_TICKS     10: -10.6    20: -14.5    40: -18.4
PULL_FRACTION  0.70: -24.1  0.90: -10.8  0.95: -8.7
```

Gas does not scale with capital but fees do, so at this size every redeploy
avoided is worth more than the fees it would have earned.

---

## Running it

Configuration lives in three `.env` files: the root one for the bot, and one
each in `test/data` and `test/backtest`.

**The bot** needs an RPC endpoint and a funded key. Against a local fork:

```bash
anvil --fork-url https://arb1.arbitrum.io/rpc --hardfork shanghai
npm run bot
```

The `--hardfork shanghai` flag is required: without it anvil fails on Arbitrum
blocks with "Excess blob gas not set".

**The backtest** replays the CSV files in `test/data`. They are committed, so it
runs straight away:

```bash
npm run backtest
```

To download a different period, set `START_DAY` and `END_DAY` in
`test/data/.env` and run `python3 download.py` there. Standard library only, no
packages needed. A week takes a few minutes.

**The sweeps and the grid search** are in `test/analytics/backtest.ipynb`.

---

## Assumptions and trade-offs

**Hanji has no Arbitrum deployment.** It runs on Etherlink, Base and Monad. Delta
can be hedged across chains — a short on Base offsets a long on Arbitrum — but
inventory for the next mint cannot: selling ETH on Base does not produce USDC on
Arbitrum. The backtest therefore models the rebalance with costs measured from
the live Base book (0.72 bp half-spread plus 1 bp taker fee, **1.72 bp** one
way), and the on-chain adapter is not wired up.

**The book gives the shape, Binance gives the level.** A Hanji snapshot is up to
a minute old. Over that minute the price drifts by 2.28 bp while the spread
moves by 0.03 bp, so only the ratio is taken from the book; the price level
comes from the Binance candle of that second.

**Fees are credited in USDC** regardless of which direction the swap went.
Uniswap charges in the input token. On a week with a 2.8% price move this shifts
the result by cents.

**Our own liquidity does not move the price.** The replay credits us a share of
each swap without simulating the impact our position would have had. This holds
while our share is small, which it is at this size.

**Results are in-sample.** The best cell of a 324-point grid on a single week is
a maximum found by looking, not a prediction. The monotone trends across 81 runs
each are worth trusting; the winning combination itself is not.

**Not done:** the live Hanji adapter, a Solidity helper contract for bundling
position calls, a Dockerfile, and Sharpe / max-drawdown — those need an equity
curve sampled on a fixed grid rather than the single end-of-week number the
backtest reports today.
