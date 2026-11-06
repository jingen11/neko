import path from "node:path";
import { fileURLToPath } from "node:url";
import { Embedder, MODEL, VectorCache, chunk, index } from "../src/embed.ts";
import { loadTextbook } from "../src/textbook.ts";

/** Make the saved vectors for every chunk that doesn't have one yet (run after adding or editing lessons). */
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.NEKO_TEXTBOOK_DIR || path.resolve(here, "../../data/textbook");
const url = process.env.NEKO_EMBED_URL ?? "http://127.0.0.1:8082";
const chunks = chunk(loadTextbook(dir));
const file = path.join(dir, ".index", `${MODEL}.json`);
const t = Date.now();
const n = await index(chunks, new VectorCache(file), new Embedder(url), (done, total) => process.stdout.write(`\r${done}/${total}`));
if (n === null) { console.error(`\nembedding server at ${url} is unavailable`); process.exit(1); }
console.log(`\n${chunks.length} chunks, ${n} newly embedded in ${((Date.now() - t) / 1000).toFixed(1)} s → ${file}`);
