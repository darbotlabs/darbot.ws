import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyProblems, weightedLength } from '../api/_lib/x-content/quality.js';
import { attachmentProblems, mediaProblems, parseFfmpegProbe } from '../api/_lib/x-content/media.js';
import { markdownToContentState, attachArticleMedia } from '../api/_lib/x-content/articles.js';
import { anchorAssignments, dueAt, inQuietHours, jitterMinutes, pickDue } from '../api/_lib/x-content/schedule.js';
import { validateItem, validateQueue, loadQueue } from '../api/_lib/x-content/queue.js';
import { previewClient, publishItem } from '../api/_lib/x-content/publisher.js';

const root = process.cwd();
const HOUR = 3_600_000;

function sandbox() {
	const dir = mkdtempSync(join(tmpdir(), 'x-content-'));
	mkdirSync(join(dir, 'public/x-media/t'), { recursive: true });
	mkdirSync(join(dir, 'data/x-content/articles'), { recursive: true });
	writeFileSync(join(dir, 'public/x-media/t/a.png'), Buffer.alloc(64));
	writeFileSync(join(dir, 'public/x-media/t/b.png'), Buffer.alloc(64));
	writeFileSync(join(dir, 'public/x-media/t/clip.mp4'), Buffer.alloc(64));
	return dir;
}

const HEAD = 'Rig Doctor names the skeleton convention of any humanoid GLB, then lists which bones animate and which stay put: three.ws/rig-doctor';

describe('quality', () => {
	it('weights URLs as 23 characters', () => {
		expect(weightedLength('see https://three.ws/a/very/long/path/that/keeps/going')).toBe(4 + 23);
	});

	it('flags the tells of an automated feed', () => {
		const problems = copyProblems('Introducing our REVOLUTIONARY AMAZING tool!!! #ai', { minimum: 1 });
		expect(problems.join('\n')).toMatch(/banned opening/);
		expect(problems.join('\n')).toMatch(/hashtags/);
		expect(problems.join('\n')).toMatch(/exclamation/);
		expect(problems.join('\n')).toMatch(/shouting/);
		expect(problems.join('\n')).toMatch(/must link/);
	});

	it('allows tickers and acronyms in capitals', () => {
		expect(copyProblems('$THREE holders get GLTF exports over HTTP on three.ws/pay', { minimum: 1 })).toEqual([]);
	});

	it('does not require a link when the item links elsewhere', () => {
		expect(copyProblems('The rig runs on our own GPU workers.', { minimum: 1, requireUrl: false })).toEqual([]);
	});
});

