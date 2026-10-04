import React, { createContext, useContext } from "react";
import { formatNumber, formatCompact, formatPercent, formatDate, localized } from "./data.mjs";
export const WorkspaceContext = createContext(null);
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace provider is required");
  const { language } = context;
  return { ...context, en: language === "en", t: (zh, en) => language === "en" ? en : zh,
    number: (v, d = 2) => formatNumber(v, d, language), compact: (v) => formatCompact(v, language),
    percent: (v) => formatPercent(v, language), date: (v, timeOnly) => formatDate(v, language, timeOnly),
    local: (v) => localized(v, language) };
}
