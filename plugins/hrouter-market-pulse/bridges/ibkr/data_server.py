"""Long-lived, read-only TWS / IB Gateway market-data session (ib_async).

Started by the workbench service. JSON requests, one per line on stdin:
    {"id": 1, "op": "quotes", "symbols": ["AAPL"]}
JSON responses, one per line on stdout, prefixed so library logs can never be mistaken for one:
    HROUTER_IBKR_DATA={"id": 1, "ok": true, "data": {...}}

US stocks only. The session never places or cancels orders (read-only API session, separate client
id from order execution). Market data type 3 is requested: TWS sends live data where the login has a
subscription and 15-minute delayed data where it does not; every quote says which one it is.
"""
import asyncio
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

PREFIX = "HROUTER_IBKR_DATA="
SYMBOL = re.compile(r"[A-Z][A-Z0-9.\-]{0,14}")
DELAY_MINUTES = 15
MAX_SUBSCRIPTIONS = 90
SCAN_CODES = {"TOP_PERC_GAIN", "TOP_PERC_LOSE", "MOST_ACTIVE", "MOST_ACTIVE_USD", "HOT_BY_VOLUME", "TOP_TRADE_RATE", "HIGH_VS_52W_HL", "LOW_VS_52W_HL"}
BAR_SIZES = {"1 min", "5 mins", "15 mins", "30 mins", "1 hour", "1 day", "1 week"}
WHAT = {"TRADES", "ADJUSTED_LAST", "MIDPOINT"}


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) and n >= 0 else None
    except (TypeError, ValueError):
        return None


def readable(message):
    text = str(message or "")
    if "\\u" in text:
        try:
            return text.encode("latin-1", "backslashreplace").decode("unicode_escape")
        except Exception:
            return text
    return text


def iso(moment):
    if moment is None:
        return None
    if isinstance(moment, datetime):
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(moment)


