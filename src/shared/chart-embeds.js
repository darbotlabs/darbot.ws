// Embeddable third-party price charts, keyed by a token's on-chain identity.
//
// Every coin page on three.ws lets the viewer pick the chart they trust. The
// URL shapes for each provider live here once, so /launches/<mint> and
// /coin/:id build identical embeds and a provider changing its embed format is
// a one-file fix.
//
// Only providers verified to render inside a cross-origin <iframe> without a
// key are listed. Checked in a real browser, 2026-09-17:
//   DexScreener    token address, resolves the top pair itself
//   Birdeye        token address (its TradingView-based tv-widget)
//   GMGN           token address (its kline widget), Solana/ETH/Base/BSC only
//   GeckoTerminal  pool address, and only once GeckoTerminal indexed that pool
// Refused framing or needs a key, so deliberately absent: DEXTools
// (X-Frame-Options), Codex/Defined (frame-ancestors / bot checkpoint), Moralis
// (key-restricted widget), pump.fun, Jupiter, Photon, Axiom, Solscan.
//
// Each chain entry holds the slug every provider uses for that chain. A chain a
// provider does not index is simply missing from its field, and the provider is
// not offered for that coin rather than rendering a dead chart.

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Chain id (CoinGecko asset-platform id) → per-provider slug. Solana leads. */
export const CHART_CHAINS = {
	solana: { ds: 'solana', gt: 'solana', be: 'solana', gm: 'sol', evm: false },
	ethereum: { ds: 'ethereum', gt: 'eth', be: 'ethereum', gm: 'eth', evm: true },
	base: { ds: 'base', gt: 'base', be: 'base', gm: 'base', evm: true },
	'binance-smart-chain': { ds: 'bsc', gt: 'bsc', be: 'bsc', gm: 'bsc', evm: true },
	'polygon-pos': { ds: 'polygon', gt: 'polygon_pos', be: 'polygon', evm: true },
	'arbitrum-one': { ds: 'arbitrum', gt: 'arbitrum', be: 'arbitrum', evm: true },
	'optimistic-ethereum': { ds: 'optimism', gt: 'optimism', be: 'optimism', evm: true },
	avalanche: { ds: 'avalanche', gt: 'avax', be: 'avalanche', evm: true },
};

/** True when `address` is well-formed for `chain`. */
export function validChartAddress(chain, address) {
	const c = CHART_CHAINS[chain];
	if (!c || typeof address !== 'string') return false;
	return c.evm ? EVM_RE.test(address) : SOL_RE.test(address);
}

const enc = encodeURIComponent;

/**
 * The embeddable providers, in the order a switcher shows them.
 *
 * `needs` is 'token' (keyed by the token address) or 'pool' (keyed by a pool
 * address the caller resolves first). `embed()` returns the iframe URL and
 * `page()` the provider's own page for the same market, used by "open in"
 * links and by the fallback panel when an embed is blocked.
 */
export const CHART_EMBEDS = [
	{
		id: 'dexscreener',
		label: 'DexScreener',
		needs: 'token',
		slug: 'ds',
		embed: ({ slug, token, theme }) =>
			`https://dexscreener.com/${slug}/${enc(token)}?${new URLSearchParams({
				embed: '1',
				loadChartSettings: '0',
				theme,
				chartTheme: theme,
				chartType: 'usd',
				interval: '15',
				info: '0',
			})}`,
		page: ({ slug, token }) => `https://dexscreener.com/${slug}/${enc(token)}`,
	},
	{
		id: 'birdeye',
		label: 'Birdeye',
		needs: 'token',
		slug: 'be',
		embed: ({ slug, token, theme }) =>
			`https://birdeye.so/tv-widget/${enc(token)}?${new URLSearchParams({
				chain: slug,
				viewMode: 'pair',
				chartInterval: '15',
				chartType: 'CANDLE',
				chartLeftToolbar: 'show',
				theme,
			})}`,
		page: ({ slug, token }) => `https://birdeye.so/token/${enc(token)}?chain=${enc(slug)}`,
	},
	{
		id: 'gmgn',
		label: 'GMGN',
		needs: 'token',
		slug: 'gm',
		embed: ({ slug, token, theme }) =>
			`https://www.gmgn.cc/kline/${slug}/${enc(token)}?${new URLSearchParams({ theme, interval: '15' })}`,
		page: ({ slug, token }) => `https://gmgn.ai/${slug}/token/${enc(token)}`,
	},
	{
		id: 'geckoterminal',
		label: 'GeckoTerminal',
		needs: 'pool',
		slug: 'gt',
		embed: ({ slug, pool, theme }) =>
			`https://www.geckoterminal.com/${slug}/pools/${enc(pool)}?${new URLSearchParams({
				embed: '1',
				info: '0',
				swaps: '0',
				grayscale: '0',
				light_chart: theme === 'light' ? '1' : '0',
			})}`,
		page: ({ slug, pool }) => `https://www.geckoterminal.com/${slug}/pools/${enc(pool)}`,
	},
];

/** Providers that index `chain`. */
export function chartEmbedsFor(chain) {
	const c = CHART_CHAINS[chain];
	if (!c) return [];
	return CHART_EMBEDS.filter((p) => c[p.slug]);
}

/**
 * Builds the embed and page URLs for one provider on one market.
 *
 * @param {string} providerId
 * @param {{ chain: string, token: string, pool?: string|null, theme?: 'dark'|'light' }} market
 * @returns {{ embed: string, page: string } | null} null when the provider does
 *   not index the chain, or it needs a pool that was not supplied.
 */
export function chartEmbedUrls(providerId, { chain, token, pool = null, theme = 'dark' }) {
	const provider = CHART_EMBEDS.find((p) => p.id === providerId);
	const slug = provider && CHART_CHAINS[chain]?.[provider.slug];
	if (!slug) return null;
	if (provider.needs === 'pool' && !pool) return null;
	const args = { slug, token, pool, theme: theme === 'light' ? 'light' : 'dark' };
	return { embed: provider.embed(args), page: provider.page(args) };
}

/**
 * Resolves the pool GeckoTerminal's embed is keyed by, and whether GeckoTerminal
 * has indexed it. /api/coin/pool falls back to DexScreener for a token
 * GeckoTerminal does not know yet (every young pump.fun coin), and GeckoTerminal
 * answers its embed for an unindexed pool with a full-page 404, so the pool is
 * confirmed against GeckoTerminal's own public API (CORS-open, keyless) before
 * the embed is mounted.
 *
 * @param {string} chain
 * @param {string} token
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ pool: string|null, indexed: boolean }>}
 */
export async function resolveGeckoPool(chain, token, { signal } = {}) {
	const network = CHART_CHAINS[chain]?.gt;
	if (!network) return { pool: null, indexed: false };
	const r = await fetch(`/api/coin/pool?address=${enc(token)}&network=${enc(network)}`, {
		headers: { accept: 'application/json' },
		signal,
	});
	if (r.status === 404) return { pool: null, indexed: false };
	if (!r.ok) throw new Error(`pool lookup ${r.status}`);
	const { pool } = await r.json();
	if (!pool) return { pool: null, indexed: false };
	const gt = await fetch(`https://api.geckoterminal.com/api/v2/networks/${enc(network)}/pools/${enc(pool)}`, {
		headers: { accept: 'application/json' },
		signal,
	});
	if (gt.status === 404) return { pool, indexed: false };
	if (!gt.ok) throw new Error(`GeckoTerminal ${gt.status}`);
	return { pool, indexed: true };
}
