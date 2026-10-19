"""Verify the installed ib_async API shapes the bridge relies on, without opening any connection."""
from importlib.metadata import version
from inspect import signature
import json
import ib_async

assert version("ib_async") == "2.1.0", "Use the pinned ib_async version"
IB = ib_async.IB
for method, kwargs in [
    (IB.connect, {"host": "127.0.0.1", "port": 7497, "clientId": 71, "timeout": 15, "readonly": True, "account": "DU1234567"}),
    (IB.managedAccounts, {}),
    (IB.accountSummary, {"account": "DU1234567"}),
    (IB.portfolio, {"account": "DU1234567"}),
    (IB.positions, {"account": "DU1234567"}),
    (IB.reqAllOpenOrders, {}),
    (IB.reqCompletedOrders, {"apiOnly": True}),
    (IB.qualifyContracts, {}),
    (IB.placeOrder, {"contract": None, "order": None}),
    (IB.openTrades, {}),
    (IB.cancelOrder, {"order": None}),
    (IB.sleep, {}),
    (IB.disconnect, {}),
]:
    signature(method).bind(None, **kwargs)
signature(ib_async.Stock).bind("AAPL", "SMART", "USD")
order = ib_async.LimitOrder("BUY", 1, 1.0, tif="DAY", outsideRth=False, account="DU1234567", orderRef="hrouter:test", transmit=True)
assert (order.orderType, order.tif, order.outsideRth, order.account, order.orderRef) == ("LMT", "DAY", False, "DU1234567", "hrouter:test")
assert hasattr(ib_async.OrderStatus(), "avgFillPrice") and hasattr(ib_async.OrderStatus(), "remaining")
print(json.dumps({"sdk": "ib_async", "version": version("ib_async"), "apiShapesVerified": True, "connected": False, "ordersSent": 0}))
