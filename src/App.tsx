import { FormEvent, useEffect, useMemo, useReducer, useState } from "react";
import {
  DISCHARGE_DROP_M,
  INFLOW_STEP_M,
  LogEvent,
  OIL_LIMIT_PPM,
  PRESSURE_GAUGE_MAX_MPA,
  PRESSURE_MAX_MPA,
  PRESSURE_MIN_MPA,
  PumpState,
  ReviewItem,
  WellState,
  isPressureOutOfBounds,
  nextShift,
  pumpForLevel,
  reducer,
} from "./domain";
import { clearState, loadState, saveState } from "./storage";
import "./styles.css";

const EVENT_META: Record<LogEvent["type"], { label: string; tone: "ok" | "err" | "warn" | "info" | "muted" }> = {
  init: { label: "初始化", tone: "muted" },
  discharge_accepted: { label: "排放完成", tone: "ok" },
  discharge_rejected: { label: "排放拒绝", tone: "err" },
  pump_started: { label: "泵启动", tone: "info" },
  pressure_alarm: { label: "压力越界", tone: "warn" },
  pump_tripped: { label: "自动停机", tone: "err" },
  review_created: { label: "待复核", tone: "warn" },
  review_closed: { label: "复核关闭", tone: "ok" },
  level_adjusted: { label: "水位调整", tone: "muted" },
  handover: { label: "交接班", tone: "info" },
};

const PUMP_STATUS_META: Record<PumpState["status"], { label: string; tone: "ok" | "err" | "muted" }> = {
  running: { label: "运行中", tone: "ok" },
  stopped: { label: "已停机", tone: "muted" },
  tripped: { label: "自动停机·待复核", tone: "err" },
};

const parseNum = (s: string): number => {
  const t = s.trim();
  return t === "" ? NaN : Number(t);
};

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

