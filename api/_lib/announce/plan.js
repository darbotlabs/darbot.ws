// The announcement calendar: which unannounced surface goes out, in what order,
// on which day, in which lane and shape.
//
// scripts/announce-rank.mjs answers "what is worth announcing" and writes the
// ledger. This module answers the next question, which nobody had automated:
// given 300-plus never-announced surfaces and an account that can carry three
// posts a day without reading as a bot, what is the actual schedule?
//
// Everything here is pure so the schedule is reproducible: the same ledger and
// the same start date always produce the same calendar, which is what makes a
// plan reviewable rather than a fresh guess on every run.
//
// Three constraints shape it, and all three come from files that already exist
// rather than from taste:
//
//   cadence      data/x-content/queue.json: daily cap, minimum gap, quiet hours.
//                Slot times are derived from those, never hardcoded.
//   rotation     the same queue's quality block: no more than N of the same
//                lane in a row, no more than M of the same pattern. The
//                scheduler in api/_lib/x-content/schedule.js enforces this at
//                publish time by *skipping* an item, so a calendar that ignores
//                it would stall itself.
//   the coin gate  a frame captured from a surface under the `crypto` section of
//                data/pages.json bakes live third-party tickers into a
//                committed file, which the operating rules gate on owner
//                approval. Those surfaces are planned like any other and carry
//                `mediaGate`, so a batch can be run without them.

const MINUTE = 60_000;

// Audience lane. Rotation only cares that neighbours differ, but the lane also
// decides who the pack is written for, so it is derived from where the surface
// lives rather than assigned round-robin.
export const LANES = ['community', 'developer', 'token', 'labs'];

// Post shape. Each surface gets a ranked list; the sequencer takes the first
// one that does not repeat its neighbour, which is how a 300-item run avoids
// converging on a single format.
export const PATTERNS = ['mechanism', 'clip', 'number', 'correction', 'walkthrough'];

const DEVELOPER_SECTIONS = new Set(['build', 'agent-tools', 'machine', 'package', 'worker', 'service']);
const TOKEN_RE = /\$THREE|\btoken\b|\bcoin\b|\bx402\b|\bwallet\b|\bUSDC\b|on-chain|onchain|\bmint\b|\btrading\b|\bpump\.fun\b/i;

export function laneFor(entry) {
	if (entry.section === 'crypto') return 'token';
	if (entry.section === 'labs') return 'labs';
	if (DEVELOPER_SECTIONS.has(entry.section)) return 'developer';
	if (TOKEN_RE.test(`${entry.title} ${entry.description}`) && entry.signals?.token) return 'token';
	return 'community';
}

// A surface that renders motion can carry a loop; one with a measured number in
// its own description can lead on the number. Everything can lead on mechanism,
// so it is always last and always available.
export function patternsFor(entry) {
	const text = `${entry.title} ${entry.description}`;
	const ranked = [];
	// A loop has to be a loop of something running, so only a surface with a
	// route can carry one. A package's frame is a typeset card, which is a
	// still by construction.
	const filmable = Boolean(entry.url);
	if (filmable && (entry.signals?.visual ?? 0) >= 25) ranked.push('clip');
	if (/\b\d[\d,.]*\s*(?:%|x\b|ms\b|seconds?|minutes?|hours?|k\b|m\b)|\b\d{2,}\b/.test(text)) ranked.push('number');
	if (/instead of|without|no longer|used to|rather than|misconception|assume/i.test(text)) ranked.push('correction');
	if (/\bhow to\b|guide|tutorial|step|studio|builder|editor/i.test(text)) ranked.push('walkthrough');
	if (filmable && (entry.signals?.visual ?? 0) > 0 && !ranked.includes('clip')) ranked.push('clip');
	// Any surface a visitor can act on can be written as a walkthrough, which is
	// what keeps a long run of pages from being 40 mechanism posts in a row.
	if (filmable && !ranked.includes('walkthrough')) ranked.push('walkthrough');
	ranked.push('mechanism');
	return [...new Set(ranked)];
}

