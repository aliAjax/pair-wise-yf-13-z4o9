// 轮机舱底水排放台 —— 领域模型与业务规则
// 说明：本文件全部为纯函数；历史记录（log）只追加不改写。

export const OIL_LIMIT_PPM = 15; // 油分浓度限值（15ppm 报警）
export const PRESSURE_MIN_MPA = 0.15; // 泵出口压力正常下限
export const PRESSURE_MAX_MPA = 0.45; // 泵出口压力正常上限
export const PRESSURE_GAUGE_MAX_MPA = 1.6; // 压力表量程
export const DISCHARGE_DROP_M = 0.5; // 单次成功排放水位下降量
export const INFLOW_STEP_M = 0.3; // 模拟进水步进
export const SHIFTS = ["00-04班", "04-08班", "08-12班", "12-16班", "16-20班", "20-24班"];

export type PumpId = "main" | "standby";
export type PumpStatus = "running" | "stopped" | "tripped"; // tripped = 保护性自动停机

export interface PumpState {
  id: PumpId;
  name: string;
  status: PumpStatus;
  lastPressureMpa: number | null;
  consecutiveOutOfBounds: number; // 连续出口压力越界次数
  startCount: number;
}

export interface WellState {
  id: string;
  name: string;
  levelM: number;
  warningLevelM: number; // 警戒线
  capacityM: number;
}

export interface ReviewItem {
  id: string;
  createdAt: string;
  shift: string;
  equipment: string;
  reason: string;
  status: "open" | "closed";
  closedAt: string | null;
  closeNote: string | null;
}

export type EventType =
  | "init"
  | "discharge_accepted"
  | "discharge_rejected"
  | "pump_started"
  | "pressure_alarm"
  | "pump_tripped"
  | "review_created"
  | "review_closed"
  | "level_adjusted"
  | "handover";

export interface LogEvent {
  seq: number;
  at: string;
  shift: string;
  type: EventType;
  equipment: string; // 设备筛选维度
  summary: string;
  detail: string;
}

export interface ConsoleState {
  version: 1;
  shift: string;
  wells: WellState[];
  pumps: PumpState[];
  valveOpeningPct: number; // 排放阀开度 0-100
  lastOilPpm: number; // 最近一次登记的油分浓度读数
  reviewItems: ReviewItem[];
  log: LogEvent[]; // 只追加不改写
  seq: number;
  filter: string; // 设备筛选（"全部" 或设备名），持久化
}

export type Action =
  | { type: "register"; wellId: string; levelM: number; oilPpm: number; pressureMpa: number; at: string }
  | { type: "setValve"; openingPct: number }
  | { type: "adjustLevel"; wellId: string; deltaM: number; at: string }
  | { type: "closeReview"; itemId: string; note: string; at: string }
  | { type: "handover"; at: string }
  | { type: "setFilter"; filter: string }
  | { type: "reset"; at: string };

const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const isPressureOutOfBounds = (mpa: number) => mpa < PRESSURE_MIN_MPA || mpa > PRESSURE_MAX_MPA;

/** 水位超过警戒线时必须启动备用泵 */
export const pumpForLevel = (levelM: number, warningLevelM: number): PumpId =>
  levelM > warningLevelM ? "standby" : "main";

export function nextShift(shift: string): string {
  const i = SHIFTS.indexOf(shift);
  return SHIFTS[(i + 1) % SHIFTS.length];
}

export function initialState(at: string): ConsoleState {
  return {
    version: 1,
    shift: "08-12班",
    wells: [
      { id: "well-er", name: "机舱舱底水井", levelM: 1.1, warningLevelM: 1.5, capacityM: 2 },
      { id: "well-fore", name: "艏尖舱舱底水井", levelM: 0.6, warningLevelM: 1.2, capacityM: 1.8 },
    ],
    pumps: [
      { id: "main", name: "主排放泵", status: "stopped", lastPressureMpa: null, consecutiveOutOfBounds: 0, startCount: 0 },
      { id: "standby", name: "备用排放泵", status: "stopped", lastPressureMpa: null, consecutiveOutOfBounds: 0, startCount: 0 },
    ],
    valveOpeningPct: 100,
    lastOilPpm: 8.2,
    reviewItems: [],
    log: [
      {
        seq: 1,
        at,
        shift: "08-12班",
        type: "init",
        equipment: "系统",
        summary: "舱底水排放台初始化完成",
        detail: `油分限值 ${OIL_LIMIT_PPM}ppm · 出口压力正常范围 ${PRESSURE_MIN_MPA}–${PRESSURE_MAX_MPA}MPa · 历史记录只追加不改写`,
      },
    ],
    seq: 1,
    filter: "全部",
  };
}

