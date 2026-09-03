#!/usr/bin/env python3
"""
Downloads the raw data for the backtest into three CSV files.

  pool_swaps.csv       every Uniswap pool trade over the period
  binance_candles.csv  per-second Binance candles over the same period
  hanji_book.csv       Hanji book snapshots on a time grid

Nothing beyond the standard library is needed. Settings live in the .env next to it.
"""

import csv
import io
import json
import os
import time
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))

# Hash of the Swap event signature. The node picks the logs out by it.
SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"

# Arbitrum produces about four blocks a second.
BLOCKS_PER_SECOND = 4

# The window we start with. In quiet hours it goes through whole; in busy ones
# the node hits its own limit and the window is halved.
CHUNK_BLOCKS = 20_000

# Base produces a block every two seconds.
BASE_BLOCKS_PER_SECOND = 0.5

# assembleOrderbookFromOrders(address,bool,uint24), the first four bytes of the
# keccak of that signature. There is nothing to hash it with: the standard
# library ships NIST SHA3, while Ethereum uses the original Keccak.
QUOTER_SELECTOR = "0x1c5f5589"

# How many levels to ask for on each side. Past the fourth come real resting
# orders percents away from the price, which nothing ever reaches.
BOOK_LEVELS = 8

# The public Base node refuses calls made back to back, and not with a 429 but
# with a plain JSON-RPC error. Hence a separate pause, longer than the common one.
BOOK_MIN_INTERVAL = 0.5

# How many calls go into one batch. A node that accepts them answers a hundred
# in a third of a second: on a minute grid that is hours against minutes.
BOOK_BATCH = 120

# Without this both the node and the Binance archive answer 403: they turn away
# requests that introduce themselves as the standard Python client.
HEADERS = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}

# Smallest pause between calls to the node. Waiting is cheaper than catching a
# 429 and then sitting out a minute of backoff.
MIN_INTERVAL = 0.15

_last_call = 0.0


def load_env():
    """Reads the .env next to the script into a plain dict."""
    settings = {}
    with open(os.path.join(HERE, ".env")) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, _, value = line.partition("=")
            settings[key.strip()] = value.strip()
    return settings


def fetch(url, payload=None, attempts=10, timeout=45, min_interval=None):
    """
    An HTTP request with JSON parsing, shared by the node and the Hanji API.

    Both sources rate limit and answer 429. The script makes hundreds of calls,
    hence both a pause before each one and a long backoff on refusal.
    """
    global _last_call

    data = payload.encode() if payload else None
    for attempt in range(attempts):
        # No rushing: a minimum interval is kept between any two requests.
        wait = (min_interval or MIN_INTERVAL) - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()

        try:
            request = urllib.request.Request(url, data=data, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == attempts - 1:
                raise
            # The source sometimes says how long to wait.
            retry_after = error.headers.get("Retry-After")
            pause = float(retry_after) if retry_after and retry_after.isdigit() else min(60, 2 ** attempt)
            print(f"    429, waiting {pause:.0f}s (attempt {attempt + 1}/{attempts})")
            time.sleep(pause)
    raise RuntimeError("unreachable")


def rpc(url, method, params, attempts=10, timeout=45, min_interval=None):
    """A single JSON-RPC call to the node."""
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    answer = fetch(url, payload, attempts, timeout, min_interval)
    if "error" in answer:
        raise RuntimeError(answer["error"])
    return answer["result"]


def signed(word, bits):
    """A 32-byte word as a signed integer: the top bit means minus."""
    value = int(word, 16)
    return value - (1 << bits) if value >= (1 << (bits - 1)) else value


_block_times = {}


def block_time(url, number):
    """
    Block time in seconds.

    The binary search and the chunk edges ask for the same blocks many times
    over, so answers are remembered; it cuts the number of calls noticeably.
    """
    if (url, number) not in _block_times:
        block = rpc(url, "eth_getBlockByNumber", [hex(number), False])
        _block_times[(url, number)] = int(block["timestamp"], 16)
    return _block_times[(url, number)]


def midnight(day):
    """Midnight UTC of the given date, in seconds."""
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())


