import { ConsoleState, initialState } from "./domain";

const STORAGE_KEY = "bilge-discharge-console:v1";

/** 从 localStorage 恢复状态；数据缺失或损坏时回退到初始状态 */
export function loadState(): ConsoleState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState(new Date().toISOString());
    const parsed = JSON.parse(raw) as ConsoleState;
    const valid =
      parsed &&
      parsed.version === 1 &&
      Array.isArray(parsed.wells) &&
      parsed.wells.length > 0 &&
      Array.isArray(parsed.pumps) &&
      parsed.pumps.length > 0 &&
      Array.isArray(parsed.log) &&
      Array.isArray(parsed.reviewItems);
    return valid ? parsed : initialState(new Date().toISOString());
  } catch {
    return initialState(new Date().toISOString());
  }
}

/** 状态同步到本地存储，刷新后保留 */
export function saveState(state: ConsoleState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用（如隐私模式）时静默忽略，页面内状态仍正常
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}
