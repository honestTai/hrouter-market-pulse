"""Offline SDK contract tests. Never import/connect the installed Futu SDK."""
import importlib.util
import pathlib
import types
import unittest
import time

spec = importlib.util.spec_from_file_location("bridge", pathlib.Path(__file__).parents[1] / "bridges/futu/bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Frame:
    def __init__(self, rows): self.rows = rows
    def to_dict(self, kind):
        assert kind == "records"
        return self.rows


def result(rows): return (0, Frame(rows))


class Context:
    def __init__(self):
        self.calls = []
        self.closed = False
        self.real_only = False
        self.capacity = 100
        self.positions = []
        self.broker_error = False
        self.stock_type = "STOCK"
        self.lot = 1
        self.account_id = 123456789012345678
    def get_acc_list(self):
        return result([{"acc_id": self.account_id, "trd_env": "REAL" if self.real_only else "SIMULATE", "sim_acc_type": "STOCK", "trdmarket_auth": ["US"]},
                       {"acc_id": 99, "trd_env": "REAL", "sim_acc_type": "STOCK", "trdmarket_auth": ["US"]},
                       {"acc_id": 88, "trd_env": "SIMULATE", "sim_acc_type": "OPTION", "trdmarket_auth": ["US"]}])
    def checked(self, method, kw):
        assert kw["trd_env"] == "SIMULATE", kw
        assert kw["acc_id"] == self.account_id, kw
        self.calls.append((method, kw))
    def accinfo_query(self, **kw):
        self.checked("funds", kw)
        assert kw["currency"] == "USD"
        return result([{"currency": "USD", "cash": 10000, "us_cash": 9999, "total_assets": 10000, "market_val": 0}])
    def position_list_query(self, **kw):
        self.checked("positions", kw)
        return result(self.positions)
    def order_list_query(self, **kw):
        self.checked("orders", kw)
        return result([{"order_id": "1001", "code": "US.AAPL", "order_status": "SUBMITTED", "trd_side": "BUY", "qty": 1, "price": 100}])
    def acctradinginfo_query(self, **kw):
        self.checked("capacity", kw)
        return result([{"max_cash_buy": self.capacity, "max_position_sell": self.capacity, "max_cash_and_margin_buy": 1000000}])
    def get_stock_basicinfo(self, **kw):
        assert kw["stock_type"] == "STOCK"
        return result([{"code": "US.AAPL", "stock_type": self.stock_type, "lot_size": self.lot}])
    def place_order(self, **kw):
        self.checked("place", kw)
        assert kw["time_in_force"] == "DAY"
        assert kw["fill_outside_rth"] is False
        if self.broker_error: raise RuntimeError("lost response")
        return result([{"order_id": "1002", "code": kw["code"], "trd_side": kw["trd_side"], "order_status": "SUBMITTED", "qty": kw["qty"], "price": kw["price"], "dealt_qty": 0, "remark": kw["remark"]}])
    def modify_order(self, **kw):
        self.checked("cancel", kw)
        assert kw["modify_order_op"] == "CANCEL"
        return result([{"order_id": kw["order_id"]}])
    def close(self): self.closed = True


def sdk(ctx):
    def create(**kw):
        assert kw["host"] == "127.0.0.1" and kw["port"] == 11111
        return ctx
    return types.SimpleNamespace(OpenSecTradeContext=create, OpenQuoteContext=create,
        TrdMarket=types.SimpleNamespace(US="US", HK="HK"), Market=types.SimpleNamespace(US="US", HK="HK"),
        TrdEnv=types.SimpleNamespace(SIMULATE="SIMULATE"), Currency=types.SimpleNamespace(USD="USD", HKD="HKD"),
        TrdSide=types.SimpleNamespace(BUY="BUY", SELL="SELL"), OrderType=types.SimpleNamespace(NORMAL="NORMAL"),
        TimeInForce=types.SimpleNamespace(DAY="DAY"), ModifyOrderOp=types.SimpleNamespace(CANCEL="CANCEL"),
        SecurityType=types.SimpleNamespace(STOCK="STOCK"))


class Contracts(unittest.TestCase):
    def setUp(self):
        self.ctx = Context()
        self.base = {"environment": "SIMULATE", "host": "127.0.0.1", "port": 11111, "market": "US", "accountId": str(self.ctx.account_id)}
        self.order = {**self.base, "action": "submit", "code": "US.AAPL", "side": "BUY", "quantity": 10, "limitPrice": 100, "quoteValidUntil": time.time() * 1000 + 30000, "remark": "hrouter:01234567-0123-4123-a123-012345678901"}
    def run_bridge(self, req): return bridge.run(req, sdk(self.ctx))
    def test_real_and_remote_rejected_before_sdk_creation(self):
        for patch in [{"environment": "REAL"}, {"host": "example.com"}, {"market": "CN"}, {"port": 0}]:
            with self.assertRaises(ValueError): self.run_bridge({**self.order, **patch})
        self.assertEqual(self.ctx.calls, [])
    def test_only_stock_simulation_accounts_exposed_without_real_identifiers(self):
        data = self.run_bridge({**self.base, "action": "accounts"})
        self.assertEqual([r["accountId"] for r in data["accounts"]], [str(self.ctx.account_id)])
        self.assertNotIn("card_num", str(data))
    def test_actual_account_revalidated_every_mutation(self):
        self.ctx.real_only = True
        with self.assertRaises(ValueError): self.run_bridge(self.order)
        self.assertFalse(any(n == "place" for n, _ in self.ctx.calls))
    def test_account_must_be_explicit_exact_string(self):
        for value in [0, "0", None, str(self.ctx.account_id + 1)]:
            with self.assertRaises(ValueError): self.run_bridge({**self.order, "accountId": value})
    def test_snapshot_never_queries_default_real_environment_or_wrong_currency(self):
        data = self.run_bridge({**self.base, "action": "snapshot"})
        self.assertEqual(data["funds"]["cash"], 9999)
        self.assertTrue(self.ctx.closed)
        self.assertEqual(data["accountId"], str(self.ctx.account_id))
        for name, kw in self.ctx.calls: self.assertEqual(kw["trd_env"], "SIMULATE")
    def test_submit_uses_cash_only_capacity_day_limit_and_preserves_broker_state(self):
        data = self.run_bridge(self.order)
        self.assertEqual(data["orders"][0]["status"], "SUBMITTED")
        self.assertEqual(data["orders"][0]["filledQuantity"], 0)
        self.assertTrue(self.ctx.closed)
    def test_no_cash_margin_fallback(self):
        self.ctx.capacity = 0
        with self.assertRaises(ValueError): self.run_bridge(self.order)
        self.assertFalse(any(n == "place" for n, _ in self.ctx.calls))
    def test_short_selling_cannot_open_without_sellable_long_shares(self):
        with self.assertRaises(ValueError): self.run_bridge({**self.order, "side": "SELL"})
        self.ctx.positions = [{"code": "US.AAPL", "can_sell_qty": 10}]
        self.assertEqual(self.run_bridge({**self.order, "side": "SELL"})["orders"][0]["side"], "SELL")
    def test_option_or_wrong_board_lot_refused(self):
        self.ctx.stock_type = "OPTION"
        with self.assertRaises(ValueError): self.run_bridge(self.order)
        self.ctx.stock_type = "STOCK"; self.ctx.lot = 100
        with self.assertRaises(ValueError): self.run_bridge(self.order)
    def test_error_after_dispatch_is_explicitly_uncertain(self):
        self.ctx.broker_error = True
        with self.assertRaises(bridge.DispatchedError) as error: self.run_bridge(self.order)
        self.assertTrue(error.exception.dispatched)
    def test_cancel_rechecks_account_and_order(self):
        self.assertTrue(self.run_bridge({**self.base, "action": "cancel", "orderId": "1001"})["cancelRequested"])
        with self.assertRaises(ValueError): self.run_bridge({**self.base, "action": "cancel", "orderId": "other"})
    def test_quote_expired_at_bridge_cannot_dispatch(self):
        with self.assertRaises(ValueError): self.run_bridge({**self.order, "quoteValidUntil": time.time() * 1000 - 1})
        self.assertFalse(any(n == "place" for n, _ in self.ctx.calls))
    def test_invalid_inputs_never_reach_place(self):
        for patch in [{"code": "HK.00700"}, {"quantity": True}, {"quantity": 0}, {"limitPrice": float("nan")}, {"remark": "missing"}]:
            with self.assertRaises(ValueError): self.run_bridge({**self.order, **patch})
        self.assertFalse(any(n == "place" for n, _ in self.ctx.calls))


if __name__ == "__main__": unittest.main()
