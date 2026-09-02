#!/usr/bin/env python3
"""
Скачивает исходные данные для бэктеста в два CSV.

  pool_swaps.csv       все сделки пула Uniswap за период
  binance_candles.csv  посекундные свечи Binance за тот же период

Ничего не требует, кроме стандартной библиотеки. Настройки — в .env рядом.
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

# Хеш сигнатуры события Swap. По нему нода отбирает нужные логи.
SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"

# Arbitrum выпускает примерно 4 блока в секунду.
BLOCKS_PER_SECOND = 4

# С какого размера окна начинаем. В тихие часы такое проходит целиком,
# в активные нода упирается в свой лимит и окно делится пополам.
CHUNK_BLOCKS = 20_000

# Без этого и нода, и архив Binance отвечают 403: они отсекают запросы,
# которые представляются стандартным клиентом Python.
HEADERS = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}

# Минимальная пауза между запросами к ноде. Дешевле подождать, чем ловить 429
# и потом стоять минуту в выдержке.
MIN_INTERVAL = 0.15

_last_call = 0.0


def load_env():
    """Читает .env рядом со скриптом в обычный словарь."""
    settings = {}
    with open(os.path.join(HERE, ".env")) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, _, value = line.partition("=")
            settings[key.strip()] = value.strip()
    return settings


def rpc(url, method, params, attempts=10, timeout=45):
    """
    Один вызов JSON-RPC к ноде.

    Публичная нода ограничивает частоту и отвечает 429. Скрипт делает сотни
    запросов, поэтому здесь и пауза перед каждым, и длинная выдержка при отказе.
    """
    global _last_call

    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    for attempt in range(attempts):
        # Не частим: держим минимальный интервал между любыми запросами.
        wait = MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()

        try:
            request = urllib.request.Request(url, data=payload.encode(), headers=HEADERS)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                answer = json.loads(response.read())
            if "error" in answer:
                raise RuntimeError(answer["error"])
            return answer["result"]
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == attempts - 1:
                raise
            # Нода иногда сама говорит, сколько ждать.
            retry_after = error.headers.get("Retry-After")
            pause = float(retry_after) if retry_after and retry_after.isdigit() else min(60, 2 ** attempt)
            print(f"    429, жду {pause:.0f} с (попытка {attempt + 1}/{attempts})")
            time.sleep(pause)
    raise RuntimeError("unreachable")


def signed(word, bits):
    """Слово из 32 байт в знаковое целое: старший бит означает минус."""
    value = int(word, 16)
    return value - (1 << bits) if value >= (1 << (bits - 1)) else value


_block_times = {}


def block_time(url, number):
    """
    Время блока в секундах.

    Двоичный поиск и границы кусков спрашивают одни и те же блоки помногу раз,
    поэтому ответы запоминаем — это заметно сокращает число запросов.
    """
    if number not in _block_times:
        block = rpc(url, "eth_getBlockByNumber", [hex(number), False])
        _block_times[number] = int(block["timestamp"], 16)
    return _block_times[number]


def midnight(day):
    """Полночь UTC указанной даты, в секундах."""
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())


def block_at_time(url, target, head, head_time):
    """
    Первый блок не раньше указанного времени.

    Сначала прикидываем номер по средней скорости блоков, потом уточняем
    двоичным поиском. Окно вокруг оценки расширяем, пока оно не накроет цель:
    скорость блоков не постоянна, и на дистанции в недели фиксированного
    запаса не хватает — поиск молча упирался бы в край и возвращал не тот блок.
    """
    guess = head - int((head_time - target) * BLOCKS_PER_SECOND)
    margin = 3600 * BLOCKS_PER_SECOND              # начальный запас — час
    while True:
        low, high = max(1, guess - margin), min(head, guess + margin)
        if block_time(url, low) <= target <= block_time(url, high):
            break
        if low <= 1 and high >= head:
            break                                   # шире уже некуда
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
    Логи за диапазон блоков, дробя его при необходимости.

    Нода отказывает по двум причинам: больше 10 000 логов в ответе или
    слишком долгий запрос. Обе лечатся одинаково — делим окно пополам,
    пока не пройдёт.
    """
    try:
        return rpc(url, "eth_getLogs", [{
            "address": pool,
            "topics": [SWAP_TOPIC],
            "fromBlock": hex(start),
            "toBlock": hex(stop),
        }])
    except (RuntimeError, TimeoutError, urllib.error.URLError) as error:
        # Нода отказывает по трём причинам, и все три означают "окно слишком
        # широкое": больше 10 000 логов, слишком долгий запрос на её стороне,
        # обрыв по таймауту на нашей. Реакция одна — поделить пополам.
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

    # Границы совпадают с сутками свечей Binance, иначе периоды двух
    # источников разъедутся и слить их в одну ленту будет нельзя.
    first = block_at_time(url, midnight(start_day), head, head_time)
    last = block_at_time(url, midnight(end_day + timedelta(days=1)), head, head_time) - 1

    print(f"свопы: {start_day} .. {end_day} UTC")
    print(f"       блоки {first}..{last}  ({last - first:,})")
    head = last

    rows = []
    start = first
    while start <= head:
        stop = min(start + CHUNK_BLOCKS - 1, head)

        logs = fetch_logs(url, pool, start, stop)

        # Время каждого блока по отдельности спрашивать слишком дорого, поэтому
        # берём время на краях куска и раскладываем блоки внутри равномерно.
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
                "amount0": signed(words[0], 256),      # + пришло в пул, − ушло
                "amount1": signed(words[1], 256),
                "sqrt_price_x96": int(words[2], 16),   # цена ПОСЛЕ сделки
                "liquidity": int(words[3], 16),        # активная L в этот момент
                # tick объявлен как int24, но в логе лежит расширенным
                # до полных 32 байт — читать надо как знаковое 256-битное.
                "tick": signed(words[4], 256),
            })

        print(f"  {start}..{stop}  +{len(logs)}  всего {len(rows):,}")
        start = stop + 1

    rows.sort(key=lambda row: (row["block"], row["log_index"]))
    with open(out_path, "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"  -> {out_path}  ({len(rows):,} строк)\n")


def download_candles(symbol, start_day, end_day, out_path):
    """Посекундные свечи из открытого архива Binance. Ключи не нужны."""
    print(f"свечи Binance {symbol}: {start_day} .. {end_day}")
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
            # Файл за самые свежие сутки появляется с задержкой в несколько часов.
            print(f"  {day}  пропуск: {error}")
            day += timedelta(days=1)
            continue

        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            name = archive.namelist()[0]
            for record in csv.reader(io.TextIOWrapper(archive.open(name))):
                rows.append({
                    "timestamp": int(record[0]) // 1_000_000,  # микросекунды -> секунды
                    "open": record[1],
                    "high": record[2],
                    "low": record[3],
                    "close": record[4],
                    "volume": record[5],
                    "trades": record[8],
                })
        print(f"  {day}  всего {len(rows):,}")
        day += timedelta(days=1)

    with open(out_path, "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"  -> {out_path}  ({len(rows):,} строк)\n")


def main():
    settings = load_env()
    start_day = date.fromisoformat(settings["START_DAY"])
    end_day = date.fromisoformat(settings["END_DAY"])
    if start_day > end_day:
        raise SystemExit("START_DAY позже END_DAY")
    if end_day >= date.today():
        raise SystemExit("END_DAY должен быть раньше сегодняшнего дня: "
                         "данные за текущие сутки ещё неполные")

    download_swaps(settings["RPC_URL"], settings["POOL"], start_day, end_day,
                   os.path.join(HERE, "pool_swaps.csv"))
    download_candles(settings["BINANCE_SYMBOL"], start_day, end_day,
                     os.path.join(HERE, "binance_candles.csv"))


if __name__ == "__main__":
    main()
