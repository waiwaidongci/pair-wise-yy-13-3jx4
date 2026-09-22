/**
 * 热定型机位放行台 —— 规则引擎（纯函数，不依赖界面与存储）
 *
 * 业务规则：
 * 1. 同一小样同一时刻只占一台机；重复或并发登记沿用最早结果，不再占机。
 * 2. 登记必须包含温度、车速、门幅（实测+标准）、纬斜，缺项整单退回。
 * 3. 门幅偏差 > 2%、纬斜绝对值 > 3cm 或手感 < 3 级：继续占机并转返工。
 * 4. 返工须另一人复测；连续两次合格且两次间隔 ≥ 4 小时才放行。
 * 5. 温度或车速更正后旧放行失效、按新参数重算；旧稿（历史参数）保留。
 * 6. 机位释放后，等待队列中最早登记的单自动补位。
 */

// ---------- 常量 ----------

export const STENTERS: readonly string[] = ["1#", "2#", "3#", "4#", "5#", "6#"];

/** 门幅允许偏差（%），超过即返工 */
export const WIDTH_TOLERANCE_PCT = 2;
/** 纬斜允许绝对值（cm），超过即返工 */
export const SKEW_LIMIT_CM = 3;
/** 手感最低合格等级 */
export const HANDFEEL_MIN_GRADE = 3;
/** 返工放行所需连续合格次数 */
export const RELEASE_CONSECUTIVE_PASSES = 2;
/** 两次合格之间的最小间隔（毫秒，4 小时） */
export const RELEASE_MIN_GAP_MS = 4 * 60 * 60 * 1000;

// ---------- 类型 ----------

export type TicketStatus =
  | "inspecting" // 已占机，待初检判定
  | "rework" // 占机返工中
  | "queued" // 等待机位
  | "released" // 已放行
  | "returned"; // 缺项整单退回

export interface ProcessParams {
  temperatureC: number; // 温度 ℃
  speedMpm: number; // 车速 m/min
  widthStdCm: number; // 标准门幅 cm
}

export interface MeasureInput {
  widthActualCm: number; // 实测门幅 cm
  skewCm: number; // 纬斜 cm（带正负号）
  handFeelGrade: number; // 手感等级 1-5
}

export interface MeasureRecord extends MeasureInput {
  at: number; // 实测时间戳
  operator: string; // 检验人
  kind: "initial" | "retest"; // 初检 / 复测
  pass: boolean; // 本次是否合格
  reasons: string[]; // 不合格原因
}

export interface Revision {
  id: string;
  at: number;
  operator: string;
  before: ProcessParams;
  after: ProcessParams;
  invalidatedRelease: boolean; // 本次更正是否使旧放行失效
}

export interface TicketEvent {
  at: number;
  text: string;
}

export interface Ticket {
  id: string;
  sampleNo: string; // 小样批号
  fabric: string; // 面料成分（可空）
  machineId: string; // 目标机位
  params: ProcessParams; // 现行工艺参数
  initialMeasure: MeasureInput | null; // 登记时的初检数据（退回单为 null）
  measures: MeasureRecord[]; // 检验记录（新→旧）
  revisions: Revision[]; // 更正记录，旧稿保留（新→旧）
  events: TicketEvent[]; // 履历（新→旧）
  status: TicketStatus;
  consecutivePasses: number; // 返工连续合格次数
  lastPassAt: number | null; // 最近一次合格时间
  registeredBy: string; // 登记人（初检人）
  createdAt: number;
  updatedAt: number;
  releasedAt: number | null;
  releaseInvalidatedAt: number | null; // 最近一次旧放行失效时间
  returnReason: string | null; // 退回原因
}

export interface RegisterInput {
  sampleNo: string;
  fabric: string;
  machineId: string;
  temperatureC: number;
  speedMpm: number;
  widthStdCm: number;
  widthActualCm: number;
  skewCm: number;
  handFeelGrade: number;
  operator: string;
  now: number;
}

