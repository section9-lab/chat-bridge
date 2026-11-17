# Agent 品牌图标

来源：[LobeHub Icons](https://lobehub.com/icons) / [lobe-icons](https://github.com/lobehub/lobe-icons)。

| Agent | 上游资源 |
| --- | --- |
| Codex | `codex-color.png` |
| Claude | `claude-color.png` |
| Pi | `src/Pi/components/Mono.tsx` 的 Pi Mono SVG 路径 |
| Hermes Agent | `nousresearch.png`（LobeHub 标注为 NousResearch / Hermes） |

Codex、Claude、Hermes 使用上游 `packages/static-png/light/` 与 `dark/` 的 PNG 原始资源，未修改图形或颜色。Codex、Claude 的两种主题资源相同。

Pi 使用 LobeHub 的 Pi Mono SVG 路径，按 24×24 viewBox 渲染为 640×640 PNG；浅色主题填充黑色，深色主题填充白色，未修改路径。`manifest.json` 记录每个文件的下载地址和 SHA-256。

应用随包加载图标，不依赖网络或 Agent 的安装状态。菜单栏图形为 18 pt；会话标题与设置列表保持比例并留出内边距，避免裁掉品牌图形。系统外观变化时切换对应资源。

上游 MIT 许可证全文见同目录 `LICENSE`，随资源一起打包。品牌名称与标识属于各自权利人。
