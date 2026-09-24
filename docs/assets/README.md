# 产品展示素材

- [品牌资源](brand/README.md)：应用图标、透明 Logo、来源与生成提示词。
- [首次启动引导 GIF](chat-bridge-intro.gif)：960 × 623、54 秒、10 fps、无限循环，用于各语言 README 首屏。
- [引导高清 MP4](chat-bridge-intro.mp4)：1512 × 982、54 秒、30 fps，可暂停和跳转。
- [引导静态预览](chat-bridge-intro-poster.png)：iMessage 把任务交给 Claude，结果同时出现在 Mac 和手机上。
- [旧版产品演示 GIF](chat-bridge-demo.gif)：1536 × 1024、75 秒、15 fps、无限循环；README 已改用引导动画，文件保留备用。
- [旧版高清 MP4](chat-bridge-demo.mp4)：1536 × 1024、75 秒、20 fps，可暂停和跳转。
- [旧版静态预览](chat-bridge-demo-poster.png)：手持 iPhone，通过微信接收 Codex 的任务结果。
- [场景素材、分镜与生成提示词](demo/README.md)。

## 首次启动引导动画

应用首次启动时播放的介绍，直接来自产品代码里的 SwiftUI 视图（`Onboarding/IntroView.swift` 与 `IntroDirector.swift` 的时间线），界面为中文。录制脚本在独立窗口里播放它，并只用 ScreenCaptureKit 录这个窗口：不录光标、其他应用和真实桌面，不启动本地服务，也不读取账号。录制版不显示“跳过介绍”按钮；成片从桌面变暗后开始，结尾淡出到黑色，GIF 首尾衔接。

在仓库根目录执行，需 macOS 15 或更新版本、Swift 和 FFmpeg，并为运行脚本的终端开启“屏幕录制”权限。录制期间屏幕会全屏播放约 1 分钟：

```sh
bash scripts/build-intro-demo.sh
```

## 旧版产品演示

演示默认使用英文，包括界面、字幕、项目名、消息、回执、选项和键盘文字。使用 AI 生成的 MacBook／手持 iPhone 场景，叠加当前应用原生 SwiftUI 视图的英文文案副本，以及按微信和 iMessage 布局制作的消息动画。所有联系人、项目、任务和回复均为演示数据。没有连接真实微信、iMessage 或 Agent，也没有记录、发送或发布用户的私人消息。它用于介绍产品，不作为端到端通道送达的验收证据。

动画从 MacBook 打开应用开始，展示 Agent 管理、消息通道、Jev 智能路由、通用设置、项目与会话选择、新建无项目会话、菜单栏直接发送消息；随后切到手持 iPhone，分别通过微信与 iMessage 将任务转给 Codex／Claude，并收取结果；最后展示文本选项兜底及成果文件返回。

在仓库根目录执行，需 macOS、Swift、Python 3、ripgrep 和 FFmpeg。首次构建会解析项目已有的 Swift 包依赖：

```sh
bash scripts/build-demo.sh
```

原生视图在临时源文件副本中注入内存演示数据；副本开放设置分类和会话列表的初始状态，移除渲染时的目录加载及钥匙串读取任务，再使用 `scripts/demo-ui.en.json` 翻译演示中出现的界面文案。产品代码和本机语言偏好不变，本地服务不会启动。随后将视图按屏幕透视投影到场景素材中，生成 MP4，再导出 GIF。所有中间文件在完成后清理，成功后才替换最终成片。

## 设备演示验证 · 2026-09-21

- 完整执行 `scripts/build-demo.sh` 成功，原生 SwiftUI 视图构建与离线渲染完成。
- FFprobe 核对 GIF 为 1536 × 1024、1125 帧、75 秒；MP4 为同分辨率、1500 帧、75 秒。GIF 无限循环元数据有效。
- GIF 约 12.6 MiB，MP4 约 3.0 MiB。MP4 支持暂停；静态预览单独提供。
- 检查全片分镜联系表，以及设置、浮窗、微信、iMessage、文本兜底的独立关键帧；再次从最终 GIF 解码手机场景，核对英文换行、气泡边缘和回执目标。
- 六种语言 README 的本地链接、GIF、MP4、静态预览引用有效；英文为默认 `README.md`，中文位于 `README.zh-CN.md`，旧的 `README.en.md` 保留跳转入口。Shell 语法及 `git diff --check` 通过。
- 本次只调整演示素材、生成脚本及 README，没有改动产品运行逻辑；未为素材修改重复运行服务测试。

## 应用与品牌更新验证 · 2026-09-21

- 先用 2 个新行为测试复现旧菜单栏的问题，再实现单 Logo；定向交互回归 9 项通过。
- 完整构建通过 370 项服务测试、45 项原生测试，随包 Node／SQLite 检查 8/8 通过，Apple Development 签名校验通过。
- 已重启更新后的应用，原会话和本地服务恢复。原生界面核对了 Agent 设置简化和透明会话浮窗；系统菜单栏按钮反复开关、保留目标与草稿由 NSStatusBarButton 集成测试覆盖。
- CUA 未能稳定读取 SystemUIServer，未宣称完成多屏或系统菜单栏物理鼠标点击验收。
- 六种语言 README 均为自包含版本，本地资源与语言切换链接存在。未恢复收尾期间被移除的历史设计／验证目录。
- 上一版 GIF 为 315 帧、21 秒、1200 × 780；本次按用户反馈替换为上述 75 秒设备场景演示。没有向真实微信或 iMessage 发送消息。
- 图标导出脚本统一使用最终母版，重新导出的 ICNS 与本次应用包中的 ICNS 的 SHA-256 一致。
