import { describe, it, expect } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import {
	AGENT_DEPLOY_V1_CONFIG,
	LEGACY_TRANSACTION_LIMIT,
	V1_TRANSACTION_LIMIT,
	buildPartiallySignedV1Transaction,
	decodeFeatureActivationSlot,
	inspectWireTransaction,
} from '../api/_lib/solana/transaction-v1.js';
import { cosignV1Transaction } from '../src/erc8004/solana-deploy.js';
import { getTransactionDecoder } from '@solana/kit';

function signedLegacyTransfer() {
	const payer = Keypair.generate();
	const tx = new Transaction({
		feePayer: payer.publicKey,
		recentBlockhash: Keypair.generate().publicKey.toBase58(),
	});
	tx.add(SystemProgram.transfer({
		fromPubkey: payer.publicKey,
		toPubkey: Keypair.generate().publicKey,
		lamports: 1,
	}));
	tx.sign(payer);
	return tx.serialize().toString('base64');
}

function createAccountInput(owner, asset) {
	const instruction = SystemProgram.createAccount({
		fromPubkey: owner.publicKey,
		newAccountPubkey: asset.publicKey,
		lamports: 1,
		space: 0,
		programId: SystemProgram.programId,
	});
	return {
		feePayer: owner.publicKey.toBase58(),
		lifetime: {
			blockhash: Keypair.generate().publicKey.toBase58(),
			lastValidBlockHeight: 123n,
		},
		instructions: [{
			programId: instruction.programId.toBase58(),
			keys: instruction.keys.map((key) => ({
				pubkey: key.pubkey.toBase58(),
				isSigner: key.isSigner,
				isWritable: key.isWritable,
			})),
			data: instruction.data,
		}],
	};
}

describe('Solana transaction V1 inspector', () => {
	it('reports exact wire metrics for a signed legacy transaction', () => {
		const wire = signedLegacyTransfer();
		const inspected = inspectWireTransaction(wire);

		expect(inspected.version).toBe('legacy');
		expect(inspected.limitBytes).toBe(LEGACY_TRANSACTION_LIMIT);
		expect(inspected.bytes).toBe(Buffer.from(wire, 'base64').length);
		expect(inspected.headroomBytes).toBe(LEGACY_TRANSACTION_LIMIT - inspected.bytes);
		expect(inspected.instructionCount).toBe(1);
		expect(inspected.signatureCount).toBe(1);
		expect(inspected.sponsor.verdict).toBe('legacy-rules');
	});

	it('publishes the protocol limits used for legacy and V1 envelopes', () => {
		expect(LEGACY_TRANSACTION_LIMIT).toBe(1_232);
		expect(V1_TRANSACTION_LIMIT).toBe(4_096);
	});

	it('builds a partially signed V1 deploy with explicit resource caps', async () => {
		const owner = Keypair.generate();
		const asset = Keypair.generate();
		const instruction = SystemProgram.createAccount({
			fromPubkey: owner.publicKey,
			newAccountPubkey: asset.publicKey,
			lamports: 1,
			space: 0,
			programId: SystemProgram.programId,
		});
		const wire = await buildPartiallySignedV1Transaction({
			feePayer: owner.publicKey.toBase58(),
			lifetime: {
				blockhash: Keypair.generate().publicKey.toBase58(),
				lastValidBlockHeight: 123n,
			},
			instructions: [{
				programId: instruction.programId.toBase58(),
				keys: instruction.keys.map((key) => ({
					pubkey: key.pubkey.toBase58(),
					isSigner: key.isSigner,
					isWritable: key.isWritable,
				})),
				data: instruction.data,
			}],
			signers: [{
				publicKey: asset.publicKey.toBase58(),
				signMessage: async (message) => nacl.sign.detached(message, asset.secretKey),
			}],
		});

		expect(wire[0]).toBe(0x81);
		const inspected = inspectWireTransaction(Buffer.from(wire).toString('base64'));
		expect(inspected.version).toBe(1);
		expect(inspected.limitBytes).toBe(V1_TRANSACTION_LIMIT);
		expect(inspected.budget).toMatchObject({
			source: 'transaction-config',
			computeUnitLimit: AGENT_DEPLOY_V1_CONFIG.computeUnitLimit,
			loadedAccountsDataSizeLimit: AGENT_DEPLOY_V1_CONFIG.loadedAccountsDataSizeLimit,
			priorityFeeLamports: Number(AGENT_DEPLOY_V1_CONFIG.priorityFeeLamports),
		});
		expect(inspected.sponsor).toMatchObject({ verdict: 'caps-explicit', safeToCosign: true });
	});

	it('leaves a browser-held vanity key slot empty, then the client co-signs it', async () => {
		const owner = Keypair.generate();
		const vanity = Keypair.generate();
		const input = createAccountInput(owner, vanity);
		const echoSigner = {
			publicKey: vanity.publicKey.toBase58(),
			signMessage: async (message) => message,
		};

		await expect(buildPartiallySignedV1Transaction({ ...input, signers: [echoSigner] }))
			.rejects.toThrow(/64-byte ed25519 signature/);

		const wire = await buildPartiallySignedV1Transaction({
			...input,
			signers: [echoSigner],
			clientSigners: [vanity.publicKey.toBase58()],
		});
		const vanityAddress = vanity.publicKey.toBase58();
		expect(getTransactionDecoder().decode(wire).signatures[vanityAddress]).toBeNull();

		const cosigned = await cosignV1Transaction(wire, vanity.secretKey);
		expect(cosigned[0]).toBe(0x81);
		const decoded = getTransactionDecoder().decode(cosigned);
		const signature = decoded.signatures[vanityAddress];
		expect(nacl.sign.detached.verify(decoded.messageBytes, signature, vanity.publicKey.toBytes())).toBe(true);
		expect(decoded.signatures[owner.publicKey.toBase58()]).toBeNull();

		await expect(cosignV1Transaction(wire, Keypair.generate().secretKey)).rejects.toThrow();
	});

	it('rejects malformed wire input without contacting an RPC', () => {
		expect(() => inspectWireTransaction('not base64!')).toThrow(/base64-encoded/);
		expect(() => inspectWireTransaction(Buffer.from('not a transaction').toString('base64'))).toThrow(/valid signed/);
	});

	it('decodes an active feature-account slot and rejects inactive data', () => {
		const data = new Uint8Array(9);
		data[0] = 1;
		new DataView(data.buffer).setBigUint64(1, 123_456n, true);
		expect(decodeFeatureActivationSlot(data)).toBe(123_456);
		expect(decodeFeatureActivationSlot(new Uint8Array(9))).toBeNull();
		expect(decodeFeatureActivationSlot(new Uint8Array(8))).toBeNull();
	});
});
