import { describe, it, expect } from 'vitest';
import { gridPosition, generationExplanation } from '../src/demo-explanation';
import type { Forecast } from '../src/contracts';

describe('锚点价格线与完整区间分别计数', () => {
  it.each([
    [100, 1, 1, 1, 1, 1, 0],
    [95, 1, 0, 2, 0, 1, 1],
    [80, 0, 0, 3, 0, 2, 0],
    [120, 3, 0, 0, 2, 0, 0],
    [90, 0, 1, 2, 0, 2, 0],
    [110, 2, 1, 0, 2, 0, 0],
    [100 + 1e-9, 2, 0, 1, 1, 0, 1],
  ])('anchor=%s', (anchor, below, equal, above, intervalsBelow, intervalsAbove, intervalsCrossing) => {
    expect(gridPosition(anchor, [90, 100, 110])).toMatchObject({below,equal,above,intervalsBelow,intervalsAbove,intervalsCrossing});
  });
  it('相对上下界使用锚点为分母',()=>{
    const s=gridPosition(100,[90,100,110])!;
    expect(s.lowerPercent).toBeCloseTo(-10);expect(s.upperPercent).toBeCloseTo(10);
  });
  it.each([[0,[90,100]], [NaN,[90,100]], [100,[]], [100,[90,90]], [100,[100,90]], [100,[90,Infinity]], [Number.MIN_VALUE,[1,2]]] as [number,number[]][])('无效值不伪装成零统计 %s',(anchor,levels)=>expect(gridPosition(anchor,levels)).toBeUndefined());
  it('未知生成器不继承已知算法说明',()=>{
    expect(generationExplanation({generator_version:'future-v2'} as Forecast)).toContain('算法尚未核实');
    expect(generationExplanation({generator_version:'fixture-v1-xorshift32-linear-8dp'} as Forecast)).toContain('固定模板分段线性插值');
  });
});
