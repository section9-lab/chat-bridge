import type { Origin } from "./core.js";
import type { RouteAction, RouteScope } from "./routing.js";

export type TextView = { stage: "route" | "agents" | "projects" | "sessions" | "correction" | "tasks";
  mode?: "send" | "select"; scope?: RouteScope; offset?: number };
export type TextOption = { label: string; aliases?: string[] } & (
  { kind: "action"; action: RouteAction } | { kind: "view"; view: TextView } |
  { kind: "task"; jobId: string } | { kind: "retry" | "cancel" | "dismiss" | "status" });
export type TextMenu = { id: string; jobId?: string; origin: Origin; view: TextView; entries: TextOption[];
  header: string; version: number; expiresAt: number; active: boolean };

export const menuLine = (text: string, limit = 80) => text.replaceAll(/[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").trim().slice(0, limit);
export function renderTextMenu(menu: TextMenu): string {
  return menu.header + "\n\n" + menu.entries.map((entry, index) => String(index + 1).padStart(2, "0") + " " + entry.label).join("\n") +
    "\n\n回复编号或选项文字即可。选项代码：" + menu.id + "-01。";
}

export function textOptionIndex(text: string, entries: TextOption[]): number | undefined {
  const numeric = /^(?:第)?(\d+|[一二三四五六七八九十])(?:个|项)?$/.exec(text);
  if (numeric) return /^\d+$/.test(numeric[1]!) ? Number(numeric[1]) - 1 : "一二三四五六七八九十".indexOf(numeric[1]!);
  const matches = entries.flatMap((entry, index) => [entry.label, ...(entry.aliases ?? [])].includes(text) ? [index] : []);
  return matches.length === 1 ? matches[0] : undefined;
}
