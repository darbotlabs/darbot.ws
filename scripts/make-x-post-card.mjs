#!/usr/bin/env node
// Render one branded 1600x900 card for an X post, in the same visual system as the
// Android launch cards (scripts/make-x-thread-cards.mjs): black ground, soft blue and
// violet glow, the three.ws lockup, a Space Grotesk headline, and the product shown
// inside a device frame instead of as a raw screenshot.
//
// Raw screenshots read as noise in a timeline. The posts that moved the most $THREE
// volume all carried either a video or a clean card that says one thing in large type,
// so every queued post gets one of these.
//
//   node scripts/make-x-post-card.mjs --spec data/x-content/cards/<id>.json
//
// Spec: { "out": "public/x-media/<id>/card.png", "headline": "Line one\nLine two",
//         "body": "One or two plain sentences.", "code": ["<line>", "<line>"],
//         "frame": "browser" | "phone", "shot": "path/to.png" | "https://three.ws/page",
//         "label": "yoursite.com" }
// `shot` is a local PNG (a capture of the feature really running) or a live URL that is
// captured on the spot. A capture that comes back blank fails the run, so a card can
// never ship showing nothing.

import sharp from 'sharp';
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const specPath = args[args.indexOf('--spec') + 1];
if (!specPath || !existsSync(specPath)) throw new Error('pass --spec <file.json>');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const W = 1600;
const H = 900;

