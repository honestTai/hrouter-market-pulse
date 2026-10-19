"""Offline contract tests for bridges/ibkr/bridge.py. A fake ib_async module; nothing connects."""
import importlib.util
import pathlib
import time
import types
import unittest

spec = importlib.util.spec_from_file_location("ibkr_bridge", pathlib.Path(__file__).parents[1] / "bridges/ibkr/bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

NS = types.SimpleNamespace


class FakeIB:
    def __init__(self, world):
        self.world = world
        self.placed = []
        self.cancelled = []

    def connect(self, host, port, clientId, timeout, readonly, account):
        assert host == "127.0.0.1"
        self.world["connect"] = {"port": port, "clientId": clientId, "readonly": readonly, "account": account}
        if self.world.get("down"):
            raise ConnectionRefusedError("refused")

    def managedAccounts(self): return self.world["accounts"]
    def accountSummary(self, account): return [NS(account=account, tag="TotalCashValue", value=str(self.world["cash"]), currency="USD"), NS(account=account, tag="NetLiquidation", value="50000", currency="USD")]
    def portfolio(self, account): return []
    def positions(self, account): return [NS(contract=NS(conId=265598, symbol="AAPL", secType="STK", currency="USD"), position=self.world["held"], avgCost=200.0)]
    def reqAllOpenOrders(self): return self.world.get("open", [])
    def reqCompletedOrders(self, apiOnly):
        if self.world.get("completed_hangs"):
            raise TimeoutError()
        return []

    def reqExecutions(self):
        return [NS(contract=NS(symbol="AAPL"), execution=NS(execId="0001", acctNumber="DU1234567", permId=1234567, orderRef="hrouter:x", side="BOT", shares=1, price=200.5, time="2026-10-19 14:00:00"))]
    def openTrades(self): return self.world.get("open", [])

    def qualifyContracts(self, contract):
        return [NS(conId=265598, symbol=contract.symbol, secType="STK", currency="USD")] if contract.symbol == "AAPL" else []

    def placeOrder(self, contract, order):
        self.placed.append(order)
        if self.world.get("broker_error"):
            raise RuntimeError("socket closed")
        order.permId = 0 if self.world.get("no_ack") or self.world.get("read_only") else 1234567
        placed = trade(contract, order, "ValidationError" if self.world.get("read_only") else "Submitted")
        if self.world.get("read_only"):
            placed.log = [NS(message="Warning 321: \\u539f\\u56e0 - API\\u63a5\\u53e3\\u73b0\\u5904\\u4e8e\\u53ea\\u8bfb\\u6a21\\u5f0f")]
        return placed

    def cancelOrder(self, order): self.cancelled.append(order.permId)
    def sleep(self, seconds): pass
    def disconnect(self): self.world["disconnected"] = True


def trade(contract, order, status):
    return NS(contract=contract, order=order, orderStatus=NS(status=status, filled=0, remaining=order.totalQuantity, avgFillPrice=0), log=[])


def sdk(world):
    holder = {}

    def make():
        holder["ib"] = FakeIB(world)
        return holder["ib"]
    module = NS(IB=make, Stock=lambda symbol, exchange, currency: NS(symbol=symbol, exchange=exchange, currency=currency),
                LimitOrder=lambda action, qty, price, **kw: NS(action=action, totalQuantity=qty, lmtPrice=price, orderType="LMT", permId=0, orderId=7, **kw))
    return module, holder


def request(**overrides):
    base = {"host": "127.0.0.1", "port": 7497, "clientId": 71, "environment": "PAPER", "action": "accounts"}
    base.update(overrides)
    return base


def order_request(**overrides):
    values = {"action": "submit", "accountId": "DU1234567", "symbol": "AAPL", "side": "BUY", "quantity": 10, "limitPrice": 200.0,
              "orderRef": "hrouter:12345678-1234-1234-1234-123456789012", "quoteValidUntil": time.time() * 1000 + 60000}
    values.update(overrides)
    return request(**values)


class BridgeTest(unittest.TestCase):
    def world(self, **overrides):
        base = {"accounts": ["DU1234567", "U7654321"], "cash": 10000, "held": 5}
        base.update(overrides)
        return base

    def test_accounts_returns_only_the_requested_environment(self):
        module, _ = sdk(self.world())
        self.assertEqual(bridge.run(request(), module)["accounts"], [{"accountId": "DU1234567", "environment": "PAPER"}])
        self.assertEqual(bridge.run(request(environment="LIVE"), module)["accounts"], [{"accountId": "U7654321", "environment": "LIVE"}])

    def test_reads_use_a_read_only_session(self):
        world = self.world()
        module, _ = sdk(world)
        bridge.run(request(action="snapshot", accountId="DU1234567"), module)
        self.assertTrue(world["connect"]["readonly"])
        self.assertTrue(world["disconnected"])

    def test_snapshot_survives_a_hanging_completed_orders_request(self):
        module, _ = sdk(self.world(completed_hangs=True))
        snap = bridge.run(request(action="snapshot", accountId="DU1234567"), module)
        self.assertEqual(snap["executions"][0]["side"], "BUY")
        self.assertTrue(snap["notes"])

    def test_live_account_cannot_be_used_as_paper_and_vice_versa(self):
        module, _ = sdk(self.world())
        with self.assertRaises(ValueError):
            bridge.run(order_request(accountId="U7654321"), module)
        with self.assertRaises(ValueError):
            bridge.run(order_request(environment="LIVE", accountId="DU1234567"), module)

    def test_rejects_non_loopback_hosts(self):
        module, _ = sdk(self.world())
        with self.assertRaises(ValueError):
            bridge.run(request(host="10.0.0.2"), module)

    def test_buy_places_a_day_limit_order_inside_regular_hours(self):
        world = self.world()
        module, holder = sdk(world)
        result = bridge.run(order_request(), module)
        order = holder["ib"].placed[0]
        self.assertEqual((order.tif, order.outsideRth, order.account, order.transmit), ("DAY", False, "DU1234567", True))
        self.assertFalse(world["connect"]["readonly"])
        self.assertEqual(result["orders"][0]["orderId"], "1234567")

    def test_buy_needs_settled_cash_and_sell_needs_a_long_position(self):
        module, holder = sdk(self.world(cash=100))
        with self.assertRaises(ValueError):
            bridge.run(order_request(), module)
        self.assertEqual(holder["ib"].placed, [])
        module, holder = sdk(self.world(held=5))
        with self.assertRaises(ValueError):
            bridge.run(order_request(side="SELL", quantity=6), module)
        self.assertEqual(holder["ib"].placed, [])

    def test_unknown_contract_and_expired_quote_never_dispatch(self):
        module, holder = sdk(self.world())
        with self.assertRaises(ValueError):
            bridge.run(order_request(symbol="ZZZZ"), module)
        with self.assertRaises(ValueError):
            bridge.run(order_request(quoteValidUntil=time.time() * 1000 - 1), module)
        self.assertEqual(holder["ib"].placed, [])

    def test_broker_failure_after_dispatch_is_marked_dispatched(self):
        for flag in ("broker_error", "no_ack"):
            module, _ = sdk(self.world(**{flag: True}))
            with self.assertRaises(bridge.DispatchedError):
                bridge.run(order_request(), module)

    def test_cancel_only_this_clients_open_orders_for_the_account(self):
        order = NS(action="BUY", totalQuantity=10, lmtPrice=200.0, orderType="LMT", tif="DAY", permId=1234567, orderId=7, account="DU1234567", orderRef="hrouter:x")
        open_trade = trade(NS(symbol="AAPL", secType="STK", currency="USD"), order, "Submitted")
        module, holder = sdk(self.world(open=[open_trade]))
        self.assertTrue(bridge.run(request(action="cancel", accountId="DU1234567", orderId="1234567"), module)["cancelRequested"])
        self.assertEqual(holder["ib"].cancelled, [1234567])
        with self.assertRaises(ValueError):
            bridge.run(request(action="cancel", accountId="DU1234567", orderId="999"), module)

    def test_tws_refusal_is_a_plain_rejection_with_its_reason(self):
        module, _ = sdk(self.world(read_only=True))
        with self.assertRaisesRegex(ValueError, "只读模式") as caught:
            bridge.run(order_request(), module)
        self.assertFalse(getattr(caught.exception, "dispatched", False))

    def test_connection_failure_says_how_to_fix_it(self):
        module, _ = sdk(self.world(down=True))
        with self.assertRaisesRegex(RuntimeError, "enable the API socket"):
            bridge.run(request(), module)


if __name__ == "__main__":
    unittest.main()
