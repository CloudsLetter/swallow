/**
 * SFTP 双栏行式文件列表：列模板常量。
 *
 * 双栏共用同一套「CSS grid 轨道」列定义（不用 shadcn Table：其外层 overflow-x-auto +
 * 全 nowrap 单元格在窄栏下必然横向溢出）。轨道总宽恒等于容器 → 永不横向溢出，
 * 纵向滚动由 shadcn ScrollArea 接管。
 *
 * 响应式收缩策略（容器查询，按列逐级塌缩，文件名最后才省略）：
 * - 列表容器挂 `@container`，轨道模板用 `@max-[…]` 断点逐级把次要列压到 0px——
 *   **塌缩顺序：权限 → 修改时间 → 大小**，名称列 `minmax(5.5rem,1fr)` 始终保留；
 *   （CSS grid 的自由空间按比例分摊，单纯 minmax 做不到「先压谁后压谁」的严格次序）
 * - 塌缩到 0px 的列，单元格内容因 min-w-0 + truncate 自然不可见；
 * - 操作列已整体移除：行内操作全部走右键 contextmenu。
 */

/** 本机（左栏）：勾选 | 名称 | 大小 | 修改时间（窄屏先收时间、再收大小） */
export const LIST_COLS = [
  'grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,5.5rem)_minmax(0,9.5rem)]',
  '@max-[520px]:grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,5.5rem)_minmax(0,0px)]',
  '@max-[420px]:grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,0px)_minmax(0,0px)]',
].join(' ');

/** 远端（右栏/左栏远端源）：勾选 | 名称 | 大小 | 修改时间 | 权限（窄屏依次收：权限 → 时间 → 大小） */
export const LIST_COLS_PERM = [
  'grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,5.5rem)_minmax(0,9.5rem)_minmax(0,4.75rem)]',
  '@max-[600px]:grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,5.5rem)_minmax(0,9.5rem)_minmax(0,0px)]',
  '@max-[520px]:grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,5.5rem)_minmax(0,0px)_minmax(0,0px)]',
  '@max-[420px]:grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,0px)_minmax(0,0px)_minmax(0,0px)]',
].join(' ');

/** FTP：无权限/修改时间概念 → 勾选 | 名称 | 大小 */
export const LIST_COLS_FTP = [
  'grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,5.5rem)]',
  '@max-[420px]:grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,0px)]',
].join(' ');