class Session:
    def __init__(self, sdk, host, port, client_id):
        self.sdk, self.host, self.port, self.client_id = sdk, host, port, client_id
        self.ib = sdk.IB()
        self.contracts, self.tickers, self.used = {}, {}, {}
        self.last_error, self.connected_at = None, None
        self.history_lock = None  # created inside the event loop (Python 3.9 needs a running loop)
        self.cache = {}
        self.ib.errorEvent += self.on_error

    def on_error(self, req_id, code, message, *rest):
        text = readable(message)
        if code in (2104, 2106, 2107, 2108, 2119, 2158, 10167, 300, 354, 10089, 10090, 10168, 200) or (code == 162 and "scanner subscription cancelled" in text):
            return  # farm notices, delayed-data notices, cancelled ids, per-symbol permission and lookup errors (reported per quote)
        self.last_error = {"code": code, "message": text[:300], "at": iso(datetime.now(timezone.utc))}

    async def keep_connected(self):
        while True:
            if not self.ib.isConnected():
                try:
                    await self.ib.connectAsync(self.host, self.port, clientId=self.client_id, timeout=15, readonly=True)
                    self.ib.reqMarketDataType(3)
                    self.connected_at = iso(datetime.now(timezone.utc))
                    self.contracts.clear(); self.tickers.clear(); self.used.clear(); self.cache.clear()
                except Exception as error:
                    self.last_error = {"code": "connect", "message": f"{type(error).__name__}: {error}"[:300], "at": iso(datetime.now(timezone.utc))}
            await asyncio.sleep(10)

    def require(self):
        if not self.ib.isConnected():
            raise RuntimeError("TWS / IB Gateway is not connected" + (f": {self.last_error['message']}" if self.last_error else ""))

    async def contract(self, symbol):
        if not isinstance(symbol, str) or not SYMBOL.fullmatch(symbol):
            raise ValueError(f"Invalid US stock symbol {symbol!r}")
        if symbol not in self.contracts:
            qualified = await self.ib.qualifyContractsAsync(self.sdk.Stock(symbol, "SMART", "USD"))
            qualified = [c for c in qualified if c is not None]
            if len(qualified) != 1 or qualified[0].secType != "STK" or qualified[0].currency != "USD":
                raise ValueError(f"{symbol} is not one unambiguous USD stock at IB")
            self.contracts[symbol] = qualified[0]
        return self.contracts[symbol]

    def quote_row(self, symbol, ticker):
        kind = ticker.marketDataType  # ib_async defaults to 1 before TWS says; only trusted once a price arrived
        delayed = kind in (3, 4)
        price = number(ticker.last) or number(ticker.marketPrice())
        received = ticker.time or datetime.now(timezone.utc)
        as_of = received - timedelta(minutes=DELAY_MINUTES) if delayed else received
        return {"symbol": symbol, "price": price, "bid": number(ticker.bid), "ask": number(ticker.ask),
                "previousClose": number(ticker.close), "open": number(ticker.open), "high": number(ticker.high), "low": number(ticker.low),
                "volume": number(ticker.volume), "asOf": iso(as_of), "receivedAt": iso(received),
                "marketDataType": kind, "delayed": delayed, "delayMinutes": DELAY_MINUTES if delayed else 0, "frozen": kind in (2, 4)}

    async def bar_quote(self, symbol):
        """The latest 1-minute bar as a quote, for symbols TWS streams nothing for (no subscription on this login)."""
        data = await self.bars(symbol, "1800 S", "1 min", "TRADES", False)
        if not data["bars"]:
            return None
        last = data["bars"][-1]
        ended = datetime.fromisoformat(last["date"].replace("Z", "+00:00")) + timedelta(minutes=1)
        lag = max(0, (datetime.now(timezone.utc) - ended).total_seconds() / 60)
        return {"symbol": symbol, "price": last["close"], "bid": None, "ask": None, "previousClose": None, "open": None, "high": last["high"], "low": last["low"],
                "volume": None, "asOf": iso(ended), "receivedAt": iso(datetime.now(timezone.utc)), "marketDataType": None,
                "delayed": lag > 2, "delayMinutes": round(lag) if lag > 2 else 0, "frozen": False, "basis": "1-minute bar"}

    async def quotes(self, symbols, wait=4.0, bar_fallback=60):
        self.require()
        symbols = list(dict.fromkeys(symbols))[:60]
        out, errors = [], {}
        for symbol in symbols:
            try:
                contract = await self.contract(symbol)
                if symbol not in self.tickers:
                    if len(self.tickers) >= MAX_SUBSCRIPTIONS:
                        oldest = min(self.used, key=self.used.get)
                        self.ib.cancelMktData(self.contracts[oldest]); self.tickers.pop(oldest, None); self.used.pop(oldest, None)
                    self.tickers[symbol] = self.ib.reqMktData(contract, "", False, False)
                self.used[symbol] = time.time()
            except Exception as error:
                errors[symbol] = str(error)[:200]
        deadline = time.time() + wait
        while time.time() < deadline and any(self.quote_row(s, self.tickers[s])["price"] is None for s in symbols if s in self.tickers):
            await asyncio.sleep(0.1)
        fallbacks = 0
        for symbol in symbols:
            if symbol in self.tickers:
                row = self.quote_row(symbol, self.tickers[symbol])
                if row["price"] is not None:
                    out.append({**row, "basis": "stream"})
                    continue
                if fallbacks < bar_fallback:
                    fallbacks += 1
                    try:
                        bar = await self.bar_quote(symbol)
                        if bar:
                            out.append(bar)
                            continue
                    except Exception as error:
                        errors[symbol] = f"No streamed price and no recent bars: {error}"[:200]
                        continue
                errors[symbol] = "No price from TWS (no market data permission, halted, or not traded yet)"
        return {"quotes": out, "errors": errors}

    async def bars(self, symbol, duration, bar_size, what, use_rth):
        self.require()
        if bar_size not in BAR_SIZES or what not in WHAT or not re.fullmatch(r"\d{1,5} [SDWMY]", duration or ""):
            raise ValueError("Unsupported bar request")
        key = (symbol, duration, bar_size, what, use_rth)
        ttl = 600 if bar_size in ("1 day", "1 week") else 60
        hit = self.cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        contract = await self.contract(symbol)
        self.history_lock = self.history_lock or asyncio.Lock()
        async with self.history_lock:  # IB paces historical requests; one at a time
            rows = await self.ib.reqHistoricalDataAsync(contract, "", duration, bar_size, what, use_rth, 1, False, [], timeout=30)
        data = {"symbol": symbol, "barSize": bar_size, "what": what, "useRTH": use_rth,
                "bars": [{"date": iso(b.date) if isinstance(b.date, datetime) else str(b.date), "open": b.open, "high": b.high, "low": b.low, "close": b.close, "volume": number(b.volume), "average": number(b.average)} for b in rows or []]}
        self.cache[key] = (time.time(), data)
        return data

    async def scan(self, code, rows, above_price, above_volume, market_cap_above):
        self.require()
        if code not in SCAN_CODES:
            raise ValueError("Unsupported scan code")
        sub = self.sdk.ScannerSubscription(instrument="STK", locationCode="STK.US.MAJOR", scanCode=code, numberOfRows=max(1, min(50, int(rows))),
                                           abovePrice=above_price or 0.0, aboveVolume=int(above_volume or 0), marketCapAbove=market_cap_above or 0.0)
        found = await self.ib.reqScannerDataAsync(sub)
        symbols = [r.contractDetails.contract.symbol for r in found if SYMBOL.fullmatch(r.contractDetails.contract.symbol or "")]
        names = {r.contractDetails.contract.symbol: r.contractDetails.longName for r in found}
        for r in found:
            self.contracts.setdefault(r.contractDetails.contract.symbol, r.contractDetails.contract)
        quotes = await self.quotes(symbols, wait=3, bar_fallback=12)
        by_symbol = {q["symbol"]: q for q in quotes["quotes"]}
        return {"scanCode": code, "rows": [{"rank": i + 1, "symbol": s, "name": names.get(s) or s, **({k: v for k, v in by_symbol[s].items() if k != "symbol"} if s in by_symbol else {})} for i, s in enumerate(symbols)]}

    def status(self):
        live = [t.marketDataType for t in self.tickers.values() if number(t.last) or number(t.close)]
        return {"connected": self.ib.isConnected(), "connectedAt": self.connected_at, "clientId": self.client_id, "port": self.port,
                "subscriptions": len(self.tickers), "liveQuotes": sum(1 for k in live if k == 1), "delayedQuotes": sum(1 for k in live if k in (3, 4)),
                "lastError": self.last_error}


