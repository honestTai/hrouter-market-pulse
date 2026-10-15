import React from "react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import "./styles.css";
import App from "./App.jsx";

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return <div className="boot-error" role="alert"><h1>Hrouter Market Pulse</h1><p>界面暂不可用 / The workspace could not render.</p><pre>{this.state.error.message}</pre><button onClick={() => window.location.reload()}>重新加载 / Reload</button></div>;
    return this.props.children;
  }
}
let report;
try { report = JSON.parse(document.getElementById("report-data").textContent); }
catch { report = { items: [], empty: true }; }
createRoot(document.getElementById("app")).render(<ErrorBoundary><App initialReport={report} initialView={new URL(window.location.href).searchParams.get("view") || "market"} /></ErrorBoundary>);
