# Chat Bridge 品牌资源

最终方向：雾蓝底、黑色双眼角色、圆润的顶部凸起、桥拱底部与小对话尾巴。应用图标有轻微立体感，菜单栏采用经过小尺寸调整的单色模板。

- `chat-bridge-app-icon.png`：应用图标母版，1254 × 1254，透明外边距。
- `chat-bridge-logo.png`：透明背景角色，用于独立展示。
- `../../../apps/macos/Resources/AppIcon.icns`：16–1024 px 的 macOS 图标，由母版导出。
- 菜单栏图形定义在 `apps/macos/Sources/ChatBridge/MenuBar.swift`，用原生路径绘制，22 × 18 pt，眼睛镂空，深浅色由系统处理。

视觉参考来自用户提供的 [Katya N. 图标作品](https://x.com/ktnr23/status/2097253869117984931)。参考角色轮廓、鲜明底色和轻微立体质感，没有直接复制其中的图标。README 结构参考本机的 [vibe-hud](https://github.com/section9-lab/vibe-hud)：居中图标、产品一句话、演示、使用场景、开始使用、更多资料。

图像使用 Codex 内置图像生成工具完成；没有使用 CLI 或需要用户配置 API Key 的流程。生成后用 `sips` 和 `iconutil` 导出平台尺寸，不依赖工作区外的文件。

在仓库根目录执行：

```sh
bash scripts/build-icon.sh
```

## 最终应用图标提示词

输入为用户参考图和前期原创桥拱角色草图。结果以仓库内母版为准，重新生成可能产生变化。

> Create the FINAL original Chat Bridge macOS app icon. Reference 1 is a screenshot of a designer's icon collection: use ONLY its design language of memorable simple black mascot, bright colored squircle tile, softly inflated material, expressive white eyes. Ignore ALL browser UI/text. Reference 2 is our current original Chat Bridge bridge-arch creature: evolve its recognizability and preserve the curved bridge opening at the bottom and its small integrated speech tail. Design one character with a compact chubby charcoal-black pebble body, two very short softly rounded asymmetric upward tufts at the top corners, two LARGE warm white oval eyes with a slight inquisitive inward tilt, no pupils, no mouth, no arms, no separate legs. The bridge arch underneath should feel natural as the body silhouette, not a cut-off circle. Avoid looking like a cat: no animal ears or whiskers, think curious AI message courier. A smooth cornflower blue tile (#87AEF5 at top transitioning very gently to #6694EA at bottom), subtle raised soft vinyl mascot and a restrained soft bottom shadow, no heavy gloss or reflections. Sophisticated, lovable, calm. The app icon is a macOS rounded square with continuous corners, nearly fills a square canvas with 7% transparent margin; center mascot filling 72% tile width. Straight-on, perfect front elevation. ONLY ONE icon, no text, no wordmark, no board, no extra objects, transparent outside tile. Crisp eye boundaries and silhouette, clean alpha, clean edges, maximum clarity at 32px. Do not copy an exact mascot in reference 1; keep our distinctive bridge-arch base and chat-tail identity.

## 透明 Logo 提示词

输入为最终 `chat-bridge-app-icon.png`。

> Produce the matching transparent LOGO SYMBOL master from this finalized Chat Bridge app icon. Preserve this exact character silhouette, its two softly rounded top tufts, two gently tilted large oval eyes, lower bridge arch, and tiny lower-right speech tail. Remove the entire blue tile, background, ALL shadows, texture and 3D shading. The character must be one perfectly flat solid charcoal-black #17191C shape, the two eyes solid warm white #FFFDF8. Transparent outside the character, including the bridge arch cutout. Sharp clean vector-like outline, exactly one centered symbol on a square transparent canvas with generous 12% margin. No text, no additional objects, no redesign of the character. This is the flat brand companion to the app icon.
