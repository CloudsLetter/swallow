// 分屏布局树：纯函数模块（无 React/Zustand 依赖，便于单元测试）。
//
// 布局是一棵二叉树，叶子是单个 pane（会话），内部节点是「横向 row（左右）」
// 或「纵向 col（上下）」分割。VS Code 式编辑器组，最多 4 个 pane。

export type SplitDirection = 'left' | 'right' | 'up' | 'down';

export type SplitLayout =
  | { kind: 'leaf'; paneId: string }
  | { kind: 'row' | 'col'; id: string; ratio: number; a: SplitLayout; b: SplitLayout };

/** 单个分屏标签最多容纳的 pane 数（2x2 网格）。 */
export const MAX_SPLIT_PANES = 4;
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

let nodeSeq = 0;
function nextNodeId(): string {
  nodeSeq += 1;
  return `split-node-${nodeSeq}`;
}

export function leaf(paneId: string): SplitLayout {
  return { kind: 'leaf', paneId };
}

/** 布局中的叶子（pane）数量。 */
export function leafCount(layout: SplitLayout): number {
  if (layout.kind === 'leaf') return 1;
  return leafCount(layout.a) + leafCount(layout.b);
}

/** 按渲染顺序收集所有 paneId（左→右 / 上→下）。 */
export function collectPaneIds(layout: SplitLayout): string[] {
  if (layout.kind === 'leaf') return [layout.paneId];
  return [...collectPaneIds(layout.a), ...collectPaneIds(layout.b)];
}

function clampRatio(ratio: number): number {
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
}

/**
 * 把 newPaneId 作为新叶子插入到原布局的 direction 一侧：
 * - left/right → 横向分割（row）
 * - up/down   → 纵向分割（col）
 * 返回新的根节点（ratio 默认 0.5）。
 */
export function insertLeaf(layout: SplitLayout, direction: SplitDirection, newPaneId: string): SplitLayout {
  const node = leaf(newPaneId);
  switch (direction) {
    case 'left':
      return { kind: 'row', id: nextNodeId(), ratio: 0.5, a: node, b: layout };
    case 'right':
      return { kind: 'row', id: nextNodeId(), ratio: 0.5, a: layout, b: node };
    case 'up':
      return { kind: 'col', id: nextNodeId(), ratio: 0.5, a: node, b: layout };
    case 'down':
      return { kind: 'col', id: nextNodeId(), ratio: 0.5, a: layout, b: node };
  }
}

/**
 * 从布局中删除 paneId 对应的叶子，并把其父节点坍缩为兄弟节点。
 * - 删除后为空 → 返回 null
 * - 未找到 → 返回原布局（引用相等）
 */
export function removeLeaf(layout: SplitLayout, paneId: string): SplitLayout | null {
  if (layout.kind === 'leaf') {
    return layout.paneId === paneId ? null : layout;
  }
  const a = removeLeaf(layout.a, paneId);
  const b = removeLeaf(layout.b, paneId);
  if (a === null) return b; // 左子树被删空 → 提升右子树
  if (b === null) return a; // 右子树被删空 → 提升左子树
  if (a === layout.a && b === layout.b) return layout; // 未找到，引用不变
  return { ...layout, a, b };
}

/** 更新指定内部节点（按 id）的 ratio，返回新布局（未找到则返回原引用）。 */
export function updateRatio(layout: SplitLayout, nodeId: string, ratio: number): SplitLayout {
  if (layout.kind === 'leaf') return layout;
  if (layout.id === nodeId) {
    const next = clampRatio(ratio);
    if (next === layout.ratio) return layout;
    return { ...layout, ratio: next };
  }
  const a = updateRatio(layout.a, nodeId, ratio);
  const b = updateRatio(layout.b, nodeId, ratio);
  if (a === layout.a && b === layout.b) return layout;
  return { ...layout, a, b };
}

/** 由一组 paneId 构造「从左到右」的默认布局（兜底用）。 */
export function layoutFromIds(ids: string[]): SplitLayout {
  if (ids.length === 0) return leaf('');
  let layout: SplitLayout = leaf(ids[0]);
  for (let i = 1; i < ids.length; i++) {
    layout = insertLeaf(layout, 'right', ids[i]);
  }
  return layout;
}
