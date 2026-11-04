#!/usr/bin/env python3
"""Generatore indipendente dei valori di riferimento per gli indicatori 5m.

Implementazione Python pura (nessuna dipendenza) degli stessi algoritmi definiti in
src/utils/indicators.ts. Serve SOLO a produrre la fixture di test:
    src/utils/__tests__/fixtures/indicator_reference.json

Uso:
    python3 scripts/indicator_reference.py

Convenzioni (identiche al modulo TS):
- ATR di Wilder (RMA) del True Range, seed = media semplice dei primi `period` TR.
- Supertrend: bande basic HL2 +/- factor*ATR, bande finali con trailing, direzione +1/-1.
- ADX di Wilder su TR/+DM/-DM; ADX seed = media semplice dei primi `period` DX.
- StochRSI: RSI Wilder(14), raw su 14, %K = SMA(raw, 3), %D = SMA(%K, 3).
- PSAR 0.02/0.02/0.20 con clamp sui due estremi precedenti.
"""
import json
import os

MS = 60_000
# 2026-11-04 e sessione precedente 2026-11-03: US in ora solare (EST, UTC-5)
# 09:30 ET = 14:30 UTC; 16:00 ET = 21:00 UTC.
BASE_UTC_MS = 1_793_802_600_000  # 2026-11-04 14:30:00 UTC (09:30 ET, EST = UTC-5)


def lcg(seed):
    state = seed & 0x7FFFFFFF

    def nxt():
        nonlocal state
        state = (state * 1103515245 + 12345) % (2 ** 31)
        return state / (2 ** 31)

    return nxt


def make_bars():
    """Serie deterministica con trend e oscillazione: produce flip, ADX e StochRSI non degeneri."""
    import math

    rand = lcg(20261104)
    bars = []
    # 78 barre della sessione precedente (2026-11-03) + 78 della sessione corrente
    sessions = [
        (BASE_UTC_MS - 86_400_000, 78),
        (BASE_UTC_MS, 78),
    ]
    idx = 0
    for start_ms, count in sessions:
        for i in range(count):
            mid = 100.0 + 6.0 * math.sin(idx / 9.0) + 0.03 * idx + (rand() - 0.5) * 0.7
            open_p = mid - (rand() - 0.5) * 0.3
            close_p = mid + (rand() - 0.5) * 0.3
            high = max(open_p, close_p) + 0.15 + rand() * 0.35
            low = min(open_p, close_p) - 0.15 - rand() * 0.35
            volume = 1000 + int(rand() * 4000)
            bars.append(
                {
                    "t": start_ms + i * 5 * MS,
                    "o": round(open_p, 6),
                    "h": round(high, 6),
                    "l": round(low, 6),
                    "c": round(close_p, 6),
                    "v": volume,
                }
            )
            idx += 1
    return bars


def true_range(bars):
    tr = [None] * len(bars)
    for i in range(1, len(bars)):
        pc = bars[i - 1]["c"]
        tr[i] = max(bars[i]["h"] - bars[i]["l"], abs(bars[i]["h"] - pc), abs(bars[i]["l"] - pc))
    return tr


def atr_series(bars, period=14):
    tr = true_range(bars)
    out = [None] * len(bars)
    if len(bars) <= period:
        return out
    seed = sum(tr[i] for i in range(1, period + 1))
    rma = seed / period
    out[period] = rma
    for i in range(period + 1, len(bars)):
        rma = (rma * (period - 1) + tr[i]) / period
        out[i] = rma
    return out


def supertrend(bars, period=14, factor=3.0):
    atr = atr_series(bars, period)
    upper = [None] * len(bars)
    lower = [None] * len(bars)
    direction = [None] * len(bars)
    last_dir = 1
    flip_index = None
    for i in range(len(bars)):
        a = atr[i]
        if a is None:
            continue
        hl2 = (bars[i]["h"] + bars[i]["l"]) / 2
        basic_upper = hl2 + factor * a
        basic_lower = hl2 - factor * a
        if i == 0 or upper[i - 1] is None or lower[i - 1] is None:
            upper[i] = basic_upper
            lower[i] = basic_lower
            direction[i] = 1
            last_dir = 1
            continue
        prev_upper = upper[i - 1]
        prev_lower = lower[i - 1]
        upper[i] = basic_upper if (basic_upper < prev_upper or bars[i - 1]["c"] > prev_upper) else prev_upper
        lower[i] = basic_lower if (basic_lower > prev_lower or bars[i - 1]["c"] < prev_lower) else prev_lower
        if bars[i]["c"] > prev_upper:
            last_dir = 1
        elif bars[i]["c"] < prev_lower:
            last_dir = -1
        if direction[i - 1] is not None and last_dir != direction[i - 1]:
            flip_index = i
        direction[i] = last_dir
    last = len(bars) - 1
    return {
        "direction": direction[last],
        "barsSinceFlip": (last - flip_index) if flip_index is not None else None,
        "value": lower[last] if direction[last] == 1 else upper[last],
    }


