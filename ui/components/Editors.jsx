import React, { useId, useState } from "react";
import { Badge, Button, Callout, Dialog, Flex, IconButton, Select, TextArea, TextField } from "@radix-ui/themes";
import { Check, Plus, Save, ShieldCheck, Trash2, X } from "lucide-react";
import { useWorkspace } from "../context.jsx";
import { api, collectEvidence } from "../data.mjs";
import { ErrorNotice } from "./Primitives.jsx";

function Field({ label, children, hint, full = false }) {
  const id = useId();
  return <div className={`form-field ${full ? "full" : ""}`}><label htmlFor={id}>{label}</label>{React.cloneElement(children, { id })}{hint && <small className="muted">{hint}</small>}</div>;
}
function SettingsForm({ finish, fail, submitting }) {
  const { preferences, language, colorConvention, t, savePreferences } = useWorkspace();
  const [symbols, setSymbols] = useState((preferences.watchlist || []).join(", "));
  const [lang, setLang] = useState(language);
  const [colors, setColors] = useState(colorConvention);
  const [positions, setPositions] = useState(() => (preferences.positions || []).map((p, i) => ({ ...p, rowKey: `saved-${i}`, invalidation: p.invalidationPrice ?? p.stopPrice ?? "" })));
  const update = (index, field, value) => setPositions((rows) => rows.map((r, i) => i === index ? { ...r, [field]: value } : r));
  const submit = async (event) => {
    event.preventDefault();
    try {
      const watchlist = [...new Set(symbols.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean))];
      if (watchlist.length > 50) throw new Error(t("最多保存 50 只自选股。", "Save at most 50 watchlist symbols."));
      const parsed = positions.map(({ rowKey, invalidation, ...p }) => {
        const quantity = Number(p.quantity); const averageCost = Number(p.averageCost);
        if (!p.symbol?.trim() || p.quantity === "" || !Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(averageCost) || averageCost <= 0)
          throw new Error(t("每条持仓需要代码、非负数量和大于零的平均成本。", "Each position requires a symbol, nonnegative quantity and positive average cost."));
        const result = { ...p, symbol: p.symbol.trim().toUpperCase(), quantity, averageCost };
        if (invalidation !== "") {
          if (!(Number(invalidation) > 0) || !Number.isFinite(Number(invalidation))) throw new Error(t("失效参考价必须大于零。", "Invalidation price must be positive."));
          result.invalidationPrice = Number(invalidation);
        }
        return result;
      });
      await finish(() => savePreferences({ watchlist, language: lang, positions: parsed }, colors));
    } catch (error) { fail(error.message); }
  };
  return <form onSubmit={submit}><fieldset disabled={submitting} className="editor-fieldset"><div className="form-grid"><Field full label={t("自选股代码", "Watchlist symbols")} hint={t("使用逗号、空格或换行分隔。例如：600519、0700.HK、AAPL。", "Separate with commas, spaces or newlines. Example: 600519, 0700.HK, AAPL.")}><TextArea rows={3} value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder="600519, 0700.HK, AAPL" /></Field><Field label={t("语言", "Language")}><select className="native-select" value={lang} onChange={(e) => setLang(e.target.value)}><option value="zh-CN">中文</option><option value="en">English</option></select></Field><Field label={t("涨跌颜色约定", "Price color convention")}><select className="native-select" value={colors} onChange={(e) => setColors(e.target.value)}><option value="red-up">{t("红涨绿跌", "Red up / green down")}</option><option value="green-up">{t("绿涨红跌", "Green up / red down")}</option></select></Field></div>
    <div className="editor-section-heading"><h3>{t("持仓记录", "Positions")}</h3><Button type="button" size="1" variant="soft" disabled={positions.length >= 100} onClick={() => setPositions((rows) => [...rows, { rowKey: `new-${Date.now()}`, symbol: "", quantity: "", averageCost: "", currency: "USD", invalidation: "" }])}><Plus size={13} />{t("添加持仓", "Add position")}</Button></div><p className="small muted">{t("币种需与标的交易币种一致。失效参考价留空时保留已保存值。", "Currency must match the instrument. A blank invalidation price preserves its saved value.")}</p>
    <div className="position-edit-list">{positions.map((p, index) => <div className="position-edit-row" key={p.rowKey}><Field label={t("代码", "Symbol")}><TextField.Root required value={p.symbol} onChange={(e) => update(index, "symbol", e.target.value)} placeholder="AAPL" /></Field><Field label={t("数量", "Quantity")}><TextField.Root type="number" min="0" step="any" required value={p.quantity} onChange={(e) => update(index, "quantity", e.target.value)} /></Field><Field label={t("平均成本", "Avg. cost")}><TextField.Root type="number" min="0.00000001" step="any" required value={p.averageCost} onChange={(e) => update(index, "averageCost", e.target.value)} /></Field><Field label={t("失效参考价", "Invalidation")}><TextField.Root type="number" min="0.00000001" step="any" value={p.invalidation} onChange={(e) => update(index, "invalidation", e.target.value)} /></Field><Field label={t("币种", "Currency")}><select className="native-select" value={p.currency || "USD"} onChange={(e) => update(index, "currency", e.target.value)}>{["CNY", "HKD", "USD"].map((c) => <option key={c}>{c}</option>)}</select></Field><IconButton type="button" variant="ghost" color="red" aria-label={t(`删除持仓 ${p.symbol || index + 1}`, `Remove position ${p.symbol || index + 1}`)} onClick={() => setPositions((rows) => rows.filter((_, i) => i !== index))}><Trash2 size={16} /></IconButton></div>)}</div>
    {!positions.length && <div className="form-empty">{t("没有已保存的持仓，仅使用自选股也可以开展研究。", "No saved positions. You can research using only a watchlist.")}</div>}
    <div className="dialog-actions"><Dialog.Close><Button type="button" color="gray" variant="soft" disabled={submitting}>{t("取消", "Cancel")}</Button></Dialog.Close><Button type="submit" loading={submitting}><Save size={15} />{t("保存设置", "Save settings")}</Button></div></fieldset></form>;
}
function DecisionForm({ finish, fail, submitting }) {
  const { selected, report, t, saveDecision } = useWorkspace();
  const [symbol, setSymbol] = useState(selected || "");
  const [pillars, setPillars] = useState([]);
  const submit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const record = { ...data, symbol: symbol.trim(), evidenceIds: collectEvidence(report, symbol.trim().toUpperCase()).map((e) => e.id).filter((id) => /^ev_[a-f0-9]{32}$/.test(id)) };
    if (pillars.length) record.pillars = pillars.map((p, i) => ({ id: `pillar_${i + 1}`, expectation: p.expectation, invalidationCondition: p.invalidationCondition, ...(p.reviewBy ? { reviewBy: p.reviewBy } : {}) }));
    try { await finish(() => saveDecision(record)); } catch (error) { fail(error.message); }
  };
  const update = (index, key, value) => setPillars((rows) => rows.map((r, i) => i === index ? { ...r, [key]: value } : r));
  return <form onSubmit={submit}><fieldset className="editor-fieldset" disabled={submitting}><div className="form-grid"><Field label={t("证券代码 *", "Symbol *")}><TextField.Root required maxLength={20} value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="AAPL" /></Field><Field label={t("研究状态", "Research state")}><select className="native-select" name="state" defaultValue="watch"><option value="watch">{t("观察", "Watch")}</option><option value="hold">{t("持有观察（需已有持仓）", "Hold & review (position required)")}</option><option value="review-exit">{t("退出评审（需已有持仓）", "Exit review (position required)")}</option><option value="inactive">{t("已停用", "Inactive")}</option></select></Field><Field full label={t("原始投资逻辑 *", "Original thesis *")}><TextArea name="thesis" required rows={3} maxLength={2000} placeholder={t("我为什么关注这家公司？什么证据能验证或推翻这个判断？", "Why this company? What would confirm or disprove the thesis?")} /></Field><Field label={t("入场观察条件", "Entry observation")}><TextArea name="entryCondition" rows={2} maxLength={2000} /></Field><Field label={t("失效条件", "Invalidation condition")}><TextArea name="invalidationCondition" rows={2} maxLength={2000} /></Field><Field label={t("观察周期", "Time horizon")}><TextField.Root name="horizon" maxLength={160} placeholder={t("例如：下一个财报季", "e.g. next earnings release")} /></Field><Field label={t("风险预算说明", "Risk budget note")}><TextField.Root name="riskBudget" maxLength={160} /></Field></div>
    <div className="editor-section-heading"><h3>{t("可证伪的论据（可选）", "Falsifiable pillars (optional)")}</h3><Button type="button" size="1" variant="soft" disabled={pillars.length >= 12} onClick={() => setPillars((rows) => [...rows, { expectation: "", invalidationCondition: "", reviewBy: "" }])}><Plus size={13} />{t("添加论据", "Add pillar")}</Button></div>{pillars.map((p, i) => <div className="pillar-editor" key={i}><Badge color="gray">{i + 1}</Badge><div className="form-grid"><Field full label={t("预期 *", "Expectation *")}><TextArea required maxLength={2000} value={p.expectation} onChange={(e) => update(i, "expectation", e.target.value)} /></Field><Field label={t("失效条件 *", "Invalidation *")}><TextArea required maxLength={2000} value={p.invalidationCondition} onChange={(e) => update(i, "invalidationCondition", e.target.value)} /></Field><Field label={t("复核期限", "Review by")}><TextField.Root type="date" value={p.reviewBy} onChange={(e) => update(i, "reviewBy", e.target.value)} /></Field></div><IconButton variant="ghost" color="red" type="button" aria-label={t(`删除论据 ${i + 1}`, `Remove pillar ${i + 1}`)} onClick={() => setPillars((rows) => rows.filter((_, j) => j !== i))}><Trash2 size={15} /></IconButton></div>)}<Callout.Root size="1" color="gray" mt="4"><Callout.Icon><ShieldCheck size={15} /></Callout.Icon><Callout.Text>{t("此处不创建交易候选，也不执行订单。候选决策须通过已有模型、证据与风险预算验证。", "This form does not create trade candidates or orders. Candidates require the existing model, evidence and risk-budget gates.")}</Callout.Text></Callout.Root><div className="dialog-actions"><Dialog.Close><Button type="button" color="gray" variant="soft" disabled={submitting}>{t("取消", "Cancel")}</Button></Dialog.Close><Button type="submit" loading={submitting}><Save size={15} />{t("保存原始判断", "Save original thesis")}</Button></div></fieldset></form>;
}
function ReviewForm({ record, finish, fail, submitting }) {
  const { t, saveReview } = useWorkspace();
  return <form onSubmit={async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); try { await finish(() => saveReview(record.id, data)); } catch (error) { fail(error.message); } }}><fieldset className="editor-fieldset" disabled={submitting}><div className="review-original"><Badge color="gray">{record.symbol}</Badge><p>{record.thesis}</p></div><div className="form-grid"><Field full label={t("复盘结果", "Review outcome")}><select className="native-select" name="outcome" defaultValue="open">{[["open", t("继续观察", "Still open")], ["invalidated", t("条件失效", "Invalidated")], ["target-reached", t("目标达到", "Target reached")], ["expired", t("观察到期", "Expired")], ["closed", t("已结束", "Closed")]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field full label={t("新增证据与反思", "New evidence and reflection")} hint={t("追加记录，不改写原始判断。逐项论据评估仍通过研究工具进行。", "Appends a review without changing the original. Per-pillar assessments remain available through research tools.")}><TextArea name="notes" rows={5} maxLength={2000} placeholder={t("发生了什么？哪些判断得到验证，哪些需要修正？", "What happened? What was confirmed, and what needs reconsideration?")} /></Field></div><div className="dialog-actions"><Dialog.Close><Button type="button" color="gray" variant="soft" disabled={submitting}>{t("取消", "Cancel")}</Button></Dialog.Close><Button type="submit" loading={submitting}><Check size={15} />{t("追加复盘", "Append review")}</Button></div></fieldset></form>;
}
export function Editor({ editor, onClose }) {
  const { t, preferences, reloadWorkspace, loading } = useWorkspace();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const finish = async (action) => { setError(""); setSubmitting(true); try { await action(); onClose(); } catch (err) { setError(err.message); } finally { setSubmitting(false); } };
  const title = editor.type === "settings" ? t("自选与持仓设置", "Watchlist & positions") : editor.type === "decision" ? t("新建研究记录", "New research decision") : t("追加复盘", "Append a review");
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}><Dialog.Content maxWidth={editor.type === "settings" ? "820px" : "740px"} className="editor-dialog" onEscapeKeyDown={(e) => { if (submitting) e.preventDefault(); }} onPointerDownOutside={(e) => e.preventDefault()}><Dialog.Title>{title}</Dialog.Title><Dialog.Description size="2" color="gray" mb="5">{editor.type === "settings" ? t("仅保存到本机工作台，不连接券商，也不提交交易。", "Saved to this local workspace. No broker connection or trades.") : t("保留证据、时间与判断边界，让研究可追溯。", "Keep your evidence, timestamps and reasoning auditable.")}</Dialog.Description><Dialog.Close><IconButton className="dialog-close" variant="ghost" color="gray" aria-label={t("关闭弹窗", "Close dialog")} disabled={submitting}><X size={18} /></IconButton></Dialog.Close><ErrorNotice message={error} />{editor.type === "settings" && !preferences ? <div className="form-empty"><p>{t("需先成功读取设置，避免覆盖已有持仓。", "Load preferences before editing to avoid overwriting saved positions.")}</p><Button loading={loading} onClick={reloadWorkspace}>{t("读取设置", "Load preferences")}</Button></div> : editor.type === "settings" ? <SettingsForm finish={finish} fail={setError} submitting={submitting} /> : editor.type === "decision" ? <DecisionForm finish={finish} fail={setError} submitting={submitting} /> : <ReviewForm record={editor.record} finish={finish} fail={setError} submitting={submitting} />}</Dialog.Content></Dialog.Root>;
}