// `/labor-market` -> `labor-market`, `@three-ws/walk-sdk` -> `walk-sdk`,
// `workers/rigger` -> `worker-rigger`. Stable, because it becomes the queue id,
// the pack filename, and the media shot id.
export function slugFor(key) {
	const raw = String(key || '');
	if (raw.startsWith('@')) return raw.split('/').pop().replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
	if (raw.includes('/') && !raw.startsWith('/')) {
		const [base, name] = raw.split('/');
		return `${base.replace(/s$/, '')}-${name}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
	}
	return raw.replace(/^\//, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'home';
}

function minutesOf(value) {
	const [hour, minute] = String(value).split(':').map(Number);
	return hour * 60 + (minute || 0);
}

const inQuiet = (minutes, quiet) => {
	if (!Array.isArray(quiet) || quiet.length !== 2) return false;
	const [start, end] = quiet.map(minutesOf);
	const at = ((minutes % 1440) + 1440) % 1440;
	return start <= end ? at >= start && at < end : at >= start || at < end;
};

// The posting times of a day, derived from the cadence rather than chosen. A
// slot whose jitter window could land inside quiet hours is dropped, so the
// calendar never promises a slot the scheduler would refuse.
export function slotTimes(cadence = {}) {
	const quiet = cadence.quietHoursUtc || null;
	const cap = Math.max(1, Number(cadence.dailyCap ?? 3));
	const gap = Math.max(60, Number(cadence.minimumMinutesApart ?? 240));
	const window = Math.max(0, Number(cadence.windowMinutes ?? 90));
	const first = quiet ? minutesOf(quiet[1]) + 60 : 13 * 60;
	const spacing = Math.max(gap, 300);
	const times = [];
	for (let index = 0; index < cap; index++) {
		const at = first + index * spacing;
		if (at >= 1440) break;
		if (inQuiet(at, quiet) || inQuiet(at + window, quiet)) continue;
		times.push(`${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`);
	}
	return times.length ? times : ['13:00'];
}

function runLength(list, field, value) {
	let run = 0;
	for (let index = list.length - 1; index >= 0; index--) {
		if (list[index][field] !== value) break;
		run++;
	}
	return run;
}

// Greedy sequencer. Highest score first, but a candidate that would repeat the
// previous lane or pattern too many times yields to the next one that fits,
// and a candidate whose preferred pattern is blocked falls through its own
// ranked list before it gives up its slot.
export function sequence(entries, { maximumSameLaneInARow = 2, maximumSamePatternInARow = 1 } = {}) {
	const pool = entries.map((entry) => ({
		entry,
		lane: laneFor(entry),
		patterns: patternsFor(entry),
	}));
	const placed = [];
	while (pool.length) {
		let chosen = -1;
		let pattern = null;
		for (let index = 0; index < pool.length; index++) {
			const candidate = pool[index];
			if (runLength(placed, 'lane', candidate.lane) >= maximumSameLaneInARow) continue;
			pattern = candidate.patterns.find((option) => runLength(placed, 'pattern', option) < maximumSamePatternInARow) || null;
			if (pattern) {
				chosen = index;
				break;
			}
		}
		// Every remaining candidate repeats the neighbour. That happens whenever
		// the inventory is lopsided (167 of the 316 unannounced surfaces are
		// developer-lane packages, so a long developer run is unavoidable), and
		// the scheduler's own starvation rule releases such an item a day past
		// its slot. Shape still matters more than lane here, so the fallback
		// takes the best candidate that can at least change the post's shape.
		if (chosen < 0) {
			const lastPattern = placed[placed.length - 1]?.pattern;
			chosen = pool.findIndex((candidate) => candidate.patterns.some((option) => option !== lastPattern));
			if (chosen < 0) chosen = 0;
			pattern = pool[chosen].patterns.find((option) => option !== lastPattern) || pool[chosen].patterns[0];
		}
		const [candidate] = pool.splice(chosen, 1);
		placed.push({ entry: candidate.entry, lane: candidate.lane, pattern });
	}
	return placed;
}

export function buildPlan(entries, { cadence = {}, quality = {}, start, cryptoPaths = new Set(), perDay = null } = {}) {
	const times = slotTimes(cadence).slice(0, perDay || Infinity);
	const day0 = Date.parse(`${start}T00:00:00Z`);
	if (!Number.isFinite(day0)) throw new Error(`start must be a YYYY-MM-DD date, got ${start}`);

	const ordered = sequence(entries, quality);
	const slots = ordered.map((row, index) => {
		const day = Math.floor(index / times.length);
		const time = times[index % times.length];
		const notBefore = new Date(day0 + day * 1440 * MINUTE + minutesOf(time) * MINUTE).toISOString().replace('.000Z', 'Z');
		const slug = slugFor(row.entry.key);
		const gated = Boolean(row.entry.url && cryptoPaths.has(row.entry.url));
		return {
			position: index + 1,
			id: slug,
			key: row.entry.key,
			kind: row.entry.kind,
			section: row.entry.section,
			url: row.entry.url || null,
			lane: row.lane,
			pattern: row.pattern,
			notBefore,
			windowMinutes: Number(cadence.windowMinutes ?? 90),
			batch: Math.floor(day / 7) + 1,
			score: row.entry.score,
			partner: row.entry.partner || null,
			shot: `${slug}-hero`,
			motion: row.pattern === 'clip',
			mediaGate: gated ? 'owner-approval' : null,
			pack: `docs/announcements/${slug}.md`,
		};
	});

	return {
		generatedAt: new Date().toISOString(),
		start,
		times,
		perDay: times.length,
		days: Math.ceil(slots.length / times.length),
		totals: {
			slots: slots.length,
			gated: slots.filter((slot) => slot.mediaGate).length,
			byLane: Object.fromEntries(LANES.map((lane) => [lane, slots.filter((slot) => slot.lane === lane).length])),
			byPattern: Object.fromEntries(PATTERNS.map((pattern) => [pattern, slots.filter((slot) => slot.pattern === pattern).length])),
		},
		slots,
	};
}