export interface RetestInput {
  ticketId: string;
  operator: string;
  widthActualCm: number;
  skewCm: number;
  handFeelGrade: number;
  measuredAt: number; // 实测时间（决定 4 小时间隔）
  now: number;
}

export interface CorrectInput {
  ticketId: string;
  operator: string;
  temperatureC: number;
  speedMpm: number;
  widthStdCm: number;
  now: number;
}

export interface ReleaseState {
  tickets: Ticket[];
  seq: number;
}

export interface ActionResult {
  state: ReleaseState;
  ok: boolean;
  message: string;
  ticketId?: string;
}

// ---------- 基础规则函数 ----------

/** 门幅偏差百分比 = |实测 - 标准| / 标准 × 100 */
export function widthDeviationPct(actualCm: number, stdCm: number): number {
  if (!(stdCm > 0)) return 0;
  return (Math.abs(actualCm - stdCm) / stdCm) * 100;
}

/** 判定一组检验数据的不合格原因；返回空数组即合格 */
export function measureReasons(m: MeasureInput, stdWidthCm: number): string[] {
  const reasons: string[] = [];
  const dev = widthDeviationPct(m.widthActualCm, stdWidthCm);
  if (dev > WIDTH_TOLERANCE_PCT) {
    reasons.push(`门幅偏差 ${dev.toFixed(2)}% ＞ ${WIDTH_TOLERANCE_PCT}%`);
  }
  if (Math.abs(m.skewCm) > SKEW_LIMIT_CM) {
    reasons.push(`纬斜 ${m.skewCm}cm 超 ±${SKEW_LIMIT_CM}cm`);
  }
  if (m.handFeelGrade < HANDFEEL_MIN_GRADE) {
    reasons.push(`手感 ${m.handFeelGrade} 级 ＜ ${HANDFEEL_MIN_GRADE} 级`);
  }
  return reasons;
}

export function measurePass(m: MeasureInput, stdWidthCm: number): boolean {
  return measureReasons(m, stdWidthCm).length === 0;
}

/** 登记缺项检查：温度、车速、门幅、纬斜任一项缺失/非法即整单退回 */
export function missingFields(input: RegisterInput): string[] {
  const missing: string[] = [];
  if (!input.sampleNo.trim()) missing.push("小样批号");
  if (!STENTERS.includes(input.machineId)) missing.push("机位");
  if (!input.operator.trim()) missing.push("登记人");
  if (!(input.temperatureC > 0)) missing.push("温度");
  if (!(input.speedMpm > 0)) missing.push("车速");
  if (!(input.widthStdCm > 0)) missing.push("标准门幅");
  if (!(input.widthActualCm > 0)) missing.push("实测门幅");
  if (!Number.isFinite(input.skewCm)) missing.push("纬斜");
  if (!(input.handFeelGrade >= 1 && input.handFeelGrade <= 5)) missing.push("手感等级");
  return missing;
}

/** 在制单（占机或排队中的单）；已放行、已退回不再占机 */
export function isActive(t: Ticket): boolean {
  return t.status === "inspecting" || t.status === "rework" || t.status === "queued";
}

/** 同一小样的最早在制单——重复/并发登记时沿用它 */
export function findActiveTicket(state: ReleaseState, sampleNo: string): Ticket | undefined {
  const no = sampleNo.trim();
  return state.tickets
    .filter((t) => t.sampleNo === no && isActive(t))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}

/** 机位占用表：同一机位最多一张在制单 */
export function occupancyMap(state: ReleaseState): Map<string, Ticket> {
  const map = new Map<string, Ticket>();
  for (const t of state.tickets) {
    if ((t.status === "inspecting" || t.status === "rework") && !map.has(t.machineId)) {
      map.set(t.machineId, t);
    }
  }
  return map;
}

