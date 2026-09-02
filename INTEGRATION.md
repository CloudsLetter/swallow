# Swallow 集成说明

## 快速开始

### 1. 安装依赖

项目依赖已在 `package.json` 中配置好，运行：

\`\`\`bash
pnpm install
\`\`\`

### 2. 启动开发环境

\`\`\`bash
pnpm tauri dev
\`\`\`

首次启动时，Tauri 会自动下载并编译 Rust 依赖，这可能需要几分钟。

### 3. 测试功能

启动后，你应该看到：

1. **无边框窗口**：窗口没有系统标题栏
2. **自定义 Topbar**：顶部有一个 44px 高的自定义标题栏
3. **Home 标签**：默认显示 Home 页面
4. **两栏布局**：左侧菜单 + 右侧内容区

#### 测试清单

- [ ] 拖拽 Topbar 移动窗口
- [ ] 双击 Topbar 最大化/还原窗口
- [ ] 点击右上角窗口控制按钮
- [ ] 按 `Ctrl+T` 创建新终端标签
- [ ] 按 `Ctrl+W` 关闭标签
- [ ] 按 `Ctrl+Shift+←/→` 切换标签
- [ ] 调整窗口大小，观察内容等比缩放
- [ ] 将窗口缩小至触发缩放警告（< 0.6）

## 文件结构

\`\`\`
src/
├── components/           # 所有 UI 组件
│   ├── Layout.tsx       # 根布局组件，处理缩放和快捷键
│   ├── Topbar.tsx       # 自定义标题栏
│   ├── TabBar.tsx       # 标签栏（支持拖拽）
│   ├── WindowControls.tsx  # 窗口控制按钮
│   ├── SideMenu.tsx     # 侧边菜单（可折叠）
│   ├── ContentArea.tsx  # 内容区域容器
│   └── TerminalView.tsx # xterm.js 终端视图
├── hooks/
│   └── useScale.ts      # 缩放计算 Hook
├── pages/
│   └── Home.tsx         # Home 页面（两栏布局）
├── store/
│   └── tabStore.ts      # Zustand 状态管理
├── App.tsx              # 应用入口
├── main.tsx             # React 挂载
├── index.css            # 全局样式 + Tailwind
└── vite-env.d.ts        # TypeScript 类型声明
\`\`\`

## 关键配置

### Tauri 配置 (src-tauri/tauri.conf.json)

\`\`\`json
{
  "app": {
    "windows": [{
      "decorations": false,  // 关键：启用无边框
      "width": 1366,
      "height": 768
    }]
  }
}
\`\`\`

### Tailwind 配置 (tailwind.config.js)

已配置 JIT 模式和内容扫描路径。

### PostCSS 配置 (postcss.config.js)

集成了 Tailwind 和 Autoprefixer。

## 样式规范

### 重要约束

1. **SideMenu 和 ContentArea 必须无间隔、无圆角、无阴影**
   - 已在 `index.css` 中强制设置
   - 使用 `!important` 覆盖

2. **缩放策略**
   - 基准画布：1366×768
   - 使用 `transform: scale()` 而非 `zoom`
   - 缩放比例 = `min(windowWidth / 1366, windowHeight / 768)`

3. **无滚动条**
   - 主容器 `overflow: hidden`
   - 局部需要滚动的区域单独设置

## 状态管理 (Zustand)

\`\`\`typescript
// 获取 store
const { tabs, activeTabId, createTab, closeTab, focusTab } = useTabStore();

// 创建新标签
const newTabId = createTab({ 
  name: 'My Terminal', 
  type: 'terminal' 
});

// 关闭标签
closeTab(tabId);

// 切换标签
focusTab(tabId);
\`\`\`

## 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+T` | 新建标签 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+Shift+←` | 切换到上一个标签 |
| `Ctrl+Shift+→` | 切换到下一个标签 |

快捷键在 `Layout.tsx` 中通过 `useEffect` 监听实现。

## xterm.js 集成

终端视图已集成 xterm.js 和 FitAddon：

\`\`\`typescript
// 在 TerminalView.tsx 中
const terminal = new Terminal({ /* ... */ });
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(containerElement);
fitAddon.fit();  // 自适应容器大小
\`\`\`

## 扩展 API（预留）

虽然当前为占位实现，但已预留以下接口：

\`\`\`typescript
// 未来可实现的功能
interface SessionConfig {
  host: string;
  port: number;
  username: string;
  // ...
}

async function openSession(config: SessionConfig): Promise<string> {
  // 调用 Tauri 后端 SSH 连接
}

function sendToTerminal(tabId: string, data: string): void {
  // 发送数据到对应终端
}
\`\`\`

## 常见问题

### Q: 窗口无法拖拽？

A: 确保 Topbar 有 `WebkitAppRegion: 'drag'` 样式，且交互元素（按钮、标签）设置了 `WebkitAppRegion: 'no-drag'`。

### Q: 缩放后内容模糊？

A: 正常现象，使用 `transform: scale()` 会产生轻微模糊。可通过以下方式优化：
- 增加 `will-change: transform`
- 调整 `image-rendering` 属性

### Q: 标签拖拽不工作？

A: 确保 react-dnd 和 react-dnd-html5-backend 已正确安装，并在 App.tsx 中包裹了 `<DndProvider>`。

### Q: 终端无法输入？

A: 当前为占位实现，未连接真实终端。需集成 Tauri 后端 SSH 功能。

### Q: 如何添加新菜单项？

编辑 `src/components/SideMenu.tsx` 中的 `MENU_ITEMS` 数组：

\`\`\`typescript
const MENU_ITEMS = [
  { id: 'hosts', label: 'Host' },
  { id: 'my-item', label: 'My Item' },  // 新增
  // ...
];
\`\`\`

## 后续开发建议

1. **实现真实 SSH 连接**
   - 在 Tauri 后端（Rust）实现 SSH 客户端
   - 通过 Tauri Command 与前端通信
   - 将数据流绑定到 xterm.js

2. **会话持久化**
   - 使用 Tauri 的存储 API 保存标签状态
   - 窗口关闭时保存，启动时恢复

3. **SFTP 文件浏览器**
   - 新增 `type: 'sftp'` 标签类型
   - 实现文件树组件
   - 支持上传/下载

4. **主题系统**
   - 扩展 Tailwind 配置支持多主题
   - 使用 CSS 变量动态切换
   - 保存用户偏好设置

5. **分屏功能**
   - 扩展 ContentArea 支持分屏布局
   - 使用 react-split-pane 或自定义实现
   - 每个分屏绑定独立的标签/会话

## 构建生产版本

\`\`\`bash
pnpm tauri build
\`\`\`

构建产物位于 `src-tauri/target/release/bundle/`。

---

**祝开发顺利！** 🎉