export function reducer(state: ConsoleState, action: Action): ConsoleState {
  switch (action.type) {
    case "register":
      return register(state, action);
    case "setValve": {
      const valveOpeningPct = clamp(Math.round(action.openingPct), 0, 100);
      if (valveOpeningPct === state.valveOpeningPct) return state;
      return { ...state, valveOpeningPct };
    }
    case "adjustLevel": {
      const well = state.wells.find((w) => w.id === action.wellId);
      if (!well) return state;
      const levelM = round2(clamp(well.levelM + action.deltaM, 0, well.capacityM));
      if (levelM === well.levelM) return state;
      const seq = state.seq + 1;
      const ev: LogEvent = {
        seq,
        at: action.at,
        shift: state.shift,
        type: "level_adjusted",
        equipment: well.name,
        summary: `舱底进水：${well.name} 水位 ${f2(well.levelM)}m → ${f2(levelM)}m`,
        detail: levelM > well.warningLevelM ? "水位已超过警戒线，排放时必须启动备用排放泵" : "模拟舱底进水",
      };
      return {
        ...state,
        wells: state.wells.map((w) => (w.id === well.id ? { ...w, levelM } : w)),
        log: [...state.log, ev],
        seq,
      };
    }
    case "closeReview": {
      const item = state.reviewItems.find((i) => i.id === action.itemId);
      if (!item || item.status !== "open") return state;
      const reviewItems = state.reviewItems.map((i) =>
        i.id === item.id ? { ...i, status: "closed" as const, closedAt: action.at, closeNote: action.note } : i
      );
      // 复核关闭后，对应泵由自动停机恢复为可启动的停机状态
      const pumps = state.pumps.map((p) =>
        p.name === item.equipment && p.status === "tripped"
          ? { ...p, status: "stopped" as const, consecutiveOutOfBounds: 0 }
          : p
      );
      const seq = state.seq + 1;
      const ev: LogEvent = {
        seq,
        at: action.at,
        shift: state.shift,
        type: "review_closed",
        equipment: item.equipment,
        summary: `待复核项 ${item.id} 已关闭`,
        detail: `处理说明：${action.note}。${item.equipment} 恢复可启动状态。`,
      };
      return { ...state, reviewItems, pumps, log: [...state.log, ev], seq };
    }
    case "handover": {
      // 本班存在未关闭项不得完成交接
      const openThisShift = state.reviewItems.filter((i) => i.status === "open" && i.shift === state.shift);
      if (openThisShift.length > 0) return state;
      const next = nextShift(state.shift);
      const shiftEvents = state.log.filter((e) => e.shift === state.shift);
      const accepted = shiftEvents.filter((e) => e.type === "discharge_accepted").length;
      const rejected = shiftEvents.filter((e) => e.type === "discharge_rejected").length;
      const reviews = state.reviewItems.filter((i) => i.shift === state.shift).length;
      const seq = state.seq + 1;
      const ev: LogEvent = {
        seq,
        at: action.at,
        shift: state.shift,
        type: "handover",
        equipment: "交接班",
        summary: `交接班完成：${state.shift} → ${next}`,
        detail: `本班排放 ${accepted} 次、拒绝 ${rejected} 次、复核项 ${reviews} 项（均已关闭）。历史记录封存，只追加不改写。`,
      };
      return { ...state, shift: next, log: [...state.log, ev], seq };
    }
    case "setFilter":
      return { ...state, filter: action.filter };
    case "reset":
      return initialState(action.at);
  }
}

