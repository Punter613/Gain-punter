/**
 * Diagnostic Stage Guard
 *
 * DIAG is hypothesis + test planning only. This deterministic boundary strips
 * invasive/repair actions from diagnosis output so prompt drift cannot turn
 * diagnosis into repair authorization before TEST -> VERIFY.
 */

const FORBIDDEN_ACTION_RE = /\b(?:replace|replacement|remove|disconnect|disassemble|teardown|tear\s*down|install|repair|rebuild|adjust|align|alignment|clean\s+and\s+(?:grease|lubricate)|re-?grease|grease\b|lubricate\b)\b/i;
const SAFE_ACTION_RE = /\b(?:inspect|inspection|check|test|verify|verification|measure|measurement|observe|observation|audit|confirm|reinspect|monitor|compare|listen|look|pry|torque\s+(?:check|audit|verification)|check\s+torque)\b/i;

function textOf(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return String(item || '');
  return item.description || item.name || item.test || item.step || item.action || JSON.stringify(item);
}

function isForbiddenDiagnosticAction(item) {
  const text = textOf(item).trim();
  if (!text) return false;
  return FORBIDDEN_ACTION_RE.test(text);
}

function sanitizeArray(items, removed, key) {
  if (!Array.isArray(items)) return [];
  const kept = [];
  for (const item of items) {
    const text = textOf(item);
    if (isForbiddenDiagnosticAction(item)) {
      removed.push({ key, text });
      continue;
    }
    kept.push(item);
  }
  return kept;
}

function applyDiagnosticStageGuard(result) {
  if (!result || typeof result !== 'object') return { output: result, removed: [], changed: false };

  const output = { ...result };
  const removed = [];

  // repairSteps may exist for legacy UI compatibility, but at DIAG stage they
  // may contain inspection/measurement steps only.
  output.repairSteps = sanitizeArray(output.repairSteps, removed, 'repairSteps');
  output.recommendedTests = sanitizeArray(output.recommendedTests, removed, 'recommendedTests');
  output.additionalChecks = sanitizeArray(output.additionalChecks, removed, 'additionalChecks');
  output.proTips = sanitizeArray(output.proTips, removed, 'proTips');

  if (removed.length) {
    output.diagnosticStageGuard = {
      enforced: true,
      removedCount: removed.length,
      reason: 'Repair/invasive actions are blocked until TEST -> VERIFY.'
    };
    output.notes = `${output.notes || ''} Diagnostic stage guard removed ${removed.length} repair/invasive action${removed.length === 1 ? '' : 's'} pending verification.`.trim();
  }

  return { output, removed, changed: removed.length > 0 };
}

module.exports = {
  applyDiagnosticStageGuard,
  isForbiddenDiagnosticAction,
  FORBIDDEN_ACTION_RE,
  SAFE_ACTION_RE
};
