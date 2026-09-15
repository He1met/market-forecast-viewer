import type { Forecast } from './contracts';

// Compare the stored numeric levels exactly; contract validation tolerances are
// for validating the level formula, not for moving a line onto the anchor.
export function gridPosition(anchor: number, levels: readonly number[]) {
  if (!Number.isFinite(anchor) || anchor <= 0 || levels.length < 2 ||
      levels.some((p, i) => !Number.isFinite(p) || p <= 0 || (i > 0 && p <= levels[i - 1]))) return undefined;
  const lowerPercent = (levels[0] / anchor - 1) * 100;
  const upperPercent = (levels[levels.length - 1] / anchor - 1) * 100;
  if (!Number.isFinite(lowerPercent) || !Number.isFinite(upperPercent)) return undefined;
  return {
    lowerPercent, upperPercent,
    below: levels.filter(p => p < anchor).length,
    equal: levels.filter(p => p === anchor).length,
    above: levels.filter(p => p > anchor).length,
    intervalsBelow: levels.slice(1).filter(p => p <= anchor).length,
    intervalsAbove: levels.slice(0, -1).filter(p => p >= anchor).length,
    intervalsCrossing: levels.slice(1).filter((p, i) => levels[i] < anchor && p > anchor).length,
  };
}

export function generationExplanation(f: Forecast) {
  return f.generator_version === 'fixture-v1-xorshift32-linear-8dp'
    ? '此版本使用固定模板分段线性插值与固定种子扰动，价格保留 8 位小数；用于验证路径与区间的显示，不衡量市场发生概率。'
    : '此生成器版本的算法尚未核实；仅展示文件元数据，不推断生成算法或市场概率。';
}