describe('media', () => {
	it('allows four images, or one video or GIF alone', () => {
		const img = (n) => ({ path: `public/x-media/t/${n}.png` });
		expect(attachmentProblems([img(1), img(2), img(3), img(4)])).toEqual([]);
		expect(attachmentProblems([img(1), img(2), img(3), img(4), img(5)])).toHaveLength(1);
		expect(attachmentProblems([{ path: 'public/x-media/t/clip.mp4' }, img(1)])).toHaveLength(1);
	});

	it('requires alt text on images and media inside the image', () => {
		const dir = sandbox();
		expect(mediaProblems({ path: 'public/x-media/t/a.png' }, dir)).toEqual(['public/x-media/t/a.png: needs alt text']);
		expect(mediaProblems({ path: 'public/x-media/t/a.png', alt: 'a hero shot' }, dir)).toEqual([]);
		expect(mediaProblems({ path: 'docs/a.png', alt: 'x' }, dir).join('\n')).toMatch(/must live under/);
	});

	it('requires a probe within X video limits', () => {
		const dir = sandbox();
		const path = 'public/x-media/t/clip.mp4';
		expect(mediaProblems({ path }, dir).join('\n')).toMatch(/no probe/);
		const good = { durationSec: 12, width: 1280, height: 720, fps: 30, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac' };
		expect(mediaProblems({ path, probe: good }, dir)).toEqual([]);
		const bad = mediaProblems({ path, probe: { ...good, durationSec: 200, width: 3840, videoCodec: 'hevc' } }, dir).join('\n');
		expect(bad).toMatch(/duration/);
		expect(bad).toMatch(/3840x720/);
		expect(bad).toMatch(/h264/);
	});

	it('parses ffmpeg stream info into a probe', () => {
		const stderr = [
			'  Duration: 00:00:06.03, start: 0.000000, bitrate: 6112 kb/s',
			'  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 5972 kb/s, 60 fps, 60 tbr, 15360 tbn (default)',
			'  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)',
		].join('\n');
		expect(parseFfmpegProbe(stderr)).toEqual({ durationSec: 6.03, width: 1920, height: 1080, fps: 60, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac' });
	});
});

describe('articles', () => {
	it('maps inline styles and links onto correct offsets', () => {
		const { content_state } = markdownToContentState('Drop one `<agent-3d>` tag &amp; go. **Bold [link](https://three.ws) text** and ~~old~~.');
		const [block] = content_state.blocks;
		expect(block.text).toBe('Drop one <agent-3d> tag & go. Bold link text and old.');
		const bold = block.inline_style_ranges.find((range) => range.style === 'bold');
		expect(block.text.substr(bold.offset, bold.length)).toBe('Bold link text');
		const strike = block.inline_style_ranges.find((range) => range.style === 'strikethrough');
		expect(block.text.substr(strike.offset, strike.length)).toBe('old');
		const [link] = block.entity_ranges;
		expect(block.text.substr(link.offset, link.length)).toBe('link');
		expect(content_state.entities[link.key].value).toEqual({ type: 'link', mutability: 'mutable', data: { url: 'https://three.ws' } });
	});

	it('turns structure into block types and atomic embeds', () => {
		const md = '# One\n\n## Two\n\n### Three\n\n- a\n- b\n\n1. c\n\n> quote\n\n---\n\n```js\nx()\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
		const { content_state, markdownWeight } = markdownToContentState(md);
		expect(content_state.blocks.map((block) => block.type)).toEqual([
			'header-one', 'header-two', 'header-three', 'unordered-list-item', 'unordered-list-item', 'ordered-list-item', 'blockquote', 'atomic', 'atomic', 'atomic',
		]);
		expect(content_state.entities.map((entity) => entity.value.type)).toEqual(['divider', 'markdown', 'markdown']);
		expect(markdownWeight).toBeGreaterThan(0);
	});

	it('resolves local images and attaches uploaded media ids', () => {
		const { content_state, images, warnings } = markdownToContentState('![Hero](../../../public/x-media/t/a.png)\n\n![Remote](https://example.com/x.png)', {
			articlePath: 'data/x-content/articles/demo.md',
		});
		expect(images).toEqual([{ entityIndex: 0, path: 'public/x-media/t/a.png', caption: 'Hero' }]);
		expect(warnings).toHaveLength(1);
		const attached = attachArticleMedia(content_state, images, ['123']);
		expect(attached.entities[0].value.data.media_items).toEqual([{ media_category: 'tweet_image', media_id: '123' }]);
		expect(content_state.entities[0].value.data.media_items).toEqual([]);
	});
});

describe('schedule', () => {
	const item = (id, over = {}) => ({ id, status: 'approved', kind: 'post', lane: 'community', pattern: 'mechanism', notBefore: '2026-09-17T14:00:00Z', ...over });
	const cadence = { windowMinutes: 60, minimumMinutesApart: 240, dailyCap: 3 };

	it('jitters deterministically inside the window', () => {
		expect(jitterMinutes('genesis', 60)).toBe(jitterMinutes('genesis', 60));
		const at = dueAt(item('genesis'), cadence);
		expect(at).toBeGreaterThanOrEqual(Date.parse('2026-09-17T14:00:00Z'));
		expect(at).toBeLessThan(Date.parse('2026-09-17T15:00:00Z'));
	});

	it('handles quiet hours that wrap midnight', () => {
		expect(inQuietHours(Date.parse('2026-09-17T23:30:00Z'), ['22:00', '06:00'])).toBe(true);
		expect(inQuietHours(Date.parse('2026-09-17T12:00:00Z'), ['22:00', '06:00'])).toBe(false);
	});

	it('waits for the jittered moment, then spacing, then the daily cap', () => {
		const now = Date.parse('2026-09-17T16:00:00Z');
		expect(pickDue({ items: [item('a')], state: {}, now: Date.parse('2026-09-17T13:00:00Z'), cadence }).item).toBeNull();
		expect(pickDue({ items: [item('a')], state: {}, now, cadence }).item.id).toBe('a');
		const recent = { published: [{ id: 'z', lane: 'x', pattern: 'y', publishedAt: new Date(now - HOUR).toISOString() }] };
		expect(pickDue({ items: [item('a')], state: recent, now, cadence }).reason).toMatch(/spacing/);
		const capped = { published: [5, 11, 17].map((h, i) => ({ id: `p${i}`, lane: 'x', pattern: 'y', publishedAt: new Date(now - h * HOUR).toISOString() })) };
		expect(pickDue({ items: [item('a')], state: capped, now, cadence }).reason).toMatch(/daily cap/);
	});

	it('rotates lanes and patterns but never starves a one-lane queue', () => {
		const now = Date.parse('2026-09-17T16:00:00Z');
		const state = { published: [{ id: 'p', lane: 'community', pattern: 'mechanism', publishedAt: new Date(now - 5 * HOUR).toISOString() }] };
		const quality = { maximumSameLaneInARow: 2, maximumSamePatternInARow: 1 };
		const picked = pickDue({ items: [item('same'), item('fresh', { pattern: 'number', notBefore: '2026-09-17T14:30:00Z' })], state, now, cadence, quality });
		expect(picked.item.id).toBe('fresh');
		expect(pickDue({ items: [item('same')], state, now, cadence, quality }).item).toBeNull();
		expect(pickDue({ items: [item('same')], state, now: now + 26 * HOUR, cadence, quality }).item.id).toBe('same');
	});

	it('resumes a half-published item ahead of pacing', () => {
		const now = Date.parse('2026-09-17T16:00:00Z');
		const state = {
			published: [{ id: 'p', lane: 'x', pattern: 'y', publishedAt: new Date(now - 10 * 60_000).toISOString() }],
			inflight: { a: { media: {}, postIds: ['1'] } },
		};
		expect(pickDue({ items: [item('a')], state, now, cadence }).resuming).toBe(true);
	});
});

describe('queue', () => {
	it('keeps the committed queue valid for every item headed to X', () => {
		const queue = loadQueue(root);
		const { problems } = validateQueue(queue, root);
		for (const item of queue.items.filter((row) => row.status === 'approved')) expect(problems[item.id]).toEqual([]);
	});

	it('requires media on the head post unless text-only is explicit', () => {
		const dir = sandbox();
		const base = { id: 'demo', status: 'review', kind: 'post', lane: 'l', pattern: 'p', notBefore: '2026-09-17T14:00:00Z' };
		expect(validateItem({ ...base, posts: [{ text: HEAD }] }, dir).join('\n')).toMatch(/no media/);
		expect(validateItem({ ...base, textOnly: true, posts: [{ text: HEAD }] }, dir)).toEqual([]);
	});

	it('validates an Article end to end', () => {
		const dir = sandbox();
		writeFileSync(join(dir, 'data/x-content/articles/demo.md'), '## Why\n\nBecause.\n\n![Hero](../../../public/x-media/t/b.png)\n\nThe end.');
		const item = {
			id: 'demo', status: 'review', kind: 'article', lane: 'article', pattern: 'longform', notBefore: '2026-09-17T14:00:00Z',
			article: { title: 'How rigs get named', body: 'data/x-content/articles/demo.md', cover: { path: 'public/x-media/t/a.png' } },
			posts: [{ text: 'The long version of how Rig Doctor reads a skeleton.' }],
		};
		expect(validateItem(item, dir)).toEqual([]);
		expect(validateItem({ ...item, article: { ...item.article, cover: undefined } }, dir).join('\n')).toMatch(/cover/);
	});
});

describe('publisher', () => {
	const store = (log) => ({ save: async (state) => log.push(structuredClone(state)) });

	it('chains a thread with media and alt text on the head', async () => {
		const dir = sandbox();
		const client = previewClient();
		const state = { published: [], inflight: {} };
		const item = {
			id: 'demo', kind: 'post', lane: 'l', pattern: 'p',
			posts: [{ text: HEAD, media: [{ path: 'public/x-media/t/a.png', alt: 'alt one' }] }, { text: 'second' }],
		};
		const row = await publishItem({ item, client, root: dir, state, store: store([]) });
		expect(client.calls.map((call) => call.call)).toEqual(['media.upload', 'media.metadata', 'tweets.create', 'tweets.create']);
		expect(client.calls[3].reply.in_reply_to_tweet_id).toBe(row.postIds[0]);
		expect(state.inflight).toEqual({});
		expect(state.published[0].url).toBe(`https://x.com/trythreews/status/${row.postIds[0]}`);
	});

	it('resumes after a failure without reposting what already went out', async () => {
		const dir = sandbox();
		const state = { published: [], inflight: {} };
		const item = { id: 'demo', kind: 'post', lane: 'l', pattern: 'p', posts: [{ text: HEAD }, { text: 'two' }, { text: 'three' }] };
		const flaky = previewClient();
		const tweet = flaky.tweet;
		let calls = 0;
		flaky.tweet = async (payload) => {
			if (++calls === 2) throw new Error('X 503');
			return tweet(payload);
		};
		await expect(publishItem({ item, client: flaky, root: dir, state, store: store([]) })).rejects.toThrow('X 503');
		expect(state.inflight.demo.postIds).toHaveLength(1);

		const retry = previewClient();
		await publishItem({ item, client: retry, root: dir, state, store: store([]) });
		expect(retry.calls.map((call) => call.text)).toEqual(['two', 'three']);
		expect(retry.calls[0].reply.in_reply_to_tweet_id).toBe(state.published[0].postIds[0]);
	});

	it('drafts, publishes, then quotes an Article', async () => {
		const dir = sandbox();
		writeFileSync(join(dir, 'data/x-content/articles/demo.md'), '## Why\n\n![Hero](../../../public/x-media/t/b.png)\n\nText.');
		const client = previewClient();
		const state = { published: [], inflight: {} };
		const item = {
			id: 'demo', kind: 'article', lane: 'article', pattern: 'longform',
			article: { title: 'Title', body: 'data/x-content/articles/demo.md', cover: { path: 'public/x-media/t/a.png' } },
			posts: [{ text: 'Quote post' }],
		};
		const row = await publishItem({ item, client, root: dir, state, store: store([]) });
		const draft = client.calls.find((call) => call.call === 'POST /2/articles/draft');
		expect(draft.body.cover_media.media_category).toBe('tweet_image');
		const image = draft.body.content_state.entities.find((entity) => entity.value.type === 'image');
		expect(image.value.data.media_items[0].media_id).toMatch(/^preview-media/);
		const quote = client.calls.at(-1);
		expect(quote.quote_tweet_id).toBe(row.articlePostId);
		expect(row.url).toBe(`https://x.com/trythreews/status/${row.articlePostId}`);
	});
});

describe('editorial', () => {
	it('passes the reviewed Genesis copy untouched', async () => {
		const { languageProblems, assertionsIn } = await import('../api/_lib/x-content/editorial.js');
		const text = 'A sentence or a selfie becomes a rigged 3D agent holding its own custodial @solana wallet, a persona, and a voice. It walks and emotes on arrival: three.ws/genesis';
		expect(languageProblems(text)).toEqual([]);
		expect(assertionsIn(text)).toEqual({ numbers: [], absolutes: [] });
	});

	it('blocks brand errors, financial promotion, slang, pushy asks, and ad-copy structure', async () => {
		const { languageProblems } = await import('../api/_lib/x-content/editorial.js');
		const rules = (text) => languageProblems(text).map((row) => `${row.rule}:${row.severity}`);
		expect(rules('Three.ws ships agents on Github: three.ws/a')).toEqual(['brand:blocking', 'brand:blocking']);
		expect(rules('$THREE has 100x potential for holders: three.ws/a')).toContain('compliance:blocking');
		expect(rules('gm frens, agents are live: three.ws/a')).toContain('register:blocking');
		expect(rules('A robust agent runtime: three.ws/a')).toEqual(['register:major']);
		expect(rules('Agents are live, check it out: three.ws/a')).toContain('register:blocking');
		expect(rules('Fast. Simple. Onchain. three.ws/a')).toContain('structure:blocking');
		expect(rules('What if agents could pay? They can: three.ws/a')).toContain('structure:blocking');
		expect(rules('Two links: three.ws/a and three.ws/b')).toContain('links:blocking');
	});

	it('treats names as names and ordinals as numbers', async () => {
		const { assertionsIn } = await import('../api/_lib/x-content/editorial.js');
		expect(assertionsIn('3D agents on ERC-8004 with $THREE: three.ws/a').numbers).toEqual([]);
		expect(assertionsIn('Rig Doctor knows 11 conventions; teach it the 12th in 40 ms at 86%').numbers).toEqual(['11', '12th', '40 ms', '86%']);
	});

	it('requires every number, absolute, and tag in the copy to be declared', async () => {
		const { claimProblems } = await import('../api/_lib/x-content/editorial.js');
		const item = { posts: [{ text: 'The first viewer with 15 rig conventions, built on @solana: three.ws/a' }] };
		const messages = claimProblems(item).map((row) => row.message).join('\n');
		expect(messages).toMatch(/"15" is an unverified number/);
		expect(messages).toMatch(/"first" is an absolute/);
		expect(messages).toMatch(/@solana has no recorded reason/);

		const declared = {
			...item,
			claims: [
				{ says: 'first viewer', evidence: [{ type: 'file', path: 'x', contains: 'y' }] },
				{ says: '15 rig conventions', evidence: [{ type: 'file', path: 'x', contains: 'y' }] },
			],
			mentions: { '@solana': 'wallets are Solana wallets' },
		};
		expect(claimProblems(declared)).toEqual([]);
		expect(claimProblems({ ...declared, claims: [...declared.claims, { says: 'not in the copy', evidence: [] }] }).map((row) => row.message).join('\n'))
			.toMatch(/does not appear in the copy[\s\S]*has no evidence/);
	});

	it('flags soft, badly cropped, undescribed, and stale media', async () => {
		const { mediaQualityProblems } = await import('../api/_lib/x-content/editorial.js');
		const { default: sharp } = await import('sharp');
		const dir = sandbox();
		await sharp({ create: { width: 800, height: 200, channels: 3, background: '#000' } }).png().toFile(join(dir, 'public/x-media/t/small.png'));
		await sharp({ create: { width: 1800, height: 1013, channels: 3, background: '#000' } }).png().toFile(join(dir, 'public/x-media/t/hero.png'));
		mkdirSync(join(dir, 'public/announce'), { recursive: true });
		writeFileSync(join(dir, 'public/announce/media-manifest.json'), JSON.stringify({ shots: { hero: { src: '/x-media/t/hero.png', route: '/hero', capturedAt: '2026-08-01T00:00:00Z' } } }));
		const now = Date.parse('2026-09-16T00:00:00Z');

		const small = await mediaQualityProblems({ text: 'x', media: [{ path: 'public/x-media/t/small.png', alt: 'short' }] }, dir, { now });
		const smallText = small.map((row) => row.message).join('\n');
		expect(smallText).toMatch(/800px wide/);
		expect(smallText).toMatch(/4\.00:1/);
		expect(smallText).toMatch(/alt text is 5 characters/);

		const stale = await mediaQualityProblems({ text: 'x', media: [{ path: 'public/x-media/t/hero.png', alt: 'The hero page with its drop zone and the four stats beneath it' }] }, dir, { now });
		expect(stale.map((row) => row.message)).toEqual([expect.stringMatching(/captured 46 days ago from \/hero/)]);
	});
});

describe('review', () => {
	it('binds approval to the exact reviewed content', async () => {
		const { approvalProblems, contentHash, reviewPath } = await import('../api/_lib/x-content/review.js');
		const dir = sandbox();
		const item = { id: 'demo', kind: 'post', posts: [{ text: HEAD, media: [{ path: 'public/x-media/t/a.png', alt: 'alt' }] }] };
		expect(approvalProblems(item, dir).join('\n')).toMatch(/no editorial review/);

		mkdirSync(join(dir, 'data/x-content/reviews'), { recursive: true });
		const record = { id: 'demo', contentHash: contentHash(item, dir), reviewedAt: '2026-09-16T00:00:00Z', passed: true, blockers: [] };
		writeFileSync(join(dir, reviewPath('demo')), JSON.stringify(record));
		const now = Date.parse('2026-09-17T00:00:00Z');
		expect(approvalProblems(item, dir, now)).toEqual([]);

		expect(approvalProblems({ ...item, posts: [{ ...item.posts[0], text: `${HEAD} ` }] }, dir, now)).toEqual([]);
		expect(approvalProblems({ ...item, posts: [{ ...item.posts[0], text: HEAD.replace('Rig', 'The rig') }] }, dir, now).join('\n')).toMatch(/changed after the last review/);
		writeFileSync(join(dir, 'public/x-media/t/a.png'), Buffer.alloc(65));
		expect(approvalProblems(item, dir, now).join('\n')).toMatch(/changed after the last review/);
		writeFileSync(join(dir, 'public/x-media/t/a.png'), Buffer.alloc(64));
		expect(approvalProblems(item, dir, Date.parse('2026-10-16T00:00:00Z')).join('\n')).toMatch(/days old/);
		writeFileSync(join(dir, reviewPath('demo')), JSON.stringify({ ...record, passed: false, blockers: ['link three.ws/a: HTTP 404'] }));
		expect(approvalProblems(item, dir, now).join('\n')).toMatch(/did not pass: link three\.ws\/a: HTTP 404/);
	});

	it('blocks an approved item in the queue validator until it is reviewed', () => {
		const dir = sandbox();
		const item = { id: 'demo', status: 'approved', kind: 'post', lane: 'l', pattern: 'p', notBefore: '2026-09-17T14:00:00Z', posts: [{ text: HEAD, media: [{ path: 'public/x-media/t/a.png', alt: 'The Rig Doctor page' }] }] };
		expect(validateItem(item, dir).join('\n')).toMatch(/review: no editorial review/);
		expect(validateItem({ ...item, status: 'review' }, dir)).toEqual([]);
	});

	it('never lets the editor pass its own blocking issue or a low score', async () => {
		const { parseReview } = await import('../api/_lib/x-content/editor.js');
		const scores = { accuracy: 5, clarity: 5, specificity: 5, voice: 5, professionalism: 5, visual: 5 };
		const clean = parseReview(`Here you go: ${JSON.stringify({ verdict: 'publish', scores, issues: [] })}`);
		expect(clean.verdict).toBe('publish');
		expect(parseReview(JSON.stringify({ verdict: 'publish', scores, issues: [{ severity: 'blocking', area: 'accuracy' }] })).verdict).toBe('revise');
		expect(parseReview(JSON.stringify({ verdict: 'publish', scores: { ...scores, clarity: 3 }, issues: [] })).verdict).toBe('revise');
		expect(() => parseReview(JSON.stringify({ verdict: 'ship', scores, issues: [] }))).toThrow(/verdict/);
		expect(() => parseReview('no json here')).toThrow(/no JSON/);
	});
});

describe('schedule seed', () => {
	const day = [
		{ id: 'forge-max', notBefore: '2026-10-01T13:00:00Z', windowMinutes: 90 },
		{ id: 'materialize', notBefore: '2026-10-01T18:00:00Z', windowMinutes: 90 },
		{ id: 'walk-sdk', notBefore: '2026-10-01T23:00:00Z', windowMinutes: 90 },
	];

	it('changes the minute an item lands, and keeps it stable per seed', () => {
		const open = dueAt(day[0], {});
		const secret = dueAt(day[0], {}, { seed: 'production-seed' });
		expect(secret).not.toBe(open);
		expect(dueAt(day[0], {}, { seed: 'production-seed' })).toBe(secret);
		expect(dueAt(day[0], {}, { seed: 'another-seed' })).not.toBe(secret);
	});

	it('is a plain hash with no seed, so previews and tests are unchanged', () => {
		expect(jitterMinutes('genesis', 60)).toBe(jitterMinutes('genesis', 60, null));
		expect(jitterMinutes('genesis', 60, 'seed')).not.toBe(jitterMinutes('genesis', 60));
	});

	it('deals the day\'s anchors out by seed without leaving the day', () => {
		const assignments = anchorAssignments(day, 'production-seed');
		expect([...assignments.values()].sort((left, right) => left - right)).toEqual([13 * 60, 18 * 60, 23 * 60]);
		expect(anchorAssignments(day, null).size).toBe(0);
		const orders = new Set(['s1', 's2', 's3', 's4', 's5'].map((seed) => [...anchorAssignments(day, seed)].map(([id]) => id).join(',')));
		expect(orders.size).toBeGreaterThan(1);
	});

	it('still respects the cadence when the seed moves an item', () => {
		const approved = day.map((item) => ({ ...item, status: 'approved', lane: 'developer', pattern: 'mechanism' }));
		const now = Date.parse('2026-10-02T04:00:00Z');
		const picked = pickDue({ items: approved, state: {}, now, cadence: { windowMinutes: 90, minimumMinutesApart: 240, dailyCap: 3, quietHoursUtc: ['05:00', '12:00'] }, seed: 'production-seed' });
		expect(approved.map((item) => item.id)).toContain(picked.item.id);
		expect(picked.dueAt).toBeLessThanOrEqual(now);
	});
});
