"""Offline tests for bridges/ibkr/data_server.py with a fake ib_async. Nothing connects to TWS."""
import asyncio
import importlib.util
import math
import pathlib
import types
import unittest
from datetime import datetime, timedelta, timezone

spec = importlib.util.spec_from_file_location("data_server", pathlib.Path(__file__).parents[1] / "bridges/ibkr/data_server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
NS = types.SimpleNamespace
NOW = datetime.now(timezone.utc)


class Event:
    def __iadd__(self, handler): return self


class FakeIB:
    def __init__(self, tickers):
        self.errorEvent = Event()
        self.tickers = tickers

    def isConnected(self): return True
    async def qualifyContractsAsync(self, contract): return [NS(symbol=contract.symbol, secType="STK", currency="USD", conId=1)]
    def reqMktData(self, contract, *args): return self.tickers[contract.symbol]
    def cancelMktData(self, contract): pass

    async def reqHistoricalDataAsync(self, contract, end, duration, size, what, rth, fmt, keep, opts, timeout):
        start = NOW - timedelta(minutes=20)
        return [NS(date=start + timedelta(minutes=i), open=10, high=11, low=9, close=10 + i / 100, volume=100, average=10) for i in range(5)]


def ticker(last, kind, received=NOW):
    return NS(last=last, bid=last, ask=last, close=9.5, open=9.6, high=11, low=9, volume=1000, time=received, marketDataType=kind, marketPrice=lambda: last)


def session(tickers):
    s = server.Session(NS(IB=lambda: FakeIB(tickers), Stock=lambda symbol, exchange, currency: NS(symbol=symbol)), "127.0.0.1", 7497, 72)
    return s


class DataServerTest(unittest.TestCase):
    def test_live_quote_is_marked_live(self):
        out = asyncio.run(session({"AAPL": ticker(200.0, 1)}).quotes(["AAPL"], wait=0.1))
        row = out["quotes"][0]
        self.assertEqual((row["delayed"], row["delayMinutes"], row["basis"]), (False, 0, "stream"))

    def test_delayed_quote_is_marked_and_dated_back(self):
        row = asyncio.run(session({"AAPL": ticker(200.0, 3)}).quotes(["AAPL"], wait=0.1))["quotes"][0]
        self.assertTrue(row["delayed"])
        self.assertEqual(row["delayMinutes"], 15)
        as_of = datetime.fromisoformat(row["asOf"].replace("Z", "+00:00"))
        self.assertAlmostEqual((NOW - as_of).total_seconds(), 900, delta=2)

    def test_no_stream_falls_back_to_the_latest_bar_with_its_real_time(self):
        row = asyncio.run(session({"NVDA": ticker(math.nan, 3)}).quotes(["NVDA"], wait=0.1))["quotes"][0]
        self.assertEqual(row["basis"], "1-minute bar")
        self.assertEqual(row["price"], 10.04)
        self.assertTrue(row["delayed"])
        self.assertGreaterEqual(row["delayMinutes"], 14)

    def test_rejects_bad_symbols_and_bar_requests(self):
        s = session({})
        out = asyncio.run(s.quotes(["bad symbol"], wait=0.1))
        self.assertIn("bad symbol", out["errors"])
        with self.assertRaises(ValueError):
            asyncio.run(s.bars("AAPL", "1 Y", "3 days", "TRADES", True))


if __name__ == "__main__":
    unittest.main()