export default function App() {
  const [state, dispatch] = useReducer(reducer, null, loadState);

  // 本地存储同步：任何状态变化立即持久化，刷新保留
  useEffect(() => {
    saveState(state);
  }, [state]);

  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  // ---- 排放登记表单 ----
  const [wellId, setWellId] = useState<string>(state.wells[0]?.id ?? "");
  const well = state.wells.find((w) => w.id === wellId) ?? state.wells[0];
  const [levelInput, setLevelInput] = useState(() => well.levelM.toFixed(2));
  const [oilInput, setOilInput] = useState(() => state.lastOilPpm.toFixed(1));
  const [pressureInput, setPressureInput] = useState("0.30");

  // 水位读数跟随所选水井的实际液位
  useEffect(() => {
    setLevelInput(well.levelM.toFixed(2));
  }, [well.id, well.levelM]);

  const level = parseNum(levelInput);
  const oil = parseNum(oilInput);
  const pressure = parseNum(pressureInput);

  const errors: string[] = [];
  if (!Number.isFinite(level) || level < 0 || level > well.capacityM) errors.push(`水位需在 0–${well.capacityM.toFixed(1)}m 之间`);
  if (!Number.isFinite(oil) || oil < 0 || oil > 100) errors.push("油分浓度需在 0–100ppm 之间");
  if (!Number.isFinite(pressure) || pressure < 0 || pressure > PRESSURE_GAUGE_MAX_MPA)
    errors.push(`出口压力需在 0–${PRESSURE_GAUGE_MAX_MPA}MPa 之间`);
  const valid = errors.length === 0;

  // 规则预演（与 reducer 判定一致，用于界面即时提示）
  const valveOpen = state.valveOpeningPct >= 100;
  const oilOver = Number.isFinite(oil) && oil > OIL_LIMIT_PPM;
  const willReject = oilOver || !valveOpen;
  const overWarning = Number.isFinite(level) && level > well.warningLevelM;
  const needPumpId = pumpForLevel(Number.isFinite(level) ? level : well.levelM, well.warningLevelM);
  const needPump = state.pumps.find((p) => p.id === needPumpId) ?? state.pumps[0];
  const pumpBlocked = !willReject && needPump.status === "tripped";

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!valid) {
      setNotice({ tone: "err", text: errors.join("；") });
      return;
    }
    if (pumpBlocked) {
      setNotice({ tone: "err", text: `${needPump.name} 已自动停机，须先关闭对应待复核项。` });
      return;
    }
    const at = new Date().toISOString();
    dispatch({ type: "register", wellId: well.id, levelM: level, oilPpm: oil, pressureMpa: pressure, at });
    if (willReject) {
      const reasons = [
        oilOver ? `油分浓度 ${oil.toFixed(1)}ppm 高于 ${OIL_LIMIT_PPM}ppm` : "",
        !valveOpen ? `排放阀未全开（当前 ${state.valveOpeningPct}%）` : "",
      ]
        .filter(Boolean)
        .join("；");
      setNotice({ tone: "err", text: `排放被拒绝：${reasons}。整次拒绝，原水位与泵状态不变。` });
      return;
    }
    const oob = isPressureOutOfBounds(pressure);
    const willTrip = oob && needPump.consecutiveOutOfBounds + 1 >= 2;
    if (willTrip) {
      setNotice({ tone: "warn", text: `排放完成；${needPump.name} 连续两次出口压力越界，已自动停机并生成待复核项。` });
    } else if (oob) {
      setNotice({ tone: "warn", text: `排放完成；${needPump.name} 出口压力越界（第 1 次），再次越界将自动停机。` });
    } else {
      setNotice({ tone: "ok", text: `排放完成：${well.name} 水位下降，${needPump.name} 运行正常。` });
    }
  };

  // ---- 交接班 ----
  const openThisShift = state.reviewItems.filter((i) => i.status === "open" && i.shift === state.shift);
  const openTotal = state.reviewItems.filter((i) => i.status === "open").length;
  const doHandover = () => {
    if (openThisShift.length > 0) {
      setNotice({ tone: "err", text: `本班存在 ${openThisShift.length} 项未关闭复核项，不得完成交接。` });
      return;
    }
    const next = nextShift(state.shift);
    dispatch({ type: "handover", at: new Date().toISOString() });
    setNotice({ tone: "ok", text: `交接班完成：${state.shift} → ${next}，本班记录已封存（只追加不改写）。` });
  };

  // ---- 看板统计 ----
  const stats = useMemo(() => {
    const ev = state.log.filter((e) => e.shift === state.shift);
    return {
      accepted: ev.filter((e) => e.type === "discharge_accepted").length,
      rejected: ev.filter((e) => e.type === "discharge_rejected").length,
    };
  }, [state.log, state.shift]);

  // ---- 设备筛选的历史记录 ----
  const equipmentOptions = ["全部", ...state.wells.map((w) => w.name), ...state.pumps.map((p) => p.name), "交接班"];
  const filteredLog = state.filter === "全部" ? state.log : state.log.filter((e) => e.equipment === state.filter);
  const shownLog = [...filteredLog].reverse();

  const resetAll = () => {
    if (!window.confirm("确定清空本地全部数据并恢复初始状态？此操作不可撤销。")) return;
    clearState();
    dispatch({ type: "reset", at: new Date().toISOString() });
    setNotice({ tone: "ok", text: "已恢复初始状态。" });
  };

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">HXYFRONT-62001 · 船舶轮机</p>
          <h1>轮机舱底水排放台</h1>
          <p className="sub">
            登记舱底水位、油分浓度、排放泵出口压力与阀门开度。水位超警戒线须启动备用泵；油分＞{OIL_LIMIT_PPM}ppm
            或阀门未全开整次拒绝；泵连续两次压力越界自动停机并生成待复核项；本班未关闭项未清零不得交接。
          </p>
        </div>
        <div className="top-actions">
          <span className="shift-badge">当班 {state.shift}</span>
          {openTotal > 0 && <span className="badge badge-err">未关闭复核 {openTotal}</span>}
          <button type="button" className="ghost" onClick={resetAll}>
            重置数据
          </button>
        </div>
      </header>

      {notice && (
        <div className={`notice notice-${notice.tone}`} role="status">
          <span>{notice.text}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      {/* 看板 */}
      <section className="dashboard" aria-label="参数看板">
        {state.wells.map((w) => (
          <WellCard
            key={w.id}
            well={w}
            onInflow={() => dispatch({ type: "adjustLevel", wellId: w.id, deltaM: INFLOW_STEP_M, at: new Date().toISOString() })}
          />
        ))}
        {state.pumps.map((p) => (
          <PumpCard key={p.id} pump={p} />
        ))}
        <ValveCard opening={state.valveOpeningPct} onChange={(v) => dispatch({ type: "setValve", openingPct: v })} />
        <OilCard ppm={state.lastOilPpm} />
        <article className="card shift-card">
          <header>
            <small>值班班次</small>
            <span className="badge badge-info">下一班 {nextShift(state.shift)}</span>
          </header>
          <strong>{state.shift}</strong>
          <dl className="kv">
            <div>
              <dt>本班排放</dt>
              <dd>{stats.accepted} 次</dd>
            </div>
            <div>
              <dt>本班拒绝</dt>
              <dd>{stats.rejected} 次</dd>
            </div>
            <div>
              <dt>未关闭复核</dt>
              <dd className={openThisShift.length > 0 ? "err-text" : ""}>{openThisShift.length} 项</dd>
            </div>
          </dl>
          <button
            type="button"
            className="primary"
            disabled={openThisShift.length > 0}
            title={openThisShift.length > 0 ? "本班存在未关闭复核项，不得完成交接" : `完成交接并进入${nextShift(state.shift)}`}
            onClick={doHandover}
          >
            完成交接 → {nextShift(state.shift)}
          </button>
          {openThisShift.length > 0 && <p className="hint err-text">本班存在未关闭复核项，不得完成交接</p>}
        </article>
      </section>

      <section className="workbench">
        {/* 排放登记 */}
        <form className="panel" onSubmit={submit}>
          <div className="heading">
            <div>
              <p>排放登记</p>
              <h2>登记本次排放参数</h2>
            </div>
            <button type="submit" className="primary" disabled={!valid || pumpBlocked}>
              登记排放
            </button>
          </div>
          <div className="field-grid">
            <label>
              <span>舱底水井</span>
              <select value={well.id} onChange={(e) => setWellId(e.target.value)}>
                {state.wells.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}（当前 {w.levelM.toFixed(2)}m）
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>舱底水位（m）· 警戒线 {well.warningLevelM.toFixed(1)}m</span>
              <input value={levelInput} onChange={(e) => setLevelInput(e.target.value)} inputMode="decimal" placeholder="如 1.20" />
            </label>
            <label>
              <span>油分浓度（ppm）· 限值 {OIL_LIMIT_PPM}</span>
              <input value={oilInput} onChange={(e) => setOilInput(e.target.value)} inputMode="decimal" placeholder="如 8.5" />
            </label>
            <label>
              <span>
                泵出口压力（MPa）· 正常 {PRESSURE_MIN_MPA}–{PRESSURE_MAX_MPA}
              </span>
              <input value={pressureInput} onChange={(e) => setPressureInput(e.target.value)} inputMode="decimal" placeholder="如 0.30" />
            </label>
            <label>
              <span>阀门开度（%）· 随登记快照入档</span>
              <input readOnly value={`${state.valveOpeningPct}% ${valveOpen ? "· 全开" : "· 未全开（在右侧看板操作阀门）"}`} />
            </label>
          </div>
          <div className="rule-hints">
            {!valid && <span className="chip chip-err">{errors[0]}</span>}
            {valid && willReject && (
              <span className="chip chip-err">
                将整次拒绝：{[oilOver ? `油分 ${oil.toFixed(1)}ppm＞${OIL_LIMIT_PPM}ppm` : "", !valveOpen ? "阀门未全开" : ""]
                  .filter(Boolean)
                  .join("；")}
                （原水位与泵状态不变）
              </span>
            )}
            {valid && !willReject && overWarning && <span className="chip chip-warn">水位超警戒线，将启动备用排放泵</span>}
            {valid && !willReject && !overWarning && (
              <span className="chip chip-ok">将启动主排放泵，单次排放水位下降 {DISCHARGE_DROP_M}m</span>
            )}
            {pumpBlocked && <span className="chip chip-err">{needPump.name} 已自动停机，须先关闭对应待复核项</span>}
          </div>
          <ul className="rules">
            <li>水位超过警戒线 → 必须启动备用排放泵</li>
            <li>油分＞{OIL_LIMIT_PPM}ppm 或阀门未全开 → 整次拒绝，原水位与泵状态不变</li>
            <li>
              泵连续两次出口压力越界（{PRESSURE_MIN_MPA}–{PRESSURE_MAX_MPA}MPa 之外）→ 自动停机并生成待复核项
            </li>
            <li>本班存在未关闭项 → 不得完成交接；历史记录只追加不改写</li>
          </ul>
        </form>

        {/* 待复核项 */}
        <aside className="panel">
          <div className="heading">
            <div>
              <p>安全联锁</p>
              <h2>待复核项（{openTotal}）</h2>
            </div>
          </div>
          {state.reviewItems.length === 0 && (
            <p className="empty">暂无复核项。泵连续两次出口压力越界将自动停机，并在此生成待复核项。</p>
          )}
          <div className="review-list">
            {[...state.reviewItems].reverse().map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                onClose={(note) => {
                  dispatch({ type: "closeReview", itemId: item.id, note, at: new Date().toISOString() });
                  setNotice({ tone: "ok", text: `待复核项 ${item.id} 已关闭，${item.equipment} 恢复可启动状态。` });
                }}
              />
            ))}
          </div>
          <p className="hint">本班存在未关闭项时不得完成交接；复核关闭后对应泵恢复可启动。</p>
        </aside>
      </section>

      {/* 历史记录：设备筛选 + 只追加不改写 */}
      <section className="panel history-panel">
        <div className="heading">
          <div>
            <p>设备筛选 · 只追加不改写</p>
            <h2>
              历史记录（{filteredLog.length} / {state.log.length} 条）
            </h2>
          </div>
        </div>
        <div className="chips">
          {equipmentOptions.map((name) => (
            <button
              key={name}
              type="button"
              className={state.filter === name ? "chip-active" : ""}
              onClick={() => dispatch({ type: "setFilter", filter: name })}
            >
              {name}
            </button>
          ))}
        </div>
        {shownLog.length === 0 && <p className="empty">当前筛选条件下暂无记录。</p>}
        <ol className="timeline">
          {shownLog.map((ev) => (
            <li key={ev.seq}>
              <b className="seq">#{String(ev.seq).padStart(3, "0")}</b>
              <div>
                <div className="ev-head">
                  <span className={`badge badge-${EVENT_META[ev.type].tone}`}>{EVENT_META[ev.type].label}</span>
                  <span className="ev-equip">{ev.equipment}</span>
                  <span className="ev-shift">{ev.shift}</span>
                  <time>{fmtTime(ev.at)}</time>
                </div>
                <p className="ev-summary">{ev.summary}</p>
                {ev.detail && <p className="ev-detail">{ev.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

function WellCard({ well, onInflow }: { well: WellState; onInflow: () => void }) {
  const over = well.levelM > well.warningLevelM;
  const pct = Math.min(100, (well.levelM / well.capacityM) * 100);
  const warnPct = (well.warningLevelM / well.capacityM) * 100;
  return (
    <article className={`card ${over ? "card-alarm" : ""}`}>
      <header>
        <small>{well.name}</small>
        <span className={`badge ${over ? "badge-err" : "badge-ok"}`}>{over ? "超警戒线" : "正常"}</span>
      </header>
      <strong>
        {well.levelM.toFixed(2)}
        <i>m</i>
      </strong>
      <div className="level-bar" aria-label={`水位 ${well.levelM.toFixed(2)} 米，警戒线 ${well.warningLevelM} 米`}>
        <div className={`level-fill ${over ? "over" : ""}`} style={{ width: `${pct}%` }} />
        <i className="warn-mark" style={{ left: `${warnPct}%` }} />
      </div>
      <footer>
        <span>
          警戒线 {well.warningLevelM.toFixed(1)}m · 容量 {well.capacityM.toFixed(1)}m
        </span>
        <button type="button" className="mini" onClick={onInflow}>
          模拟进水 +{INFLOW_STEP_M}m
        </button>
      </footer>
    </article>
  );
}

function PumpCard({ pump }: { pump: PumpState }) {
  const st = PUMP_STATUS_META[pump.status];
  return (
    <article className={`card ${pump.status === "tripped" ? "card-alarm" : ""}`}>
      <header>
        <small>{pump.name}</small>
        <span className={`badge badge-${st.tone}`}>{st.label}</span>
      </header>
      <strong>
        {pump.lastPressureMpa == null ? "—" : pump.lastPressureMpa.toFixed(2)}
        <i>MPa</i>
      </strong>
      <dl className="kv">
        <div>
          <dt>连续越界</dt>
          <dd className={pump.consecutiveOutOfBounds > 0 ? "warn-text" : ""}>{pump.consecutiveOutOfBounds} 次</dd>
        </div>
        <div>
          <dt>累计启动</dt>
          <dd>{pump.startCount} 次</dd>
        </div>
      </dl>
      <footer>
        <span>
          正常压力 {PRESSURE_MIN_MPA}–{PRESSURE_MAX_MPA}MPa
        </span>
      </footer>
    </article>
  );
}

function ValveCard({ opening, onChange }: { opening: number; onChange: (v: number) => void }) {
  const full = opening >= 100;
  return (
    <article className={`card ${full ? "" : "card-warn"}`}>
      <header>
        <small>排放阀开度</small>
        <span className={`badge ${full ? "badge-ok" : "badge-err"}`}>{full ? "全开" : "未全开"}</span>
      </header>
      <strong>
        {opening}
        <i>%</i>
      </strong>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={opening}
        aria-label="排放阀开度"
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <footer>
        <span>{full ? "满足排放条件" : "未全开时排放将被整次拒绝"}</span>
        {[0, 50, 100].map((v) => (
          <button key={v} type="button" className="mini" onClick={() => onChange(v)}>
            {v === 0 ? "全关" : v === 100 ? "全开" : "50%"}
          </button>
        ))}
      </footer>
    </article>
  );
}

function OilCard({ ppm }: { ppm: number }) {
  const over = ppm > OIL_LIMIT_PPM;
  return (
    <article className={`card ${over ? "card-alarm" : ""}`}>
      <header>
        <small>最近油分浓度</small>
        <span className={`badge ${over ? "badge-err" : "badge-ok"}`}>{over ? "超标" : "合格"}</span>
      </header>
      <strong>
        {ppm.toFixed(1)}
        <i>ppm</i>
      </strong>
      <footer>
        <span>限值 ≤ {OIL_LIMIT_PPM}ppm（15ppm 油分报警）</span>
      </footer>
    </article>
  );
}

function ReviewCard({ item, onClose }: { item: ReviewItem; onClose: (note: string) => void }) {
  const [note, setNote] = useState("");
  const open = item.status === "open";
  return (
    <article className={`review ${open ? "" : "closed"}`}>
      <header>
        <b>{item.id}</b>
        <span className={`badge ${open ? "badge-warn" : "badge-ok"}`}>{open ? "待复核" : "已关闭"}</span>
      </header>
      <p className="review-reason">{item.reason}</p>
      <p className="review-meta">
        {item.equipment} · {item.shift} · {fmtTime(item.createdAt)}
      </p>
      {open ? (
        <div className="review-actions">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="处理说明（如：拆检出口阀，已复位）" />
          <button type="button" className="primary" onClick={() => onClose(note.trim() || "已复核，泵恢复正常")}>
            关闭
          </button>
        </div>
      ) : (
        <p className="review-close-note">
          关闭于 {item.closedAt ? fmtTime(item.closedAt) : "—"} · {item.closeNote}
        </p>
      )}
    </article>
  );
}
