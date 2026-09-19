import type { PathCategory } from './m1-contracts';
import type { RuntimeDisplay } from './m1-display';

// Category identity is stable across runs and probability orderings. Letters also
// identify lines when colours cannot be distinguished; probabilities stay numeric.
export const CATEGORY_STYLE: Readonly<Record<PathCategory, { color: string; symbol: string }>> = {
  surge_reversal: { color: '#f0bd6c', symbol: 'A' },
  dip_rebound: { color: '#8cb8ff', symbol: 'B' },
  uptrend: { color: '#70ddbc', symbol: 'C' },
  downtrend: { color: '#ef90b2', symbol: 'D' },
  narrow: { color: '#b4a0f3', symbol: 'E' },
  other: { color: '#c8d4dd', symbol: 'F' },
};
type Probability = { id: PathCategory; probability_24h: number };
export function rankProbabilities<T extends Probability>(scenarios: readonly T[]): T[] {
  return [...scenarios].sort((a, b) => b.probability_24h - a.probability_24h
    || CATEGORY_STYLE[a.id].symbol.localeCompare(CATEGORY_STYLE[b.id].symbol));
}
export function topProbabilityIds(scenarios: readonly Probability[]): Set<PathCategory> {
  const ranked = rankProbabilities(scenarios), threshold = ranked[Math.min(2, ranked.length - 1)]?.probability_24h;
  return new Set(ranked.filter(s => s.probability_24h >= threshold).map(s => s.id));
}
export function probabilityStyle(id: PathCategory, probability: number, subdued = false) {
  const { color, symbol } = CATEGORY_STYLE[id];
  // Absolute 0..1 scale, never divided by the largest probability. Even zero
  // remains visible; top-three emphasis changes neither probability nor width.
  const width = (1 + Math.round(3 * probability)) as 1 | 2 | 3 | 4;
  const opacity = (0.65 + 0.35 * probability) * (subdued ? 0.7 : 1);
  const rgb = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));
  return { color, symbol, width, opacity, stroke: `rgba(${rgb.join(',')},${opacity})` };
}
export function formatProbability(probability: number): string {
  // The contract allows at most four decimals; display all meaningful precision.
  return `${Number((probability * 100).toFixed(8))}%`;
}
export function displayTime(value: string | number | null | undefined, zone = 'Asia/Shanghai'): string {
  if (value == null) return '未知';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
export function runtimeHeadline(runtime: RuntimeDisplay): string {
  if (runtime.paused) return '本地暂停标记生效';
  if (runtime.release_integrity === 'changed') return '固定发布版本已改变 · 业务入口将拒绝';
  if (runtime.release_integrity !== 'verified') return '运行状态待核验';
  if (runtime.latest_attempt?.status === 'failed') return '最近运行失败';
  if (runtime.latest_attempt?.status === 'late') return '最近预报发布迟到';
  if (runtime.publication_health?.status === 'stalled') return '更新停滞 · 最近时段缺少有效预报';
  if (runtime.inspection?.paused) return '巡检已暂停 · 当前运行待核验';
  if (runtime.inspection && runtime.inspection.freshness !== 'fresh') return '巡检信息陈旧或未知 · 当前运行待核验';
  if (runtime.inspection?.result === 'failed') return '巡检发现异常 · 查看运行详情';
  if (runtime.publication_health?.status === 'current' && runtime.inspection?.result === 'ok')
    return '最近时段产出正常 · 巡检已更新';
  return '当前运行待核验 · 官方启用状态请查看 Codex 任务';
}
