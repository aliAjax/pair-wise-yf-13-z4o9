import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  DISCHARGE_STEP,
  EQUIPMENT_FILTERS,
  MAX_LEVEL,
  MAX_PRESSURE_VIOLATIONS,
  OIL_LIMIT,
  PRESSURE_MAX,
  PRESSURE_MIN,
  PUMP_IDS,
  PUMP_NAMES,
  PUMP_STATUS_NAMES,
  SHIFTS,
  VALVE_FULL,
  WARNING_LEVEL,
  attemptDischarge,
  closeReview,
  completeHandover,
  currentShift,
  initialState,
  type AttemptResult,
  type ConsoleState,
  type LogKind,
  type PumpId,
} from "./domain";

const STORAGE_KEY = "bilge-console-v1";
const FILTER_KEY = "bilge-console-filter";

function loadState(): ConsoleState {
  const base = initialState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<ConsoleState>;
    return {
      ...base,
      ...parsed,
      pumps: {
        main: { ...base.pumps.main, ...parsed.pumps?.main },
        standby: { ...base.pumps.standby, ...parsed.pumps?.standby },
      },
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
      log: Array.isArray(parsed.log) ? parsed.log : [],
    };
  } catch {
    return base;
  }
}

const KIND_META: Record<LogKind, { label: string; cls: string }> = {
  discharge: { label: "排放完成", cls: "ok" },
  "pressure-warn": { label: "压力越界", cls: "warn" },
  "auto-stop": { label: "自动停机", cls: "bad" },
  rejected: { label: "已拒绝", cls: "muted" },
  "review-closed": { label: "复核关闭", cls: "info" },
  handover: { label: "交接班", cls: "info" },
};

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

