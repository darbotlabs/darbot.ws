// Solana Transaction V1 observatory and pre-sign inspector.
//
// GET  /api/solana/atomic                  -> live feature-gate status
// GET  /api/solana/atomic?signature=<sig>  -> fetch and inspect a confirmed tx
// POST /api/solana/atomic { transaction }  -> inspect base64 wire bytes offline

import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import {
	TX_V1_FEATURE_ADDRESS,
	decodeFeatureActivationSlot,
	inspectWireTransaction,
} from '../_lib/solana/transaction-v1.js';

function isSignature(value) {
	if (!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(value)) return false;
	try {
		return bs58.decode(value).length === 64;
	} catch {
		return false;
	}
}

async function liveStatus(connection) {
	const [account, slot] = await Promise.all([
		connection.getAccountInfo(new PublicKey(TX_V1_FEATURE_ADDRESS), 'confirmed'),
		connection.getSlot('confirmed'),
	]);
	const activationSlot = account ? decodeFeatureActivationSlot(account.data) : null;
	return {
		cluster: 'mainnet-beta',
		feature: 'txv1',
		featureAddress: TX_V1_FEATURE_ADDRESS,
		active: activationSlot !== null && Number(slot) >= Number(activationSlot),
		activationSlot,
		currentSlot: slot,
		legacyLimitBytes: 1_232,
		v1LimitBytes: 4_096,
	};
}

async function inspectSignature(connection, signature) {
	const rpc = await connection._rpcRequest('getTransaction', [
		signature,
		{ encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 1 },
	]);
	if (rpc.error) throw Object.assign(new Error(rpc.error.message || 'Solana RPC rejected the request'), { upstream: true });
	if (!rpc.result) return null;

	const encoded = rpc.result.transaction?.[0];
	if (typeof encoded !== 'string') {
		throw Object.assign(new Error('Solana RPC returned an unsupported transaction encoding'), { upstream: true });
	}
	const inspection = inspectWireTransaction(encoded);
	const consumed = rpc.result.meta?.computeUnitsConsumed ?? null;
	return {
		...inspection,
		signature,
		cluster: 'mainnet-beta',
		confirmation: {
			slot: rpc.result.slot,
			blockTime: rpc.result.blockTime ?? null,
			success: rpc.result.meta?.err == null,
			error: rpc.result.meta?.err ?? null,
			feeLamports: rpc.result.meta?.fee ?? null,
			computeUnitsConsumed: consumed,
			computeUtilizationPct:
				consumed !== null && inspection.budget.computeUnitLimit
					? Math.round((Number(consumed) / Number(inspection.budget.computeUnitLimit)) * 1_000) / 10
					: null,
		},
		explorerUrl: `https://solscan.io/tx/${signature}`,
	};
}

export default wrap(async function atomicHandler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const [ipLimit, globalLimit] = await Promise.all([
		limits.cryptoDataIp(clientIp(req)),
		limits.cryptoDataGlobal(),
	]);
	if (!ipLimit.success || !globalLimit.success) {
		return error(res, 429, 'rate_limited', 'too many requests - retry shortly');
	}

	if (req.method === 'POST') {
		let body;
		try {
			body = await readJson(req, 16_384);
			const inspection = inspectWireTransaction(body.transaction);
			res.setHeader('cache-control', 'no-store');
			return json(res, 200, { inspection });
		} catch (err) {
			return error(res, err.status || 400, 'invalid_transaction', err.message);
		}
	}

	const url = new URL(req.url, 'http://atomic.local');
	const signature = (url.searchParams.get('signature') || '').trim();
	const connection = solanaConnection({ network: 'mainnet' });

	if (!signature) {
		try {
			const status = await liveStatus(connection);
			res.setHeader('cache-control', 'public, s-maxage=15, stale-while-revalidate=45');
			return json(res, 200, { status });
		} catch (err) {
			console.error('[solana/atomic] status lookup failed:', err?.message);
			return error(res, 502, 'upstream_error', 'Solana mainnet status is temporarily unavailable');
		}
	}

	if (!isSignature(signature)) {
		return error(res, 400, 'invalid_signature', 'signature must be a base58 Solana transaction signature');
	}

	try {
		const inspection = await inspectSignature(connection, signature);
		if (!inspection) return error(res, 404, 'not_found', 'transaction was not found on Solana mainnet');
		res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
		return json(res, 200, { inspection });
	} catch (err) {
		console.error('[solana/atomic] transaction lookup failed:', err?.message);
		return error(res, err.upstream ? 502 : 400, err.upstream ? 'upstream_error' : 'invalid_transaction', err.message);
	}
});