const FONT_FACES = [
	['Space Grotesk', '300 700', 'space-grotesk-latin.woff2'],
	['Inter', '300 800', 'inter-latin.woff2'],
].map(([family, weight, file]) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(path.join(ROOT, 'public/fonts', file)).toString('base64')}) format('woff2');}`).join('\n');
const MARK_URI = `data:image/png;base64,${readFileSync(path.join(ROOT, 'public/pwa-512x512.png')).toString('base64')}`;
const OVERLAYS = ['#tws-corner-stack', '.twx-i18n-fab', '.walk-companion', '.walk-c2w-fx', '.walk-trail-layer', '#market-sidebar-toggle'];
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function shotUri() {
	let buf;
	if (/^https?:/.test(spec.shot)) {
		const page = await browser.newPage({ viewport: spec.frame === 'phone' ? { width: 412, height: 892 } : { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark' });
		try { await page.goto(spec.shot, { waitUntil: 'networkidle', timeout: 90000 }); } catch { /* an open socket never idles; the settle below covers it */ }
		await page.addStyleTag({ content: `${OVERLAYS.join(',')}{display:none!important}` });
		await page.waitForTimeout(spec.settleMs ?? 9000);
		buf = await page.screenshot({ type: 'png' });
		await page.close();
	} else {
		buf = readFileSync(path.resolve(ROOT, spec.shot));
	}
	const means = (await sharp(buf).stats()).channels.slice(0, 3).map((c) => c.mean);
	if (means.every((m) => m < 6)) throw new Error(`[x-card] the capture for ${spec.out} is effectively blank`);
	return `data:image/png;base64,${buf.toString('base64')}`;
}

const shot = await shotUri();
const headline = esc(spec.headline).replace(/\n/g, '<br>');
const code = (spec.code || []).map((line) => `<div>${esc(line).replace(/(&lt;\/?)([a-z0-9-]+)/gi, '$1<b>$2</b>').replace(/([a-z-]+)=(&quot;|")/gi, '<i>$1</i>=$2')}</div>`).join('');
const phoneFrame = spec.frame === 'phone';

const html = `<!doctype html><meta charset="utf-8"><style>
${FONT_FACES}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;background:#000;color:#fff;overflow:hidden;position:relative;font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;background:
	radial-gradient(34% 40% at 22% 28%, rgba(78,120,255,.22), transparent 70%),
	radial-gradient(30% 36% at 80% 24%, rgba(56,180,255,.14), transparent 72%),
	radial-gradient(34% 40% at 30% 84%, rgba(140,84,255,.16), transparent 70%),
	radial-gradient(30% 36% at 84% 80%, rgba(104,96,255,.14), transparent 72%)}
.beam{position:absolute;left:4%;right:4%;top:40%;height:220px;transform:rotate(-5deg);filter:blur(60px);
	background:linear-gradient(90deg, transparent, rgba(150,200,255,.09) 22%, rgba(190,220,255,.14) 50%, rgba(150,200,255,.09) 78%, transparent)}
.lockup{position:absolute;left:72px;top:60px;display:flex;align-items:center;gap:16px}
.lockup img{width:64px;height:64px;border-radius:17px}
.lockup span{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:42px;letter-spacing:-.045em}
.copy{position:absolute;left:72px;top:${spec.code ? 196 : 232}px;width:${phoneFrame ? 760 : 650}px}
h1{font-family:'Space Grotesk',sans-serif;font-weight:600;letter-spacing:-.04em;line-height:1.02;font-size:${spec.headlineSize || 74}px}
.copy p{margin-top:26px;font-size:27px;line-height:1.45;color:#a7b6d3}
.code{margin-top:34px;padding:22px 24px;border-radius:16px;background:rgba(12,16,32,.78);box-shadow:0 0 0 1px rgba(255,255,255,.10) inset;
	font:500 16px/1.75 ui-monospace,'SF Mono',Menlo,Consolas,monospace;color:#c9d6f2;white-space:nowrap;overflow:hidden}
.code b{color:#7fb2ff;font-weight:600}.code i{color:#b79bff;font-style:normal}
.foot{position:absolute;left:72px;bottom:58px;font-size:21px;color:#8fa3c6;letter-spacing:.01em}
.browser{position:absolute;left:760px;top:150px;width:780px;border-radius:18px;overflow:hidden;
	background:#12131f;box-shadow:0 50px 100px rgba(0,0,0,.9), 0 12px 30px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.12) inset;
	transform:perspective(2200px) rotateY(-7deg) rotateX(2deg)}
.bar{height:44px;display:flex;align-items:center;gap:8px;padding:0 16px;background:linear-gradient(#262a40,#1a1d2e)}
.bar u{width:11px;height:11px;border-radius:50%;background:#4a5070;display:block}
.bar span{margin-left:14px;flex:1;height:24px;border-radius:12px;background:rgba(255,255,255,.07);font-size:13px;line-height:24px;padding:0 12px;color:#93a2c4}
.browser img{display:block;width:100%}
.phone{position:absolute;left:1180px;top:470px;width:360px;transform:translate(-50%,-50%) perspective(1800px) rotateY(-8deg) rotateX(3deg);
	border-radius:34px;padding:8px;background:linear-gradient(135deg,#4a5070 0%,#2a2e44 26%,#12131f 62%,#31364f 100%);
	box-shadow:0 50px 100px rgba(0,0,0,.92), 0 12px 30px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.10) inset}
.phone img{display:block;width:100%;border-radius:27px;background:#000}
</style>
<div class="glow"></div><div class="beam"></div>
<div class="lockup"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>
<div class="copy"><h1>${headline}</h1>${spec.body ? `<p>${esc(spec.body)}</p>` : ''}${code ? `<div class="code">${code}</div>` : ''}</div>
${spec.foot ? `<div class="foot">${esc(spec.foot)}</div>` : ''}
${phoneFrame ? `<div class="phone"><img src="${shot}" alt=""></div>` : `<div class="browser"><div class="bar"><u></u><u></u><u></u><span>${esc(spec.label || 'yoursite.com')}</span></div><img src="${shot}" alt=""></div>`}`;

const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.waitForTimeout(400);
const out = path.resolve(ROOT, spec.out);
mkdirSync(path.dirname(out), { recursive: true });
const png = await page.screenshot({ type: 'png' });
await browser.close();
writeFileSync(out, await sharp(png).png({ compressionLevel: 9 }).toBuffer());
console.log(`[x-card] wrote ${spec.out} (${W}x${H})`);
