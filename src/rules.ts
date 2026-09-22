// 热定型机位放行台 —— 规则层
// 纯函数：判定规则、事件归约、机位/队列/履历派生。不依赖 localStorage 与 React。

export const STORAGE_KEY = "heat-set-release-console:v1";
export const REWORK_GAP_MS = 4 * 60 * 60 * 1000; // 返工：连续两次合格须相隔 4 小时
export const WIDTH_TOLERANCE = 0.02; // 门幅偏差上限 2%
export const SKEW_LIMIT_CM = 3; // 纬斜上限 3cm
export const HANDLE_MIN_GRADE = 3; // 手感最低 3 级

export const MACHINES = ["1#热定型", "2#热定型", "3#热定型", "4#热定型"] as const;

export type MachineId = (typeof MACHINES)[number];

export const REQUIRED_FIELDS = ["温度", "车速", "标准门幅", "实测门幅", "纬斜", "手感"] as const;

export type StatusKey = "queued" | "running" | "rework" | "released";

// ---------- 数据模型 ----------

export interface RegisterInput {
  sampleNo: string;
  fabric: string;
  machineId: MachineId;
  tempC: string;
  speed: string;
  targetWidth: string;
  actualWidth: string;
  skewCm: string;
  handleGrade: string;
  inspector: string;
  note?: string;
}

export interface Inspection {
  at: number;
  inspector: string;
  actualWidth: number;
  skewCm: number;
  handleGrade: number;
  passed: boolean;
  failReasons: string[];
}

export interface Revision {
  rev: number;
  tempC: number;
  speed: number;
  targetWidth: number;
  createdAt: number;
  initial?: Inspection;
  retests: Inspection[];
  releasedAt?: number;
  releasedBy?: string;
  voidedAt?: number;
  voidedReason?: string;
}

export interface ReturnRecord {
  at: number;
  missing: string[];
  raw: RegisterInput;
}

export interface Order {
  sampleNo: string;
  fabric: string;
  machineId: MachineId;
  registeredAt: number;
  revisions: Revision[];
  returns: ReturnRecord[];
}

export interface ConsoleState {
  orders: Record<string, Order>;
}

// ---------- 事件（履历原子记录） ----------

export type ConsoleEvent =
  | { type: "Registered"; at: number; orderId: string; fabric: string; machineId: MachineId; input: RegisterInput; initial?: Inspection }
  | { type: "Returned"; at: number; sampleNo: string; missing: string[]; raw: RegisterInput }
  | { type: "Retested"; at: number; orderId: string; rev: number; inspection: Inspection }
  | { type: "Released"; at: number; orderId: string; rev: number; by: string }
  | {
      type: "Amended";
      at: number;
      orderId: string;
      oldRev: number;
      newRev: number;
      tempC: number;
      speed: number;
      reason: string;
    };

// ---------- 判定 ----------

export function widthDeviation(target: number, actual: number): number {
  if (!target) return 0;
  return Math.abs(actual - target) / target;
}

export function widthDeviationPct(target: number, actual: number): number {
  return widthDeviation(target, actual) * 100;
}

export function evaluateInspection(
  targetWidth: number,
  actualWidth: number,
  skewCm: number,
  handleGrade: number
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (widthDeviation(targetWidth, actualWidth) > WIDTH_TOLERANCE) {
    reasons.push(`门幅偏差 ${widthDeviationPct(targetWidth, actualWidth).toFixed(2)}% 超过 2%`);
  }
  if (Math.abs(skewCm) > SKEW_LIMIT_CM) {
    reasons.push(`纬斜 ${skewCm}cm 超过 3cm`);
  }
  if (handleGrade < HANDLE_MIN_GRADE) {
    reasons.push(`手感 ${handleGrade} 级低于 3 级`);
  }
  return { passed: reasons.length === 0, reasons };
}

export function makeInspection(
  at: number,
  inspector: string,
  targetWidth: number,
  actualWidth: number,
  skewCm: number,
  handleGrade: number
): Inspection {
  const verdict = evaluateInspection(targetWidth, actualWidth, skewCm, handleGrade);
  return { at, inspector: inspector.trim(), actualWidth, skewCm, handleGrade, passed: verdict.passed, failReasons: verdict.reasons };
}

