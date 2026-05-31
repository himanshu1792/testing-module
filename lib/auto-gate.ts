/**
 * Autonomous bounded-retry critic.
 *
 * This REPLACES the human approval loops from the source app
 * (`requestPromptApproval`, `requestPlanApproval`). Instead of blocking on a
 * person, an artifact is produced, checked by deterministic rules, and then
 * judged by an LLM critic. On any problem the feedback is folded back into the
 * next `produce(...)` call. The loop is strictly bounded and NEVER throws or
 * blocks — at scale the pipeline must always make forward progress and reach
 * PR creation; a human reviews the resulting PR afterward.
 */

export interface AutoGateResult<T> {
  value: T;
  approved: boolean;
  attempts: number;
}

export interface AutoGateOptions<T> {
  /** Produce a candidate. `feedback` is null on the first attempt, otherwise
   *  the accumulated deterministic problems or critic feedback to address. */
  produce: (feedback: string | null) => Promise<T>;
  /** Deterministic, synchronous checks. Returns a list of problems; `[]` = clean. */
  validate: (candidate: T) => string[];
  /** LLM-backed judgement. Only runs when `validate` is clean. */
  critique: (candidate: T) => Promise<{ approved: boolean; feedback: string }>;
  /** Maximum attempts before returning the last (best-effort) candidate. Default 3. */
  maxAttempts?: number;
  /** Optional progress logger. */
  log?: (msg: string) => void;
}

/**
 * Loop up to `maxAttempts`:
 *   1. produce(feedback)
 *   2. validate -> if problems and not the last attempt, set feedback and retry
 *   3. critique -> if approved, return { approved: true }; else set feedback and retry
 * On exhausting attempts, return the LAST candidate with approved: false.
 * NEVER throws, NEVER blocks.
 */
export async function runAutoGate<T>(opts: AutoGateOptions<T>): Promise<AutoGateResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const log = opts.log ?? (() => {});

  let feedback: string | null = null;
  let lastCandidate: T | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = await opts.produce(feedback);
    lastCandidate = candidate;
    const isLast = attempt === maxAttempts;

    // --- Deterministic checks ---
    const problems = opts.validate(candidate);
    if (problems.length > 0) {
      feedback = problems.join("; ");
      log(`auto-gate attempt ${attempt}/${maxAttempts}: validation found ${problems.length} problem(s): ${feedback}`);
      if (isLast) {
        log(`auto-gate exhausted ${maxAttempts} attempts with unresolved validation issues; returning best-effort candidate.`);
        return { value: candidate, approved: false, attempts: attempt };
      }
      continue;
    }

    // --- LLM critic (only on a deterministically clean candidate) ---
    let critique: { approved: boolean; feedback: string };
    try {
      critique = await opts.critique(candidate);
    } catch (err) {
      // A failing critic must not stall the pipeline. Accept the clean candidate.
      const msg = err instanceof Error ? err.message : String(err);
      log(`auto-gate attempt ${attempt}/${maxAttempts}: critic errored (${msg}); accepting deterministically-clean candidate.`);
      return { value: candidate, approved: false, attempts: attempt };
    }

    if (critique.approved) {
      log(`auto-gate approved on attempt ${attempt}/${maxAttempts}.`);
      return { value: candidate, approved: true, attempts: attempt };
    }

    feedback = critique.feedback || "The critic rejected the candidate without specifics; improve coverage and specificity.";
    log(`auto-gate attempt ${attempt}/${maxAttempts}: critic rejected: ${feedback}`);
    if (isLast) {
      log(`auto-gate exhausted ${maxAttempts} attempts; returning best-effort candidate.`);
      return { value: candidate, approved: false, attempts: attempt };
    }
  }

  // Unreachable in practice (loop always returns), but keeps the type checker happy.
  return { value: lastCandidate as T, approved: false, attempts: maxAttempts };
}
