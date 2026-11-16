/** Deterministic natural-language intents for the phone channel. No model call. */
export type Intent =
  | { kind: "task-list" }
  | { kind: "new-task"; text?: string }
  | { kind: "switch-task"; query: string }
  | { kind: "stop" }
  | { kind: "cancel" }
  | { kind: "approval"; decision: "approve" | "deny" }
  | { kind: "target-agent"; agent: string }
  | { kind: "project-menu" }
  | { kind: "session-menu" };

const agentAliases: Record<string, string> = {
  codex: "codex",
  claude: "claude",
  "claude code": "claude",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  hermes: "hermes",
  "hermes agent": "hermes",
};

const clean = (value: string) => value.replace(/\s+/g, " ").trim().replace(/[。！!？?]+$/u, "").trim();
const prefix = (text: string, pattern: RegExp): string | undefined => {
  const match = pattern.exec(text);
  if (!match) return undefined;
  return clean(match[1] ?? "") || "";
};

export function parseIntent(value: string): Intent | undefined {
  const text = clean(value);
  if (!text) return undefined;

  if (/^(?:任务|任务列表|看看任务|查看任务|有哪些任务|进度|状态|现在在做什么|在做什么)$/iu.test(text)) {
    return { kind: "task-list" };
  }

  const newTask = prefix(text, /^(?:新任务|另开一个|新开一个|单独做|重新开始)(?:[：:，,\s]+(.*))?$/iu);
  if (newTask !== undefined) return { kind: "new-task", ...(newTask ? { text: newTask } : {}) };

  const switchTask = prefix(text, /^(?:继续|接着|回到|切到|切换到)\s*(.+)$/u);
  if (switchTask) return { kind: "switch-task", query: switchTask };

  if (/^(?:停一下|停止|停下来|别做了|暂停)$/iu.test(text)) return { kind: "stop" };
  if (/^(?:取消这个|取消|算了)$/iu.test(text)) return { kind: "cancel" };
  if (/^(?:同意|批准|允许|可以)$/iu.test(text)) return { kind: "approval", decision: "approve" };
  if (/^(?:拒绝|不同意|不允许)$/iu.test(text)) return { kind: "approval", decision: "deny" };

  const target = /^(?:换成|用|让)\s*(Codex|Claude Code|Claude|Cursor|Grok|OpenCode|Hermes Agent|Hermes)$/iu.exec(text);
  if (target) {
    const agent = agentAliases[target[1]!.toLocaleLowerCase()];
    if (agent) return { kind: "target-agent", agent };
  }

  if (/^(?:换个项目|换项目|看看项目|项目列表|有哪些项目)$/iu.test(text)) return { kind: "project-menu" };
  if (/^(?:看看会话|会话列表|有哪些会话|看看历史会话)$/iu.test(text)) return { kind: "session-menu" };
  return undefined;
}
