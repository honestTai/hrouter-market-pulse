"""One-shot, loopback-only Futu SIMULATE adapter. Never unlocks or uses REAL.
JSON input on stdin, one prefixed JSON response on stdout (SDK may log).
"""
import json
import math
import re
import sys
import time

PREFIX = "HROUTER_FUTU_RESULT="


class DispatchedError(RuntimeError):
    dispatched = True



def records(result):
    ret, data = result
    if ret != 0:
        raise RuntimeError(str(data)[:1200])
    return data.to_dict("records")


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def stock_code(value, market):
    pattern = r"HK\.\d{5}" if market == "HK" else r"US\.[A-Z][A-Z0-9.\-]{0,14}"
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError("Invalid security code / 市场与证券代码不匹配")
    return value


def order_row(row):
    return {
        "orderId": str(row.get("order_id", "")), "code": row.get("code"),
        "name": row.get("stock_name"), "side": row.get("trd_side"),
        "status": row.get("order_status"), "quantity": number(row.get("qty")),
        "price": number(row.get("price")), "filledQuantity": number(row.get("dealt_qty")),
        "filledAveragePrice": number(row.get("dealt_avg_price")) if (number(row.get("dealt_qty")) or 0) > 0 else None,
        "createdAt": row.get("create_time"), "updatedAt": row.get("updated_time"),
        "remark": row.get("remark", ""),
    }


