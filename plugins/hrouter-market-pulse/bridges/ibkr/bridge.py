"""One-shot, loopback-only Interactive Brokers adapter for TWS / IB Gateway (ib_async).

JSON request on stdin, one prefixed JSON response on stdout. US stocks only, DAY limit orders,
long positions only (no shorts, no margin buys). PAPER accounts (DU…) and LIVE accounts (U…) are
never mixed: the requested environment must match the account prefix, and the JavaScript side
only sends LIVE orders after the owner confirms each one in the dashboard.
"""
import json
import math
import re
import sys
import time

PREFIX = "HROUTER_IBKR_RESULT="
ACCOUNT_PATTERNS = {"PAPER": r"D[UF]\d{1,12}", "LIVE": r"U\d{4,12}"}
SYMBOL = r"[A-Z][A-Z0-9.\-]{0,14}"
ACTIVE = ("ApiPending", "PendingSubmit", "PreSubmitted", "Submitted", "PendingCancel")
ACKNOWLEDGED = ("PreSubmitted", "Submitted", "Filled", "PendingCancel", "ApiCancelled", "Cancelled", "Inactive")


class DispatchedError(RuntimeError):
    dispatched = True


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def readable(message):
    """TWS sends non-ASCII text as \\uXXXX escapes; turn them back into characters."""
    text = str(message or "")
    if "\\u" in text:
        try:
            return text.encode("latin-1", "backslashreplace").decode("unicode_escape")
        except Exception:
            return text
    return text


def order_row(trade):
    order, status, contract = trade.order, trade.orderStatus, trade.contract
    filled = number(getattr(status, "filled", None))
    return {
        "orderId": str(order.permId) if getattr(order, "permId", 0) else None,
        "clientOrderId": order.orderId, "account": order.account, "symbol": contract.symbol,
        "secType": contract.secType, "currency": contract.currency, "side": order.action,
        "quantity": number(order.totalQuantity), "price": number(getattr(order, "lmtPrice", None)),
        "orderType": order.orderType, "tif": order.tif, "status": status.status,
        "filledQuantity": filled, "remaining": number(getattr(status, "remaining", None)),
        "filledAveragePrice": number(status.avgFillPrice) if (filled or 0) > 0 else None,
        "orderRef": getattr(order, "orderRef", "") or "",
        "messages": [readable(entry.message) for entry in getattr(trade, "log", []) if getattr(entry, "message", "")][-3:],
    }


def check_request(request):
    if request.get("host") != "127.0.0.1":
        raise ValueError("Only a loopback TWS / IB Gateway is permitted")
    port, client_id = request.get("port"), request.get("clientId")
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Invalid TWS / IB Gateway port")
    if type(client_id) is not int or not 1 <= client_id <= 32000:
        raise ValueError("Invalid API client ID")
    environment = request.get("environment")
    if environment not in ACCOUNT_PATTERNS:
        raise ValueError("Environment must be PAPER or LIVE")
    action = request.get("action")
    if action not in ("accounts", "snapshot", "submit", "cancel"):
        raise ValueError("Unsupported action")
    account = request.get("accountId")
    if action != "accounts" and (not isinstance(account, str) or not re.fullmatch(ACCOUNT_PATTERNS[environment], account)):
        raise ValueError(f"A {environment} account ID is required ({'DU…' if environment == 'PAPER' else 'U…'})")
    return port, client_id, environment, action, account


def summary_values(ib, account):
    values = {}
    for row in ib.accountSummary(account):
        if row.account == account and row.currency in ("USD", "BASE", ""):
            values.setdefault(row.tag, number(row.value))
    return values


