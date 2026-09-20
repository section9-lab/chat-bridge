import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type OutputAttachment = { path: string; name: string; size: number; sha256: string; type: "image" | "video" | "file" };
const maximumSize = 50 * 1024 * 1024;
const imageTypes = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const videoTypes = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const fileTypes = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".csv", ".txt", ".zip", ".mp3", ".wav", ".m4a"]);
const within = (root: string, path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith("../") && !isAbsolute(part); };

function outputPaths(text: string, root: string): string[] {
  const result = new Set<string>();
  const prose = text.replace(/```[\s\S]*?```/g, "");
  const links = [...prose.matchAll(/\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\n)]+))\)/g)].map(m => m[1] ?? m[2]!);
  links.push(...[...prose.matchAll(/`(\/[^`\n]+)`/g)].map(m => m[1]!));
  for (let link of links.slice(0, 64)) {
    try {
      link = link.startsWith("file:") ? fileURLToPath(link) : decodeURIComponent(link);
      if (!isAbsolute(link) || /:\d+(?::\d+)?$/.test(link)) continue;
      const path = realpathSync(link);
      if (within(root, path)) result.add(path);
    } catch { /* Missing paths and remote links are not local outputs. */ }
  }
  return [...result];
}

export function outputProject(text: string, cwd?: string): { root: string; name: string } | undefined {
  if (!cwd) return;
  const workspace = realpathSync(cwd), roots = new Set<string>();
  for (const path of outputPaths(text, workspace)) {
    let dir = statSync(path).isDirectory() ? path : dirname(path);
    while (within(workspace, dir)) {
      if (["project.godot", "package.json", "pyproject.toml", "Cargo.toml", ".git"].some(name => statSync(join(dir, name), { throwIfNoEntry: false }))) {
        roots.add(dir); break;
      }
      if (dir === workspace) break;
      dir = dirname(dir);
    }
  }
  if (roots.size !== 1) return;
  const root = [...roots][0]!;
  let name = basename(root);
  const godot = join(root, "project.godot");
  if ((statSync(godot, { throwIfNoEntry: false })?.size ?? Infinity) < 256 * 1024) {
    name = /^config\/name="([^"\n]+)"/m.exec(readFileSync(godot, "utf8"))?.[1] ?? name;
  }
  return { root, name: name.replaceAll(/[\r\n\t]/g, " ").slice(0, 60) };
}

export function snapshotOutputs(text: string, cwd: string | undefined, directory: string): { files: OutputAttachment[]; warnings: string[] } {
  const files: OutputAttachment[] = [], warnings: string[] = [];
  if (!cwd) return { files, warnings };
  const root = realpathSync(cwd);
  for (const path of outputPaths(text, root)) {
    const ext = extname(path).toLowerCase(), name = basename(path);
    if (!imageTypes.has(ext) && !videoTypes.has(ext) && !fileTypes.has(ext)) continue;
    let fd: number | undefined;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      if (stat.size > maximumSize || files.length >= 8) { warnings.push(name + " 未作为附件发送：单文件上限为 50 MB，每次最多 8 个文件。"); continue; }
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error("Changed output");
      const bytes = readFileSync(fd);
      if (bytes.length !== stat.size || bytes.length > maximumSize) throw new Error("Changed output");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const folder = join(directory, sha256);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const saved = join(folder, name);
      try { writeFileSync(saved, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      files.push({ path: saved, name, size: bytes.length, sha256, type: imageTypes.has(ext) ? "image" : videoTypes.has(ext) ? "video" : "file" });
    } catch { warnings.push(name + " 未作为附件发送：文件无法读取或在准备时发生变化。"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return { files, warnings };
}

export function attachmentBytes(attachment: OutputAttachment): Buffer {
  if (attachment.size > maximumSize || !statSync(attachment.path).isFile() || statSync(attachment.path).size !== attachment.size) throw new Error("附件副本不可用。");
  const data = readFileSync(attachment.path);
  if (createHash("sha256").update(data).digest("hex") !== attachment.sha256) throw new Error("附件副本校验失败。");
  return data;
}