def run(request, sdk=None):
    if request.get("environment") != "SIMULATE":
        raise ValueError("Only SIMULATE is permitted; REAL is permanently disabled")
    if request.get("host") != "127.0.0.1":
        raise ValueError("Only loopback OpenD is permitted")
    port = request.get("port", 11111)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Invalid OpenD port")
    market = request.get("market", "HK")
    if market not in ("HK", "US"):
        raise ValueError("Only HK and US equity simulation is supported")
    action = request.get("action")
    if action not in ("accounts", "snapshot", "submit", "cancel"):
        raise ValueError("Unsupported action")
    if sdk is None:
        try:
            import futu as sdk
            from importlib.metadata import version
            if version("futu-api") != "10.11.7108":
                raise RuntimeError("Unsupported Futu SDK version; use pinned bridges/futu/requirements.txt")
        except ImportError as error:
            raise RuntimeError("Futu SDK missing. Install bridges/futu/requirements.txt in a venv and set HROUTER_FUTU_PYTHON.") from error
    ctx = sdk.OpenSecTradeContext(filter_trdmarket=getattr(sdk.TrdMarket, market), host="127.0.0.1", port=port)
    try:
        # Never use acc_index / default acc_id; filter real accounts before returning any data.
        accounts = [r for r in records(ctx.get_acc_list())
                    if r.get("trd_env") == sdk.TrdEnv.SIMULATE
                    and r.get("sim_acc_type") in ("STOCK", "STOCK_AND_OPTION")
                    and market in r.get("trdmarket_auth", [])]
        if action == "accounts":
            return {"accounts": [{"accountId": str(r["acc_id"]), "market": market,
                                   "environment": "SIMULATE", "type": r["sim_acc_type"]} for r in accounts]}
        account_id = request.get("accountId")
        if not isinstance(account_id, str) or not re.fullmatch(r"[1-9]\d{0,19}", account_id):
            raise ValueError("Explicit simulation account ID required")
        if not any(str(r["acc_id"]) == account_id for r in accounts):
            raise ValueError("Account is not a permitted SIMULATE equity account for this market")
        options = {"trd_env": sdk.TrdEnv.SIMULATE, "acc_id": int(account_id)}
        currency = "HKD" if market == "HK" else "USD"
        if action == "snapshot":
            funds = records(ctx.accinfo_query(**options, currency=getattr(sdk.Currency, currency)))
            positions = records(ctx.position_list_query(**options, currency=getattr(sdk.Currency, currency)))
            orders = records(ctx.order_list_query(**options))
            f = funds[0] if funds else {}
            if f.get("currency") != currency:
                raise ValueError("Broker funds currency does not match requested currency")
            return {"accountId": account_id, "market": market, "currency": currency,
                    "funds": {"totalAssets": number(f.get("total_assets")), "cash": number(f.get("hk_cash" if market == "HK" else "us_cash")) if number(f.get("hk_cash" if market == "HK" else "us_cash")) is not None else number(f.get("cash")),
                              "marketValue": number(f.get("market_val")), "frozenCash": number(f.get("frozen_cash"))},
                    "positions": [{"code": r.get("code"), "name": r.get("stock_name"),
                                   "currency": r.get("currency"), "quantity": number(r.get("qty")), "canSellQuantity": number(r.get("can_sell_qty")),
                                   "costPrice": number(r.get("cost_price")) if r.get("cost_price_valid") is True else None,
                                   "marketValue": number(r.get("market_val")),
                                   "unrealizedPnl": number(r.get("unrealized_pl"))}
                                  for r in positions if str(r.get("code", "")).startswith(market + ".")],
                    "orders": [order_row(r) for r in orders if str(r.get("code", "")).startswith(market + ".")],
                    "orderScope": "Futu current order list; not complete historical fills",
                    "sourceTimezone": "Asia/Hong_Kong" if market == "HK" else "America/New_York"}
        if action == "submit":
            code = stock_code(request.get("code"), market)
            quantity, price = request.get("quantity"), request.get("limitPrice")
            if type(quantity) is not int or not 0 < quantity <= 1000000:
                raise ValueError("Quantity must be a positive whole share count")
            if type(price) not in (int, float) or not math.isfinite(price) or not 0 < price <= 1000000:
                raise ValueError("Invalid limit price")
            if request.get("side") not in ("BUY", "SELL"):
                raise ValueError("Only BUY or long-position SELL supported")
            remark = request.get("remark", "")
            if not re.fullmatch(r"hrouter:[0-9a-f-]{36}", remark):
                raise ValueError("Missing trace ID")
            deadline = request.get("quoteValidUntil")
            if type(deadline) not in (float, int) or not math.isfinite(deadline) or not time.time() * 1000 < deadline <= time.time() * 1000 + 305000:
                raise ValueError("Valid live-quote expiry required")
            quote_ctx = sdk.OpenQuoteContext(host="127.0.0.1", port=port)
            try:
                basics = records(quote_ctx.get_stock_basicinfo(market=getattr(sdk.Market, market),
                                 stock_type=sdk.SecurityType.STOCK, code_list=[code]))
                basic = next((r for r in basics if r.get("code") == code), None)
                if not basic or basic.get("stock_type") != sdk.SecurityType.STOCK:
                    raise ValueError("Only verified stock securities are supported; no options/warrants")
                lot = number(basic.get("lot_size"))
                if lot is None or lot < 1 or quantity % lot != 0:
                    raise ValueError("Quantity does not match current broker board lot")
            finally:
                quote_ctx.close()
            # Broker-calculated cash-only capacity accounts for fees, buying-power
            # rules and lots; never use max_cash_and_margin_buy or max_sell_short.
            capacities = records(ctx.acctradinginfo_query(order_type=sdk.OrderType.NORMAL,
                                 price=price, code=code, **options))
            capacity = capacities[0] if capacities else {}
            maximum = number(capacity.get("max_cash_buy" if request["side"] == "BUY" else "max_position_sell"))
            if maximum is None or quantity > maximum:
                raise ValueError("Broker cash-only / long-position capacity exceeded or unavailable")
            # Recheck sell availability immediately before dispatch. No opening shorts.
            if request["side"] == "SELL":
                positions = records(ctx.position_list_query(code=code, **options))
                available = sum(number(r.get("can_sell_qty")) or 0 for r in positions if r.get("code") == code)
                if quantity > available:
                    raise ValueError("Insufficient sellable quantity; short selling is disabled")
            if time.time() * 1000 >= deadline:
                raise ValueError("Quote expired during broker checks; no order dispatched")
            try:
                result = records(ctx.place_order(price=price, qty=quantity, code=code,
                                 trd_side=getattr(sdk.TrdSide, request["side"]), order_type=sdk.OrderType.NORMAL,
                                 remark=remark, time_in_force=sdk.TimeInForce.DAY,
                                 fill_outside_rth=False, **options))
                if len(result) != 1 or not result[0].get("order_id"):
                    raise RuntimeError("No unambiguous order acknowledgement; reconcile before retrying")
            except Exception as error:
                raise DispatchedError(str(error)) from error
            return {"orders": [order_row(r) for r in result]}
        order_id = request.get("orderId")
        if not isinstance(order_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", order_id):
            raise ValueError("Invalid order ID")
        orders = records(ctx.order_list_query(order_id=order_id, **options))
        order = next((r for r in orders if str(r.get("order_id")) == order_id), None)
        if not order or not str(order.get("code", "")).startswith(market + "."):
            raise ValueError("Order does not belong to selected simulation account and market")
        if order.get("order_status") not in ("SUBMITTED", "FILLED_PART"):
            raise ValueError("Order is not in a cancellable state")
        try:
            rows = records(ctx.modify_order(modify_order_op=sdk.ModifyOrderOp.CANCEL, order_id=order_id,
                           qty=0, price=0, **options))
        except Exception as error:
            raise DispatchedError(str(error)) from error
        return {"orders": [order_row(r) for r in rows], "cancelRequested": True}
    finally:
        try:
            ctx.close()
        except Exception:
            pass


def main():
    try:
        request = json.loads(sys.stdin.read(16384))
        result = {"ok": True, "data": run(request)}
    except Exception as error:
        result = {"ok": False, "error": str(error)[:1600], "dispatched": bool(getattr(error, "dispatched", False))}
    print("\n" + PREFIX + json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
