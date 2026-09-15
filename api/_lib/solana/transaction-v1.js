import {
	COMPUTE_BUDGET_PROGRAM_ADDRESS,
	ComputeBudgetInstruction,
	getRequestHeapFrameInstructionDataDecoder,
	getSetComputeUnitLimitInstructionDataDecoder,
	getSetComputeUnitPriceInstructionDataDecoder,
	getSetLoadedAccountsDataSizeLimitInstructionDataDecoder,
	identifyComputeBudgetInstruction,
	MAX_COMPUTE_UNIT_LIMIT,
} from '@solana-program/compute-budget';
import {
	decompileTransactionMessage,
	getBase64Encoder,
	getCompiledTransactionMessageDecoder,
	getTransactionDecoder,
} from '@solana/kit';

export const TX_V1_FEATURE_ADDRESS = 'txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL';
export const LEGACY_TRANSACTION_LIMIT = 1_232;
export const V1_TRANSACTION_LIMIT = 4_096;
const DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION = 200_000;

function asSafeNumber(value) {
	if (value === undefined || value === null) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) ? n : String(value);
}

function defaultComputeUnitLimit(instructionCount) {
	return Math.min(DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION * instructionCount, MAX_COMPUTE_UNIT_LIMIT);
}

function budgetFromLegacyMessage(compiled) {
	const instructions = compiled.instructions || [];
	const budget = {};
	let priceMicroLamportsPerCu;

	for (const instruction of instructions) {
		const program = compiled.staticAccounts?.[instruction.programAddressIndex];
		if (program !== COMPUTE_BUDGET_PROGRAM_ADDRESS || !instruction.data) continue;

		switch (identifyComputeBudgetInstruction(instruction.data)) {
			case ComputeBudgetInstruction.RequestHeapFrame:
				budget.heapSize = getRequestHeapFrameInstructionDataDecoder().decode(instruction.data).bytes;
				break;
			case ComputeBudgetInstruction.SetComputeUnitLimit:
				budget.computeUnitLimit = getSetComputeUnitLimitInstructionDataDecoder().decode(instruction.data).units;
				break;
			case ComputeBudgetInstruction.SetComputeUnitPrice:
				priceMicroLamportsPerCu = getSetComputeUnitPriceInstructionDataDecoder().decode(instruction.data).microLamports;
				break;
			case ComputeBudgetInstruction.SetLoadedAccountsDataSizeLimit:
				budget.loadedAccountsDataSizeLimit =
					getSetLoadedAccountsDataSizeLimitInstructionDataDecoder().decode(instruction.data).accountDataSizeLimit;
				break;
			default:
				break;
		}
	}

	const implicitComputeLimit = defaultComputeUnitLimit(instructions.length);
	if (priceMicroLamportsPerCu !== undefined) {
		const computeLimit = BigInt(budget.computeUnitLimit ?? implicitComputeLimit);
		budget.priorityFeeLamports = (computeLimit * priceMicroLamportsPerCu + 999_999n) / 1_000_000n;
	}

	return {
		...budget,
		computeUnitLimit: budget.computeUnitLimit ?? implicitComputeLimit,
		source: 'compute-budget-instructions',
		explicit: {
			computeUnitLimit: budget.computeUnitLimit !== undefined,
			loadedAccountsDataSizeLimit: budget.loadedAccountsDataSizeLimit !== undefined,
			heapSize: budget.heapSize !== undefined,
			priorityFee: priceMicroLamportsPerCu !== undefined,
		},
	};
}

function budgetFromV1Message(compiled) {
	const config = decompileTransactionMessage(compiled).config || {};
	return {
		...config,
		source: 'transaction-config',
		explicit: {
			computeUnitLimit: config.computeUnitLimit !== undefined,
			loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit !== undefined,
			heapSize: config.heapSize !== undefined,
			priorityFee: config.priorityFeeLamports !== undefined,
		},
	};
}

