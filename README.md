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

A Uniswap position does not quote one price. It quotes a whole range and trades
along it as the price moves through, so the first thing to work out is the price
we actually get.

If the price travels from $P_1$ to $P_2$ inside our range, the position gives up

$$\Delta x = \frac{L\left(\sqrt{P_2} - \sqrt{P_1}\right)}{\sqrt{P_1}\sqrt{P_2}}
\qquad\text{and receives}\qquad
\Delta y = L\left(\sqrt{P_2} - \sqrt{P_1}\right)$$

Divide one by the other and $L$ cancels:

$$P_{\text{exec}} = \frac{\Delta y}{\Delta x} = \sqrt{P_1 P_2}$$

**The price we actually trade at is the geometric mean of the two ends of the
segment.** It does not depend on how big our position is.

That single number decides everything. The money in any fill is

$$\left|P_{\text{exec}} - P_{\text{fair}}\right|$$

and the sign decides who walks away with it. If our quote ends up on the wrong
side of fair — Binance moved and our position did not — the taker buys cheap
from us and sells elsewhere in the same block, with no risk. If the range
straddles fair, then $P_{\text{exec}} \approx P_{\text{fair}}$ and nobody gains
anything at all: the 0.0375% pool fee is the whole income, and it does not cover
what informed flow takes out of the position.

**The main idea.** Quoting away from the fair price is what creates the edge —
it guarantees every fill happens at a price better than fair. And when the pool
price starts coming back towards fair, we should not be providing liquidity at
all. That is the next section.

### 2. What a round trip costs

Being filled is not the problem. The problem is being filled *twice*.

Say we hold an ask on $[p_a, p_b]$, entirely above the fair price. The pool
price wanders up into it and we sell ETH at

$$P_{\text{exec}} = \sqrt{p_a P_2} > P_{\text{fair}}$$

Good: we sold above fair value.

But the pool price is not the fair price — arbitrageurs pull it back. When it
comes back down through the same range, **our own position buys that ETH back**,
along the same curve, at the same geometric mean. The composition returns to
exactly what it was:

```
ask 1930..1951, fair price 1900

  before      0.124860 ETH +   0.00 USDC
  at the top  0.000000 ETH + 242.25 USDC
  back down   0.124860 ETH +   0.00 USDC   <- exactly as before
```

Note what this is and is not. The round trip does **not** lose money — we end
with what we started, and we collected the fee on both legs. What it destroys is
the profit we had already made and could have kept:

```
value at fair price 1900, after the round trip     237.23 USD
value if we had closed at the top                  242.25 USD
                                                   ------
given back                                           5.01 USD
```

So the position that costs us money is **the one still standing when the pool
price turns around**. Not the one that got filled — the one that got filled and
then un-filled.

### 3. What we do about it

Three rules, one for each problem above, and each is a parameter.

**Keep a gap from the fair price** — `SPREAD_TICKS`. This is not defence, it is
the edge itself: a quote held back from fair can only be filled at a price
better than fair, and that margin is what pays for adverse selection.

**Redeploy once the fair price drifts** — `PULL_FRACTION`. A quote that has not
moved while Binance has is the stale quote of section 1, and stale quotes are
the real arbitrage. We move ours before the gap is eaten up, measuring distance
rather than waiting for a boundary to be crossed: the fair price moving *away*
from our quotes needs a redeploy just as much as it moving into them.

**Pull when the pool price reverses** — `POOL_ARBITRAGE_TRIGGER`. We remember
the deepest point the pool price reached inside each live range. When it
retraces from that point by more than the threshold, **we close before the
position can be un-filled**.

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
| `POOL_ARBITRAGE_TRIGGER` | How far the pool price may retrace from its best point inside our range before we pull. This is the third rule of section 3. A large value turns it off. |
| `HEDGE_BAND` | How far the ETH share of the wallet may drift from 50% before we rebalance on Hanji. `100` turns hedging off. |
| `START_WETH`, `START_USDC` | Starting wallet. |
| `GAS_BURN`, `GAS_MINT` | Cost of one on-chain operation on Arbitrum, in dollars. |
| `POOL_FEE`, `LP_FEE_SHARE` | Pool fee tier and the share reaching providers. This pool has the protocol fee switched on (`feeProtocol = 68`), so of the 0.05% a trader pays we receive 0.0375%. |

### What the search found

432 combinations were run over the same week and ranked by **delta-hedged
PnL**
**The recommended setting:**

```
SPREAD_TICKS = 30      RANGE_TICKS = 10      PULL_FRACTION = 0.99
POOL_ARBITRAGE_TRIGGER = 20                  HEDGE_BAND = 10
```

```
fees            $30.74
spread edge     $33.57
gas            -$16.98   (243 redeploys)
rebalancing     -$4.54   (7 hedge-swaps on $26,415)
                -------
delta-hedged    $42.79    0.49% of capital in a week
total PnL      $130.72    
```

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