def block_at_time(url, target, head, head_time, blocks_per_second=BLOCKS_PER_SECOND):
    """
    The first block no earlier than the given time.

    The number is estimated from the average block rate, then refined by binary
    search. The window around the estimate widens until it covers the target:
    the block rate is not constant, and over weeks a fixed margin is not enough -
    the search would quietly hit the edge and return the wrong block.
    """
    guess = head - int((head_time - target) * blocks_per_second)
    margin = int(3600 * blocks_per_second)         # an hour to start with
    while True:
        low, high = max(1, guess - margin), min(head, guess + margin)
        if block_time(url, low) <= target <= block_time(url, high):
            break
        if low <= 1 and high >= head:
            break                                   # nowhere left to widen
        margin *= 4
    while low < high:
        middle = (low + high) // 2
        if block_time(url, middle) < target:
            low = middle + 1
        else:
            high = middle
    return low


def fetch_logs(url, pool, start, stop):
    """
    Logs over a block range, splitting it when needed.

    The node refuses for two reasons: more than 10,000 logs in the answer, or a
    query that took too long. Both are cured the same way - halve the window
    until it goes through.
    """
    try:
        return rpc(url, "eth_getLogs", [{
            "address": pool,
            "topics": [SWAP_TOPIC],
            "fromBlock": hex(start),
            "toBlock": hex(stop),
        }])
    except (RuntimeError, TimeoutError, urllib.error.URLError) as error:
        # The node refuses for three reasons, and all three mean "the window is
        # too wide": over 10,000 logs, a query too slow on its side, a timeout on
        # ours. The response to all three is the same - halve it.
        text = str(error)
        recoverable = isinstance(error, (TimeoutError, urllib.error.URLError)) or \
                      "exceeds limit" in text or "timed out" in text
        if not recoverable or start >= stop:
            raise
        middle = (start + stop) // 2
        return fetch_logs(url, pool, start, middle) + fetch_logs(url, pool, middle + 1, stop)


