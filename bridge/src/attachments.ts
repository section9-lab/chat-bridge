import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export type InputAttachment = { id: string; name: string; path: string; size: number };
export const attachmentLimit = 10;
const maximumSize = 50 * 1024 * 1024;

export function importAttachments(directory: string, paths: unknown): InputAttachment[] {
  if (!Array.isArray(paths) || !paths.length || paths.length > attachmentLimit ||
      paths.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error("每次最多选择 10 个本机文件。");
  }
  const files: InputAttachment[] = [], folders: string[] = [];
  try {
    for (const source of new Set<string>(paths)) {
      const path = realpathSync(source), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > maximumSize) throw new Error("请选择文件，单个文件不能超过 50 MiB。");
        // Bound the read even if the source grows after selection.
        const bytes = Buffer.alloc(stat.size);
        let count = 0;
        while (count < bytes.length) {
          const read = readSync(fd, bytes, count, bytes.length - count, null);
          if (!read) break;
          count += read;
        }
        const after = fstatSync(fd);
        if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("文件正在变化，请重新选择。");
        const id = randomUUID(), name = basename(source), folder = join(directory, id);
        mkdirSync(folder, { recursive: true, mode: 0o700 }); folders.push(folder);
        const saved = join(folder, name);
        writeFileSync(saved, bytes, { flag: "wx", mode: 0o600 });
        files.push({ id, name, path: saved, size: bytes.length });
      } finally { closeSync(fd); }
    }
    return files;
  } catch (error) {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}