function serializableBudget(budget) {
	return {
		source: budget.source,
		computeUnitLimit: asSafeNumber(budget.computeUnitLimit),
		loadedAccountsDataSizeLimit: asSafeNumber(budget.loadedAccountsDataSizeLimit),
		heapSize: asSafeNumber(budget.heapSize),
		priorityFeeLamports: asSafeNumber(budget.priorityFeeLamports),
		explicit: budget.explicit,
	};
}

function instructionCount(compiled) {
	return compiled.version === 1
		? compiled.numInstructions ?? compiled.instructionHeaders?.length ?? 0
		: compiled.instructions?.length ?? 0;
}

function sponsorAssessment(version, budget) {
	if (version !== 1) {
		return {
			verdict: 'legacy-rules',
			safeToCosign: null,
			notes: ['Resource limits are carried by Compute Budget program instructions.'],
		};
	}

	const notes = ['Read caps from transactionConfig. Compute Budget instruction scans do not bind V1 transactions.'];
	if (!budget.computeUnitLimit) notes.push('Compute unit limit is zero or missing, so this V1 transaction cannot execute.');
	if (!budget.loadedAccountsDataSizeLimit) {
		notes.push('Loaded accounts data size limit is zero or missing, so this V1 transaction cannot load account data.');
	}
	if (!budget.priorityFeeLamports) notes.push('No priority fee is set. The transaction is valid but may land slowly.');

	const safeToCosign = Boolean(budget.computeUnitLimit && budget.loadedAccountsDataSizeLimit);
	return { verdict: safeToCosign ? 'caps-explicit' : 'limits-missing', safeToCosign, notes };
}

/**
 * Decode a signed Solana wire transaction without contacting an RPC.
 * Returns one stable, JSON-safe shape for legacy, V0, and V1.
 */
export function inspectWireTransaction(base64Transaction) {
	const value = String(base64Transaction || '').trim();
	if (!value || value.length > 12_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
		throw new TypeError('transaction must be a base64-encoded signed Solana transaction');
	}

	let wire;
	let transaction;
	let compiled;
	try {
		wire = getBase64Encoder().encode(value);
		transaction = getTransactionDecoder().decode(wire);
		compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
	} catch {
		throw new TypeError('transaction is not a valid signed Solana wire transaction');
	}

	const version = compiled.version;
	if (version !== 'legacy' && version !== 0 && version !== 1) {
		throw new TypeError(`unsupported Solana transaction version: ${String(version)}`);
	}

	const limit = version === 1 ? V1_TRANSACTION_LIMIT : LEGACY_TRANSACTION_LIMIT;
	const rawBudget = version === 1 ? budgetFromV1Message(compiled) : budgetFromLegacyMessage(compiled);
	const budget = serializableBudget(rawBudget);
	const signatures = Object.keys(transaction.signatures || {});
	const bytes = wire.length;

	return {
		version,
		versionLabel: version === 'legacy' ? 'Legacy' : `V${version}`,
		wireDiscriminator: version === 1 ? '0x81' : null,
		bytes,
		limitBytes: limit,
		headroomBytes: limit - bytes,
		utilizationPct: Math.round((bytes / limit) * 1_000) / 10,
		largerThanLegacyLimit: bytes > LEGACY_TRANSACTION_LIMIT,
		signatureCount: signatures.length,
		requiredSignatureCount: compiled.header?.numSignerAccounts ?? signatures.length,
		feePayer: signatures[0] || compiled.staticAccounts?.[0] || null,
		staticAccountCount: compiled.numStaticAccounts ?? compiled.staticAccounts?.length ?? 0,
		instructionCount: instructionCount(compiled),
		budget,
		sponsor: sponsorAssessment(version, budget),
	};
}

/** Decode the 9-byte Solana feature account: Option<u64> activation slot. */
export function decodeFeatureActivationSlot(data) {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
	if (bytes.length < 9 || bytes[0] !== 1) return null;
	const slot = new DataView(bytes.buffer, bytes.byteOffset + 1, 8).getBigUint64(0, true);
	return asSafeNumber(slot);
}