// 登记表缺项检查：任一缺项整单退回
export function findMissingFields(input: RegisterInput): string[] {
  const missing: string[] = [];
  const checkPositive = (label: string, value: string) => {
    const t = value.trim();
    if (t === "") {
      missing.push(label);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) missing.push(label);
  };
  if (!input.sampleNo.trim()) missing.push("小样编号");
  if (!input.fabric.trim()) missing.push("面料");
  if (!input.inspector.trim()) missing.push("检验员");
  checkPositive("温度", input.tempC);
  checkPositive("车速", input.speed);
  checkPositive("标准门幅", input.targetWidth);
  checkPositive("实测门幅", input.actualWidth);
  checkPositive("纬斜", input.skewCm);
  const grade = Number(input.handleGrade);
  if (input.handleGrade.trim() === "" || !Number.isFinite(grade) || grade < 1 || grade > 5) {
    missing.push("手感");
  }
  return missing;
}

// ---------- 取数 ----------

export function currentRevision(order: Order): Revision {
  return order.revisions[order.revisions.length - 1];
}

export function isVoided(rev: Revision): boolean {
  return rev.voidedAt !== undefined;
}

export function inspectionChain(rev: Revision): Inspection[] {
  const seq: Inspection[] = [];
  if (rev.initial) seq.push(rev.initial);
  seq.push(...rev.retests);
  return seq;
}

export const STATUS_META: Record<StatusKey, { label: string; cls: string }> = {
  queued: { label: "排队待位", cls: "st-queued" },
  running: { label: "占机检验中", cls: "st-running" },
  rework: { label: "占机返工", cls: "st-rework" },
  released: { label: "已放行", cls: "st-released" },
};

// ---------- 返工闸门 ----------

export function formatRemaining(ms: number): string {
  const m = Math.ceil(ms / 60000);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h > 0 ? `${h}小时${rest}分` : `${rest}分`;
}

