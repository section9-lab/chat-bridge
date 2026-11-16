export const commandGuide = `Chat Bridge 使用说明 · 命令指南
直接发消息就会继续当前任务；不需要记命令。

任务
任务 / 进度 / 在做什么 — 查看任务和当前状态
新任务 — 下一条消息开始新任务
新任务：写封请假邮件 — 直接开始新任务
继续登录 bug / 回到写请假邮件 — 切换到对应任务
回复任务列表里的 1、2 等编号 — 切换任务
停一下 / 取消 / 别做了 — 停止当前任务
同意 / 拒绝 — 处理待审批操作

目标
换成 Claude / 用 Pi — 修改下一条新任务的 Agent
换个项目 — 查看并选择项目
看看会话 — 查看并选择已有会话

高级命令（可选）
/status — 当前目标、可用状态与任务
/agent — 查看 Agent 列表
/mode — 查看当前模式
/project 或 /projects — 查看项目
/sessions — 当前项目的会话
/sessions all — 当前 Agent 的全部会话
/more — 查看列表下一页
/agent codex — 切换到 Codex
/agent claude — 切换到 Claude Code
/agent pi — 切换到 Pi
/agent hermes — 切换到 Hermes Agent
/project none — 切换到无项目
/new — 下一条消息新建会话
/tasks — 查看任务列表

任务与审批编号
/stop J… — 停止正在执行的任务
/continue J… — 继续等待中的未发送任务
/cancel J… — 取消未发送任务
/approve A… — 单次允许
/deny A… — 拒绝

随时发送 /help 重看指南。用 // 开头可发送以 / 开头的普通内容。
手机端仅接收文字，桌面支持 @ 附件。Agent 登录后自动检测；微信需先扫码绑定。`;

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
    new: [0, 0], tasks: [0, 0], status: [0, 0], stop: [0, 1], approve: [1, 1],
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
