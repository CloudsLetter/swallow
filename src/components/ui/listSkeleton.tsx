import type { ReactNode } from 'react';
import { Skeleton } from './skeleton';
import { Table, TableBody, TableCell, TableHeader, TableRow } from './table';

/**
 * 与真实卡片列表同构的网格骨架：图标块 + 标题/副信息条 + 右侧操作钮。
 * 调用方页面在加载态用它顶替真实卡片容器。
 */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5 rounded-lg border border-border bg-card p-3">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <div className="flex shrink-0 gap-1">
            <Skeleton className="size-8 rounded-lg" />
            <Skeleton className="size-8 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 与真实表格同构的列表骨架：表头由调用方传入真实文本（避免加载完成后表头跳动），
 * 数据行骨架 = 首列(图标+两行) + 中间列短条 + 末列操作钮。
 * colCount = 表头总列数。
 */
export function ListTableSkeleton({
  head,
  colCount,
  rows = 6,
}: {
  head: ReactNode;
  colCount: number;
  rows?: number;
}) {
  const midCols = Math.max(colCount - 2, 0);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table>
        <TableHeader className="[&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
          {head}
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, r) => (
            <TableRow key={r}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <Skeleton className="size-8 shrink-0 rounded-lg" />
                  <div className="min-w-0 space-y-1.5">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-40" />
                  </div>
                </div>
              </TableCell>
              {Array.from({ length: midCols }).map((_, c) => (
                <TableCell key={c}>
                  <Skeleton className="h-3.5 w-16 max-w-full" />
                </TableCell>
              ))}
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <Skeleton className="size-7 rounded-md" />
                  <Skeleton className="size-7 rounded-md" />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