// 依据当前草稿已有的检验记录，判断返工闸门（连续两次合格 / 换人 / 相隔 4 小时）
export function reworkGate(rev: Revision): { ok: boolean; reasons: string[] } {
  const seq = inspectionChain(rev);
  const reasons: string[] = [];
  if (seq.length === 0) return { ok: false, reasons: ["还没有检验记录"] };
  if (seq.length < 2) reasons.push("需另一人复测，连续两次合格，目前仅 1 次检验记录");

  const last = seq[seq.length - 1];
  const prev = seq[seq.length - 2];
  if (!last.passed) {
    reasons.push("最近一次检验不合格，继续占机返工：" + last.failReasons.join("；"));
  }
  if (prev && !prev.passed) {
    reasons.push("需连续两次合格，上一次检验不合格");
  }
  if (prev && last.inspector.trim() === prev.inspector.trim()) {
    reasons.push(`两次复测为同一人（${last.inspector}），返工复测必须换人`);
  }
  if (prev && last.passed && prev.passed && last.at - prev.at < REWORK_GAP_MS) {
    reasons.push(`两次合格须相隔满 4 小时（还差 ${formatRemaining(REWORK_GAP_MS - (last.at - prev.at))}）`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------- 放行判定 ----------

export interface ReleaseCheck {
  eligible: boolean;
  reasons: string[];
  mode: "direct" | "rework";
}

export function checkRelease(order: Order): ReleaseCheck {
  const rev = currentRevision(order);
  const seq = inspectionChain(rev);
  const last = seq[seq.length - 1];
  if (!last) return { eligible: false, reasons: ["还没有检验记录"], mode: "direct" };
  if (!last.passed) {
    return { eligible: false, reasons: ["最近一次检验不合格，继续占机返工", ...last.failReasons], mode: "rework" };
  }

  // 本稿是否进入过返工：任一检验不合格即触发返工闸门；否则合格即可直接放行
  const everFailed = seq.some((s) => !s.passed);
  if (!everFailed) {
    return { eligible: true, reasons: [seq.length > 1 ? "各次检验均合格，可直接放行" : "初检合格，可直接放行"], mode: "direct" };
  }

  const gate = reworkGate(rev);
  return { eligible: gate.ok, reasons: gate.reasons.length ? gate.reasons : ["连续两次合格、相隔 4 小时且复测换人，可放行"], mode: "rework" };
}

// 复测登记前校验：换人、时间不倒置
export function validateRetest(order: Order, inspector: string, at: number): string[] {
  const rev = currentRevision(order);
  const seq = inspectionChain(rev);
  const last = seq[seq.length - 1];
  const errors: string[] = [];
  if (!inspector.trim()) errors.push("请填写复测人");
  if (last && inspector.trim() && inspector.trim() === last.inspector.trim()) {
    errors.push(`返工复测须由另一人执行，不能与上一次检验人 ${last.inspector} 相同`);
  }
  if (last && at < last.at) errors.push("复测时间不能早于上一次检验");
  return errors;
}

// ---------- 事件归约 ----------

export function reduceState(events: ConsoleEvent[]): ConsoleState {
  const state: ConsoleState = { orders: {} };

  for (const e of events) {
    switch (e.type) {
      case "Registered": {
        state.orders[e.orderId] = {
          sampleNo: e.orderId,
          fabric: e.fabric,
          machineId: e.machineId,
          registeredAt: e.at,
          revisions: [
            {
              rev: 1,
              tempC: Number(e.input.tempC),
              speed: Number(e.input.speed),
              targetWidth: Number(e.input.targetWidth),
              createdAt: e.at,
              initial: e.initial,
              retests: [],
            },
          ],
          returns: [],
        };
        break;
      }
      case "Returned": {
        const order = state.orders[e.sampleNo];
        const rec: ReturnRecord = { at: e.at, missing: e.missing, raw: e.raw };
        if (order && order.revisions.length > 0) {
          order.returns.push(rec);
        } else {
          state.orders[e.sampleNo] = {
            sampleNo: e.sampleNo,
            fabric: e.raw.fabric,
            machineId: e.raw.machineId,
            registeredAt: 0,
            revisions: [],
            returns: [rec],
          };
        }
        break;
      }
      case "Retested": {
        const rev = state.orders[e.orderId]?.revisions.find((r) => r.rev === e.rev);
        if (!rev) break;
        // 工艺更正确立的新稿尚无初检：首次检验即新稿初检（按新工艺重新计算）
        if (!rev.initial) rev.initial = e.inspection;
        else rev.retests.push(e.inspection);
        break;
      }
      case "Released": {
        const rev = state.orders[e.orderId]?.revisions.find((r) => r.rev === e.rev);
        if (rev) {
          rev.releasedAt = e.at;
          rev.releasedBy = e.by;
        }
        break;
      }
      case "Amended": {
        const order = state.orders[e.orderId];
        if (!order) break;
        const old = order.revisions.find((r) => r.rev === e.oldRev);
        if (old) {
          // 旧稿保留，仅在旧稿已放行时标记失效
          if (old.releasedAt !== undefined) {
            old.voidedAt = e.at;
            old.voidedReason = "温度/车速更正，旧放行失效，重新计算";
          }
        }
        order.revisions.push({
          rev: e.newRev,
          tempC: e.tempC,
          speed: e.speed,
          targetWidth: old?.targetWidth ?? 0,
          createdAt: e.at,
          retests: [],
        });
        break;
      }
    }
  }
  return state;
}

// ---------- 机位 / 队列 / 状态 派生 ----------

export interface QueueEntry {
  order: Order;
  rev: Revision;
  since: number;
}

export interface MachineView {
  machineId: MachineId;
  occupant?: QueueEntry;
  queue: QueueEntry[];
}

export interface ConsoleView {
  machines: MachineView[];
  statusByOrder: Record<string, StatusKey>;
  metrics: { waiting: number; rework: number; released: number; returns: number };
}

export function deriveView(state: ConsoleState): ConsoleView {
  const machines: MachineView[] = MACHINES.map((machineId) => ({ machineId, queue: [] }));
  const byMachine = new Map<MachineId, MachineView>(machines.map((m) => [m.machineId, m]));

  // 同一小样只占一台机：只看每单最新且未作废、未放行的草稿；按最早登记时间 FIFO
  const active: QueueEntry[] = [];
  let returns = 0;
  for (const order of Object.values(state.orders)) {
    returns += order.returns.length;
    if (order.revisions.length === 0) continue;
    const rev = currentRevision(order);
    if (isVoided(rev) || rev.releasedAt !== undefined) continue;
    active.push({ order, rev, since: rev.createdAt });
  }
  active.sort((a, b) => a.since - b.since || a.order.sampleNo.localeCompare(b.order.sampleNo));

  const occupantByOrder = new Set<string>();
  for (const entry of active) {
    const view = byMachine.get(entry.order.machineId)!;
    if (!view.occupant) {
      view.occupant = entry;
      occupantByOrder.add(entry.order.sampleNo);
    } else {
      view.queue.push(entry);
    }
  }

  const statusByOrder: Record<string, StatusKey> = {};
  let waiting = 0;
  let rework = 0;
  let released = 0;
  for (const order of Object.values(state.orders)) {
    if (order.revisions.length === 0) continue;
    const rev = currentRevision(order);
    let status: StatusKey;
    if (rev.releasedAt !== undefined) {
      status = "released";
      released++;
    } else {
      const last = inspectionChain(rev).slice(-1)[0];
      if (last && !last.passed) {
        status = "rework";
        rework++;
      } else if (occupantByOrder.has(order.sampleNo)) {
        status = "running";
        waiting++;
      } else {
        status = "queued";
        waiting++;
      }
    }
    statusByOrder[order.sampleNo] = status;
  }

  return { machines, statusByOrder, metrics: { waiting, rework, released, returns } };
}
