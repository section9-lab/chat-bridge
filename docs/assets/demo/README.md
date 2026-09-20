# 设备场景演示

使用内置 `image_gen` 工具生成两张摄影风格素材，未使用 CLI 或外部图片 API。两张母版均为 1536 × 1024 PNG：

- [MacBook 场景](macbook-scene.png)
- [手持 iPhone 场景](phone-scene.png)

这些是合成场景，并非用户设备或真人操作的实拍。屏幕中的 Mac 界面由当前应用的 SwiftUI 视图副本渲染，并为这段演示替换英文文案；微信与 iMessage 的界面、任务执行和回执为离线演示。账号使用保留的示例邮箱及虚构号码。

默认语言为英文，覆盖界面、字幕、消息、目标回执、文本选项和键盘。英文词表仅应用于临时的演示视图副本，不修改产品源码或用户的语言设置。README 同样默认英文，另保留中文、日文、韩文、法文和西班牙文。

## 分镜

| 时间 | 操作与展示 |
| --- | --- |
| 00–05 秒 | 在 MacBook Dock 打开 Chat Bridge，展示六个 Agent 与已有对话。 |
| 05–16 秒 | 依次查看 Agent、消息通道、智能路由、通用设置；滚动展示更多设置。 |
| 16–24 秒 | 浏览项目与会话、按项目筛选、切换 Claude 新建无项目会话、恢复 Codex 会话。 |
| 24–34 秒 | 关闭主窗口，点击单个菜单栏 Logo；输入任务、发送、查看执行状态与返回结果。 |
| 34–47 秒 | 手持 iPhone，通过微信继续 Codex 官网项目；Mac 接收并执行，结果回到微信。 |
| 47–60 秒 | 通过 iMessage 创建 Claude 无项目会话；Mac 执行文案任务，结果回到 iMessage。 |
| 60–75 秒 | 模糊意图触发文本选项，回复 1 后执行原任务，并收到变更说明文件。 |

## 场景生成提示词

第一张，新生成：

> Use case: product-mockup. Asset type: photorealistic background plate for a Chat Bridge product demonstration animation, landscape 3:2. A real open space-gray 16-inch MacBook Pro on a light warm oak desk in a quiet home workspace, seen almost straight-on at screen height with a slight view down to the keyboard. The unobstructed display fills most of the composition and is plain dark charcoal (#101214), with no interface, text, cursor or obstructing reflections. Accurate thin black bezel, central camera, rounded display corners, aluminum chassis, keyboard and trackpad. Full laptop visible. Soft daylight from the left, warm wood texture, pale plaster wall, natural grounding shadows, realistic aluminum highlights. Premium lifestyle product photography, 50mm lens, screen and keyboard sharp. No people, hands or phone in this shot; no overlays, illustration or toy-like CGI. The same desk and laptop will be used in a second shot with a handheld iPhone.

第二张，以第一张为场景连续性参考：

> Use case: product-mockup / photorealistic-natural. Create the second shot of the same Chat Bridge demonstration, landscape 3:2, 1536 × 1024. Preserve the same MacBook Pro, warm oak desk, window daylight, plants, photographic realism and color. Reframe the laptop to the left, leaving its display visible in the left 65% of the image. In the right foreground, a real adult hand holds a modern black titanium iPhone vertically in front of the MacBook. Show the entire phone outline, almost front-on with a tiny natural tilt, large enough to read. The hand enters from the bottom right and supports the phone behind and at the lower edges; the thumb stays on the right bezel without covering the display. Both displays are completely blank dark charcoal #101214. Accurate thin bezel, camera island and glass. Keep both screens crisp; natural skin texture and soft shadows. The phone overlaps only the far right of the laptop. No interface, overlays, diagram lines, text, watermark or extra fingers. The screens will receive separately animated application content.

## 重建

从仓库根目录运行 `bash scripts/build-demo.sh`。脚本完成原生视图渲染、屏幕透视合成、MP4 编码、GIF 调色板导出和静态预览生成。GIF 适合 README 自动播放，MP4 保留更好的摄影色彩并支持暂停，静态预览用于不希望播放动画的场景。

渲染入口为 `scripts/render-native-demo.swift` 和 `scripts/render-product-demo.swift`。准备原生视图副本的脚本会核对替换位置；若应用视图结构变化，会停止而不是默默渲染过时界面。