/** 等待队列（按登记先后，最早在前） */
export function queueOf(state: ReleaseState): Ticket[] {
  return state.tickets
    .filter((t) => t.status === "queued")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 距下一次可计入放行的时间（毫秒）；已可计入返回 0 */
export function nextRetestInMs(ticket: Ticket, now: number): number {
  if (ticket.consecutivePasses !== 1 || ticket.lastPassAt === null) return 0;
  return Math.max(0, ticket.lastPassAt + RELEASE_MIN_GAP_MS - now);
}

/** 返工放行进度说明 */
export function releaseProgressText(ticket: Ticket, now: number): string {
  if (ticket.status !== "rework") return "";
  if (ticket.consecutivePasses === 0) return "待第 1 次合格复测（须另一人）";
  if (ticket.consecutivePasses === 1) {
    const wait = nextRetestInMs(ticket, now);
    return wait > 0
      ? `已 1 次合格，第 2 次需再等 ${(wait / 3600000).toFixed(1)} 小时`
      : "已 1 次合格且间隔满 4 小时，可复测放行";
  }
  return "已达放行条件";
}

// ---------- 状态构造 ----------

export function createInitialState(): ReleaseState {
  return { tickets: [], seq: 0 };
}

function cloneState(state: ReleaseState): ReleaseState {
  return structuredClone(state);
}

function nextId(state: ReleaseState, prefix: string): string {
  state.seq += 1;
  return `${prefix}-${String(state.seq).padStart(4, "0")}`;
}

function fail(state: ReleaseState, message: string): ActionResult {
  return { state, ok: false, message };
}

function pushEvent(ticket: Ticket, at: number, text: string): void {
  ticket.events.unshift({ at, text });
}

// ---------- 内部流转 ----------

function buildMeasure(
  input: MeasureInput,
  stdWidthCm: number,
  operator: string,
  kind: MeasureRecord["kind"],
  at: number
): MeasureRecord {
  const reasons = measureReasons(input, stdWidthCm);
  return { ...input, at, operator, kind, pass: reasons.length === 0, reasons };
}

/** 初检判定：合格直接放行；不合格继续占机转返工 */
function applyInitialDecision(state: ReleaseState, ticket: Ticket, at: number): void {
  const m = ticket.initialMeasure;
  if (!m) return;
  const record = buildMeasure(m, ticket.params.widthStdCm, ticket.registeredBy, "initial", at);
  ticket.measures.unshift(record);
  ticket.updatedAt = at;
  if (record.pass) {
    ticket.status = "released";
    ticket.releasedAt = at;
    pushEvent(ticket, at, `初检合格，${ticket.machineId} 机放行`);
  } else {
    ticket.status = "rework";
    ticket.consecutivePasses = 0;
    ticket.lastPassAt = null;
    pushEvent(ticket, at, `初检不合格（${record.reasons.join("；")}），继续占 ${ticket.machineId} 机转返工`);
  }
}

/** 机位释放后，最早登记的等待单自动补位；补位单初检即放行则继续补下一张 */
function promoteQueue(state: ReleaseState, machineId: string, at: number): void {
  for (;;) {
    const occupied = state.tickets.some(
      (t) => (t.status === "inspecting" || t.status === "rework") && t.machineId === machineId
    );
    if (occupied) return;
    const next = state.tickets
      .filter((t) => t.status === "queued" && t.machineId === machineId)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return;
    next.status = "inspecting";
    next.updatedAt = at;
    pushEvent(next, at, `${machineId} 机空出，补位上机，执行初检判定`);
    applyInitialDecision(state, next, at);
  }
}

// ---------- 对外动作 ----------

/** 登记小样：缺项整单退回；重复/并发沿用最早结果；机位空闲则占机初检，否则排队 */
export function registerSample(prev: ReleaseState, input: RegisterInput): ActionResult {
  const state = cloneState(prev);
  const now = input.now;
  const sampleNo = input.sampleNo.trim();
  const operator = input.operator.trim();

  const missing = missingFields(input);
  if (missing.length > 0) {
    const ticket: Ticket = {
      id: nextId(state, "T"),
      sampleNo,
      fabric: input.fabric.trim(),
      machineId: STENTERS.includes(input.machineId) ? input.machineId : "—",
      params: {
        temperatureC: input.temperatureC,
        speedMpm: input.speedMpm,
        widthStdCm: input.widthStdCm,
      },
      initialMeasure: null,
      measures: [],
      revisions: [],
      events: [],
      status: "returned",
      consecutivePasses: 0,
      lastPassAt: null,
      registeredBy: operator || "—",
      createdAt: now,
      updatedAt: now,
      releasedAt: null,
      releaseInvalidatedAt: null,
      returnReason: `缺项：${missing.join("、")}`,
    };
    pushEvent(ticket, now, `登记缺项（${missing.join("、")}），整单退回`);
    state.tickets.unshift(ticket);
    return {
      state,
      ok: false,
      ticketId: ticket.id,
      message: `缺 ${missing.join("、")}，整单退回（已留档 ${ticket.id}）`,
    };
  }

  // 同一小样只占一台机：重复或并发登记沿用最早结果
  const existing = findActiveTicket(state, sampleNo);
  if (existing) {
    return {
      state: prev,
      ok: true,
      ticketId: existing.id,
      message: `小样 ${sampleNo} 已在 ${existing.machineId} 机（${existing.id}），重复/并发登记沿用最早结果`,
    };
  }

  const ticket: Ticket = {
    id: nextId(state, "T"),
    sampleNo,
    fabric: input.fabric.trim(),
    machineId: input.machineId,
    params: {
      temperatureC: input.temperatureC,
      speedMpm: input.speedMpm,
      widthStdCm: input.widthStdCm,
    },
    initialMeasure: {
      widthActualCm: input.widthActualCm,
      skewCm: input.skewCm,
      handFeelGrade: input.handFeelGrade,
    },
    measures: [],
    revisions: [],
    events: [],
    status: "inspecting",
    consecutivePasses: 0,
    lastPassAt: null,
    registeredBy: operator,
    createdAt: now,
    updatedAt: now,
    releasedAt: null,
    releaseInvalidatedAt: null,
    returnReason: null,
  };

  const occupied = occupancyMap(state).has(input.machineId);
  if (occupied) {
    ticket.status = "queued";
    pushEvent(ticket, now, `${input.machineId} 机占用中，进入等待队列`);
    state.tickets.unshift(ticket);
    return {
      state,
      ok: true,
      ticketId: ticket.id,
      message: `${input.machineId} 机占用中，${sampleNo} 已排队（${ticket.id}）`,
    };
  }

  pushEvent(ticket, now, `登记上 ${input.machineId} 机，执行初检判定`);
  state.tickets.unshift(ticket);
  applyInitialDecision(state, ticket, now);
  const finalTicket = state.tickets.find((t) => t.id === ticket.id)!;
  return {
    state,
    ok: true,
    ticketId: ticket.id,
    message:
      finalTicket.status === "released"
        ? `${sampleNo} 初检合格，${input.machineId} 机放行（${ticket.id}）`
        : `${sampleNo} 初检不合格，继续占 ${input.machineId} 机转返工（${ticket.id}）`,
  };
}

/** 返工复测：须另一人；连续两次合格且间隔 ≥4 小时才放行 */
export function retestSample(prev: ReleaseState, input: RetestInput): ActionResult {
  const state = cloneState(prev);
  const ticket = state.tickets.find((t) => t.id === input.ticketId);
  if (!ticket) return fail(prev, "未找到该小样单");
  if (ticket.status !== "rework") return fail(prev, "当前状态不可复测（仅返工中可复测）");

  const operator = input.operator.trim();
  if (!operator) return fail(prev, "请填写复测人");
  // 返工须另一人复测：复测人既不能是登记人，也不能是上一次检验人
  const prevTester = ticket.measures[0]?.operator ?? ticket.registeredBy;
  if (operator === prevTester) {
    return fail(prev, `返工须另一人复测：复测人不能与上一位检验人（${prevTester}）相同`);
  }
  if (!(input.widthActualCm > 0)) return fail(prev, "实测门幅须为正数");
  if (!Number.isFinite(input.skewCm)) return fail(prev, "纬斜须为数值");
  if (!(input.handFeelGrade >= 1 && input.handFeelGrade <= 5)) return fail(prev, "手感等级须为 1-5");
  if (!Number.isFinite(input.measuredAt) || input.measuredAt <= 0) return fail(prev, "实测时间无效");
  if (input.measuredAt > input.now + 5 * 60 * 1000) return fail(prev, "实测时间不能晚于当前时间");
  const lastAt = ticket.measures[0]?.at;
  if (lastAt !== undefined && input.measuredAt < lastAt) {
    return fail(prev, "实测时间不能早于上一次检验");
  }

  const record = buildMeasure(
    {
      widthActualCm: input.widthActualCm,
      skewCm: input.skewCm,
      handFeelGrade: input.handFeelGrade,
    },
    ticket.params.widthStdCm,
    operator,
    "retest",
    input.measuredAt
  );
  ticket.measures.unshift(record);
  ticket.updatedAt = input.now;

  if (!record.pass) {
    ticket.consecutivePasses = 0;
    ticket.lastPassAt = null;
    pushEvent(
      ticket,
      input.now,
      `复测不合格（${record.reasons.join("；")}），连续合格清零，继续占 ${ticket.machineId} 机返工`
    );
    return { state, ok: true, ticketId: ticket.id, message: `复测不合格：${record.reasons.join("；")}` };
  }

  // 合格：距上次合格不足 4 小时不计入连续次数
  if (ticket.consecutivePasses === 1 && ticket.lastPassAt !== null) {
    const gap = input.measuredAt - ticket.lastPassAt;
    if (gap < RELEASE_MIN_GAP_MS) {
      const waitH = ((RELEASE_MIN_GAP_MS - gap) / 3600000).toFixed(1);
      pushEvent(
        ticket,
        input.now,
        `复测合格，但与上次合格间隔不足 4 小时（还差 ${waitH} 小时），不计入连续次数`
      );
      return {
        state,
        ok: true,
        ticketId: ticket.id,
        message: `复测合格，但距上次合格不足 4 小时（还差 ${waitH} 小时），本次不计入`,
      };
    }
  }

  ticket.consecutivePasses += 1;
  ticket.lastPassAt = input.measuredAt;

  if (ticket.consecutivePasses >= RELEASE_CONSECUTIVE_PASSES) {
    ticket.status = "released";
    ticket.releasedAt = input.now;
    pushEvent(ticket, input.now, `连续 ${RELEASE_CONSECUTIVE_PASSES} 次合格且间隔满 4 小时，${ticket.machineId} 机放行`);
    promoteQueue(state, ticket.machineId, input.now);
    return {
      state,
      ok: true,
      ticketId: ticket.id,
      message: `连续两次合格且间隔满 4 小时，${ticket.sampleNo} 放行，${ticket.machineId} 机已释放`,
    };
  }

  pushEvent(ticket, input.now, `复测合格（第 1 次），需间隔 4 小时后再由他人复测`);
  return {
    state,
    ok: true,
    ticketId: ticket.id,
    message: `第 1 次合格已记录，间隔满 4 小时后再复测`,
  };
}

/** 更正工艺参数：温度或车速变化 → 旧放行失效、按新参数重算；旧稿保留 */
export function correctParams(prev: ReleaseState, input: CorrectInput): ActionResult {
  const state = cloneState(prev);
  const ticket = state.tickets.find((t) => t.id === input.ticketId);
  if (!ticket) return fail(prev, "未找到该小样单");
  if (ticket.status === "returned") return fail(prev, "退回单不可更正，请重新登记");

  const operator = input.operator.trim();
  if (!operator) return fail(prev, "请填写更正人");
  if (!(input.temperatureC > 0)) return fail(prev, "温度须为正数");
  if (!(input.speedMpm > 0)) return fail(prev, "车速须为正数");
  if (!(input.widthStdCm > 0)) return fail(prev, "标准门幅须为正数");

  const before = { ...ticket.params };
  const after: ProcessParams = {
    temperatureC: input.temperatureC,
    speedMpm: input.speedMpm,
    widthStdCm: input.widthStdCm,
  };
  if (
    before.temperatureC === after.temperatureC &&
    before.speedMpm === after.speedMpm &&
    before.widthStdCm === after.widthStdCm
  ) {
    return fail(prev, "参数未变化，无需更正");
  }

  const criticalChanged =
    before.temperatureC !== after.temperatureC || before.speedMpm !== after.speedMpm;
  const hadRelease = ticket.status === "released";

  ticket.params = after;
  ticket.updatedAt = input.now;
  ticket.revisions.unshift({
    id: nextId(state, "R"),
    at: input.now,
    operator,
    before,
    after,
    invalidatedRelease: criticalChanged && hadRelease,
  });

  if (criticalChanged) {
    // 温度/车速更正：旧放行失效，按新参数重算
    ticket.consecutivePasses = 0;
    ticket.lastPassAt = null;
    if (hadRelease) {
      ticket.status = "rework";
      ticket.releaseInvalidatedAt = input.now;
      pushEvent(
        ticket,
        input.now,
        `温度/车速更正（${before.temperatureC}℃·${before.speedMpm}m/min → ${after.temperatureC}℃·${after.speedMpm}m/min），旧放行失效，重新占 ${ticket.machineId} 机返工`
      );
    } else {
      pushEvent(
        ticket,
        input.now,
        `温度/车速更正（${before.temperatureC}℃·${before.speedMpm}m/min → ${after.temperatureC}℃·${after.speedMpm}m/min），按新参数重算，连续合格清零`
      );
    }
  } else {
    pushEvent(
      ticket,
      input.now,
      `标准门幅更正（${before.widthStdCm}cm → ${after.widthStdCm}cm），后续检验按新标准判定`
    );
  }

  return {
    state,
    ok: true,
    ticketId: ticket.id,
    message: criticalChanged
      ? hadRelease
        ? "温度/车速已更正，旧放行失效，按新参数重算（旧稿已保留）"
        : "温度/车速已更正，按新参数重算，连续合格清零（旧稿已保留）"
      : "标准门幅已更正（旧稿已保留）",
  };
}

// ---------- 展示元数据 ----------

export const STATUS_META: Record<TicketStatus, { label: string; tone: string }> = {
  inspecting: { label: "待初检", tone: "info" },
  rework: { label: "返工中", tone: "warn" },
  queued: { label: "排队中", tone: "muted" },
  released: { label: "已放行", tone: "ok" },
  returned: { label: "已退回", tone: "bad" },
};

export const RULE_SUMMARY: string[] = [
  "同一小样只占一台机，重复或并发登记沿用最早结果",
  "登记须含温度、车速、门幅、纬斜，缺项整单退回",
  `门幅偏差＞${WIDTH_TOLERANCE_PCT}%、纬斜＞±${SKEW_LIMIT_CM}cm 或手感＜${HANDFEEL_MIN_GRADE} 级：继续占机转返工`,
  `返工须另一人复测，连续 ${RELEASE_CONSECUTIVE_PASSES} 次合格且间隔满 4 小时才放行`,
  "温度或车速更正后旧放行失效重算，旧稿保留",
];
