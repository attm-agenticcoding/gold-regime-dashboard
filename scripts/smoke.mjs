// Runs the engine on data/history.json and prints the headline numbers — fails loudly if the data layer broke.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeAll, weeklySummary } from "../engine.js";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const res = computeAll(R("data/history.json"), R("03_metrics.json"), R("config.json"), R("data/manual.json"));
if (!Number.isFinite(res.composite)) { console.error("composite is null — data layer broken"); process.exit(1); }
console.log(weeklySummary(res));
const dead = res.data_status.filter((d) => d.weight_used === 0 && !d.manual);
if (dead.length) console.log("weight 0 (stale/missing):", dead.map((d) => `${d.id} (stale ${d.stale_rows})`).join(", "));
