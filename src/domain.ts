// 舱底水排放台领域逻辑：常量、状态与全部业务规则（纯函数，便于测试与后续接入后端）

export const WARNING_LEVEL = 1.5; // 舱底水警戒线（m）
export const OIL_LIMIT = 15; // 油分浓度限值（ppm）
export const VALVE_FULL = 100; // 排放阀全开开度（%）
export const PRESSURE_MIN = 0.2; // 泵出口压力正常下限（MPa）
export const PRESSURE_MAX = 0.6; // 泵出口压力正常上限（MPa）
export const DISCHARGE_STEP = 0.4; // 单次排放水位下降量（m）
export const MAX_LEVEL = 2.5; // 舱底水井量程（m）
export const MAX_PRESSURE_VIOLATIONS = 2; // 连续压力越界达到此次数即自动停机

export const SHIFTS = ["00-04班", "04-08班", "08-12班", "12-16班", "16-20班", "20-24班"] as const;

export type PumpId = "main" | "standby";
export const PUMP_IDS: PumpId[] = ["main", "standby"];
export const PUMP_NAMES: Record<PumpId, string> = {
  main: "主排放泵",
  standby: "备用排放泵",
};

export type PumpStatus = "stopped" | "running" | "tripped";
export const PUMP_STATUS_NAMES: Record<PumpStatus, string> = {
  stopped: "待机",
  running: "运行中",
  tripped: "已自动停机",
};

export interface PumpState {
  status: PumpStatus;
  pressureViolations: number; // 连续出口压力越界次数
  lastPressure: number | null; // 最近一次出口压力（MPa）
}

export type Equipment = "舱底水井" | "主排放泵" | "备用排放泵" | "排放阀系" | "交接班";
export const EQUIPMENT_OF_PUMP: Record<PumpId, Equipment> = {
  main: "主排放泵",
  standby: "备用排放泵",
};
export const EQUIPMENT_FILTERS: Array<"全部" | Equipment> = [
  "全部",
  "舱底水井",
  "主排放泵",
  "备用排放泵",
  "排放阀系",
  "交接班",
];

export type LogKind =
  | "discharge"
  | "pressure-warn"
  | "auto-stop"
  | "rejected"
  | "review-closed"
  | "handover";

export interface LogEntry {
  id: string;
  ts: number;
  shift: string;
  kind: LogKind;
  equipment: Equipment;
  summary: string;
  detail: string;
}

export interface ReviewItem {
  id: string;
  ts: number;
  shift: string;
  pump: PumpId;
  reason: string;
  status: "open" | "closed";
  closedAt: number | null;
  closeNote: string | null;
}

export interface ConsoleState {
  seq: number; // 自增序号，用于生成追加记录 ID
  shiftIndex: number;
  waterLevel: number;
  oilPpm: number;
  valveOpen: number;
  pumps: Record<PumpId, PumpState>;
  reviews: ReviewItem[];
  log: LogEntry[]; // 历史记录：只追加，不改写
}

export interface DischargeInput {
  waterLevel: number;
  oilPpm: number;
  valveOpen: number;
  outletPressure: number;
  pump: PumpId;
}

export interface AttemptResult {
  next: ConsoleState;
  ok: boolean;
  message: string;
}

export const currentShift = (state: ConsoleState): string =>
  SHIFTS[state.shiftIndex % SHIFTS.length];

const round2 = (n: number) => Math.round(n * 100) / 100;

export function initialState(): ConsoleState {
  return {
    seq: 0,
    shiftIndex: 2, // 默认 08-12 班
    waterLevel: 0.9,
    oilPpm: 6,
    valveOpen: VALVE_FULL,
    pumps: {
      main: { status: "stopped", pressureViolations: 0, lastPressure: null },
      standby: { status: "stopped", pressureViolations: 0, lastPressure: null },
    },
    reviews: [],
    log: [],
  };
}

function appendLog(
  state: ConsoleState,
  entry: Omit<LogEntry, "id" | "ts" | "shift">
): ConsoleState {
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    log: [
      ...state.log,
      { ...entry, id: `JL-${String(seq).padStart(4, "0")}`, ts: Date.now(), shift: currentShift(state) },
    ],
  };
}