def download_swaps(url, pool, start_day, end_day, out_path):
    head = int(rpc(url, "eth_blockNumber", []), 16)
    head_time = block_time(url, head)

    # The bounds match the Binance candle days, otherwise the periods of the two
    # sources drift apart and they cannot be merged into one stream.
    first = block_at_time(url, midnight(start_day), head, head_time)
    last = block_at_time(url, midnight(end_day + timedelta(days=1)), head, head_time) - 1

    print(f"pool swaps: {start_day} .. {end_day} UTC")
    print(f"            blocks {first}..{last}  ({last - first:,})")
    head = last

    rows = []
    start = first
    while start <= head:
        stop = min(start + CHUNK_BLOCKS - 1, head)

        logs = fetch_logs(url, pool, start, stop)

        # Asking for every block time separately is too expensive, so the times
        # at the chunk edges are taken and the blocks inside spread evenly.
        time_start = block_time(url, start)
        time_stop = block_time(url, stop)
        span = max(stop - start, 1)

        for log in logs:
            block = int(log["blockNumber"], 16)
            data = log["data"][2:]
            words = [data[i:i + 64] for i in range(0, len(data), 64)]
            rows.append({
                "timestamp": time_start + (time_stop - time_start) * (block - start) // span,
                "block": block,
                "log_index": int(log["logIndex"], 16),
                "amount0": signed(words[0], 256),      # + came into the pool, - left
                "amount1": signed(words[1], 256),
                "sqrt_price_x96": int(words[2], 16),   # the price AFTER the trade
                "liquidity": int(words[3], 16),        # the L active at that moment
                # tick is declared int24 but sits in the log sign extended to a
                # full 32 bytes, so it has to be read as a signed 256-bit word.
                "tick": signed(words[4], 256),
            })

        print(f"  {start}..{stop}  +{len(logs)}  total {len(rows):,}")
        start = stop + 1

    rows.sort(key=lambda row: (row["block"], row["log_index"]))
    with open(out_path, "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"  -> {out_path}  ({len(rows):,} rows)\n")


def download_candles(symbol, start_day, end_day, out_path):
    """Per-second candles from the open Binance archive. No keys needed."""
    print(f"Binance candles {symbol}: {start_day} .. {end_day}")
    rows = []
    day = start_day
    while day <= end_day:
        url = (f"https://data.binance.vision/data/spot/daily/klines/"
               f"{symbol}/1s/{symbol}-1s-{day}.zip")
        try:
            request = urllib.request.Request(url, headers={"User-Agent": HEADERS["User-Agent"]})
            with urllib.request.urlopen(request, timeout=120) as response:
                blob = response.read()
        except Exception as error:
            # The file for the most recent day appears a few hours late.
            print(f"  {day}  skipped: {error}")
            day += timedelta(days=1)
            continue

        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            name = archive.namelist()[0]
            for record in csv.reader(io.TextIOWrapper(archive.open(name))):
                rows.append({
                    "timestamp": int(record[0]) // 1_000_000,  # microseconds -> seconds
                    "open": record[1],
                    "high": record[2],
                    "low": record[3],
                    "close": record[4],
                    "volume": record[5],
                    "trades": record[8],
                })
        print(f"  {day}  total {len(rows):,}")
        day += timedelta(days=1)

    with open(out_path, "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"  -> {out_path}  ({len(rows):,} rows)\n")


def book_calldata(proxy, is_ask):
    """The arguments of assembleOrderbookFromOrders, packed the ABI way."""
    return (QUOTER_SELECTOR
            + proxy.lower().removeprefix("0x").rjust(64, "0")
            + ("1" if is_ask else "0").rjust(64, "0")
            + f"{BOOK_LEVELS:x}".rjust(64, "0"))


def decode_book(raw):
    """
    Two dynamic arrays out of the contract answer.

    The offsets to each come first; at an offset sits the length, then the items.
    """
    words = [raw[2:][i:i + 64] for i in range(0, len(raw[2:]), 64)]
    out = []
    for head in (0, 1):
        at = int(words[head], 16) // 32
        count = int(words[at], 16)
        out.append([int(word, 16) for word in words[at + 1:at + 1 + count]])
    return out


def rpc_batch(url, calls, attempts=6, timeout=90):
    """
    Several JSON-RPC calls in one request.

    Answers may come back in any order, so they are laid out by id. A node with
    no batch support answers with something other than a list; the caller catches
    the RuntimeError and falls back to one call at a time.
    """
    payload = json.dumps([{"jsonrpc": "2.0", "id": i, "method": method, "params": params}
                          for i, (method, params) in enumerate(calls)])
    for attempt in range(attempts):
        answer = fetch(url, payload, timeout=timeout, min_interval=BOOK_MIN_INTERVAL)
        if not isinstance(answer, list) or len(answer) != len(calls):
            raise RuntimeError("batch not supported")
        results = [None] * len(calls)
        failed = False
        for item in answer:
            if "error" in item:
                failed = True
                break
            results[item["id"]] = item["result"]
        if not failed:
            return results
        if attempt == attempts - 1:
            raise RuntimeError(answer[0].get("error"))
        time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def fetch_book(url, quoter, proxy, block, is_ask, attempts=6):
    """
    One snapshot of one side of the book at a historical block.

    The quoter method is declared view, so it can be called through eth_call with
    a past block number: the node runs it against the state of that moment.
    """
    call = [{"to": quoter, "data": book_calldata(proxy, is_ask)}, hex(block)]
    for attempt in range(attempts):
        try:
            return decode_book(rpc(url, "eth_call", call, min_interval=BOOK_MIN_INTERVAL))
        except RuntimeError:
            # Refusal to be rushed arrives as a plain JSON-RPC error rather than
            # a 429, so the backoff inside fetch never sees this case.
            if attempt == attempts - 1:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def call_many(url, calls, batched):
    """A bunch of calls: one batch if the node can, otherwise one at a time."""
    if batched:
        return rpc_batch(url, calls)
    return [rpc(url, method, params, min_interval=BOOK_MIN_INTERVAL)
            for method, params in calls]


def download_book(url, api, market, quoter, proxy, step_min, start_day, end_day, out_path):
    """
    The book on an even grid of time.

    What the backtest takes from a snapshot is not the level of the price but a
    ratio: the half spread and the offsets of the levels from the middle. Over
    fifteen minutes the price drifts by 5.7 bps and the ratio by 0.00, which is
    why the grid may be sparse.
    """
    meta = fetch(f"{api}/markets?market={market}")[0]
    price_factor = 10 ** meta["priceScalingFactor"]
    size_factor = 10 ** meta["tokenXScalingFactor"]

    head = int(rpc(url, "eth_blockNumber", []), 16)
    head_time = block_time(url, head)
    first_second = midnight(start_day)
    last_second = midnight(end_day + timedelta(days=1)) - 1

    # The binary search runs only on the edges and the rest of the block numbers
    # are taken linearly: Base steps exactly two seconds, and searching for every
    # snapshot separately would cost more than the download itself.
    first_block = block_at_time(url, first_second, head, head_time, BASE_BLOCKS_PER_SECOND)
    last_block = block_at_time(url, last_second, head, head_time, BASE_BLOCKS_PER_SECOND)
    rate = (last_block - first_block) / max(last_second - first_second, 1)

    grid = range(first_second, last_second, step_min * 60)
    blocks = [first_block + round((second - first_second) * rate) for second in grid]

    batched = True
    try:
        rpc_batch(url, [("eth_blockNumber", [])] * 2)
    except RuntimeError:
        batched = False

    print(f"Hanji book {meta['symbol']}: {start_day} .. {end_day}, step {step_min} min")
    print(f"            blocks {first_block}..{last_block}, snapshots {len(blocks)}, "
          f"batching {'yes' if batched else 'no'}")

    # One flat list of calls: the block time and both sides for every snapshot.
    calls = []
    for block in blocks:
        calls.append(("eth_getBlockByNumber", [hex(block), False]))
        for is_ask in (False, True):
            calls.append(("eth_call", [{"to": quoter, "data": book_calldata(proxy, is_ask)},
                                       hex(block)]))

    # A week comes to two and a half hundred batches, and printing each is
    # pointless: it makes a wall of lines in which it is impossible to see whether
    # the work is moving at all. A tenth of the way and the time left instead.
    step = BOOK_BATCH if batched else 1
    answers = []
    shown = 0
    started = time.monotonic()
    while len(answers) < len(calls):
        answers += call_many(url, calls[len(answers):len(answers) + step], batched)
        done = len(answers) // 3
        if done - shown < len(blocks) / 10 and done < len(blocks):
            continue
        shown = done
        spent = time.monotonic() - started
        left = spent / done * (len(blocks) - done)
        eta = f"~{left / 60:.1f} left" if done < len(blocks) else "done"
        print(f"  {done:>{len(str(len(blocks)))}}/{len(blocks)}  "
              f"{100 * done // len(blocks):>3}%  {spent / 60:4.1f} min spent, {eta}")

    rows = []
    for index, block in enumerate(blocks):
        stamp = int(answers[index * 3]["timestamp"], 16)
        # The labels come from the data, not from the documentation: the
        # isAsk=false side stands above the Binance fair price (+0.32 bps) and
        # isAsk=true below it (-1.11 bps). A taker overpays when buying and is
        # underpaid when selling, so the first is the ask and the second the bid.
        for offset, side in ((1, "ask"), (2, "bid")):
            prices, sizes = decode_book(answers[index * 3 + offset])
            for level, (price, size) in enumerate(zip(prices, sizes), 1):
                rows.append({
                    "timestamp": stamp,
                    "block": block,
                    "side": side,
                    "level": level,
                    "price": price / price_factor,
                    "size": size / size_factor,
                })

    with open(out_path, "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"  -> {out_path}  ({len(rows):,} rows)\n")


def main():
    settings = load_env()
    start_day = date.fromisoformat(settings["START_DAY"])
    end_day = date.fromisoformat(settings["END_DAY"])
    if start_day > end_day:
        raise SystemExit("START_DAY is later than END_DAY")
    if end_day >= date.today():
        raise SystemExit("END_DAY must be earlier than today: "
                         "the data for the current day is still incomplete")

    download_swaps(settings["RPC_URL"], settings["POOL"], start_day, end_day,
                   os.path.join(HERE, "pool_swaps.csv"))
    download_candles(settings["BINANCE_SYMBOL"], start_day, end_day,
                     os.path.join(HERE, "binance_candles.csv"))
    download_book(settings["BASE_RPC_URL"], settings["HANJI_API"], settings["HANJI_MARKET"],
                  settings["HANJI_QUOTER"], settings["HANJI_PROXY"],
                  int(settings["HANJI_BOOK_STEP_MIN"]), start_day, end_day,
                  os.path.join(HERE, "hanji_book.csv"))


if __name__ == "__main__":
    main()
