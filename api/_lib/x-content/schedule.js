// Picks the one item a tick should publish, or explains why nothing is due.
//
// Human cadence, not cron cadence. An account that posts at 14:00:00 every day
// in lane order is obviously a bot. So:
//   - each item lands at a stable jittered moment inside its window after
//     `notBefore` (hashed from its id, so a preview and the real tick agree);
//   - posts keep a minimum gap and a rolling 24h cap;
//   - quiet hours are respected;
//   - the same lane or format never runs more times in a row than the config
//     allows, unless the item has waited a full day past its moment (so a
//     one-lane queue still drains).
// Pure: no I/O, so the rules are unit-tested and the CLI shows the same
// decision the cron will make.

import { createHash, createHmac } from 'node:crypto';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const DEFAULT_CADENCE = {
	windowMinutes: 90,
	minimumMinutesApart: 240,
	dailyCap: 3,
	quietHoursUtc: null,
};

// ── Why the schedule carries a secret ────────────────────────────────────────
// The queue is a committed file in a public repository, so the day an item
// posts is public by construction. Without a seed the minute is public too:
// the jitter was a plain hash of the item's id, which anyone holding the repo
// can compute, and an announcement whose exact minute is knowable days ahead
// can be camped, front-run, or pre-empted.
//
// `X_CONTENT_SCHEDULE_SEED` (production env, never committed) turns that hash
// into an HMAC. Same properties for us (stable per item, so a preview, a retry
// and the real tick all agree), no properties at all for anyone without the
// seed. It also deals out the day's anchor times, so which of the day's posts
// goes first is unknowable as well. With no seed configured the behaviour is
// exactly what it was, which keeps local previews and the tests honest.

export function jitterMinutes(id, windowMinutes, seed = null) {
	const digest = seed
		? createHmac('sha256', String(seed)).update(String(id)).digest()
		: createHash('sha256').update(String(id)).digest();
	return digest.readUInt32BE(0) % Math.max(1, windowMinutes);
}

const startOfUtcDay = (timestamp) => Date.parse(`${new Date(timestamp).toISOString().slice(0, 10)}T00:00:00Z`);
const minutesOfUtcDay = (timestamp) => (timestamp - startOfUtcDay(timestamp)) / MINUTE;

// The anchor each of a day's items takes, as minutes past midnight UTC. The
// anchors are the ones the plan already chose; the seed only decides which item
// gets which, so no item ever moves outside the day, the quiet hours, or the
// cadence it was planned under.
export function anchorAssignments(items, seed = null) {
	const assignments = new Map();
	if (!seed) return assignments;
	const byDay = new Map();
	for (const item of items) {
		const at = Date.parse(item.notBefore);
		if (!Number.isFinite(at)) continue;
		const day = startOfUtcDay(at);
		if (!byDay.has(day)) byDay.set(day, []);
		byDay.get(day).push(item);
	}
	for (const [, dayItems] of byDay) {
		const anchors = dayItems.map((item) => minutesOfUtcDay(Date.parse(item.notBefore))).sort((left, right) => left - right);
		const order = [...dayItems].sort((left, right) => {
			const rank = (item) => createHmac('sha256', String(seed)).update(`order:${item.id}`).digest('hex');
			return rank(left).localeCompare(rank(right));
		});
		order.forEach((item, index) => assignments.set(item.id, anchors[index]));
	}
	return assignments;
}

export function dueAt(item, cadence = DEFAULT_CADENCE, { seed = null, anchorMinutes = null } = {}) {
	const window = Number(item.windowMinutes ?? cadence.windowMinutes ?? DEFAULT_CADENCE.windowMinutes);
	const planned = Date.parse(item.notBefore);
	const base = anchorMinutes === null || anchorMinutes === undefined ? planned : startOfUtcDay(planned) + anchorMinutes * MINUTE;
	return base + jitterMinutes(item.id, window, seed) * MINUTE;
}

export function inQuietHours(now, quiet) {
	if (!Array.isArray(quiet) || quiet.length !== 2) return false;
	const minutes = new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes();
	const [start, end] = quiet.map((value) => {
		const [h, m] = String(value).split(':').map(Number);
		return h * 60 + (m || 0);
	});
	return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function trailingRun(published, field, value) {
	let run = 0;
	for (let index = published.length - 1; index >= 0; index--) {
		if (published[index][field] !== value) break;
		run++;
	}
	return run;
}

// `requestedId` names one item and skips pacing; `anyStatus` lets a preview of
// that item run before it is approved.
export function pickDue({ items, state, now = Date.now(), cadence: rawCadence = {}, quality = {}, requestedId = null, anyStatus = false, seed = null }) {
	const cadence = { ...DEFAULT_CADENCE, ...rawCadence };
	const published = [...(state?.published || [])].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
	const publishedIds = new Set(published.map((row) => row.id));
	const inflight = state?.inflight || {};

	const eligible = items
		.filter((item) => (item.status === 'approved' || (anyStatus && requestedId)) && !publishedIds.has(item.id))
		.filter((item) => !requestedId || item.id === requestedId);
	const anchors = anchorAssignments(eligible, seed);
	const candidates = eligible
		.map((item) => ({ item, at: dueAt(item, cadence, { seed, anchorMinutes: anchors.get(item.id) ?? null }) }))
		.sort((a, b) => a.at - b.at);

	if (requestedId) {
		return candidates[0] ? { item: candidates[0].item, dueAt: candidates[0].at, forced: true } : { item: null, reason: `no ${anyStatus ? '' : 'approved '}unpublished item named ${requestedId}` };
	}

	// A half-published item (thread cut off mid-way, Article drafted but not
	// yet published) always resumes first, ahead of every pacing rule.
	const resuming = candidates.find(({ item }) => inflight[item.id]);
	if (resuming) return { item: resuming.item, dueAt: resuming.at, resuming: true };

	if (inQuietHours(now, cadence.quietHoursUtc)) return { item: null, reason: 'quiet hours' };

	const last = published[published.length - 1];
	if (last) {
		const nextAllowed = Date.parse(last.publishedAt) + cadence.minimumMinutesApart * MINUTE;
		if (now < nextAllowed) return { item: null, reason: `spacing: next post allowed at ${new Date(nextAllowed).toISOString()}` };
	}
	const lastDay = published.filter((row) => now - Date.parse(row.publishedAt) < DAY).length;
	if (lastDay >= cadence.dailyCap) return { item: null, reason: `daily cap of ${cadence.dailyCap} reached` };

	const maxLane = Number(quality.maximumSameLaneInARow ?? Infinity);
	const maxPattern = Number(quality.maximumSamePatternInARow ?? Infinity);
	const due = candidates.filter(({ at }) => at <= now);
	if (!due.length) {
		const next = candidates[0];
		return { item: null, reason: next ? `next item ${next.item.id} is due at ${new Date(next.at).toISOString()}` : 'queue has no approved unpublished items' };
	}
	for (const candidate of due) {
		const starved = now - candidate.at >= DAY;
		const laneRun = trailingRun(published, 'lane', candidate.item.lane);
		const patternRun = trailingRun(published, 'pattern', candidate.item.pattern);
		if (starved || (laneRun < maxLane && patternRun < maxPattern)) return { item: candidate.item, dueAt: candidate.at };
	}
	return { item: null, reason: 'every due item would repeat the previous lane or pattern; waiting for variety' };
}
