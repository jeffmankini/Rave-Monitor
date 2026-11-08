// Minimal Apify client: start an actor run with a spending cap, wait for it, read its dataset.
import { fetchJson, sleep } from './util.js';

const API = process.env.APIFY_API_BASE || 'https://api.apify.com/v2';

/*
 * Apify caps the memory of all of an account's runs at once (16 GB on the free plan) and refuses
 * a run that would go over. Runs wait here for room instead, sized by each actor's default memory.
 */
let budgetMb = 16384, inUseMb = 0;
const waiting = [];
export function setMemoryBudget(mb) { if (mb > 0) budgetMb = mb; }
export function acquireMemory(mb) {
  const need = Math.min(mb, budgetMb);
  return new Promise(resolve => {
    const take = () => (inUseMb + need <= budgetMb ? (inUseMb += need, resolve(need), true) : false);
    if (!take()) waiting.push(take);
  });
}
export function releaseMemory(mb) {
  inUseMb -= mb;
  for (let i = 0; i < waiting.length;) if (waiting[i]()) waiting.splice(i, 1); else i++;
}
const memoryOf = new Map();
function actorMemoryMb(actor) {
  if (!memoryOf.has(actor)) {
    memoryOf.set(actor, fetchJson(`${API}/acts/${actor}`, {}, { label: `info ${actor}`, retries: 1 })
      .then(r => r?.data?.defaultRunOptions?.memoryMbytes || 4096).catch(() => 4096));
  }
  return memoryOf.get(actor);
}

/**
 * Run a store actor and return its dataset items.
 * actor: 'username~actor-name'. maxItems and maxChargeUsd cap what a pay-per-result run can bill.
 */
export async function runActor(actor, input, opts = {}) {
  if (!opts.token) throw new Error('APIFY_TOKEN is not set');
  const mb = await acquireMemory(await actorMemoryMb(actor));
  try { return await runNow(actor, input, opts); } finally { releaseMemory(mb); }
}

async function runNow(actor, input, { token, maxItems, maxChargeUsd, timeoutSecs = 900, log = () => {}, memoryWaitMs = 30000 }) {
  const q = new URLSearchParams({ token, timeout: String(timeoutSecs) });
  if (maxItems) q.set('maxItems', String(maxItems));
  if (maxChargeUsd) q.set('maxTotalChargeUsd', String(maxChargeUsd));
  let started;
  for (let attempt = 0; ; attempt++) {
    try {
      started = await fetchJson(`${API}/acts/${actor}/runs?${q}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
      }, { label: `start ${actor}` });
      break;
    } catch (err) {
      // Other runs on the account can still fill the memory limit; wait for them rather than fail.
      if (err.status === 402 && /memory/i.test(err.message) && attempt < 12) {
        if (!attempt) log(`  ${actor}: waiting for Apify memory to free up`);
        await sleep(memoryWaitMs);
        continue;
      }
      throw err;
    }
  }
  const run = started.data;
  log(`  ${actor}: run ${run.id} started`);
  const deadline = Date.now() + (timeoutSecs + 120) * 1000;
  let status = run.status, info = run;
  while (!['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(status)) {
    if (Date.now() > deadline) throw new Error(`${actor}: run ${run.id} did not finish in time`);
    const r = await fetchJson(`${API}/actor-runs/${run.id}?token=${encodeURIComponent(token)}&waitForFinish=60`, {}, { label: `poll ${actor}` });
    info = r.data; status = info.status;
    if (!['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(status)) await sleep(2000);
  }
  // A run stopped by its cap or time limit still has usable results, so read them either way.
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await fetchJson(`${API}/datasets/${info.defaultDatasetId}/items?token=${encodeURIComponent(token)}&clean=true&format=json&limit=1000&offset=${offset}`, {}, { label: `dataset ${actor}` });
    items.push(...page);
    if (page.length < 1000) break;
  }
  const usd = info.usageTotalUsd ?? info.stats?.computeUnits;
  log(`  ${actor}: ${status}, ${items.length} items${typeof usd === 'number' ? `, about $${usd.toFixed(3)}` : ''}`);
  if (status !== 'SUCCEEDED' && !items.length) throw new Error(`${actor}: run ${run.id} ended ${status} with no results`);
  return { items, status, costUsd: typeof info.usageTotalUsd === 'number' ? info.usageTotalUsd : null };
}
