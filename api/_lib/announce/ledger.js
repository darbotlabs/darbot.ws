// Where the announcement machinery reads its state from, in one place, so the
// planner, the kit factory, and anything added later agree on what the backlog
// is and which slot a surface holds.
//
// Nothing here is generated on the fly that could be stale: the ledger is
// rebuilt by `npm run announce:rank -- --write`, and the plan, once written, is
// reused rather than recomputed, because a calendar that moves every time it is
// read is not a calendar.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildPlan, slugFor } from './plan.js';

export const LEDGER_PATH = 'data/announcements.json';
export const PLAN_DIR = 'data/announce-plan';
export const PLAN_PATH = `${PLAN_DIR}/plan.json`;

export class MissingLedgerError extends Error {
	constructor() {
		super('data/announcements.json is missing. Build it first:\n\n  npm run announce:rank -- --probe --write\n');
		this.name = 'MissingLedgerError';
	}
}

export function loadLedger(root) {
	const path = resolve(root, LEDGER_PATH);
	if (!existsSync(path)) throw new MissingLedgerError();
	return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadQueueFile(root) {
	return JSON.parse(readFileSync(resolve(root, 'data/x-content/queue.json'), 'utf8'));
}

// Surfaces under the `crypto` section render live third-party market data, so a
// frame of one carries the operating rules' coin gate.
export function cryptoPaths(root) {
	const pages = JSON.parse(readFileSync(resolve(root, 'data/pages.json'), 'utf8'));
	return new Set(pages.sections.filter((section) => section.id === 'crypto').flatMap((section) => section.pages.map((page) => page.path)));
}

// Ids that are already spoken for: queued, or carrying a pack.
export function takenIds(root, queue) {
	const taken = new Set((queue.items || []).map((item) => item.id));
	const dir = resolve(root, 'docs/announcements');
	if (existsSync(dir)) {
		for (const file of readdirSync(dir)) {
			if (file.endsWith('.md') && file !== 'README.md') taken.add(file.replace(/\.md$/, ''));
		}
	}
	return taken;
}

// Surfaces the owner or an earlier capture took off the table, with the reason.
// Committed, unlike the ledger, because the reason is knowledge the regenerated
// ledger cannot re-derive: `/genome` and `/portfolio` were both deferred after
// their frames showed an empty market and an empty input.
export function deferrals(root) {
	const path = resolve(root, 'data/announce-deferred.json');
	if (!existsSync(path)) return new Map();
	const { deferred = {} } = JSON.parse(readFileSync(path, 'utf8'));
	return new Map(Object.entries(deferred));
}

export function backlogOf(root, { ledger = null, queue = null } = {}) {
	const source = ledger || loadLedger(root);
	const taken = takenIds(root, queue || loadQueueFile(root));
	const deferred = deferrals(root);
	return (source.entries || [])
		.filter((entry) => entry.coverage === 'no')
		.filter((entry) => !entry.live || entry.live.ok)
		.filter((entry) => !taken.has(slugFor(entry.key)))
		.filter((entry) => !deferred.has(entry.key));
}

export function planFor(root, { start, ledger = null } = {}) {
	const queue = loadQueueFile(root);
	const entries = backlogOf(root, { ledger, queue });
	const plan = buildPlan(entries, { cadence: queue.cadence, quality: queue.quality, start, cryptoPaths: cryptoPaths(root) });
	plan.deferred = [...deferrals(root)].map(([key, why]) => ({ key, why }));
	return plan;
}

export function writePlan(root, plan, calendar) {
	const dir = resolve(root, PLAN_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(plan, null, '\t')}\n`);
	if (calendar) writeFileSync(join(dir, 'CALENDAR.md'), calendar);
}

// The written plan, so a batch drafted last week keeps its dates. Rebuilt only
// when there is none, or when the caller asks for a fresh start date.
export function loadOrBuildPlan(root, { start = null, refresh = false } = {}) {
	const path = resolve(root, PLAN_PATH);
	if (!refresh && !start && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
	const plan = planFor(root, { start: start || new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) });
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(plan, null, '\t')}\n`);
	return plan;
}

export function ledgerEntryFor(ledger, key) {
	return (ledger.entries || []).find((entry) => entry.key === key) || {};
}
