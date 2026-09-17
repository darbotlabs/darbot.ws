// POST /api/labor/settle: verify a delivered job and release escrow on-chain.
// Idempotent (job settle_key): a retry never double-pays. Callable by either
// participant (poster or worker owner) so a stuck-but-delivered job can always be
// resolved; the neutral verifier, not the caller, decides whether funds release.

import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { requireRealFundsAgreement } from '../_lib/real-funds-agreement.js';
import { authWrite, requireUuid } from '../_lib/labor-auth.js';
import { getJob, getJobByBounty, getBounty } from '../_lib/agent-labor.js';
import { runSettlement } from '../_lib/labor-settle.js';

// Which side of the job the caller owns: { poster, worker }.
async function ownedSides(userId, posterAgentId, workerAgentId) {
	const rows = await sql`
		SELECT id FROM agent_identities
		WHERE id IN (${posterAgentId}, ${workerAgentId}) AND user_id = ${userId} AND deleted_at IS NULL`;
	const ids = new Set(rows.map((r) => r.id));
	return { poster: ids.has(posterAgentId), worker: ids.has(workerAgentId) };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await authWrite(req, res);
	if (!auth) return;
	const { userId } = auth;

	const body = (await readJson(req)) || {};
	const { jobId, bountyId } = body;
	// Say "you sent nothing" rather than "the job does not exist": a caller that
	// omitted both ids used to get a 404 and go hunting for a missing job.
	if (!jobId && !bountyId) return error(res, 400, 'validation_error', 'jobId or bountyId is required');
	if (jobId && !requireUuid(res, jobId, 'jobId')) return;
	if (!jobId && !requireUuid(res, bountyId, 'bountyId')) return;

	const job = jobId ? await getJob(jobId) : await getJobByBounty(bountyId);
	if (!job) return error(res, 404, 'not_found', 'job not found');

	const sides = await ownedSides(userId, job.poster_agent_id, job.worker_agent_id);
	if (!sides.poster && !sides.worker) {
		return error(res, 403, 'forbidden', 'only the poster or worker owner can settle this job');
	}

	if (!['delivered', 'verifying'].includes(job.status)) {
		if (job.status === 'settled' || job.status === 'failed' || job.status === 'refunded') {
			return json(res, 200, { ok: true, idempotent: true, status: job.status, job_id: job.id });
		}
		return error(res, 409, 'not_deliverable', `job is ${job.status}; nothing to settle until it is delivered`);
	}

	// The poster releasing its own escrow is a real-funds action; a worker settling
	// to get paid is not.
	if (sides.poster && !sides.worker && !(await requireRealFundsAgreement(req, res, { userId, context: 'labor-settle' }))) return;

	const bounty = await getBounty(job.bounty_id);
	const result = await runSettlement({ job, bounty });
	return json(res, 200, { ok: true, job_id: job.id, settlement: result });
});
