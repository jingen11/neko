import type { NoteFile } from "../../shared/protocol.ts";
import "./style.css";

/** The Notes page: the vault's markdown files, listed by folder, newest first, each shown as written. */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const filesEl = $("files");
const noteEl = $("note");
const pathEl = $("notePath");
const copyBtn = $<HTMLButtonElement>("copyBtn");
const downloadBtn = $<HTMLAnchorElement>("downloadBtn");
const filter = $<HTMLInputElement>("noteFilter");

let files: NoteFile[] = [];
let openPath = "";
let openText = "";

async function loadList() {
  try {
    const res = await fetch("/api/notes");
    if (!res.ok) throw new Error(`server error ${res.status}`);
    files = await res.json();
    renderList();
    const want = new URLSearchParams(location.search).get("path") ?? files.find((f) => f.path.startsWith("Daily/"))?.path ?? files[0]?.path;
    if (want) openNote(want, false);
  } catch (err) {
    filesEl.innerHTML = `<p class="empty">Couldn't list the notes: ${esc((err as Error).message)}</p>`;
  }
}

function renderList() {
  const q = filter.value.trim().toLowerCase();
  const shown = files.filter((f) => f.path.toLowerCase().includes(q));
  $("noteCount").textContent = files.length ? `${shown.length} of ${files.length}` : "";
  if (!shown.length) {
    filesEl.innerHTML = `<p class="empty">${files.length ? "No note matches." : "No notes yet. They appear once you practise."}</p>`;
    return;
  }
  const groups = new Map<string, NoteFile[]>();
  for (const f of shown) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(f);
  }
  // Daily first, then the other folders by name, loose files last
  const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  filesEl.innerHTML = order
    .map(
      (dir) =>
        `<section class="file-group"><h3>${esc(dir || "Vault")}</h3><ul>${groups
          .get(dir)!
          .map((f) => {
            const name = f.path.slice(f.path.lastIndexOf("/") + 1, -3);
            return `<li><button type="button" data-path="${esc(f.path)}" aria-current="${f.path === openPath}"><span>${esc(name)}</span><span class="meta">${when(f.mtime)}</span></button></li>`;
          })
          .join("")}</ul></section>`,
    )
    .join("");
}
const rank = (dir: string) => (dir === "Daily" ? 0 : dir ? 1 : 2);

filesEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-path]");
  if (b) openNote(b.dataset.path!);
});
filter.addEventListener("input", renderList);

async function openNote(p: string, push = true) {
  try {
    const res = await fetch(`/api/notes/file?path=${encodeURIComponent(p)}`);
    if (!res.ok) throw new Error(res.status === 404 ? "not found" : `server error ${res.status}`);
    openText = await res.text();
    openPath = p;
    pathEl.textContent = p;
    noteEl.innerHTML = markdown(openText);
    copyBtn.disabled = false;
    downloadBtn.removeAttribute("aria-disabled");
    downloadBtn.href = URL.createObjectURL(new Blob([openText], { type: "text/markdown" }));
    downloadBtn.download = p.split("/").pop()!;
    if (push) history.replaceState(null, "", `?path=${encodeURIComponent(p)}`);
    renderList();
    if (push && matchMedia("(max-width: 900px)").matches) noteEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    toast(`Couldn't open ${p}: ${(err as Error).message}`);
  }
}

noteEl.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-note]");
  if (!a) return;
  e.preventDefault();
  const target = resolveLink(a.dataset.note!);
  if (target) openNote(target);
  else toast(`There's no note called "${a.dataset.note}" yet.`);
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(openText);
    toast("Copied the markdown.");
  } catch {
    toast("Couldn't copy. Use Download instead.");
  }
});

/** An Obsidian link ("Japanese/Daily/2026-11-02" or just "2026-11-02") → a file in the list. */
function resolveLink(link: string): string | undefined {
  const want = link.replace(/\.md$/, "").toLowerCase();
  return files.find((f) => {
    const p = f.path.slice(0, -3).toLowerCase();
    return want === p || want.endsWith("/" + p) || p.endsWith("/" + want) || p === want.split("/").pop();
  })?.path;
}

// ── a small markdown renderer: what the notes use, and what Hermes usually writes ──

function markdown(src: string): string {
  let text = src.replace(/\r\n/g, "\n");
  let props = "";
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    text = text.slice(fm[0].length);
    const rows = fm[1].split("\n").map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean) as RegExpMatchArray[];
    if (rows.length) props = `<dl class="props">${rows.map((r) => `<div><dt>${esc(r[1])}</dt><dd>${inline(r[2])}</dd></div>`).join("")}</dl>`;
  }
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      i++;
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      out.push(`<h${level + 1 > 6 ? 6 : level + 1}>${inline(line.replace(/^#+\s*/, ""))}</h${level + 1 > 6 ? 6 : level + 1}>`);
      i++;
    } else if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*> ?/, ""));
      out.push(`<blockquote>${markdown(quote.join("\n"))}</blockquote>`);
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items: { depth: number; ordered: boolean; text: string }[] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)!;
        items.push({ depth: Math.floor(m[1].replace(/\t/g, "  ").length / 2), ordered: /\d/.test(m[2]), text: m[3] });
      }
      out.push(list(items));
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, "|")));
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
    } else if (line.trim()) {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s+|\s*\|)/.test(lines[i]); i++) para.push(lines[i].trim());
      if (!para.length) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join(" "))}</p>`);
    } else i++;
  }
  return props + out.join("");
}

function list(items: { depth: number; ordered: boolean; text: string }[]): string {
  let html = "";
  const stack: string[] = [];
  for (const it of items) {
    while (stack.length > it.depth + 1) html += `</li></${stack.pop()}>`;
    if (stack.length < it.depth + 1) {
      while (stack.length < it.depth + 1) {
        const tag = it.ordered ? "ol" : "ul";
        stack.push(tag);
        html += `<${tag}>`;
      }
    } else html += "</li>";
    html += `<li>${inline(it.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop()}>`;
  return html;
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => `<a href="#" data-note="${target}">${alias ?? target.split("/").pop()}</a>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/(^|\s)#([\w/-]+)/g, '$1<span class="tag">#$2</span>');
}

function when(t: number) {
  const d = new Date(t);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

let toastTimer: number | undefined;
function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 4000);
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

loadList();
