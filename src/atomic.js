const $ = (id) => document.getElementById(id);
const state = { mode: 'signature', lastInspection: null };

function formatNumber(value) {
	return value == null ? 'Not set' : Number(value).toLocaleString('en-US');
}

function show(name) {
	for (const key of ['loading', 'error', 'report', 'empty']) $(`at-${key}`).hidden = key !== name;
}

function setMode(mode) {
	state.mode = mode;
	for (const tab of document.querySelectorAll('[data-mode]')) {
		tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
	}
	const wire = mode === 'wire';
	$('at-input-label').textContent = wire ? 'Signed or partially signed transaction bytes' : 'Solana mainnet transaction signature';
	$('at-input').placeholder = wire ? 'Paste a base64-encoded wire transaction' : 'Paste a transaction signature';
	$('at-input').rows = wire ? 6 : 2;
	$('at-hint').textContent = wire
		? 'Decoded locally by the API. The transaction is not simulated, signed, or broadcast.'
		: 'Fetched through the three.ws rotating Solana RPC rail with V1 reads enabled.';
	$('at-submit').textContent = wire ? 'Inspect wire bytes' : 'Inspect transaction';
	$('at-input').focus();
}

async function responseJson(response) {
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.message || data.error || `Request failed with HTTP ${response.status}`);
	return data;
}

async function loadStatus() {
	try {
		const { status } = await fetch('/api/solana/atomic', { headers: { accept: 'application/json' } }).then(responseJson);
		$('at-live').classList.toggle('is-live', status.active);
		$('at-live').querySelector('strong').textContent = status.active ? 'V1 live on mainnet' : 'V1 gate not active';
		$('at-slot').textContent = `Slot ${formatNumber(status.currentSlot)}`;
	} catch {
		$('at-live').querySelector('strong').textContent = 'Mainnet status unavailable';
		$('at-slot').textContent = 'Inspector still available';
	}
}

function budgetValue(value, suffix, isExplicit) {
	if (value == null) return '<not set>';
	return `${formatNumber(value)} ${suffix}${isExplicit ? '' : ' · implicit'}`;
}

function render(inspection) {
	state.lastInspection = inspection;
	$('at-version').textContent = inspection.versionLabel;
	$('at-bytes').textContent = formatNumber(inspection.bytes);
	$('at-headroom').textContent = `${formatNumber(inspection.headroomBytes)} bytes free`;
	$('at-size-fill').style.width = `${Math.min(100, inspection.utilizationPct)}%`;
	$('at-legacy-mark').style.left = `${(1232 / inspection.limitBytes) * 100}%`;
	$('at-legacy-mark').hidden = inspection.limitBytes <= 1232;
	$('at-size-note').textContent = inspection.largerThanLegacyLimit
		? `This payload is ${formatNumber(inspection.bytes - 1232)} bytes beyond the old transaction wall. V1 makes it a single atomic landing.`
		: `${inspection.utilizationPct}% of the ${formatNumber(inspection.limitBytes)}-byte ${inspection.versionLabel} envelope is in use.`;
	$('at-signatures').textContent = `${inspection.signatureCount} / ${inspection.requiredSignatureCount} required`;
	$('at-accounts').textContent = formatNumber(inspection.staticAccountCount);
	$('at-instructions').textContent = formatNumber(inspection.instructionCount);

	const confirmed = inspection.confirmation;
	$('at-compute-used').textContent = confirmed?.computeUnitsConsumed == null
		? 'Not on-chain'
		: `${formatNumber(confirmed.computeUnitsConsumed)}${confirmed.computeUtilizationPct == null ? '' : ` · ${confirmed.computeUtilizationPct}%`}`;

	const budget = inspection.budget;
	$('at-config-source').textContent = budget.source === 'transaction-config' ? 'V1 config' : 'Compute Budget instructions';
	$('at-cu-limit').textContent = budgetValue(budget.computeUnitLimit, 'CU', budget.explicit.computeUnitLimit);
	$('at-data-limit').textContent = budgetValue(budget.loadedAccountsDataSizeLimit, 'bytes', budget.explicit.loadedAccountsDataSizeLimit);
	$('at-heap').textContent = budgetValue(budget.heapSize, 'bytes', budget.explicit.heapSize);
	$('at-priority').textContent = budgetValue(budget.priorityFeeLamports, 'lamports total', budget.explicit.priorityFee);

	const badge = $('at-verdict-badge');
	badge.className = 'at-verdict-badge';
	if (inspection.version === 1 && inspection.sponsor.safeToCosign) {
		badge.textContent = 'Caps explicit';
		badge.classList.add('is-safe');
		$('at-verdict-copy').textContent = 'The 0x81 envelope is V1 and both execution limits are explicit in transactionConfig.';
	} else if (inspection.version === 1) {
		badge.textContent = 'Limits missing';
		badge.classList.add('is-warn');
		$('at-verdict-copy').textContent = 'This is V1, but at least one required execution limit resolves to zero.';
	} else {
		badge.textContent = 'Legacy budget rules';
		$('at-verdict-copy').textContent = `${inspection.versionLabel} keeps the 1,232-byte ceiling and instruction-based compute budget.`;
	}

	$('at-notes').replaceChildren(...inspection.sponsor.notes.map((note) => {
		const item = document.createElement('li');
		item.textContent = note;
		return item;
	}));
	const explorer = $('at-explorer');
	explorer.hidden = !inspection.explorerUrl;
	if (inspection.explorerUrl) explorer.href = inspection.explorerUrl;
	$('at-share').hidden = !inspection.signature;
	show('report');
}

async function inspect() {
	const value = $('at-input').value.trim();
	if (!value) {
		$('at-error-message').textContent = state.mode === 'wire' ? 'Paste base64 wire bytes first.' : 'Paste a Solana transaction signature first.';
		show('error');
		return;
	}

	show('loading');
	$('at-submit').disabled = true;
	try {
		const request = state.mode === 'wire'
			? fetch('/api/solana/atomic', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ transaction: value }),
			})
			: fetch(`/api/solana/atomic?signature=${encodeURIComponent(value)}`, { headers: { accept: 'application/json' } });
		const { inspection } = await request.then(responseJson);
		render(inspection);
		if (state.mode === 'signature') {
			const url = new URL(location.href);
			url.searchParams.set('signature', value);
			history.replaceState(null, '', url);
		}
	} catch (err) {
		$('at-error-message').textContent = err.message;
		show('error');
	} finally {
		$('at-submit').disabled = false;
	}
}

for (const tab of document.querySelectorAll('[data-mode]')) tab.addEventListener('click', () => setMode(tab.dataset.mode));
$('at-form').addEventListener('submit', (event) => { event.preventDefault(); inspect(); });
$('at-retry').addEventListener('click', inspect);
$('at-share').addEventListener('click', async () => {
	await navigator.clipboard.writeText(location.href);
	const button = $('at-share');
	button.textContent = 'Link copied';
	setTimeout(() => { button.textContent = 'Copy inspection link'; }, 1_400);
});

loadStatus();
const initialSignature = new URLSearchParams(location.search).get('signature');
if (initialSignature) {
	$('at-input').value = initialSignature;
	inspect();
} else {
	show('empty');
}
