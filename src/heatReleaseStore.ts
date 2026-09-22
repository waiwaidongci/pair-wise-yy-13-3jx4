/**
 * 热定型机位放行台 —— 存档（localStorage 持久化）
 *
 * 每次状态变更后整体落盘；刷新后从存档恢复，
 * 机位占用、等待队列与履历均由同一份状态推导，保证一致。
 * 首次打开时写入一份演示数据，便于直接查看各状态。
 */

import {
  correctParams,
  createInitialState,
  registerSample,
  retestSample,
  type ReleaseState,
} from "./heatReleaseRules";

export const STORAGE_KEY = "heat-set-release:v1";

function isValidState(value: unknown): value is ReleaseState {
  if (!value || typeof value !== "object") return false;
  const v = value as ReleaseState;
  return Array.isArray(v.tickets) && typeof v.seq === "number";
}

/** 读取存档；无存档时生成演示数据 */
export function loadState(): ReleaseState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (isValidState(parsed)) return parsed;
    }
  } catch {
    // 存档损坏时回落到演示数据
  }
  const seeded = buildDemoSeed();
  saveState(seeded);
  return seeded;
}

/** 写入存档 */
export function saveState(state: ReleaseState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用（如隐私模式）时静默失败，界面仍可操作
  }
}

/** 清空存档并恢复演示数据 */
export function resetState(): ReleaseState {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  const seeded = buildDemoSeed();
  saveState(seeded);
  return seeded;
}

const HOUR = 3600 * 1000;

/** 演示数据：覆盖返工中、排队、已放行、已退回四种状态 */
function buildDemoSeed(): ReleaseState {
  const now = Date.now();
  let state = createInitialState();

  // 1# 机：LAB-620A 初检门幅超差转返工，5 小时前第 1 次复测合格（间隔已满 4 小时）
  let r = registerSample(state, {
    sampleNo: "LAB-620A",
    fabric: "棉府绸 120g",
    machineId: "1#",
    temperatureC: 190,
    speedMpm: 45,
    widthStdCm: 150,
    widthActualCm: 154.2,
    skewCm: 1.2,
    handFeelGrade: 4,
    operator: "王芳",
    now: now - 26 * HOUR,
  });
  state = r.state;
  const t620a = r.ticketId!;
  r = retestSample(state, {
    ticketId: t620a,
    operator: "李强",
    widthActualCm: 150.8,
    skewCm: 0.9,
    handFeelGrade: 4,
    measuredAt: now - 5 * HOUR,
    now: now - 5 * HOUR,
  });
  state = r.state;

  // 1# 机等待队列：LAB-621C（初检即合格，补位后会直接放行）
  r = registerSample(state, {
    sampleNo: "LAB-621C",
    fabric: "涤纶针织",
    machineId: "1#",
    temperatureC: 185,
    speedMpm: 50,
    widthStdCm: 160,
    widthActualCm: 160.9,
    skewCm: 0.6,
    handFeelGrade: 4,
    operator: "王芳",
    now: now - 20 * HOUR,
  });
  state = r.state;

  // 2# 机：LAB-624B 初检纬斜超差转返工，1 小时前第 1 次复测合格（间隔未满 4 小时）
  r = registerSample(state, {
    sampleNo: "LAB-624B",
    fabric: "混纺斜纹",
    machineId: "2#",
    temperatureC: 195,
    speedMpm: 40,
    widthStdCm: 148,
    widthActualCm: 148.6,
    skewCm: 3.6,
    handFeelGrade: 4,
    operator: "赵敏",
    now: now - 30 * HOUR,
  });
  state = r.state;
  const t624b = r.ticketId!;
  r = retestSample(state, {
    ticketId: t624b,
    operator: "王芳",
    widthActualCm: 148.4,
    skewCm: 1.1,
    handFeelGrade: 4,
    measuredAt: now - 1 * HOUR,
    now: now - 1 * HOUR,
  });
  state = r.state;

  // 2# 机等待队列：LAB-625A（初检手感不足，补位后转返工）
  r = registerSample(state, {
    sampleNo: "LAB-625A",
    fabric: "锦纶塔夫绸",
    machineId: "2#",
    temperatureC: 180,
    speedMpm: 55,
    widthStdCm: 152,
    widthActualCm: 152.4,
    skewCm: 0.8,
    handFeelGrade: 2,
    operator: "赵敏",
    now: now - 18 * HOUR,
  });
  state = r.state;

  // 3# 机：LAB-618D 初检合格放行，随后更正温度 → 旧放行失效重新返工（演示更正规则）
  r = registerSample(state, {
    sampleNo: "LAB-618D",
    fabric: "棉麻混纺",
    machineId: "3#",
    temperatureC: 188,
    speedMpm: 42,
    widthStdCm: 150,
    widthActualCm: 150.7,
    skewCm: 0.5,
    handFeelGrade: 4,
    operator: "李强",
    now: now - 50 * HOUR,
  });
  state = r.state;
  const t618d = r.ticketId!;
  r = correctParams(state, {
    ticketId: t618d,
    operator: "李强",
    temperatureC: 192,
    speedMpm: 42,
    widthStdCm: 150,
    now: now - 8 * HOUR,
  });
  state = r.state;

  // 退回留档：LAB-626F 缺车速与纬斜，整单退回
  r = registerSample(state, {
    sampleNo: "LAB-626F",
    fabric: "涤棉府绸",
    machineId: "4#",
    temperatureC: 190,
    speedMpm: 0,
    widthStdCm: 150,
    widthActualCm: 150.5,
    skewCm: Number.NaN,
    handFeelGrade: 4,
    operator: "王芳",
    now: now - 10 * HOUR,
  });
  state = r.state;

  return state;
}
