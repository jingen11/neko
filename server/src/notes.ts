import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { NoteFile } from "../../shared/protocol.ts";
import { config } from "./config.ts";

/**
 * Read-only access to the vault's markdown files, for the Notes page. neko only shows the files as
 * they are: it doesn't parse them back into records. Only .md files inside the vault folder are
 * served; hidden folders (.obsidian, .trash) and symlinks are skipped.
 */

export async function listNotes(): Promise<NoteFile[]> {
  if (!config.vaultDir) return [];
  const root = path.resolve(config.vaultDir);
  const out: NoteFile[] = [];
  async function walk(dir: string) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      const st = await lstat(full).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) await walk(full);
      else if (name.endsWith(".md")) out.push({ path: path.relative(root, full).split(path.sep).join("/"), mtime: st.mtimeMs, size: st.size });
    }
  }
  await walk(root);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** One note's text, or null if the path isn't a .md file inside the vault. */
export async function readNote(rel: string): Promise<string | null> {
  if (!config.vaultDir || !rel.endsWith(".md") || rel.split("/").some((p) => p.startsWith("."))) return null;
  const root = await realpath(config.vaultDir).catch(() => null);
  if (!root) return null;
  const file = await realpath(path.join(root, rel)).catch(() => null);
  if (!file || !file.startsWith(root + path.sep)) return null; // no ../ or symlinks out of the vault
  return readFile(file, "utf8");
}
