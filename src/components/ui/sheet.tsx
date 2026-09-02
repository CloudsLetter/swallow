import * as React from "react"
import { useTranslation } from "react-i18next"
import { Dialog as SheetPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

/**
 * 抽屉（Sheet）。
 * 基于 Radix Dialog，统一三段式布局：
 *   SheetHeader（标题 + 关闭按钮，border-b）
 *   内容区（flex-1 独立滚动）
 *   SheetFooter（操作按钮，border-t 固定底部）
 * 背景使用 bg-popover/85 + backdrop-blur（弹层半透明磨砂，任何主题下内容清晰）；开合动画由 index.css 手写 [data-slot] 规则提供。
 */

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn("fixed inset-0 z-50 bg-black/40", className)}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
}) {
  const sideClass = {
    right: "inset-y-0 right-0 h-full w-full max-w-[340px] border-l",
    left: "inset-y-0 left-0 h-full w-full max-w-[340px] border-r",
    top: "inset-x-0 top-0 h-auto border-b",
    bottom: "inset-x-0 bottom-0 h-auto border-t",
  }[side]

  // 自动拆出 Header / Footer，其余内容放入独立滚动区
  const childrenArray = React.Children.toArray(children)
  const header = childrenArray.find(
    (child) => React.isValidElement(child) && (child.type as React.ElementType) === SheetHeader,
  )
  const footer = childrenArray.find(
    (child) => React.isValidElement(child) && (child.type as React.ElementType) === SheetFooter,
  )
  const body = childrenArray.filter(
    (child) =>
      !React.isValidElement(child) ||
      ((child.type as React.ElementType) !== SheetHeader &&
        (child.type as React.ElementType) !== SheetFooter),
  )

  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col border-border bg-popover/85 text-sm text-popover-foreground shadow-lg backdrop-blur-xl outline-none",
          sideClass,
          className,
        )}
        {...props}
      >
        {header}
        <div data-slot="sheet-body" className="overlay-scrollbar flex-1 px-5 py-4">
          {body}
        </div>
        {footer}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, children, ...props }: React.ComponentProps<"div">) {
  const { t } = useTranslation()
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        "flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">{children}</div>
      <SheetPrimitive.Close asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label={t("common.close")}
        >
          <XIcon size={16} />
          <span className="sr-only">{t("common.close")}</span>
        </Button>
      </SheetPrimitive.Close>
    </div>
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-4",
        className,
      )}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-sm font-semibold text-foreground", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