const readingsOf = (input: DischargeInput) =>
  `水位 ${input.waterLevel.toFixed(2)}m · 油分 ${input.oilPpm}ppm · 阀开度 ${input.valveOpen}% · 出口压力 ${input.outletPressure.toFixed(2)}MPa`;

// 登记一次排放：拒绝时整次无效（水位与泵状态不变），只追加一条拒绝记录
export function attemptDischarge(state: ConsoleState, input: DischargeInput): AttemptResult {
  const values = [input.waterLevel, input.oilPpm, input.valveOpen, input.outletPressure];
  if (!values.every((v) => Number.isFinite(v))) {
    return { next: state, ok: false, message: "读数缺失或不是有效数字，本次未登记。" };
  }
  if (input.waterLevel < 0 || input.waterLevel > MAX_LEVEL) {
    return { next: state, ok: false, message: `舱底水位应在 0–${MAX_LEVEL}m 之间。` };
  }
  if (input.oilPpm < 0 || input.oilPpm > 100) {
    return { next: state, ok: false, message: "油分浓度应在 0–100ppm 之间。" };
  }
  if (input.valveOpen < 0 || input.valveOpen > 100) {
    return { next: state, ok: false, message: "阀门开度应在 0–100% 之间。" };
  }
  if (input.outletPressure < 0 || input.outletPressure > 1.6) {
    return { next: state, ok: false, message: "出口压力应在 0–1.6MPa 之间。" };
  }

  const reject = (equipment: Equipment, reason: string): AttemptResult => ({
    next: appendLog(state, {
      kind: "rejected",
      equipment,
      summary: `排放被拒绝：${reason}`,
      detail: readingsOf(input),
    }),
    ok: false,
    message: `已拒绝：${reason}。原水位与泵状态不变。`,
  });

  const pump = state.pumps[input.pump];
  if (pump.status === "tripped") {
    return reject(EQUIPMENT_OF_PUMP[input.pump], `${PUMP_NAMES[input.pump]}已自动停机，复核关闭前禁止使用`);
  }
  if (input.oilPpm > OIL_LIMIT) {
    return reject("舱底水井", `油分浓度 ${input.oilPpm}ppm 高于 ${OIL_LIMIT}ppm 限值`);
  }
  if (input.valveOpen < VALVE_FULL) {
    return reject("排放阀系", `排放阀开度 ${input.valveOpen}%，未全开`);
  }
  if (input.waterLevel > WARNING_LEVEL && input.pump !== "standby") {
    return reject("舱底水井", `水位 ${input.waterLevel.toFixed(2)}m 超过警戒线 ${WARNING_LEVEL}m，必须启动备用排放泵`);
  }

  // 允许排放
  const newLevel = round2(Math.max(0, input.waterLevel - DISCHARGE_STEP));
  const pressureOk = input.outletPressure >= PRESSURE_MIN && input.outletPressure <= PRESSURE_MAX;
  const violations = pressureOk ? 0 : pump.pressureViolations + 1;
  const tripped = violations >= MAX_PRESSURE_VIOLATIONS;

  const pumps: Record<PumpId, PumpState> = {
    main: { ...state.pumps.main },
    standby: { ...state.pumps.standby },
  };
  pumps[input.pump] = {
    status: tripped ? "tripped" : "running",
    pressureViolations: violations,
    lastPressure: input.outletPressure,
  };
  const other: PumpId = input.pump === "main" ? "standby" : "main";
  if (pumps[other].status === "running") {
    pumps[other] = { ...pumps[other], status: "stopped" };
  }

  let next: ConsoleState = {
    ...state,
    waterLevel: newLevel,
    oilPpm: input.oilPpm,
    valveOpen: input.valveOpen,
    pumps,
  };
  const detail = `${readingsOf(input)} · 排放后水位 ${newLevel.toFixed(2)}m`;

  if (tripped) {
    const review: ReviewItem = {
      id: `FH-${String(next.seq + 1).padStart(4, "0")}`,
      ts: Date.now(),
      shift: currentShift(next),
      pump: input.pump,
      reason: `${PUMP_NAMES[input.pump]}连续 ${MAX_PRESSURE_VIOLATIONS} 次出口压力越界（本次 ${input.outletPressure.toFixed(2)}MPa，正常 ${PRESSURE_MIN}–${PRESSURE_MAX}MPa）`,
      status: "open",
      closedAt: null,
      closeNote: null,
    };
    next = { ...next, reviews: [...next.reviews, review] };
    next = appendLog(next, {
      kind: "auto-stop",
      equipment: EQUIPMENT_OF_PUMP[input.pump],
      summary: `${PUMP_NAMES[input.pump]}连续两次出口压力越界，自动停机并生成待复核项`,
      detail,
    });
    return {
      next,
      ok: true,
      message: `排放完成；${PUMP_NAMES[input.pump]}连续两次压力越界已自动停机，复核关闭后方可再用。`,
    };
  }

  if (!pressureOk) {
    next = appendLog(next, {
      kind: "pressure-warn",
      equipment: EQUIPMENT_OF_PUMP[input.pump],
      summary: `${PUMP_NAMES[input.pump]}出口压力 ${input.outletPressure.toFixed(2)}MPa 越界（第 1 次，正常 ${PRESSURE_MIN}–${PRESSURE_MAX}MPa）`,
      detail,
    });
    return {
      next,
      ok: true,
      message: `排放完成；出口压力越界警告（1/${MAX_PRESSURE_VIOLATIONS}），再次越界将自动停机。`,
    };
  }

  next = appendLog(next, {
    kind: "discharge",
    equipment: EQUIPMENT_OF_PUMP[input.pump],
    summary: `${PUMP_NAMES[input.pump]}排放完成`,
    detail,
  });
  return { next, ok: true, message: `排放完成，水位降至 ${newLevel.toFixed(2)}m。` };
}

