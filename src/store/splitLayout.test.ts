import { describe, it, expect } from 'vitest';
import {
  leaf,
  leafCount,
  collectPaneIds,
  insertLeaf,
  removeLeaf,
  updateRatio,
  layoutFromIds,
  MAX_SPLIT_PANES,
} from './splitLayout';

describe('splitLayout', () => {
  it('leaf 与 leafCount', () => {
    const l = leaf('p1');
    expect(leafCount(l)).toBe(1);
    expect(collectPaneIds(l)).toEqual(['p1']);
  });

  it('insertLeaf 四个方向构造 row/col 并保持顺序', () => {
    const base = leaf('A');
    const right = insertLeaf(base, 'right', 'B');
    expect(right.kind).toBe('row');
    expect(collectPaneIds(right)).toEqual(['A', 'B']);

    const left = insertLeaf(base, 'left', 'B');
    expect(left.kind).toBe('row');
    expect(collectPaneIds(left)).toEqual(['B', 'A']);

    const down = insertLeaf(base, 'down', 'B');
    expect(down.kind).toBe('col');
    expect(collectPaneIds(down)).toEqual(['A', 'B']);

    const up = insertLeaf(base, 'up', 'B');
    expect(up.kind).toBe('col');
    expect(collectPaneIds(up)).toEqual(['B', 'A']);
  });

  it('insertLeaf 组合成 2x2（4 个 pane）', () => {
    let l = leaf('A');
    l = insertLeaf(l, 'right', 'B'); // [A | B]
    l = insertLeaf(l, 'down', 'C'); // [[A|B] / C]
    l = insertLeaf(l, 'right', 'D'); // [[A|B] / [C|D]]
    expect(leafCount(l)).toBe(4);
    expect(leafCount(l)).toBeLessThanOrEqual(MAX_SPLIT_PANES);
    expect(collectPaneIds(l)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('removeLeaf 坍缩父节点并保留兄弟', () => {
    let l = leaf('A');
    l = insertLeaf(l, 'right', 'B'); // [A | B]
    const onlyA = removeLeaf(l, 'B');
    expect(onlyA).not.toBeNull();
    expect(leafCount(onlyA!)).toBe(1);
    expect(collectPaneIds(onlyA!)).toEqual(['A']);

    const empty = removeLeaf(onlyA!, 'A');
    expect(empty).toBeNull();
  });

  it('removeLeaf 未找到时返回原引用', () => {
    const l = insertLeaf(leaf('A'), 'right', 'B');
    const result = removeLeaf(l, 'X');
    expect(result).toBe(l);
  });

  it('updateRatio 命中节点并夹取范围', () => {
    const l = insertLeaf(leaf('A'), 'right', 'B');
    expect(l.kind).toBe('row');
    if (l.kind === 'leaf') throw new Error('unreachable');
    const updated = updateRatio(l, l.id, 0.95);
    expect(updated).not.toBe(l);
    if (updated.kind === 'leaf') throw new Error('unreachable');
    expect(updated.ratio).toBe(0.9); // 被夹取到 MAX_RATIO

    const unchanged = updateRatio(l, 'nope', 0.5);
    expect(unchanged).toBe(l);
  });

  it('layoutFromIds 构造从左到右布局', () => {
    const l = layoutFromIds(['A', 'B', 'C']);
    expect(leafCount(l)).toBe(3);
    expect(collectPaneIds(l)).toEqual(['A', 'B', 'C']);
  });
});