function register(state: ConsoleState, a: Extract<Action, { type: "register" }>): ConsoleState {
  const well = state.wells.find((w) => w.id === a.wellId);
  if (!well) return state;

  const valve = state.valveOpeningPct;
  let seq = state.seq;
  const events: LogEvent[] = [];
  const emit = (type: EventType, equipment: string, summary: string, detail: string) => {
    seq += 1;
    events.push({ seq, at: a.at, shift: state.shift, type, equipment, summary, detail });
  };
  const snapshot = `水位 ${f2(a.levelM)}m · 油分 ${f1(a.oilPpm)}ppm · 出口压力 ${f2(a.pressureMpa)}MPa · 阀门 ${valve}%`;

  // 规则：油分浓度高于 15ppm 或阀门未全开 → 整次拒绝，原水位与泵状态不变
  const reasons: string[] = [];
  if (a.oilPpm > OIL_LIMIT_PPM) reasons.push(`油分浓度 ${f1(a.oilPpm)}ppm 高于 ${OIL_LIMIT_PPM}ppm`);
  if (valve < 100) reasons.push(`排放阀未全开（当前 ${valve}%）`);
  if (reasons.length > 0) {
    emit("discharge_rejected", well.name, `排放被拒绝：${reasons.join("；")}`, `${snapshot}。整次拒绝，原水位与泵状态不变。`);
    return { ...state, lastOilPpm: a.oilPpm, log: [...state.log, ...events], seq };
  }

  // 规则：水位超过警戒线时必须启动备用泵，否则主泵
  const pumpId = pumpForLevel(a.levelM, well.warningLevelM);
  const pump = state.pumps.find((p) => p.id === pumpId);
  if (!pump || pump.status === "tripped") return state; // 安全联锁：界面已拦截，此处兜底

  const outOfBounds = isPressureOutOfBounds(a.pressureMpa);
  const newLevel = round2(Math.max(0, a.levelM - DISCHARGE_DROP_M));
  let violations = outOfBounds ? pump.consecutiveOutOfBounds + 1 : 0;
  const tripped = violations >= 2;
  if (tripped) violations = 0;

  const pumps = state.pumps.map((p) => {
    if (p.id === pump.id) {
      return {
        ...p,
        status: (tripped ? "tripped" : "running") as PumpStatus,
        lastPressureMpa: a.pressureMpa,
        consecutiveOutOfBounds: violations,
        startCount: p.startCount + 1,
      };
    }
    // 另一台泵若在运行则停下；自动停机状态保持不变
    return p.status === "running" ? { ...p, status: "stopped" as PumpStatus } : p;
  });
  const wells = state.wells.map((w) => (w.id === well.id ? { ...w, levelM: newLevel } : w));

  emit(
    "discharge_accepted",
    well.name,
    `排放完成：${well.name} 水位 ${f2(a.levelM)}m → ${f2(newLevel)}m`,
    snapshot + (pumpId === "standby" ? `。水位超过警戒线 ${f2(well.warningLevelM)}m` : "")
  );
  emit(
    "pump_started",
    pump.name,
    pumpId === "standby" ? "水位超警戒线，备用排放泵启动" : `${pump.name} 启动`,
    `出口压力 ${f2(a.pressureMpa)}MPa（正常 ${PRESSURE_MIN_MPA}–${PRESSURE_MAX_MPA}MPa）`
  );

  let reviewItems = state.reviewItems;
  if (outOfBounds && !tripped) {
    emit(
      "pressure_alarm",
      pump.name,
      `${pump.name} 出口压力越界（第 1 次）`,
      `实测 ${f2(a.pressureMpa)}MPa，正常范围 ${PRESSURE_MIN_MPA}–${PRESSURE_MAX_MPA}MPa；连续两次越界将自动停机。`
    );
  }
  if (tripped) {
    // 规则：泵连续两次出口压力越界 → 自动停机并生成待复核项
    const itemId = `RV-${String(state.reviewItems.length + 1).padStart(3, "0")}`;
    const reason = `${pump.name} 连续两次出口压力越界（本次 ${f2(a.pressureMpa)}MPa，正常 ${PRESSURE_MIN_MPA}–${PRESSURE_MAX_MPA}MPa），保护性自动停机。`;
    const item: ReviewItem = {
      id: itemId,
      createdAt: a.at,
      shift: state.shift,
      equipment: pump.name,
      reason,
      status: "open",
      closedAt: null,
      closeNote: null,
    };
    reviewItems = [...state.reviewItems, item];
    emit("pump_tripped", pump.name, `${pump.name} 连续两次出口压力越界，自动停机`, `生成待复核项 ${itemId}；复核关闭前该泵不可再次启动。`);
    emit("review_created", pump.name, `生成待复核项 ${itemId}`, reason);
  }

  return { ...state, wells, pumps, reviewItems, lastOilPpm: a.oilPpm, log: [...state.log, ...events], seq };
}
