/**
 * SFTP 双栏行式文件列表：列模板常量。
 *
 * 双栏共用同一套「CSS grid 轨道」列定义（不用 shadcn Table：其外层 overflow-x-auto +
 * 全 nowrap 单元格在窄栏下必然横向溢出）。轨道总宽恒等于容器 → 永不横向溢出，
 * 纵向滚动由 shadcn ScrollArea 接管。
 *
 * 响应式收缩优先级（缩小窗口时谁先让步）：
 * - 名称列 minmax(5.5rem, 1fr)：底限 5.5rem（≈88px），富余宽度全归它 →
 *   窗口再窄也是「文件名/目录名最后才被省略」，与直觉一致；
 * - 元数据列（大小/修改时间/权限/操作）minmax(0, 上限)：只给「理想宽度」，
 *   空间不足时先于名称列收缩、内容用省略号截断 → 先牺牲次要信息；
 * - 名称列若连底限都保不住（极端窄），元数据列已先缩到 0，名称列仍保持 5.5rem。
 */
export const LIST_COLS = 'grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,5.5rem)_minmax(0,9.5rem)]';
/** 双远端/另一台主机场景：左侧也是远端文件时多一列「权限」 */
export const LIST_COLS_PERM = 'grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,5.5rem)_minmax(0,9.5rem)_minmax(0,4.75rem)]';
/** 右栏：权限 + 「操作」（hover 显现），操作列同样允许先收缩 */
export const LIST_COLS_ACTIONS =
  'grid-cols-[2.5rem_minmax(5.5rem,1fr)_minmax(0,5.5rem)_minmax(0,9.5rem)_minmax(0,4.75rem)_minmax(0,5.5rem)]';
