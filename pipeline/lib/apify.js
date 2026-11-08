// Minimal Apify client: start an actor run with a spending cap, wait for it, read its dataset.
import { fetchJson, sleep } from './util.js';

const API = 'https://api.apify.com/v2';

/**
 * Run a store actor and return its dataset items.
 * actor: 'username~actor-name'. maxItems and maxChargeUsd cap what a pay-per-result run can bill.
 */
export async function runActor(actor, input, { token, maxItems, maxChargeUsd, timeoutSecs = 900, log = () => {} } = {}) {
  if (!token) throw new Error('APIFY_TOKEN is not set');
  const q = new URLSearchParams({ token, timeout: String(timeoutSecs) });
  if (maxItems) q.set('maxItems', String(maxItems));
  if (maxChargeUsd) q.set('maxTotalChargeUsd', String(maxChargeUsd));
  const started = await fetchJson(`${API}/acts/${actor}/runs?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
  }, { label: `start ${actor}` });
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
  if (status !== 'SUCCEEDED' && !items.length) throw new Error(`${actor}: run ended ${status} with no results`);
  return { items, status, costUsd: typeof info.usageTotalUsd === 'number' ? info.usageTotalUsd : null };
}
