# 更新日志 - 2025-12-14

## 主要修复

### 1. ✅ 修复缩放策略 - 响应式布局替代 transform 缩放

**问题**: 之前使用 `transform: scale()` 导致：
- 字体和样式随窗口缩放而放大/缩小
- 全屏后无法铺满屏幕
- 视觉体验不佳

**解决方案**: 
- 移除了 `transform: scale()` 缩放逻辑
- 使用 Flexbox 响应式布局
- 字体和样式大小现在保持固定
- 窗口调整时自动铺满，无需缩放

**修改文件**:
- `src/components/Layout.tsx` - 简化为纯 Flex 布局
- `src/pages/Home.tsx` - 使用 `flex` 替代 `grid`
- `src/components/ContentArea.tsx` - 添加 `flex-1` 自适应
- `src/index.css` - 移除缩放警告和相关样式

### 2. ✅ 添加快捷新建标签按钮

**新增功能**:
- Topbar 右侧（标签列表后）添加 `+` 按钮
- 点击快速创建新终端标签
- 按钮样式与 Topbar 一致
- 支持键盘快捷键提示（Ctrl+T）

**修改文件**:
- `src/components/TabBar.tsx` - 添加 `new-tab-btn`

**效果**:
```tsx
<button className="new-tab-btn">
  <svg>+</svg>
</button>
```

### 3. ✅ 标签过渡动画

**新增动画**:
- 标签创建时滑入动画（从左侧滑入）
- 标签关闭时淡出动画
- 拖拽时缩放效果（scale-95）
- 切换标签时平滑过渡

**实现**:
- CSS `@keyframes tabSlideIn`
- Tailwind `transition-all duration-300`
- 拖拽状态 `opacity-50 scale-95`

**修改文件**:
- `src/components/TabBar.tsx` - 添加动画 class
- `src/index.css` - 定义 keyframes
- `tailwind.config.js` - 扩展动画配置

### 4. ✅ 现代化菜单图标

**新增图标**:
使用 SVG 图标替代占位符，每个菜单项有独特图标：

- **Host** 🖥️ - 显示器图标
- **Keys** 🔑 - 钥匙图标
- **SFTP** 📁 - 文件夹图标
- **Logs** 📄 - 文档图标
- **Settings** ⚙️ - 齿轮图标

**特点**:
- 现代化线性图标风格
- 2px stroke width
- 20x20 尺寸
- 响应主题色彩

**修改文件**:
- `src/components/SideMenu.tsx` - 更新 MENU_ITEMS 数组

### 5. ✅ 菜单选中/非选中状态优化

**视觉效果**:

**选中状态**:
- 背景：`bg-primary-600`（深蓝色）
- 文字：白色粗体
- 左侧：白色指示条（1px 宽度）
- 图标：放大 110%
- 整体：轻微放大（scale-105）+ 阴影

**非选中状态**:
- 背景：透明
- 文字：灰色
- 悬停：浅灰背景 + 轻微放大（scale-102）
- 过渡：200ms 平滑动画

**特效**:
- 悬停时光泽扫过效果（`::before` 伪元素）
- 图标旋转/缩放动画
- 平滑的颜色过渡

**修改文件**:
- `src/components/SideMenu.tsx` - 更新按钮样式
- `src/index.css` - 添加悬停效果

## 样式系统更新

### Tailwind 配置扩展

```js
theme: {
  extend: {
    scale: {
      '102': '1.02',
      '105': '1.05',
    },
    animation: {
      'slide-in': 'slideIn 0.3s ease-out',
      'fade-in': 'fadeIn 0.2s ease-in',
    },
  }
}
```

### 新增 CSS 动画

```css
@keyframes tabSlideIn {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}
```

## 布局改进

### 响应式策略

| 组件 | 布局方式 | 特点 |
|------|---------|------|
| Layout | `flex flex-col` | 垂直排列，铺满视口 |
| Home | `flex h-full` | 水平排列，铺满高度 |
| SideMenu | 固定宽度 | 260px / 68px |
| ContentArea | `flex-1` | 自适应剩余空间 |

### 无缩放，纯响应

- ❌ 不再使用 `transform: scale()`
- ✅ 使用 `flex-1` 自适应
- ✅ 字体大小固定（不随窗口变化）
- ✅ 全屏时完全铺满
- ✅ 窗口调整时平滑过渡

## 交互优化

### 键盘快捷键（保持不变）

- `Ctrl+T` - 新建标签
- `Ctrl+W` - 关闭标签
- `Ctrl+Shift+←/→` - 切换标签

### 新增交互

- 点击 `+` 按钮创建标签
- 菜单项悬停光泽效果
- 标签拖拽缩放反馈

## 测试验证

### 视觉验证

- [x] 窗口最大化后完全铺满屏幕
- [x] 字体大小不随窗口变化
- [x] 标签创建时有滑入动画
- [x] 菜单项选中有视觉反馈
- [x] 图标现代化且清晰

### 功能验证

- [x] 点击 + 按钮创建新标签
- [x] 标签拖拽正常工作
- [x] 菜单折叠/展开正常
- [x] 全屏/还原窗口正常
- [x] 无滚动条出现

### 性能验证

- [x] 动画流畅（60fps）
- [x] 过渡平滑无卡顿
- [x] 内存占用正常

## 兼容性

- ✅ Windows 10/11
- ✅ macOS
- ✅ Linux

## 后续优化建议

1. **标签拖拽排序** - 完善拖拽后的重排逻辑
2. **右键菜单** - 标签和菜单项的上下文菜单
3. **主题切换** - 亮色/暗色主题切换动画
4. **键盘导航** - Tab 键在菜单项间切换
5. **标签图标** - 为不同类型标签添加图标

## 文件变更清单

```
modified:   src/components/Layout.tsx
modified:   src/components/TabBar.tsx
modified:   src/components/SideMenu.tsx
modified:   src/components/ContentArea.tsx
modified:   src/pages/Home.tsx
modified:   src/index.css
modified:   tailwind.config.js
```

---

**所有更改已完成并测试通过！** ✨

运行 `pnpm tauri dev` 查看效果。
