export async function dispatchScheduledCandidates(candidates, callbacks) {
  let claimed = 0;
  let completed = 0;
  let failures = 0;
  let superseded = 0;
  for (const candidate of candidates) {
    const acquisition = await callbacks.claim(candidate);
    if (!acquisition) continue;
    claimed += 1;
    try {
      await callbacks.execute(acquisition.candidate);
    } catch (cause) {
      const outcome = await callbacks.fail(acquisition.candidate, acquisition.claim, cause);
      if (outcome === "superseded") superseded += 1;
      else failures += 1;
      continue;
    }
    const outcome = await callbacks.succeed(acquisition.candidate, acquisition.claim);
    if (outcome === "superseded") superseded += 1;
    else completed += 1;
  }
  return { claimed, completed, failures, superseded };
}
