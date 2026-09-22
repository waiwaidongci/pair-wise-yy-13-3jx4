/**
 * 热定型机位放行台 —— 界面
 *
 * 布局：规则条 → 指标 → 机位看板 → 登记/队列 → 小样单列表（复测、更正、留档）→ 履历。
 * 全部状态来自 heatReleaseRules 引擎，经 heatReleaseStore 落盘，刷新后一致恢复。
 */

import { useEffect, useMemo, useState } from "react";
import {
  HANDFEEL_MIN_GRADE,
  RULE_SUMMARY,
  SKEW_LIMIT_CM,
  STATUS_META,
  STENTERS,
  WIDTH_TOLERANCE_PCT,
  correctParams,
  occupancyMap,
  queueOf,
  registerSample,
  releaseProgressText,
  retestSample,
  widthDeviationPct,
  type ReleaseState,
  type Ticket,
  type TicketStatus,
} from "./heatReleaseRules";
import { loadState, resetState, saveState } from "./heatReleaseStore";

// ---------- 小工具 ----------

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromLocalInput(value: string): number {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : Number.NaN;
}

/** 空串按缺项处理（NaN），交给规则引擎判缺 */
function num(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function StatusBadge({ status }: { status: TicketStatus }) {
  const meta = STATUS_META[status];
  return <span className={`badge badge-${meta.tone}`}>{meta.label}</span>;
}

// ---------- 登记表单 ----------

interface RegisterFormState {
  sampleNo: string;
  fabric: string;
  machineId: string;
  operator: string;
  temperatureC: string;
  speedMpm: string;
  widthStdCm: string;
  widthActualCm: string;
  skewCm: string;
  handFeelGrade: string;
}

const INITIAL_REGISTER_FORM: RegisterFormState = {
  sampleNo: "",
  fabric: "",
  machineId: STENTERS[0],
  operator: "王芳",
  temperatureC: "190",
  speedMpm: "45",
  widthStdCm: "150",
  widthActualCm: "",
  skewCm: "",
  handFeelGrade: "4",
};

function RegisterPanel({
  onSubmit,
}: {
  onSubmit: (form: RegisterFormState) => void;
}) {
  const [form, setForm] = useState<RegisterFormState>(INITIAL_REGISTER_FORM);
  const set = (key: keyof RegisterFormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const std = num(form.widthStdCm);
  const actual = num(form.widthActualCm);
  const devPreview =
    Number.isFinite(std) && std > 0 && Number.isFinite(actual) && actual > 0
      ? widthDeviationPct(actual, std)
      : null;

  return (
    <section className="panel form-panel">
      <div className="heading">
        <div>
          <p>小样登记</p>
          <h2>登记上机</h2>
        </div>
      </div>
      <div className="field-grid">
        <label>
          <span>小样批号 *</span>
          <input
            value={form.sampleNo}
            onChange={set("sampleNo")}
            placeholder="如 LAB-627A"
          />
        </label>
        <label>
          <span>面料成分</span>
          <input value={form.fabric} onChange={set("fabric")} placeholder="如 棉府绸 120g" />
        </label>
        <label>
          <span>机位 *</span>
          <select value={form.machineId} onChange={set("machineId")}>
            {STENTERS.map((m) => (
              <option key={m} value={m}>
                {m} 热定型机
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>登记人 *</span>
          <input value={form.operator} onChange={set("operator")} placeholder="姓名" />
        </label>
        <label>
          <span>温度 ℃ *</span>
          <input value={form.temperatureC} onChange={set("temperatureC")} inputMode="decimal" />
        </label>
        <label>
          <span>车速 m/min *</span>
          <input value={form.speedMpm} onChange={set("speedMpm")} inputMode="decimal" />
        </label>
        <label>
          <span>标准门幅 cm *</span>
          <input value={form.widthStdCm} onChange={set("widthStdCm")} inputMode="decimal" />
        </label>
        <label>
          <span>实测门幅 cm *</span>
          <input
            value={form.widthActualCm}
            onChange={set("widthActualCm")}
            inputMode="decimal"
            placeholder="缺项整单退回"
          />
        </label>
        <label>
          <span>纬斜 cm *</span>
          <input
            value={form.skewCm}
            onChange={set("skewCm")}
            inputMode="decimal"
            placeholder="带正负号，超 ±3 返工"
          />
        </label>
        <label>
          <span>手感等级（1-5）*</span>
          <select value={form.handFeelGrade} onChange={set("handFeelGrade")}>
            {[1, 2, 3, 4, 5].map((g) => (
              <option key={g} value={String(g)}>
                {g} 级{g < HANDFEEL_MIN_GRADE ? "（不合格）" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-foot">
        <span className="hint">
          {devPreview === null
            ? `判定线：门幅偏差＞${WIDTH_TOLERANCE_PCT}%、纬斜＞±${SKEW_LIMIT_CM}cm、手感＜${HANDFEEL_MIN_GRADE} 级`
            : `当前门幅偏差 ${devPreview.toFixed(2)}%（限 ${WIDTH_TOLERANCE_PCT}%）${
                devPreview > WIDTH_TOLERANCE_PCT ? "，将转返工" : ""
              }`}
        </span>
        <button
          className="primary"
          onClick={() => {
            onSubmit(form);
            setForm((f) => ({ ...f, sampleNo: "", widthActualCm: "", skewCm: "" }));
          }}
        >
          登记上机
        </button>
      </div>
    </section>
  );
}

// ---------- 复测表单 ----------

function RetestForm({
  ticket,
  onSubmit,
  onCancel,
}: {
  ticket: Ticket;
  onSubmit: (input: {
    operator: string;
    widthActualCm: number;
    skewCm: number;
    handFeelGrade: number;
    measuredAt: number;
  }) => void;
  onCancel: () => void;
}) {
  const lastTester = ticket.measures[0]?.operator ?? ticket.registeredBy;
  const [operator, setOperator] = useState("");
  const [width, setWidth] = useState(String(ticket.params.widthStdCm));
  const [skew, setSkew] = useState("");
  const [grade, setGrade] = useState("4");
  const [measuredAt, setMeasuredAt] = useState(toLocalInput(Date.now()));

  return (
    <div className="sub-form">
      <h3>返工复测（须另一人，上一位检验人：{lastTester}）</h3>
      <div className="field-grid">
        <label>
          <span>复测人 *</span>
          <input
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            placeholder={`不能是 ${lastTester}`}
          />
        </label>
        <label>
          <span>实测时间 *</span>
          <input
            type="datetime-local"
            value={measuredAt}
            onChange={(e) => setMeasuredAt(e.target.value)}
          />
        </label>
        <label>
          <span>实测门幅 cm（标准 {ticket.params.widthStdCm}）*</span>
          <input value={width} onChange={(e) => setWidth(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>纬斜 cm *</span>
          <input value={skew} onChange={(e) => setSkew(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>手感等级（1-5）*</span>
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            {[1, 2, 3, 4, 5].map((g) => (
              <option key={g} value={String(g)}>
                {g} 级
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-foot">
        <span className="hint">连续两次合格且间隔满 4 小时才放行</span>
        <div className="btn-row">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            onClick={() =>
              onSubmit({
                operator,
                widthActualCm: num(width),
                skewCm: num(skew),
                handFeelGrade: num(grade),
                measuredAt: fromLocalInput(measuredAt),
              })
            }
          >
            提交复测
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 更正表单 ----------

function CorrectForm({
  ticket,
  onSubmit,
  onCancel,
}: {
  ticket: Ticket;
  onSubmit: (input: { operator: string; temperatureC: number; speedMpm: number; widthStdCm: number }) => void;
  onCancel: () => void;
}) {
  const [operator, setOperator] = useState("");
  const [temperature, setTemperature] = useState(String(ticket.params.temperatureC));
  const [speed, setSpeed] = useState(String(ticket.params.speedMpm));
  const [widthStd, setWidthStd] = useState(String(ticket.params.widthStdCm));

  return (
    <div className="sub-form">
      <h3>更正工艺参数（温度/车速更正后旧放行失效重算，旧稿保留）</h3>
      <div className="field-grid">
        <label>
          <span>更正人 *</span>
          <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="姓名" />
        </label>
        <label>
          <span>温度 ℃（原 {ticket.params.temperatureC}）*</span>
          <input value={temperature} onChange={(e) => setTemperature(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>车速 m/min（原 {ticket.params.speedMpm}）*</span>
          <input value={speed} onChange={(e) => setSpeed(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>标准门幅 cm（原 {ticket.params.widthStdCm}）*</span>
          <input value={widthStd} onChange={(e) => setWidthStd(e.target.value)} inputMode="decimal" />
        </label>
      </div>
      <div className="form-foot">
        <span className="hint">仅改标准门幅不影响放行状态</span>
        <div className="btn-row">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            onClick={() =>
              onSubmit({
                operator,
                temperatureC: num(temperature),
                speedMpm: num(speed),
                widthStdCm: num(widthStd),
              })
            }
          >
            提交更正
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 小样单卡片 ----------

type ActionPayload =
  | {
      kind: "retest";
      ticketId: string;
      input: {
        operator: string;
        widthActualCm: number;
        skewCm: number;
        handFeelGrade: number;
        measuredAt: number;
      };
    }
  | {
      kind: "correct";
      ticketId: string;
      input: { operator: string; temperatureC: number; speedMpm: number; widthStdCm: number };
    };

function TicketCard({
  ticket,
  selected,
  onAction,
}: {
  ticket: Ticket;
  selected: boolean;
  onAction: (result: ActionPayload) => void;
}) {
  const [open, setOpen] = useState<"none" | "retest" | "correct">("none");
  const progress = releaseProgressText(ticket, Date.now());

  return (
    <article
      id={`ticket-${ticket.id}`}
      className={`ticket${selected ? " ticket-selected" : ""}`}
    >
      <header className="ticket-head">
        <div>
          <StatusBadge status={ticket.status} /> <strong>{ticket.sampleNo}</strong>
          {ticket.fabric ? <span className="muted"> · {ticket.fabric}</span> : null}
        </div>
        <div className="muted">
          {ticket.machineId} 机 · 单号 {ticket.id}
        </div>
      </header>

      <div className="chips param-chips">
        <span>温度 {ticket.params.temperatureC}℃</span>
        <span>车速 {ticket.params.speedMpm} m/min</span>
        <span>标准门幅 {ticket.params.widthStdCm}cm</span>
        {ticket.initialMeasure ? (
          <>
            <span>实测门幅 {ticket.initialMeasure.widthActualCm}cm</span>
            <span>纬斜 {ticket.initialMeasure.skewCm}cm</span>
            <span>手感 {ticket.initialMeasure.handFeelGrade} 级</span>
          </>
        ) : null}
      </div>

      <p className="muted ticket-meta">
        登记人 {ticket.registeredBy} · 登记于 {fmtTime(ticket.createdAt)} · 更新于{" "}
        {fmtTime(ticket.updatedAt)}
        {ticket.releasedAt ? ` · 放行于 ${fmtTime(ticket.releasedAt)}` : ""}
      </p>

      {ticket.status === "rework" ? (
        <p className="progress">
          返工进度：连续合格 {ticket.consecutivePasses}/2 · {progress}
        </p>
      ) : null}
      {ticket.releaseInvalidatedAt ? (
        <p className="warn-text">
          旧放行已于 {fmtTime(ticket.releaseInvalidatedAt)} 因温度/车速更正失效，按新参数重算
        </p>
      ) : null}
      {ticket.status === "returned" ? (
        <p className="bad-text">整单退回：{ticket.returnReason}</p>
      ) : null}

      <div className="btn-row">
        {ticket.status === "rework" ? (
          <button
            className="primary"
            onClick={() => setOpen(open === "retest" ? "none" : "retest")}
          >
            {open === "retest" ? "收起复测" : "复测"}
          </button>
        ) : null}
        {ticket.status !== "returned" ? (
          <button onClick={() => setOpen(open === "correct" ? "none" : "correct")}>
            {open === "correct" ? "收起更正" : "更正参数"}
          </button>
        ) : null}
      </div>

      {open === "retest" ? (
        <RetestForm
          ticket={ticket}
          onCancel={() => setOpen("none")}
          onSubmit={(input) => {
            onAction({ kind: "retest", ticketId: ticket.id, input });
            setOpen("none");
          }}
        />
      ) : null}
      {open === "correct" ? (
        <CorrectForm
          ticket={ticket}
          onCancel={() => setOpen("none")}
          onSubmit={(input) => {
            onAction({ kind: "correct", ticketId: ticket.id, input });
            setOpen("none");
          }}
        />
      ) : null}

      {ticket.measures.length > 0 ? (
        <details>
          <summary>检验记录（{ticket.measures.length}）</summary>
          <table className="mini-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>检验人</th>
                <th>类型</th>
                <th>门幅</th>
                <th>纬斜</th>
                <th>手感</th>
                <th>结论</th>
              </tr>
            </thead>
            <tbody>
              {ticket.measures.map((m, i) => (
                <tr key={`${m.at}-${i}`}>
                  <td>{fmtTime(m.at)}</td>
                  <td>{m.operator}</td>
                  <td>{m.kind === "initial" ? "初检" : "复测"}</td>
                  <td>
                    {m.widthActualCm}cm（
                    {widthDeviationPct(m.widthActualCm, ticket.params.widthStdCm).toFixed(2)}%）
                  </td>
                  <td>{m.skewCm}cm</td>
                  <td>{m.handFeelGrade} 级</td>
                  <td className={m.pass ? "ok-text" : "bad-text"}>
                    {m.pass ? "合格" : m.reasons.join("；")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}

      {ticket.revisions.length > 0 ? (
        <details>
          <summary>更正旧稿（{ticket.revisions.length}，保留）</summary>
          <table className="mini-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>更正人</th>
                <th>旧稿</th>
                <th>新稿</th>
                <th>影响</th>
              </tr>
            </thead>
            <tbody>
              {ticket.revisions.map((r) => (
                <tr key={r.id}>
                  <td>{fmtTime(r.at)}</td>
                  <td>{r.operator}</td>
                  <td>
                    {r.before.temperatureC}℃ · {r.before.speedMpm}m/min · {r.before.widthStdCm}cm
                  </td>
                  <td>
                    {r.after.temperatureC}℃ · {r.after.speedMpm}m/min · {r.after.widthStdCm}cm
                  </td>
                  <td className={r.invalidatedRelease ? "bad-text" : "muted"}>
                    {r.invalidatedRelease ? "旧放行失效" : "状态不变"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}

      <details>
        <summary>履历（{ticket.events.length}）</summary>
        <ul className="timeline">
          {ticket.events.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <span className="muted">{fmtTime(e.at)}</span> {e.text}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

// ---------- 主界面 ----------

export default function HeatReleaseConsole() {
  const [state, setState] = useState<ReleaseState>(() => loadState());
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<TicketStatus | "all">("all");

  // 每次状态变更即落盘：刷新后机位、队列、履历一致恢复
  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    if (!selectedId) return;
    document
      .getElementById(`ticket-${selectedId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedId]);

  const occ = useMemo(() => occupancyMap(state), [state]);
  const queue = useMemo(() => queueOf(state), [state]);

  const counts = useMemo(() => {
    const c: Record<TicketStatus, number> = {
      inspecting: 0,
      rework: 0,
      queued: 0,
      released: 0,
      returned: 0,
    };
    for (const t of state.tickets) c[t.status] += 1;
    return c;
  }, [state]);

  const history = useMemo(
    () =>
      state.tickets
        .flatMap((t) => t.events.map((e) => ({ ...e, sampleNo: t.sampleNo, ticketId: t.id })))
        .sort((a, b) => b.at - a.at)
        .slice(0, 30),
    [state]
  );

  const visibleTickets = useMemo(
    () =>
      state.tickets
        .filter((t) => filter === "all" || t.status === filter)
        .sort((a, b) => b.createdAt - a.createdAt),
    [state, filter]
  );

  const handleRegister = (form: RegisterFormState) => {
    const res = registerSample(state, {
      sampleNo: form.sampleNo,
      fabric: form.fabric,
      machineId: form.machineId,
      temperatureC: num(form.temperatureC),
      speedMpm: num(form.speedMpm),
      widthStdCm: num(form.widthStdCm),
      widthActualCm: num(form.widthActualCm),
      skewCm: num(form.skewCm),
      handFeelGrade: num(form.handFeelGrade),
      operator: form.operator,
      now: Date.now(),
    });
    setState(res.state);
    setBanner({ ok: res.ok, text: res.message });
    if (res.ticketId) setSelectedId(res.ticketId);
  };

  const handleAction = (payload: ActionPayload) => {
    const res =
      payload.kind === "retest"
        ? retestSample(state, { ...payload.input, ticketId: payload.ticketId, now: Date.now() })
        : correctParams(state, { ...payload.input, ticketId: payload.ticketId, now: Date.now() });
    setState(res.state);
    setBanner({ ok: res.ok, text: res.message });
    if (res.ticketId) setSelectedId(res.ticketId);
  };

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62012 · 热定型机位放行台 · Port 62012</p>
        <h1>热定型机位放行台</h1>
        <span>
          由染整小样页扩展：小样登记上机 → 初检判定 → 不合格继续占机返工 → 另一人复测，
          连续两次合格且间隔满 4 小时放行；温度/车速更正后旧放行失效重算，旧稿保留，全程留档。
        </span>
        <ul className="rule-chips">
          {RULE_SUMMARY.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>

      {banner ? (
        <div className={`banner ${banner.ok ? "banner-ok" : "banner-bad"}`}>
          <span>{banner.text}</span>
          <button onClick={() => setBanner(null)}>知道了</button>
        </div>
      ) : null}

      <section className="metrics">
        <article>
          <small>在制小样</small>
          <strong>{counts.inspecting + counts.rework + counts.queued}</strong>
        </article>
        <article>
          <small>机位占用</small>
          <strong>
            {occ.size}/{STENTERS.length}
          </strong>
        </article>
        <article>
          <small>等待队列</small>
          <strong>{counts.queued}</strong>
        </article>
        <article>
          <small>已放行 / 已退回</small>
          <strong>
            {counts.released} / {counts.returned}
          </strong>
        </article>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>机位看板</p>
            <h2>热定型机位</h2>
          </div>
          <button
            onClick={() => {
              if (window.confirm("清空全部数据并恢复演示数据？")) {
                setState(resetState());
                setBanner({ ok: true, text: "已重置为演示数据" });
                setSelectedId(null);
              }
            }}
          >
            重置演示数据
          </button>
        </div>
        <div className="machine-grid">
          {STENTERS.map((m) => {
            const t = occ.get(m);
            const waiting = queue.filter((q) => q.machineId === m).length;
            return (
              <button
                key={m}
                className={`machine ${t ? "machine-busy" : "machine-free"}`}
                onClick={() => t && setSelectedId(t.id)}
              >
                <b>{m}</b>
                {t ? (
                  <>
                    <StatusBadge status={t.status} />
                    <span className="machine-sample">{t.sampleNo}</span>
                  </>
                ) : (
                  <span className="muted">空闲</span>
                )}
                {waiting > 0 ? <small>等待 {waiting} 单</small> : <small>&nbsp;</small>}
              </button>
            );
          })}
        </div>
      </section>

      <section className="workspace">
        <RegisterPanel onSubmit={handleRegister} />

        <aside className="panel">
          <div className="heading">
            <div>
              <p>等待队列</p>
              <h2>排队小样（{queue.length}）</h2>
            </div>
          </div>
          {queue.length === 0 ? (
            <p className="muted">暂无排队，机位空出时最早登记的单自动补位。</p>
          ) : (
            <ol className="queue-list">
              {queue.map((t, i) => (
                <li key={t.id}>
                  <button className="queue-item" onClick={() => setSelectedId(t.id)}>
                    <b>{String(i + 1).padStart(2, "0")}</b>
                    <span>
                      {t.sampleNo} · {t.machineId} 机
                      <small>
                        {fmtTime(t.createdAt)} 登记 · {t.registeredBy}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>小样单</p>
            <h2>放行管理</h2>
          </div>
          <div className="chips">
            <button className={filter === "all" ? "chip-on" : ""} onClick={() => setFilter("all")}>
              全部 {state.tickets.length}
            </button>
            {(Object.keys(STATUS_META) as TicketStatus[]).map((s) => (
              <button
                key={s}
                className={filter === s ? "chip-on" : ""}
                onClick={() => setFilter(s)}
              >
                {STATUS_META[s].label} {counts[s]}
              </button>
            ))}
          </div>
        </div>
        <div className="tickets">
          {visibleTickets.length === 0 ? (
            <p className="muted">该状态下暂无小样单。</p>
          ) : (
            visibleTickets.map((t) => (
              <TicketCard
                key={t.id}
                ticket={t}
                selected={t.id === selectedId}
                onAction={handleAction}
              />
            ))
          )}
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>全程留档</p>
            <h2>履历（最近 {history.length} 条）</h2>
          </div>
        </div>
        {history.length === 0 ? (
          <p className="muted">暂无履历。</p>
        ) : (
          <ul className="timeline history">
            {history.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <button className="history-link" onClick={() => setSelectedId(e.ticketId)}>
                  {e.sampleNo}
                </button>
                <span className="muted"> {fmtTime(e.at)}</span> {e.text}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
