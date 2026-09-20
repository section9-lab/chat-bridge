import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function projectName(text: string): string {
  const quoted = text.match(/(?:名为|叫做?|命名为|named|called)\s*[“"「『']([^”"」』'\n]{1,80})[”"」』']/i) ??
    text.match(/[“"「『']([^”"」』'\n]{1,80})[”"」』']\s*(?:的)?(?:项目|工程|project)/i);
  const description = text.split(/[，。！？\n,!?]/)[0]!.replace(/^(?:请|帮我|请帮我)\s*/, "")
    .replace(/^(?:用|使用)\s*(?:codex|claude(?:\s*code)?)\s*/i, "")
    .replace(/^(?:创建|新建|建立|另建)(?:一个|个)?\s*/, "").replace(/(?:的)?(?:项目|工程)$/, "");
  return (quoted?.[1] ?? description).replaceAll(/[\p{C}<>:"/\\|?*]/gu, "").trim().replace(/^\.+|\.+$/g, "")
    .trim().slice(0, 36) || "新项目";
}

export function createProjectDirectory(parent: string, name: string): { root: string; name: string } {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const base = realpathSync(parent);
  for (let index = 1; index <= 1000; index++) {
    const label = name + (index === 1 ? "" : "（" + index + "）");
    const root = join(base, label);
    try { mkdirSync(root, { mode: 0o700 }); return { root, name: label }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw new Error("Too many projects with this name");
}