async def handle(session, request):
    op = request.get("op")
    if op == "status":
        return session.status()
    if op == "quotes":
        return await session.quotes(request.get("symbols") or [], float(request.get("wait", 4)))
    if op == "bars":
        return await session.bars(request.get("symbol"), request.get("duration", "1 Y"), request.get("barSize", "1 day"), request.get("what", "TRADES"), bool(request.get("useRTH", True)))
    if op == "scan":
        return await session.scan(request.get("scanCode"), request.get("rows", 30), request.get("abovePrice"), request.get("aboveVolume"), request.get("marketCapAbove"))
    raise ValueError("Unsupported op")


def reply(payload):
    sys.stdout.write(PREFIX + json.dumps(payload, ensure_ascii=False, allow_nan=False, default=str) + "\n")
    sys.stdout.flush()


async def serve(session):
    asyncio.get_running_loop().create_task(session.keep_connected())
    reader = asyncio.StreamReader()
    await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    async def run(request):
        try:
            reply({"id": request.get("id"), "ok": True, "data": await handle(session, request)})
        except Exception as error:
            reply({"id": request.get("id"), "ok": False, "error": f"{error}"[:600]})

    while True:
        line = await reader.readline()
        if not line:
            break  # the service went away
        try:
            request = json.loads(line)
        except ValueError:
            continue
        asyncio.get_running_loop().create_task(run(request))


def main():
    port, client_id = int(os.environ.get("HROUTER_IBKR_PORT", "7497")), int(os.environ.get("HROUTER_IBKR_DATA_CLIENT_ID", "72"))
    import ib_async as sdk
    asyncio.run(serve(Session(sdk, "127.0.0.1", port, client_id)))


if __name__ == "__main__":
    main()
