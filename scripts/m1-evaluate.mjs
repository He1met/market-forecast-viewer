import { createDisplayReader } from './m1-display.mjs';
import { createOutcomeStore } from './m1-outcome-store.mjs';

// Deliberate local execution only. Page reloads use readLatest and never invoke this command.
const [command, id, captureId] = process.argv.slice(2);
try {
  if (!['capture', 'evaluate', 'run', 'read'].includes(command) || !id) throw Error('USAGE: capture|evaluate|run|read RUN_ID [CAPTURE_ID]');
  const run = await createDisplayReader().readRun(id, { includeEvaluation: false });
  const store = createOutcomeStore();
  let result;
  if (command === 'read') result = await store.readLatest(run);
  else if (command === 'evaluate') result = await store.evaluateCapture(run, captureId);
  else {
    result = await store.capture(run);
    if (result.status === 'failed') throw Error(`OUTCOME_CAPTURE_FAILED: ${result.capture_id}; raw evidence retained LOCAL_ONLY`);
    if (command === 'run') result = await store.evaluateCapture(run, result.capture_id);
  }
  if (result.status === 'failed') process.exitCode = 1;
  // No prices, raw files or full model text in the command summary.
  console.log(JSON.stringify({ status: result.status, reason: result.reason, capture_id: result.capture_id, revision_id: result.revision_id,
    evaluation_sha256: result.evaluation_sha256, forecast_id: id, evaluated_at: result.result?.evaluated_at,
    windows: result.result && Object.fromEntries(Object.entries(result.result.windows).map(([k, w]) => [k, {
      status: w.status, observed_count: w.observed_count, expected_count: w.expected_count, brier_score: w.brier_score }])) }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