// 关闭待复核项：泵复位待机，并追加一条关闭记录（不改写历史）
export function closeReview(state: ConsoleState, id: string, note: string): AttemptResult {
  const item = state.reviews.find((r) => r.id === id);
  if (!item || item.status === "closed") {
    return { next: state, ok: false, message: "复核项不存在或已关闭。" };
  }
  const closeNote = note.trim() || "复核完成，泵复位待机。";
  const pumps: Record<PumpId, PumpState> = {
    main: { ...state.pumps.main },
    standby: { ...state.pumps.standby },
  };
  if (pumps[item.pump].status === "tripped") {
    pumps[item.pump] = { ...pumps[item.pump], status: "stopped", pressureViolations: 0 };
  }
  const closed: ReviewItem = { ...item, status: "closed", closedAt: Date.now(), closeNote };
  let next: ConsoleState = {
    ...state,
    pumps,
    reviews: state.reviews.map((r) => (r.id === id ? closed : r)),
  };
  next = appendLog(next, {
    kind: "review-closed",
    equipment: EQUIPMENT_OF_PUMP[item.pump],
    summary: `待复核项关闭：${item.reason}`,
    detail: `处理备注：${closeNote}`,
  });
  return { next, ok: true, message: "复核项已关闭，泵已复位为待机。" };
}

// 交接班：本班存在未关闭复核项时不得完成交接
export function completeHandover(state: ConsoleState, note: string): AttemptResult {
  const shift = currentShift(state);
  const openCount = state.reviews.filter((r) => r.shift === shift && r.status === "open").length;
  if (openCount > 0) {
    return { next: state, ok: false, message: `本班还有 ${openCount} 项待复核未关闭，不得完成交接。` };
  }
  const nextIndex = (state.shiftIndex + 1) % SHIFTS.length;
  let next = appendLog(state, {
    kind: "handover",
    equipment: "交接班",
    summary: `${shift} → ${SHIFTS[nextIndex]} 交接完成`,
    detail: note.trim() ? `交接备注：${note.trim()}` : "无交接备注",
  });
  next = { ...next, shiftIndex: nextIndex };
  return { next, ok: true, message: `交接完成，当前班次：${SHIFTS[nextIndex]}。` };
}