def adx(bars, period=14):
    tr = true_range(bars)
    plus_dm = [0.0] * len(bars)
    minus_dm = [0.0] * len(bars)
    for i in range(1, len(bars)):
        up = bars[i]["h"] - bars[i - 1]["h"]
        down = bars[i - 1]["l"] - bars[i]["l"]
        plus_dm[i] = up if (up > down and up > 0) else 0.0
        minus_dm[i] = down if (down > up and down > 0) else 0.0

    tr_s = sum(tr[i] for i in range(1, period + 1))
    plus_s = sum(plus_dm[i] for i in range(1, period + 1))
    minus_s = sum(minus_dm[i] for i in range(1, period + 1))

    adx_value = None
    adx_sum = 0.0
    adx_count = 0
    last = None
    for i in range(period, len(bars)):
        if i > period:
            tr_s = tr_s - tr_s / period + tr[i]
            plus_s = plus_s - plus_s / period + plus_dm[i]
            minus_s = minus_s - minus_s / period + minus_dm[i]
        pdi = (100 * plus_s / tr_s) if tr_s > 0 else 0.0
        mdi = (100 * minus_s / tr_s) if tr_s > 0 else 0.0
        di_sum = pdi + mdi
        dx = (100 * abs(pdi - mdi) / di_sum) if di_sum > 0 else 0.0
        if adx_value is None:
            adx_sum += dx
            adx_count += 1
            if adx_count == period:
                adx_value = adx_sum / period
                last = (adx_value, pdi, mdi)
        else:
            adx_value = (adx_value * (period - 1) + dx) / period
            last = (adx_value, pdi, mdi)
    return {"value": last[0], "plusDI": last[1], "minusDI": last[2]}


def wilder_rsi(closes, period=14):
    out = [None] * len(closes)
    if len(closes) <= period:
        return out
    gain = 0.0
    loss = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            gain += d
        else:
            loss += abs(d)
    avg_gain = gain / period
    avg_loss = loss / period
    out[period] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        g = d if d > 0 else 0.0
        l = abs(d) if d < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + g) / period
        avg_loss = (avg_loss * (period - 1) + l) / period
        out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return out


def sma(values, end, length):
    start = end - length + 1
    if start < 0:
        return None
    total = 0.0
    for i in range(start, end + 1):
        v = values[i]
        if v is None:
            return None
        total += v
    return total / length


def stoch_rsi(bars, rsi_len=14, stoch_len=14, k_period=3, d_period=3):
    closes = [b["c"] for b in bars]
    rsi = wilder_rsi(closes, rsi_len)
    raw = [None] * len(bars)
    for i in range(len(bars)):
        if rsi[i] is None:
            continue
        start = i - stoch_len + 1
        if start < 0:
            continue
        window = rsi[start : i + 1]
        if any(v is None for v in window):
            continue
        lo, hi = min(window), max(window)
        raw[i] = 50.0 if hi == lo else (rsi[i] - lo) / (hi - lo) * 100
    k_serie = [sma(raw, i, k_period) for i in range(len(bars))]
    d_serie = [sma(k_serie, i, d_period) for i in range(len(bars))]
    last = len(bars) - 1
    return {"k": k_serie[last], "d": d_serie[last]}


def psar(bars, start=0.02, step=0.02, maximum=0.20):
    series = [None] * len(bars)
    is_long = True
    sar = 0.0
    ep = 0.0
    af = start
    flip_index = 0
    initialised = False
    for i in range(len(bars)):
        if not initialised:
            if i < 1:
                continue
            is_long = bars[i]["c"] >= bars[i - 1]["c"]
            sar = bars[i - 1]["l"] if is_long else bars[i - 1]["h"]
            ep = bars[i]["h"] if is_long else bars[i]["l"]
            af = start
            flip_index = i
            initialised = True
            series[i] = sar
            continue
        sar = sar + af * (ep - sar)
        if is_long:
            prev_low = bars[i - 1]["l"]
            prev2_low = bars[i - 2]["l"] if i >= 2 else prev_low
            sar = min(sar, prev_low, prev2_low)
            if bars[i]["l"] < sar:
                is_long = False
                sar = ep
                ep = bars[i]["l"]
                af = start
                flip_index = i
            elif bars[i]["h"] > ep:
                ep = bars[i]["h"]
                af = min(maximum, af + step)
        else:
            prev_high = bars[i - 1]["h"]
            prev2_high = bars[i - 2]["h"] if i >= 2 else prev_high
            sar = max(sar, prev_high, prev2_high)
            if bars[i]["h"] > sar:
                is_long = True
                sar = ep
                ep = bars[i]["h"]
                af = start
                flip_index = i
            elif bars[i]["l"] < ep:
                ep = bars[i]["l"]
                af = min(maximum, af + step)
        series[i] = sar
    last = len(bars) - 1
    return {
        "value": sar,
        "direction": 1 if is_long else -1,
        "barsSinceFlip": last - flip_index,
    }


def main():
    bars = make_bars()
    atr = atr_series(bars)
    payload = {
        "meta": {
            "generatedBy": "scripts/indicator_reference.py",
            "bars": len(bars),
            "note": "Valori di riferimento indipendenti (Python) per i test di src/utils/indicators.ts",
        },
        "bars": bars,
        "expected": {
            "atr": atr[-1],
            "supertrend": supertrend(bars),
            "adx": adx(bars),
            "stochRsi": stoch_rsi(bars),
            "psar": psar(bars),
        },
    }
    out_dir = os.path.join("src", "utils", "__tests__", "fixtures")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "indicator_reference.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1)
    print(f"scritto {out_path} con {len(bars)} barre")
    print(json.dumps(payload["expected"], indent=1))


if __name__ == "__main__":
    main()
