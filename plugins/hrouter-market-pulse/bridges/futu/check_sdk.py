"""Verify the installed official API shapes without opening any connection."""
from importlib.metadata import version
from inspect import signature
import json
import futu

assert version("futu-api") == "10.11.7108", "Use the pinned SDK version"
common = {"trd_env": futu.TrdEnv.SIMULATE, "acc_id": 1}
checks = [
    (futu.OpenSecTradeContext, {"filter_trdmarket": futu.TrdMarket.US, "host": "127.0.0.1", "port": 11111}),
    (futu.OpenQuoteContext, {"host": "127.0.0.1", "port": 11111}),
]
for cls, kwargs in checks:
    signature(cls).bind(**kwargs)
for method, kwargs in [
    (futu.OpenSecTradeContext.get_acc_list, {}),
    (futu.OpenSecTradeContext.accinfo_query, {**common, "currency": futu.Currency.USD}),
    (futu.OpenSecTradeContext.position_list_query, {**common, "currency": futu.Currency.HKD}),
    (futu.OpenSecTradeContext.order_list_query, {**common, "order_id": "1"}),
    (futu.OpenSecTradeContext.acctradinginfo_query, {**common, "order_type": futu.OrderType.NORMAL, "price": 1, "code": "US.AAPL"}),
    (futu.OpenSecTradeContext.place_order, {**common, "price": 1, "qty": 1, "code": "US.AAPL", "trd_side": futu.TrdSide.BUY, "order_type": futu.OrderType.NORMAL, "remark": "test", "time_in_force": futu.TimeInForce.DAY, "fill_outside_rth": False}),
    (futu.OpenSecTradeContext.modify_order, {**common, "modify_order_op": futu.ModifyOrderOp.CANCEL, "order_id": "1", "qty": 0, "price": 0}),
    (futu.OpenQuoteContext.get_stock_basicinfo, {"market": futu.Market.US, "stock_type": futu.SecurityType.STOCK, "code_list": ["US.AAPL"]}),
]:
    signature(method).bind(None, **kwargs)
print(json.dumps({"sdk": "futu-api", "version": version("futu-api"), "apiShapesVerified": True, "connected": False, "ordersSent": 0}))