def run(request, sdk=None):
    port, client_id, environment, action, account = check_request(request)
    if sdk is None:
        try:
            import ib_async as sdk
            from importlib.metadata import version
            if version("ib_async") != "2.1.0":
                raise RuntimeError("Unsupported ib_async version; use the pinned bridges/ibkr/requirements.txt")
        except ImportError as error:
            raise RuntimeError("ib_async missing. Run npm run setup:ibkr and point the IBKR settings at that Python.") from error
    ib = sdk.IB()
    try:
        try:
            # Reads use a read-only session so they can never place or cancel anything.
            ib.connect("127.0.0.1", port, clientId=client_id, timeout=15, readonly=action in ("accounts", "snapshot"), account=account or "")
        except Exception as error:
            raise RuntimeError(f"Cannot reach TWS / IB Gateway on 127.0.0.1:{port}. Start it, log in, enable the API socket and allow 127.0.0.1 ({type(error).__name__}: {error})") from error
        managed = [a for a in ib.managedAccounts() if isinstance(a, str)]
        matching = [a for a in managed if re.fullmatch(ACCOUNT_PATTERNS[environment], a)]
        if action == "accounts":
            return {"accounts": [{"accountId": a, "environment": environment} for a in matching],
                    "otherEnvironmentAccounts": len(managed) - len(matching)}
        if account not in matching:
            raise ValueError(f"Account is not a {environment} account of this TWS / IB Gateway login")
        if action == "snapshot":
            values = summary_values(ib, account)
            portfolio = {item.contract.conId: item for item in ib.portfolio(account)}
            positions = []
            for row in ib.positions(account):
                c = row.contract
                item = portfolio.get(c.conId)
                positions.append({"symbol": c.symbol, "secType": c.secType, "currency": c.currency, "quantity": number(row.position),
                                  "averageCost": number(row.avgCost), "marketPrice": number(getattr(item, "marketPrice", None)),
                                  "marketValue": number(getattr(item, "marketValue", None)), "unrealizedPnl": number(getattr(item, "unrealizedPNL", None))})
            trades, notes = list(ib.reqAllOpenOrders()), []
            # Some TWS builds (the demo system among them) never finish the completed-orders
            # list; read it best-effort and rely on executions for fills when it does not answer.
            ib.RequestTimeout = 10
            try:
                trades += list(ib.reqCompletedOrders(True))
            except Exception:
                notes.append("TWS did not return completed orders; fills come from today's executions")
            try:
                fills = [f for f in ib.reqExecutions() if f.execution.acctNumber == account]
            except Exception:
                fills, notes = [], notes + ["TWS did not return executions"]
            ib.RequestTimeout = 0
            seen, orders = set(), []
            for trade in trades:
                row = order_row(trade)
                key = row["orderId"] or f"client:{row['clientOrderId']}"
                if row["account"] == account and key not in seen:
                    seen.add(key)
                    orders.append(row)
            return {"accountId": account, "environment": environment, "currency": "USD",
                    "funds": {"netLiquidation": values.get("NetLiquidation"), "cash": values.get("TotalCashValue"),
                              "availableFunds": values.get("AvailableFunds"), "buyingPower": values.get("BuyingPower"),
                              "marketValue": values.get("GrossPositionValue")},
                    "positions": positions, "orders": orders,
                    "executions": [{"orderId": str(f.execution.permId) if f.execution.permId else None, "orderRef": getattr(f.execution, "orderRef", "") or "",
                                    "symbol": f.contract.symbol, "side": "BUY" if f.execution.side == "BOT" else "SELL", "quantity": number(f.execution.shares),
                                    "price": number(f.execution.price), "time": str(f.execution.time)} for f in fills],
                    "notes": notes,
                    "orderScope": "IB open orders, completed API orders when TWS returns them, and today's executions; not a full fill history"}
        if action == "submit":
            symbol, side = request.get("symbol"), request.get("side")
            quantity, price = request.get("quantity"), request.get("limitPrice")
            if not isinstance(symbol, str) or not re.fullmatch(SYMBOL, symbol):
                raise ValueError("Invalid US stock symbol")
            if side not in ("BUY", "SELL"):
                raise ValueError("Only BUY or long-position SELL supported")
            if type(quantity) is not int or not 0 < quantity <= 1000000:
                raise ValueError("Quantity must be a positive whole share count")
            if type(price) not in (int, float) or not math.isfinite(price) or not 0 < price <= 1000000:
                raise ValueError("Invalid limit price")
            reference = request.get("orderRef", "")
            if not isinstance(reference, str) or not re.fullmatch(r"hrouter:[0-9a-f-]{36}", reference):
                raise ValueError("Missing trace ID")
            deadline = request.get("quoteValidUntil")
            if type(deadline) not in (float, int) or not math.isfinite(deadline) or not time.time() * 1000 < deadline <= time.time() * 1000 + 305000:
                raise ValueError("Valid live-quote expiry required")
            qualified = ib.qualifyContracts(sdk.Stock(symbol, "SMART", "USD"))
            if len(qualified) != 1 or qualified[0].secType != "STK" or qualified[0].currency != "USD":
                raise ValueError("Only one unambiguous USD common stock contract is supported")
            contract = qualified[0]
            held = sum(number(p.position) or 0 for p in ib.positions(account) if p.contract.conId == contract.conId)
            if side == "SELL" and quantity > held:
                raise ValueError("Insufficient long position; short selling is disabled")
            if side == "BUY":
                cash = summary_values(ib, account).get("TotalCashValue")
                if cash is None or cash < quantity * price:
                    raise ValueError("Settled cash does not cover this buy; margin is not used")
            if time.time() * 1000 >= deadline:
                raise ValueError("Quote expired during broker checks; no order dispatched")
            order = sdk.LimitOrder(side, quantity, price, tif="DAY", outsideRth=False, account=account, orderRef=reference, transmit=True)
            try:
                trade = ib.placeOrder(contract, order)
                for _ in range(80):
                    if trade.orderStatus.status in ACKNOWLEDGED and trade.order.permId:
                        break
                    ib.sleep(0.25)
            except Exception as error:
                raise DispatchedError(str(error)) from error
            row = order_row(trade)
            # Refused by TWS before transmission (read-only API, invalid order, precautions):
            # nothing reached the exchange, so report a plain rejection with TWS's reason.
            if not row["orderId"] and row["status"] in ("ValidationError", "Inactive", "Cancelled", "ApiCancelled"):
                raise ValueError("TWS rejected the order before sending it: " + ("; ".join(row["messages"]) or row["status"]))
            if not row["orderId"] or row["status"] not in ACKNOWLEDGED:
                raise DispatchedError("No unambiguous acknowledgement from IB; reconcile before retrying")
            return {"orders": [row]}
        order_id = request.get("orderId")
        if not isinstance(order_id, str) or not re.fullmatch(r"\d{1,20}", order_id):
            raise ValueError("Invalid IB permanent order ID")
        trade = next((t for t in ib.openTrades() if str(t.order.permId) == order_id), None)
        if not trade or trade.order.account != account:
            raise ValueError("Order is not an open order of this API client and account (orders from other clients must be cancelled in TWS)")
        if trade.orderStatus.status not in ACTIVE:
            raise ValueError("Order is not in a cancellable state")
        try:
            ib.cancelOrder(trade.order)
            ib.sleep(1)
        except Exception as error:
            raise DispatchedError(str(error)) from error
        return {"orders": [order_row(trade)], "cancelRequested": True}
    finally:
        try:
            ib.disconnect()
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