export default function App() {
  const [state, setState] = useState<ConsoleState>(loadState);
  const [filter, setFilter] = useState<string>(() => localStorage.getItem(FILTER_KEY) ?? "全部");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({
    waterLevel: "1.20",
    oilPpm: "8",
    valveOpen: "100",
    outletPressure: "0.45",
    pump: "main" as PumpId,
  });
  const [handoverNote, setHandoverNote] = useState("");
  const [closeNotes, setCloseNotes] = useState<Record<string, string>>({});

  // 本地存储同步：状态与筛选条件变化即写入，刷新后保留
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);
  useEffect(() => {
    localStorage.setItem(FILTER_KEY, filter);
  }, [filter]);

  const shift = currentShift(state);
  const nextShift = SHIFTS[(state.shiftIndex + 1) % SHIFTS.length];
  const openReviews = state.reviews.filter((r) => r.status === "open");
  const openThisShift = openReviews.filter((r) => r.shift === shift);

  const shownLog = useMemo(
    () => [...state.log].reverse().filter((e) => filter === "全部" || e.equipment === filter),
    [state.log, filter]
  );

  const apply = (result: AttemptResult): AttemptResult => {
    setState(result.next);
    setNotice({ ok: result.ok, text: result.message });
    return result;
  };

  const fillCurrent = () =>
    setForm((f) => ({
      ...f,
      waterLevel: state.waterLevel.toFixed(2),
      oilPpm: String(state.oilPpm),
      valveOpen: String(state.valveOpen),
    }));

  const onDischarge = () => {
    if ([form.waterLevel, form.oilPpm, form.valveOpen, form.outletPressure].some((s) => s.trim() === "")) {
      setNotice({ ok: false, text: "请完整填写水位、油分、阀开度与出口压力四项读数。" });
      return;
    }
    const result = apply(
      attemptDischarge(state, {
        waterLevel: Number(form.waterLevel),
        oilPpm: Number(form.oilPpm),
        valveOpen: Number(form.valveOpen),
        outletPressure: Number(form.outletPressure),
        pump: form.pump,
      })
    );
    if (result.ok) {
      setForm((f) => ({
        ...f,
        waterLevel: result.next.waterLevel.toFixed(2),
        oilPpm: String(result.next.oilPpm),
        valveOpen: String(result.next.valveOpen),
      }));
    }
  };

  const onHandover = () => {
    const result = apply(completeHandover(state, handoverNote));
    if (result.ok) setHandoverNote("");
  };

  return (
    <main className="app">
      <section className="hero">
        <p>轮机部 · 舱底水排放控制台</p>
        <h1>舱底水排放台</h1>
        <span>
          登记舱底水位、油分浓度、泵出口压力与阀门开度。水位超过警戒线 {WARNING_LEVEL}m 必须启动备用排放泵；
          油分浓度高于 {OIL_LIMIT}ppm 或排放阀未全开时整次拒绝，原水位与泵状态不变；
          泵连续 {MAX_PRESSURE_VIOLATIONS} 次出口压力越界（正常 {PRESSURE_MIN}–{PRESSURE_MAX}MPa）自动停机并生成待复核项；
          本班存在未关闭项不得完成交接，历史记录只追加不改写。
        </span>
        <div className="hero-meta">
          <span className="shift-badge">当前班次：{shift}</span>
          <span className="shift-badge next">下一班次：{nextShift}</span>
        </div>
      </section>

      {notice && <div className={`notice ${notice.ok ? "ok" : "err"}`}>{notice.text}</div>}

      <section className="dash">
        <article className={`card ${state.waterLevel > WARNING_LEVEL ? "bad" : "ok"}`}>
          <small>舱底水位（警戒线 {WARNING_LEVEL}m）</small>
          <strong>{state.waterLevel.toFixed(2)} m</strong>
          <div className="level-bar">
            <div
              className="level-fill"
              style={{ width: `${Math.min(100, (state.waterLevel / MAX_LEVEL) * 100)}%` }}
            />
            <span className="level-mark" style={{ left: `${(WARNING_LEVEL / MAX_LEVEL) * 100}%` }}>
              <i>警戒线</i>
            </span>
          </div>
          <div className="pump-line">
            <span>{state.waterLevel > WARNING_LEVEL ? "超警戒线，须用备用泵" : "低于警戒线"}</span>
            <span>单次排放 -{DISCHARGE_STEP}m</span>
          </div>
        </article>

        <article className={`card ${state.oilPpm > OIL_LIMIT ? "bad" : "ok"}`}>
          <small>油分浓度（限值 {OIL_LIMIT}ppm）</small>
          <strong>{state.oilPpm} ppm</strong>
          <div className="pump-line">
            <span>{state.oilPpm > OIL_LIMIT ? "超标，禁止排放" : "低于限值，允许排放"}</span>
          </div>
        </article>

        <article className={`card ${state.valveOpen >= VALVE_FULL ? "ok" : "warn"}`}>
          <small>排放阀开度（须全开）</small>
          <strong>{state.valveOpen}%</strong>
          <div className="pump-line">
            <span>{state.valveOpen >= VALVE_FULL ? "已全开" : "未全开，禁止排放"}</span>
          </div>
        </article>

        {PUMP_IDS.map((id) => {
          const p = state.pumps[id];
          const cls = p.status === "tripped" ? "bad" : p.status === "running" ? "ok" : "";
          return (
            <article key={id} className={`card ${cls}`}>
              <small>{PUMP_NAMES[id]}</small>
              <strong>{PUMP_STATUS_NAMES[p.status]}</strong>
              <div className="pump-line">
                <span>
                  压力越界 {p.pressureViolations}/{MAX_PRESSURE_VIOLATIONS}
                </span>
                <span>上次出口压力 {p.lastPressure === null ? "—" : `${p.lastPressure.toFixed(2)}MPa`}</span>
              </div>
            </article>
          );
        })}

        <article className={`card ${openThisShift.length > 0 ? "warn" : ""}`}>
          <small>待复核项（本班）</small>
          <strong>{openThisShift.length} 项</strong>
          <div className="pump-line">
            <span>全部未关闭 {openReviews.length} 项</span>
            <span>未关闭不得交接</span>
          </div>
        </article>
      </section>

      <section className="workspace">
        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>排放登记</p>
              <h2>登记读数并执行排放</h2>
            </div>
            <button type="button" onClick={fillCurrent}>
              载入当前读数
            </button>
          </div>
          <div className="field-grid">
            <label>
              <span>舱底水位（m，0–{MAX_LEVEL}）</span>
              <input
                type="number"
                step="0.01"
                min="0"
                max={MAX_LEVEL}
                value={form.waterLevel}
                onChange={(e) => setForm((f) => ({ ...f, waterLevel: e.target.value }))}
              />
            </label>
            <label>
              <span>油分浓度（ppm，限值 {OIL_LIMIT}）</span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={form.oilPpm}
                onChange={(e) => setForm((f) => ({ ...f, oilPpm: e.target.value }))}
              />
            </label>
            <label>
              <span>排放阀开度（%，全开 {VALVE_FULL}）</span>
              <input
                type="number"
                step="1"
                min="0"
                max="100"
                value={form.valveOpen}
                onChange={(e) => setForm((f) => ({ ...f, valveOpen: e.target.value }))}
              />
            </label>
            <label>
              <span>
                泵出口压力（MPa，正常 {PRESSURE_MIN}–{PRESSURE_MAX}）
              </span>
              <input
                type="number"
                step="0.01"
                min="0"
                max="1.6"
                value={form.outletPressure}
                onChange={(e) => setForm((f) => ({ ...f, outletPressure: e.target.value }))}
              />
            </label>
          </div>
          <div className="pump-picker">
            {PUMP_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className={form.pump === id ? "active" : ""}
                onClick={() => setForm((f) => ({ ...f, pump: id }))}
              >
                {PUMP_NAMES[id]} · {PUMP_STATUS_NAMES[state.pumps[id].status]}
              </button>
            ))}
          </div>
          {state.waterLevel > WARNING_LEVEL && (
            <p className="hint warn-text">当前水位超警戒线，必须选择备用排放泵。</p>
          )}
          <button className="primary big" type="button" onClick={onDischarge}>
            执行排放
          </button>
        </section>

        <section className="panel">
          <div className="heading">
            <div>
              <p>待复核项</p>
              <h2>泵自动停机复核（{openReviews.length} 项未关闭）</h2>
            </div>
          </div>
          {state.reviews.length === 0 && (
            <p className="empty">暂无复核项。泵连续两次出口压力越界时将自动生成。</p>
          )}
          <div className="review-list">
            {[...state.reviews].reverse().map((item) => (
              <article key={item.id} className={`review-item ${item.status}`}>
                <div className="log-head">
                  <span className={`badge ${item.status === "open" ? "bad" : "ok"}`}>
                    {item.status === "open" ? "未关闭" : "已关闭"}
                  </span>
                  <span className="tag">{PUMP_NAMES[item.pump]}</span>
                  <span className="tag">{item.shift}</span>
                  <span className="log-time">
                    {item.id} · {fmtTime(item.ts)}
                  </span>
                </div>
                <p>{item.reason}</p>
                {item.status === "open" ? (
                  <div className="row">
                    <input
                      placeholder="复核处理备注"
                      value={closeNotes[item.id] ?? ""}
                      onChange={(e) => setCloseNotes((m) => ({ ...m, [item.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      onClick={() => apply(closeReview(state, item.id, closeNotes[item.id] ?? ""))}
                    >
                      关闭并复位泵
                    </button>
                  </div>
                ) : (
                  <p>
                    关闭于 {item.closedAt ? fmtTime(item.closedAt) : "—"} · {item.closeNote}
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>
      </section>

      <section className="panel handover">
        <div className="heading">
          <div>
            <p>交接班</p>
            <h2>
              {shift} → {nextShift}
            </h2>
          </div>
          <button className="primary" type="button" onClick={onHandover}>
            完成交接
          </button>
        </div>
        <div className="row">
          <input
            placeholder="交接备注（可选）"
            value={handoverNote}
            onChange={(e) => setHandoverNote(e.target.value)}
          />
        </div>
        {openThisShift.length > 0 ? (
          <p className="hint warn-text">本班还有 {openThisShift.length} 项待复核未关闭，不得完成交接。</p>
        ) : (
          <p className="hint">本班无未关闭复核项，可以交接。</p>
        )}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录（只追加，不改写）</p>
            <h2>排放与事件台账 · 共 {state.log.length} 条</h2>
          </div>
        </div>
        <div className="chips">
          {EQUIPMENT_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? "active" : ""}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="log-list">
          {shownLog.length === 0 && <p className="empty">当前筛选下暂无记录。</p>}
          {shownLog.map((entry) => (
            <article key={entry.id} className="log-entry">
              <div className="log-head">
                <span className={`badge ${KIND_META[entry.kind].cls}`}>{KIND_META[entry.kind].label}</span>
                <span className="tag">{entry.equipment}</span>
                <span className="tag">{entry.shift}</span>
                <span className="log-time">
                  {entry.id} · {fmtTime(entry.ts)}
                </span>
              </div>
              <h3>{entry.summary}</h3>
              <p>{entry.detail}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
