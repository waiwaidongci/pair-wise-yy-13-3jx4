import { useMemo, useState, useSyncExternalStore } from "react";
import { store } from "./archive";
import {
  MACHINES,
  STATUS_META,
  WIDTH_TOLERANCE,
  SKEW_LIMIT_CM,
  HANDLE_MIN_GRADE,
  checkRelease,
  currentRevision,
  deriveView,
  inspectionChain,
  isVoided,
  reworkGate,
  widthDeviationPct,
  type ConsoleEvent,
  type Inspection,
  type MachineId,
  type Order,
  type RegisterInput,
  type Revision,
  type StatusKey,
} from "./rules";
import "./styles.css";

// ---------- 时间工具 ----------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLocalInput(v: string): number {
  return new Date(v).getTime();
}

// ---------- 通知 ----------

interface Notice {
  id: number;
  kind: "ok" | "warn" | "err";
  text: string;
}

// ---------- 小组件 ----------

function StatusBadge({ status }: { status: StatusKey }) {
  const meta = STATUS_META[status];
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>;
}

function InspectionRows({ rev, onPick }: { rev: Revision; onPick?: (sample: string) => void }) {
  void onPick;
  const rows: { label: string; ins?: Inspection }[] = [{ label: "初检", ins: rev.initial }];
  rev.retests.forEach((ins, i) => rows.push({ label: `复测${i + 1}`, ins }));
  return (
    <table className="insp-table">
      <thead>
        <tr>
          <th>环节</th>
          <th>时间</th>
          <th>检验人</th>
          <th>实测门幅</th>
          <th>偏差</th>
          <th>纬斜</th>
          <th>手感</th>
          <th>结论</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ label, ins }) => (
          <tr key={label} className={ins && !ins.passed ? "fail-row" : ""}>
            <td>{label}</td>
            <td>{ins ? fmtTime(ins.at) : "—"}</td>
            <td>{ins?.inspector ?? "—"}</td>
            <td>{ins ? `${ins.actualWidth}` : "—"}</td>
            <td>{ins ? `${widthDeviationPct(rev.targetWidth, ins.actualWidth).toFixed(2)}%` : "—"}</td>
            <td>{ins ? `${ins.skewCm}cm` : "—"}</td>
            <td>{ins ? `${ins.handleGrade}级` : "—"}</td>
            <td>
              {ins ? (
                ins.passed ? (
                  <span className="pass">合格</span>
                ) : (
                  <span className="fail" title={ins.failReasons.join("；")}>
                    不合格
                  </span>
                )
              ) : (
                "—"
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- 机位看板 ----------

function MachineBoard({
  machines,
  statusByOrder,
  selected,
  onSelect,
}: {
  machines: ReturnType<typeof deriveView>["machines"];
  statusByOrder: Record<string, StatusKey>;
  selected?: string;
  onSelect: (sampleNo: string) => void;
}) {
  return (
    <div className="machine-grid">
      {machines.map((m) => {
        const occ = m.occupant;
        return (
        <article key={m.machineId} className={`machine-card ${occ ? "busy" : "free"}`}>
          <div className="machine-head">
            <b>{m.machineId}</b>
            <span className={`lamp ${occ ? "on" : "off"}`}>{occ ? "占用" : "空闲"}</span>
          </div>
          {occ ? (
            <button
              type="button"
              className={`occ ${selected === occ.order.sampleNo ? "selected" : ""}`}
              onClick={() => onSelect(occ.order.sampleNo)}
            >
              <span className="occ-top">
                <b>{occ.order.sampleNo}</b>
                <StatusBadge status={statusByOrder[occ.order.sampleNo] ?? "running"} />
              </span>
              <span className="occ-sub">
                {occ.order.fabric} · {occ.rev.tempC}℃ / {occ.rev.speed}m/min
              </span>
              <span className="occ-sub">自 {fmtTime(occ.since)} 占机</span>
            </button>
          ) : (
            <p className="machine-empty">机位空闲，队列首位自动上片</p>
          )}
          <div className="queue-list">
            {m.queue.length > 0 && <small>队列 {m.queue.length} · FIFO</small>}
            {m.queue.map((q, i) => (
              <button
                type="button"
                key={q.order.sampleNo}
                className={`queue-item ${selected === q.order.sampleNo ? "selected" : ""}`}
                onClick={() => onSelect(q.order.sampleNo)}
              >
                <span>
                  <em>#{i + 1}</em> <b>{q.order.sampleNo}</b> · {q.order.fabric}
                </span>
                <StatusBadge status={statusByOrder[q.order.sampleNo] ?? "queued"} />
              </button>
            ))}
          </div>
        </article>
        );
      })}
    </div>
  );
}

// ---------- 登记表 ----------

const EMPTY_FORM: RegisterInput = {
  sampleNo: "",
  fabric: "",
  machineId: MACHINES[0],
  tempC: "",
  speed: "",
  targetWidth: "",
  actualWidth: "",
  skewCm: "",
  handleGrade: "",
  inspector: "",
};

function RegisterPanel({ notify, onSelect }: { notify: (n: Omit<Notice, "id">) => void; onSelect: (s: string) => void }) {
  const [form, setForm] = useState<RegisterInput>(EMPTY_FORM);
  const set = (key: keyof RegisterInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const result = store.register(form);
    if (result.outcome === "registered") {
      notify({ kind: "ok", text: `小样 ${result.sampleNo} 已登记，按机位占用情况自动上片或进入队列` });
      onSelect(result.sampleNo);
      setForm((f) => ({ ...EMPTY_FORM, machineId: f.machineId }));
    } else if (result.outcome === "duplicate") {
      notify({
        kind: "warn",
        text:
          result.status === "released"
            ? `小样 ${result.sampleNo} 已放行；如需改温度/车速请在工单中更正，旧稿保留`
            : `小样 ${result.sampleNo} 已在机台流程中，重复/并发登记沿用最早结果`,
      });
      onSelect(result.sampleNo);
    } else {
      notify({ kind: "err", text: `整单退回：缺项或无效项 ${result.missing.join("、")}，未占机，原稿已留存` });
    }
  }

  return (
    <section className="panel register-panel">
      <div className="heading">
        <div>
          <p>机位放行台</p>
          <h2>小样登记</h2>
        </div>
      </div>
      <p className="rule-hint">温度、车速、门幅、纬斜、手感缺项整单退回；同一小样只占一台机。</p>
      <form onSubmit={submit} className="register-form">
        <label className="wide">
          <span>小样编号</span>
          <input value={form.sampleNo} onChange={set("sampleNo")} placeholder="如 RX-2407" />
        </label>
        <label className="wide">
          <span>面料 / 规格</span>
          <input value={form.fabric} onChange={set("fabric")} placeholder="如 涤纶春亚纺" />
        </label>
        <label className="wide">
          <span>指定机位</span>
          <select value={form.machineId} onChange={set("machineId")}>
            {MACHINES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>定型温度 ℃</span>
          <input inputMode="decimal" value={form.tempC} onChange={set("tempC")} placeholder="如 180" />
        </label>
        <label>
          <span>车速 m/min</span>
          <input inputMode="decimal" value={form.speed} onChange={set("speed")} placeholder="如 22" />
        </label>
        <label>
          <span>标准门幅 cm</span>
          <input inputMode="decimal" value={form.targetWidth} onChange={set("targetWidth")} placeholder="如 150" />
        </label>
        <label>
          <span>实测门幅 cm</span>
          <input inputMode="decimal" value={form.actualWidth} onChange={set("actualWidth")} placeholder="如 150.4" />
        </label>
        <label>
          <span>纬斜 cm（≤{SKEW_LIMIT_CM}）</span>
          <input inputMode="decimal" value={form.skewCm} onChange={set("skewCm")} placeholder="如 1.2" />
        </label>
        <label>
          <span>手感 1–5 级（≥{HANDLE_MIN_GRADE}）</span>
          <input inputMode="decimal" value={form.handleGrade} onChange={set("handleGrade")} placeholder="如 3.5" step="0.5" />
        </label>
        <label className="wide">
          <span>初检检验员</span>
          <input value={form.inspector} onChange={set("inspector")} placeholder="返工复测须为另一人" />
        </label>
        <button type="submit" className="primary wide">
          登记并上片 / 入队
        </button>
      </form>
    </section>
  );
}

// ---------- 复测表单 ----------

function RetestPanel({ order, notify }: { order: Order; notify: (n: Omit<Notice, "id">) => void }) {
  const rev = currentRevision(order);
  const [inspector, setInspector] = useState("");
  const [actualWidth, setActualWidth] = useState("");
  const [skewCm, setSkewCm] = useState("");
  const [handleGrade, setHandleGrade] = useState("");
  const [at, setAt] = useState(toLocalInput(Date.now()));
  const chain = inspectionChain(rev);
  const last = chain[chain.length - 1];
  const isFreshRev = !rev.initial;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = parseLocalInput(at);
    if (!Number.isFinite(t)) {
      notify({ kind: "err", text: "复测时间无效" });
      return;
    }
    const errors = store.retest(order.sampleNo, { inspector, actualWidth, skewCm, handleGrade, at: t });
    if (errors.length > 0) {
      notify({ kind: "err", text: `复测未受理：${errors.join("；")}` });
      return;
    }
    const rev0 = currentRevision(order);
    const fresh = !rev0.initial;
    notify({
      kind: "ok",
      text: fresh
        ? `${order.sampleNo} 新稿初检已记录：合格可直接放行，不合格继续占机返工`
        : `${order.sampleNo} 复测已记录：不合格继续占机返工，合格计入连续合格次数`,
    });
    setInspector("");
    setActualWidth("");
    setSkewCm("");
    setHandleGrade("");
    setAt(toLocalInput(Date.now()));
  }

  return (
    <form className="subform" onSubmit={submit}>
      <h4>{isFreshRev ? "新稿初检（按更正后工艺）" : "返工复测（另一人）"}</h4>
      {isFreshRev ? (
        <p className="rule-hint">旧放行已失效、旧稿保留；本稿首次检验合格可直接放行，不合格则转返工复测流程。</p>
      ) : last ? (
        <p className="rule-hint">
          上一次：{fmtTime(last.at)} {last.inspector} · {last.passed ? "合格" : "不合格"}
          {!last.passed ? `（${last.failReasons.join("；")}）` : ""}
        </p>
      ) : null}
      <div className="subform-grid">
        <label>
          <span>{isFreshRev ? "初检检验人" : "复测人（不得同上一次）"}</span>
          <input value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder="姓名" />
        </label>
        <label>
          <span>复测时间</span>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <label>
          <span>实测门幅 cm</span>
          <input inputMode="decimal" value={actualWidth} onChange={(e) => setActualWidth(e.target.value)} />
        </label>
        <label>
          <span>纬斜 cm</span>
          <input inputMode="decimal" value={skewCm} onChange={(e) => setSkewCm(e.target.value)} />
        </label>
        <label>
          <span>手感级</span>
          <input inputMode="decimal" step="0.5" value={handleGrade} onChange={(e) => setHandleGrade(e.target.value)} />
        </label>
      </div>
      <button type="submit" className="primary">
        提交复测
      </button>
    </form>
  );
}

// ---------- 工艺更正 ----------

function AmendPanel({ order, notify }: { order: Order; notify: (n: Omit<Notice, "id">) => void }) {
  const rev = currentRevision(order);
  const [tempC, setTempC] = useState(String(rev.tempC));
  const [speed, setSpeed] = useState(String(rev.speed));
  const [reason, setReason] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const errors = store.amend(order.sampleNo, tempC, speed, reason);
    if (errors.length > 0) {
      notify({ kind: "err", text: `更正未受理：${errors.join("；")}` });
      return;
    }
    notify({ kind: "warn", text: `${order.sampleNo} 温度/车速已更正，旧放行失效并重新计算，旧稿保留可查` });
    setReason("");
  }

  return (
    <form className="subform amend" onSubmit={submit}>
      <h4>温度 / 车速更正</h4>
      <p className="rule-hint">仅温度或车速更正即触发重算：旧稿保留，旧放行失效，按新稿重新检验放行。</p>
      <div className="subform-grid">
        <label>
          <span>新温度 ℃（旧 {rev.tempC}）</span>
          <input inputMode="decimal" value={tempC} onChange={(e) => setTempC(e.target.value)} />
        </label>
        <label>
          <span>新车速 m/min（旧 {rev.speed}）</span>
          <input inputMode="decimal" value={speed} onChange={(e) => setSpeed(e.target.value)} />
        </label>
        <label className="wide">
          <span>更正原因</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如 客户反馈缩率超标" />
        </label>
      </div>
      <button type="submit">提交更正（重算）</button>
    </form>
  );
}

// ---------- 工单详情 ----------

function OrderDetail({
  order,
  status,
  queued,
  notify,
}: {
  order: Order;
  status: StatusKey;
  queued: boolean;
  notify: (n: Omit<Notice, "id">) => void;
}) {
  const rev = currentRevision(order);
  const check = checkRelease(order);
  const gate = reworkGate(rev);
  const [releaseBy, setReleaseBy] = useState("");

  function doRelease() {
    const res = store.release(order.sampleNo, releaseBy);
    if (!res.ok) {
      notify({ kind: "err", text: `放行被拦：${res.reasons.join("；")}` });
      return;
    }
    notify({ kind: "ok", text: `${order.sampleNo} 已放行，机位释放，队列首位自动上片` });
    setReleaseBy("");
  }

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <h2>
            {order.sampleNo} <StatusBadge status={status} />
          </h2>
          <p className="muted">
            {order.fabric} · 目标机位 {order.machineId} · 登记于 {fmtTime(order.registeredAt)}
            {queued && " · 排队待位，机位释放后自动上片"}
          </p>
        </div>
      </div>

      {[...order.revisions].reverse().map((r) => {
        const isCurrent = r.rev === rev.rev;
        const voided = isVoided(r);
        return (
          <section key={r.rev} className={`rev-card ${isCurrent ? "current" : "old"} ${voided ? "voided" : ""}`}>
            <div className="rev-head">
              <b>
                {isCurrent ? "当前稿" : "旧稿（保留）"} v{r.rev}
              </b>
              <span className="muted">
                {r.tempC}℃ / {r.speed}m/min · 标准门幅 {r.targetWidth}cm · 建档 {fmtTime(r.createdAt)}
              </span>
              {r.releasedAt && <span className="tag ok">放行 {fmtTime(r.releasedAt)} · {r.releasedBy}</span>}
              {voided && <span className="tag dead">已失效：{r.voidedReason}</span>}
            </div>
            <InspectionRows rev={r} />
            {isCurrent && !r.releasedAt && r.initial && (!r.initial.passed || r.retests.length > 0) && (
              <div className={`gate ${gate.ok ? "ok" : "bad"}`}>
                <b>返工放行闸门</b>
                <ul>
                  {(gate.reasons.length ? gate.reasons : ["连续两次合格、相隔满 4 小时且复测换人，满足放行条件"]).map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}

      {!rev.releasedAt && !queued && <RetestPanel order={order} notify={notify} />}

      <section className="subform release-box">
        <h4>放行确认</h4>
        <ul className={`gate ${check.eligible ? "ok" : "bad"}`} style={{ marginBottom: 10 }}>
          {check.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {queued && <p className="rule-hint">排队待位工单暂不能放行，上片检验后方可操作。</p>}
        <div className="release-row">
          <input
            value={releaseBy}
            onChange={(e) => setReleaseBy(e.target.value)}
            placeholder="放行确认人"
            disabled={!check.eligible || queued}
          />
          <button type="button" className="primary" disabled={!check.eligible || queued} onClick={doRelease}>
            放行并释放机位
          </button>
        </div>
      </section>

      <AmendPanel order={order} notify={notify} />
    </div>
  );
}

// ---------- 退回单 ----------

interface ReturnItem {
  sampleNo: string;
  at: number;
  missing: string[];
  machineId: MachineId;
  fabric: string;
}

function ReturnsPanel({ items }: { items: ReturnItem[] }) {
  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>缺项整单退回</p>
          <h2>退回原稿（{items.length}）</h2>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="muted">暂无整单退回记录。</p>
      ) : (
        <div className="returns">
          {items.map((r, i) => (
            <article key={`${r.sampleNo}-${r.at}-${i}`} className="return-card">
              <div className="rev-head">
                <b>{r.sampleNo || "(未填编号)"}</b>
                <span className="muted">
                  {r.fabric || "未填面料"} · 拟上 {r.machineId} · 退回时间 {fmtTime(r.at)}
                </span>
              </div>
              <p className="rule-hint">缺项 / 无效项导致整单退回，未占机；补齐后以同编号重新登记：</p>
              <div className="chips static">
                {r.missing.map((m) => (
                  <span key={m} className="miss-chip">
                    缺 {m}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- 履历 ----------

function describeEvent(e: ConsoleEvent): string {
  switch (e.type) {
    case "Registered":
      return `登记 ${e.orderId} → ${e.machineId}：${e.input.tempC}℃ / ${e.input.speed}m/min，门幅${e.input.targetWidth}，初检${
        e.initial ? (e.initial.passed ? "合格" : "不合格（" + e.initial.failReasons.join("；") + "）") : "待检"
      }`;
    case "Returned":
      return `整单退回 ${e.sampleNo}：缺 ${e.missing.join("、")}，未占机，原稿保留`;
    case "Retested": {
      const ins = e.inspection;
      return `复测 ${e.orderId} v${e.rev} · ${ins.inspector}：${ins.passed ? "合格" : "不合格（" + ins.failReasons.join("；") + "）"}，门幅${ins.actualWidth} / 纬斜${ins.skewCm}cm / 手感${ins.handleGrade}级`;
    }
    case "Released":
      return `放行 ${e.orderId} v${e.rev} · 确认人 ${e.by}，机位释放`;
    case "Amended":
      return `工艺更正 ${e.orderId} v${e.oldRev}→v${e.newRev}：${e.tempC}℃ 等参数变更（${e.reason}），旧放行失效重算，旧稿保留`;
  }
}

function HistoryPanel({ events, onSelect }: { events: ConsoleEvent[]; onSelect: (s: string) => void }) {
  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>事件溯源履历</p>
          <h2>全量操作履历（{events.length}）</h2>
        </div>
        <button onClick={() => store.resetDemo()}>重置演示数据</button>
      </div>
      <ol className="history">
        {[...events].reverse().map((e, i) => {
          const ref = "orderId" in e ? e.orderId : e.type === "Returned" ? e.sampleNo : "";
          const selectable = e.type !== "Returned";
          return (
            <li key={i} className={`hist-item hist-${e.type}`}>
              <span className="hist-time">{fmtTime(e.at)}</span>
              {selectable ? (
                <button type="button" className="hist-link" onClick={() => onSelect(ref)}>
                  {describeEvent(e)}
                </button>
              ) : (
                <span>{describeEvent(e)}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------- 主应用 ----------

const RULES = [
  "同一小样只占一台机；重复或并发登记沿用最早结果",
  `登记必填：温度 / 车速 / 门幅 / 纬斜 / 手感，缺项整单退回`,
  `门幅偏差 >${(WIDTH_TOLERANCE * 100).toFixed(0)}%、纬斜 >${SKEW_LIMIT_CM}cm 或手感 <${HANDLE_MIN_GRADE} 级：继续占机并转返工`,
  `返工须另一人复测，连续两次合格且相隔 4 小时才放行`,
  "温度或车速更正后旧放行失效、重新计算，旧稿保留可查",
];

function App() {
  const state = useSyncExternalStore(store.subscribe, () => store.getState());
  const events = useSyncExternalStore(store.subscribe, () => store.getEvents());
  const view = useMemo(() => deriveView(state), [state]);

  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [notices, setNotices] = useState<Notice[]>([]);

  function notify(n: Omit<Notice, "id">) {
    const id = Date.now() + Math.random();
    setNotices((list) => [...list, { ...n, id }]);
    window.setTimeout(() => setNotices((list) => list.filter((x) => x.id !== id)), 6000);
  }

  const selectedOrder = selected ? state.orders[selected] : undefined;
  const selectedHasRev = selectedOrder && selectedOrder.revisions.length > 0;
  const occupantSamples = useMemo(() => {
    const set = new Set<string>();
    view.machines.forEach((m) => m.occupant && set.add(m.occupant.order.sampleNo));
    return set;
  }, [view]);

  const returns: ReturnItem[] = useMemo(() => {
    const items: ReturnItem[] = [];
    for (const order of Object.values(state.orders)) {
      for (const r of order.returns) {
        items.push({ sampleNo: order.sampleNo, at: r.at, missing: r.missing, machineId: order.machineId || r.raw.machineId, fabric: order.fabric });
      }
    }
    return items.sort((a, b) => b.at - a.at);
  }, [state]);

  const occupiedCount = view.machines.filter((m) => m.occupant).length;
  const queueCount = view.machines.reduce((n, m) => n + m.queue.length, 0);

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62012 · 热定型机位放行台 · Port 62012</p>
        <h1>热定型机位放行台</h1>
        <span>小样登记即锁定机位，同一小样只占一台机；检验、返工复测、放行与工艺更正全程留痕，刷新后机位、队列与履历一致。</span>
        <ul className="rule-strip">
          {RULES.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>

      <section className="metrics">
        <article>
          <small>机位占用</small>
          <strong>
            {occupiedCount}/{MACHINES.length}
          </strong>
        </article>
        <article>
          <small>排队待位</small>
          <strong>{queueCount}</strong>
        </article>
        <article>
          <small>占机返工</small>
          <strong>{view.metrics.rework}</strong>
        </article>
        <article>
          <small>已放行 / 整单退回</small>
          <strong>
            {view.metrics.released} / {view.metrics.returns}
          </strong>
        </article>
      </section>

      <MachineBoard machines={view.machines} statusByOrder={view.statusByOrder} selected={selected} onSelect={setSelected} />

      <section className="workspace detail-layout">
        <RegisterPanel notify={notify} onSelect={setSelected} />
        <section className="panel detail-panel">
          {selectedHasRev ? (
            <OrderDetail
              key={selectedOrder!.sampleNo}
              order={selectedOrder!}
              status={view.statusByOrder[selectedOrder!.sampleNo] ?? "queued"}
              queued={!occupantSamples.has(selectedOrder!.sampleNo)}
              notify={notify}
            />
          ) : (
            <div className="detail-empty">
              <h2>工单详情</h2>
              <p className="muted">点击机位上的小样或队列条目，查看检验记录、返工闸门、放行与工艺更正。</p>
              {returns.length > 0 && (
                <p className="rule-hint">被整单退回的小样不占机位，在下方“退回原稿”中可查看缺项。</p>
              )}
            </div>
          )}
        </section>
      </section>

      <ReturnsPanel items={returns} />
      <HistoryPanel events={events} onSelect={setSelected} />

      <div className="notice-stack">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.kind}`}>
            {n.text}
          </div>
        ))}
      </div>
    </main>
  );
}

export default App;
