// 热定型机位放行台 —— 存档层
// 事件溯源：所有操作追加为不可变事件并持久化到 localStorage；
// 机位占用、队列、履历全部由同一事件流归约得到，刷新 / 多标签页一致。

import {
  ConsoleEvent,
  ConsoleState,
  RegisterInput,
  STORAGE_KEY,
  currentRevision,
  findMissingFields,
  makeInspection,
  reduceState,
  validateRetest,
  checkRelease,
  type MachineId,
} from "./rules";

const HOUR = 60 * 60 * 1000;

export type RegisterResult =
  | { outcome: "registered"; sampleNo: string }
  | { outcome: "duplicate"; sampleNo: string; status: "active" | "released" }
  | { outcome: "returned"; sampleNo: string; missing: string[] };

function uid(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

function fullInput(partial: Partial<RegisterInput> & Pick<RegisterInput, "sampleNo" | "fabric" | "machineId">): RegisterInput {
  return {
    tempC: "",
    speed: "",
    targetWidth: "",
    actualWidth: "",
    skewCm: "",
    handleGrade: "",
    inspector: "",
    ...partial,
  };
}

// 演示数据：覆盖已放行后改工艺失效、返工 4 小时闸门、排队、整单退回等场景
export function buildSeedEvents(now: number): ConsoleEvent[] {
  const ev: ConsoleEvent[] = [];

  // RX-2401：已放行 → 温度更正，旧放行失效重算，最新一次复测不合格，占 1# 机返工
  {
    const input = fullInput({
      sampleNo: "RX-2401",
      fabric: "棉氨纶汗布 180g",
      machineId: "1#热定型",
      tempC: "175",
      speed: "22",
      targetWidth: "150",
      actualWidth: "149.6",
      skewCm: "1.2",
      handleGrade: "3.5",
      inspector: "李倩",
    });
    ev.push({
      type: "Registered",
      at: now - 26 * HOUR,
      orderId: "RX-2401",
      fabric: input.fabric,
      machineId: input.machineId,
      input,
      initial: makeInspection(now - 26 * HOUR, "李倩", 150, 149.6, 1.2, 3.5),
    });
    ev.push({ type: "Released", at: now - 25 * HOUR, orderId: "RX-2401", rev: 1, by: "李倩" });
    ev.push({
      type: "Amended",
      at: now - 6 * HOUR,
      orderId: "RX-2401",
      oldRev: 1,
      newRev: 2,
      tempC: 180,
      speed: 22,
      reason: "客户反馈门幅稳定性不足，定型温度由175℃上调至180℃",
    });
    ev.push({
      type: "Retested",
      at: now - 5 * HOUR,
      orderId: "RX-2401",
      rev: 2,
      inspection: makeInspection(now - 5 * HOUR, "王梅", 150, 153.6, 1.5, 3.5),
    });
  }

  // RX-2402：初检不合格 → 已换人复测 1 次合格，等待隔 4 小时后的第 2 次合格复测，占 2# 机
  {
    const input = fullInput({
      sampleNo: "RX-2402",
      fabric: "涤纶春亚纺",
      machineId: "2#热定型",
      tempC: "190",
      speed: "28",
      targetWidth: "150",
      actualWidth: "154.2",
      skewCm: "2.0",
      handleGrade: "3.5",
      inspector: "李倩",
    });
    ev.push({
      type: "Registered",
      at: now - 10 * HOUR,
      orderId: "RX-2402",
      fabric: input.fabric,
      machineId: input.machineId,
      input,
      initial: makeInspection(now - 10 * HOUR, "李倩", 150, 154.2, 2.0, 3.5),
    });
    ev.push({
      type: "Retested",
      at: now - 5 * HOUR - 20 * 60000,
      orderId: "RX-2402",
      rev: 1,
      inspection: makeInspection(now - 5 * HOUR - 20 * 60000, "王梅", 150, 150.6, 1.1, 3.5),
    });
  }

  // RX-2403：初检合格待放行，占 3# 机
  {
    const input = fullInput({
      sampleNo: "RX-2403",
      fabric: "锦纶塔丝隆",
      machineId: "3#热定型",
      tempC: "165",
      speed: "20",
      targetWidth: "148",
      actualWidth: "147.8",
      skewCm: "0.8",
      handleGrade: "4",
      inspector: "赵磊",
    });
    ev.push({
      type: "Registered",
      at: now - 2 * HOUR,
      orderId: "RX-2403",
      fabric: input.fabric,
      machineId: input.machineId,
      input,
      initial: makeInspection(now - 2 * HOUR, "赵磊", 148, 147.8, 0.8, 4),
    });
  }

  // RX-2404：初检合格，在 1# 机后排队待位
  {
    const input = fullInput({
      sampleNo: "RX-2404",
      fabric: "混纺帆布",
      machineId: "1#热定型",
      tempC: "185",
      speed: "18",
      targetWidth: "160",
      actualWidth: "159.4",
      skewCm: "1.5",
      handleGrade: "3.5",
      inspector: "陈晨",
    });
    ev.push({
      type: "Registered",
      at: now - 30 * 60000,
      orderId: "RX-2404",
      fabric: input.fabric,
      machineId: input.machineId,
      input,
      initial: makeInspection(now - 30 * 60000, "陈晨", 160, 159.4, 1.5, 3.5),
    });
  }
  // RX-2405：初检合格，在 2# 机后排队待位
  {
    const input = fullInput({
      sampleNo: "RX-2405",
      fabric: "棉府绸 120g",
      machineId: "2#热定型",
      tempC: "170",
      speed: "24",
      targetWidth: "144",
      actualWidth: "144.5",
      skewCm: "0.6",
      handleGrade: "4",
      inspector: "陈晨",
    });
    ev.push({
      type: "Registered",
      at: now - 15 * 60000,
      orderId: "RX-2405",
      fabric: input.fabric,
      machineId: input.machineId,
      input,
      initial: makeInspection(now - 15 * 60000, "陈晨", 144, 144.5, 0.6, 4),
    });
  }

  // RX-2406：登记缺纬斜、手感 → 整单退回（未占机）
  {
    const raw = fullInput({
      sampleNo: "RX-2406",
      fabric: "涤棉斜纹",
      machineId: "4#热定型",
      tempC: "178",
      speed: "21",
      targetWidth: "152",
      actualWidth: "152.4",
      skewCm: "",
      handleGrade: "",
      inspector: "陈晨",
    });
    ev.push({ type: "Returned", at: now - 3 * HOUR, sampleNo: "RX-2406", missing: ["纬斜", "手感"], raw });
  }

  return ev;
}

function isEventArray(value: unknown): value is ConsoleEvent[] {
  return Array.isArray(value) && value.every((v) => v && typeof v === "object" && typeof (v as ConsoleEvent).type === "string");
}

export class EventStore {
  private events: ConsoleEvent[];
  private state: ConsoleState;
  private listeners = new Set<() => void>();

  constructor() {
    this.events = this.load();
    this.state = reduceState(this.events);
    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.onStorage);
    }
  }

  private load(): ConsoleEvent[] {
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (text) {
        const parsed: unknown = JSON.parse(text);
        if (isEventArray(parsed)) return parsed;
      }
    } catch {
      // 存档损坏时回落为演示数据
    }
    const seed = buildSeedEvents(Date.now());
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    } catch {
      // 忽略持久化失败
    }
    return seed;
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.events));
    } catch {
      // 忽略持久化失败
    }
  }

  private onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    try {
      const parsed: unknown = e.newValue ? JSON.parse(e.newValue) : [];
      if (isEventArray(parsed)) {
        this.events = parsed;
        this.state = reduceState(this.events);
        this.listeners.forEach((fn) => fn());
      }
    } catch {
      // 忽略不可解析的外部写入
    }
  };

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getEvents(): ConsoleEvent[] {
    return this.events;
  }

  getState(): ConsoleState {
    return this.state;
  }

  private append(event: ConsoleEvent) {
    this.events = [...this.events, event];
    this.state = reduceState(this.events);
    this.persist();
    this.listeners.forEach((fn) => fn());
  }

  // 登记：同一小样只占一台机；重复或并发登记沿用最早结果；缺项整单退回
  register(input: RegisterInput, at: number = Date.now()): RegisterResult {
    const existing = this.state.orders[input.sampleNo.trim()];
    if (existing && existing.revisions.length > 0) {
      const released = currentRevision(existing).releasedAt !== undefined;
      return { outcome: "duplicate", sampleNo: existing.sampleNo, status: released ? "released" : "active" };
    }
    const missing = findMissingFields(input);
    if (missing.length > 0) {
      this.append({ type: "Returned", at, sampleNo: input.sampleNo.trim() || "(未填编号)", missing, raw: input });
      return { outcome: "returned", sampleNo: input.sampleNo.trim(), missing };
    }
    const orderId = input.sampleNo.trim();
    const initial = makeInspection(
      at,
      input.inspector,
      Number(input.targetWidth),
      Number(input.actualWidth),
      Number(input.skewCm),
      Number(input.handleGrade)
    );
    this.append({ type: "Registered", at, orderId, fabric: input.fabric.trim(), machineId: input.machineId, input, initial });
    return { outcome: "registered", sampleNo: orderId };
  }

  // 返工复测：另一人复测；数值缺项按整单处理同样拒绝
  retest(
    orderId: string,
    fields: { inspector: string; actualWidth: string; skewCm: string; handleGrade: string; at: number }
  ): string[] {
    const order = this.state.orders[orderId];
    if (!order || order.revisions.length === 0) return ["小样工单不存在"];
    const errors: string[] = [];
    if (!fields.inspector.trim()) errors.push("复测人");
    const actualWidth = Number(fields.actualWidth);
    const skewCm = Number(fields.skewCm);
    const handleGrade = Number(fields.handleGrade);
    if (fields.actualWidth.trim() === "" || !Number.isFinite(actualWidth) || actualWidth < 0) errors.push("实测门幅");
    if (fields.skewCm.trim() === "" || !Number.isFinite(skewCm)) errors.push("纬斜");
    if (fields.handleGrade.trim() === "" || !Number.isFinite(handleGrade) || handleGrade < 1 || handleGrade > 5) errors.push("手感");
    errors.push(...validateRetest(order, fields.inspector, fields.at));
    if (errors.length > 0) return errors;

    const rev = currentRevision(order);
    const inspection = makeInspection(fields.at, fields.inspector, rev.targetWidth, actualWidth, skewCm, handleGrade);
    this.append({ type: "Retested", at: Date.now(), orderId, rev: rev.rev, inspection });
    return [];
  }

  release(orderId: string, by: string, at: number = Date.now()): { ok: boolean; reasons: string[] } {
    const order = this.state.orders[orderId];
    if (!order || order.revisions.length === 0) return { ok: false, reasons: ["小样工单不存在"] };
    if (!by.trim()) return { ok: false, reasons: ["请填写放行确认人"] };
    const check = checkRelease(order);
    if (!check.eligible) return { ok: false, reasons: check.reasons };
    const rev = currentRevision(order);
    this.append({ type: "Released", at, orderId, rev: rev.rev, by: by.trim() });
    return { ok: true, reasons: [] };
  }

  // 温度或车速更正：旧稿保留；旧放行失效，新稿重新计算
  amend(orderId: string, tempC: string, speed: string, reason: string, at: number = Date.now()): string[] {
    const order = this.state.orders[orderId];
    if (!order || order.revisions.length === 0) return ["小样工单不存在"];
    const t = Number(tempC);
    const s = Number(speed);
    const errors: string[] = [];
    if (tempC.trim() === "" || !Number.isFinite(t) || t < 0) errors.push("温度");
    if (speed.trim() === "" || !Number.isFinite(s) || s < 0) errors.push("车速");
    if (errors.length > 0) return errors;
    const rev = currentRevision(order);
    if (t === rev.tempC && s === rev.speed) return ["温度、车速均未变化，无需更正"];
    this.append({
      type: "Amended",
      at,
      orderId,
      oldRev: rev.rev,
      newRev: rev.rev + 1,
      tempC: t,
      speed: s,
      reason: reason.trim() || "工艺参数更正",
    });
    return [];
  }

  resetDemo() {
    const seed = buildSeedEvents(Date.now());
    this.events = seed;
    this.state = reduceState(seed);
    this.persist();
    this.listeners.forEach((fn) => fn());
  }
}

export const store = new EventStore();

export type { MachineId };
export { uid };
