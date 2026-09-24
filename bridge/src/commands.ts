export const commandGuide = `Chat Bridge 命令指南
直接说明意图，如“用 Claude 在商城项目新建会话分析支付”。
开启智能路由后自动判断；无法判断时保留原消息并显示选项，回复编号或选项文字即可。选错目标可发“选错了”，已发送的消息不会自动重发。关闭路由时，普通消息继续当前会话。

手动命令（每次单独发送一条）
/status — 当前目标、可用状态与需关注的任务
/agent — 自动检测并查看 Agent 列表
/mode — 查看当前模式
/project 或 /projects — 查看项目
/sessions — 当前项目的会话
/sessions all — 当前 Agent 的全部会话
/more — 查看列表下一页

切换与新建
/agent codex — 切换到 Codex
/agent claude — 切换到 Claude Code
/agent cursor — 切换到 Cursor
/agent grok — 切换到 Grok
/agent opencode — 切换到 OpenCode
/agent hermes — 切换到 Hermes Agent
/project none — 切换到无项目
/new — 下一条消息新建会话

在显示列表的通道回复 01、02 等编号选择，选中项目后列出会话。智能路由的选项也支持回复文字、“返回上一步”和“下一页”；不会把选项回复发给 Agent。

任务与审批
/stop J… — 停止正在执行的任务
/continue J… — 继续等待中的未发送任务
/cancel J… — 取消未发送任务
/approve A… — 单次允许
/deny A… — 拒绝

J…、A… 请替换为消息中的实际编号。任务操作和审批请在发起任务的通道进行。

随时发送 /help 或“菜单”重看指南。用 // 开头可发送以 / 开头的普通内容。
手机端仅接收文字，桌面支持 @ 附件。Agent 登录后自动检测；消息通道需先绑定。`;

export type ParsedInput =
  | { kind: "message"; text: string }
  | { kind: "command"; name: string; argument: string }
  | { kind: "invalid"; message: string };

export function parseInput(text: string): ParsedInput {
  if (text.startsWith("//")) return { kind: "message", text: text.slice(1) };
  const match = /^\/([a-z]+)(?:[ \t]+([^\r\n]*))?$/.exec(text.trim());
  if (!match) {
    if (/^\/(?:agent|mode|project|use|new|stop|approve|deny|retry|cancel|continue)\b/.test(text.trim())) {
      return { kind: "invalid", message: "指令格式不正确，请发送 /help 查看用法。" };
    }
    return { kind: "message", text };
  }
  const name = match[1]!;
  const argument = (match[2] ?? "").trim();
  const arity: Record<string, [number, number]> = {
    help: [0, 0], agent: [0, 1], mode: [0, 1], projects: [0, 0],
    project: [0, 1], sessions: [0, 1], use: [1, 1], more: [0, 1],
    new: [0, 0], status: [0, 0], stop: [0, 1], approve: [1, 1],
    deny: [1, 1], retry: [1, 1], cancel: [1, 1], continue: [1, 1],
  };
  const range = arity[name];
  if (!range) return { kind: "message", text };
  const count = argument ? argument.split(/\s+/).length : 0;
  if (count < range[0] || count > range[1]) {
    return { kind: "invalid", message: "指令格式不正确，请发送 /help 查看用法。" };
  }
  return { kind: "command", name, argument };
}
