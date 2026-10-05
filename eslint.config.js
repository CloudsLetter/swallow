import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// 只查 bug，不管风格：本仓库没有 Prettier / rustfmt，代码风格手工维护，
// 任何 stylistic 规则都会产生海量纯重排 diff（.deepsource.toml 里也是同样理由关掉了 formatter）。
//
// ⚠️ react-hooks v7 的 `recommended` 已经不是「rules-of-hooks + exhaustive-deps」两条，
// 而是 17 条 React Compiler 规则集。2026-10-02 在 153 个源文件上实测的命中：
//   set-state-in-effect 24 / refs 17 / immutability 9 / purity 4 / static-components 1 / globals 1
// 其中相当一部分是误报，实证两例：
//   - PageHeader：props 对象里含一个 ref，导致连 `search.value` 这样的普通读取都被判为
//     「render 中访问 ref」（4 条全在该文件）；
//   - TabBar：`tabIcon(type)` 只是从协议注册表里取既有组件，被判为「render 中创建组件」。
// 其余是「为启用 React Compiler 而改造」的范式要求（如 effect 内 setState），不是缺陷。
// 因此这里只保留能指出真实缺陷的两条。将来若真要上 React Compiler，
// 再整体开启这组规则并做一次专项迁移，而不是现在混在 bug 规则里当噪声。
const REACT_COMPILER_RULES = [
  "static-components",
  "use-memo",
  "void-use-memo",
  "preserve-manual-memoization",
  "immutability",
  "globals",
  "refs",
  "set-state-in-effect",
  "set-state-in-render",
  "error-boundaries",
  "purity",
  "config",
  "gating",
  "incompatible-library",
  "unsupported-syntax",
];

const reactHooksFlat = reactHooks.configs.flat["recommended-latest"];

export default [
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "src-tauri/**",
      "server/**",
      "public/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ...reactHooksFlat,
    files: ["**/*.{ts,tsx}"],
    rules: {
      ...reactHooksFlat.rules,
      // 这两条抓的是真实缺陷：hook 顺序错乱、effect 依赖漏写
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      ...Object.fromEntries(REACT_COMPILER_RULES.map((rule) => [`react-hooks/${rule}`, "off"])),
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // 以 _ 前缀声明「故意不用」，避免为了过 lint 而删掉语义
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
];
