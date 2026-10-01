import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { preloadBundledFonts } from "./hooks/terminalOptions";

// ⚠️ 先等**全部内置字体**就绪再挂载 React。
//
// xterm 6.0 内部没有任何 document.fonts 相关逻辑（已核对 node_modules 产物），
// 即异步字体在首次测量之后才加载完成时，它**不会重新测量单元格宽度** ——
// 列宽按回退字体算、渲染用内置字体，结果是整体错位。启动时会自动恢复上次的
// 会话（可能立刻创建终端），所以这里必须等，不能只靠「用户点连接时早加载完了」。
//
// 覆盖两类：符号回退字体（JetBrains Mono Symbol）与可选主字体（Source Code Pro，
// 用户可能在设置里选中它；运行时切换字体同样受上面这条限制）。
//
// 字体随应用打包（本地资源，正常毫秒级完成）；函数内部带超时兜底，
// 即便字体损坏也不会卡住启动。
preloadBundledFonts().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
