// ⚠️ 当前**未被任何钩子调用**（保留作参考）。
//
// 2026-10-06 用 `lint-staged --debug` 定位到：lint-staged 收尾时会 `git add` 它从
// **整份工作区 diff**（不只它检查的暂存文件）里挑出的文件，于是
//   ① 试图 add 被 .gitignore 覆盖的 docs/*.md（`.gitignore` 有 docs 规则，而 docs/
//      下文件是「已跟踪但被 ignore 覆盖」的历史状态）→ git 报
//      "The following paths are ignored by one of your .gitignore files: docs"
//      → Failed to stage changes from tasks! → 只要工作区有 docs 改动，提交必失败；
//   ② 会把无关的未暂存文件一并暂存（实测踩过，memory 有记录）。
// 与是否加 --fix / core.autocrlf 无关 —— 之前把这个报错误判成 --fix 引起，实测不加 --fix 照样失败。
//
// 现由 .husky/pre-commit 直接对暂存范围内的 ts/tsx 跑 eslint（效果等价、不碰暂存区）。
// 若要用回 lint-staged：先处理 .gitignore 的 docs 规则与 .gitattributes 行尾策略，再用 --debug 验证。
export default {
  '*.{ts,tsx}': 'eslint',
};
