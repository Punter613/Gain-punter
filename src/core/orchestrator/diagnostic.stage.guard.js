/**
 * Diagnostic Stage Guard
 *
 * DIAG is hypothesis + test planning only. This deterministic boundary strips
 * invasive/repair actions from diagnosis output so prompt drift cannot turn
 * diagnosis into repair authorization before TEST -> VERIFY.
 */

const FORBIDDEN_ACTION_RE = /\b(?:replace|replacement|remove|disconnect|disassemble|teardown|tear\s*down|install|repair|rebuild|adjust|align|alignment|clean\s+and\s+(?:grease|lubricate)|re-?grease|greasing\b|lubricate\b|lubricating\b|(?:apply|add|pack|use)\s+(?:high[-\s]?temp(?:erature)?\s+|special\s+|spline\s+)?grease\b)\b/i;
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

function cleanFragment(fragment) {
  return String(fragment || '')
    .replace(/^\s*(?:and|then|or|but)\s+/i, '')
    .replace(/^\s*[,;:\-–—]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Preserve safe diagnostic clauses when the model mixes them with a repair
 * authorization in the same sentence. Example:
 *   "Check slip yoke for binding, greasing or replacing as needed."
 * becomes:
 *   "Check slip yoke for binding."
 *
 * If a forbidden action is inseparable from the diagnostic instruction, the
 * whole item is dropped rather than trying to rewrite mechanical meaning.
 */
function sanitizeText(text) {
  const original = String(text || '').trim();
  if (!original || !FORBIDDEN_ACTION_RE.test(original)) {
    return { text: original, changed: false, removed: false };
  }

  const fragments = original
    .split(/(?<=[.!?;])\s+|\s*;\s*|\s*,\s*(?=(?:and\s+|then\s+|or\s+)?(?:replace|replacement|remove|disconnect|disassemble|teardown|tear\s*down|install|repair|rebuild|adjust|align|alignment|clean|re-?grease|greasing|lubricate|lubricating|apply\s+grease|add\s+grease|pack\s+grease|use\s+grease)\b)/i)
    .map(cleanFragment)
    .filter(Boolean);

  const safe = fragments.filter(fragment => !FORBIDDEN_ACTION_RE.test(fragment));
  const safeDiagnostic = safe.filter(fragment => SAFE_ACTION_RE.test(fragment));
  const kept = safeDiagnostic.length ? safeDiagnostic : safe;

  if (!kept.length) return { text: '', changed: true, removed: true };

  let sanitized = kept.join(' ').replace(/\s+/g, ' ').trim();
  if (sanitized && !/[.!?]$/.test(sanitized)) sanitized += '.';

  // Never return a rewritten string that still contains a forbidden action.
  if (!sanitized || FORBIDDEN_ACTION_RE.test(sanitized)) {
    return { text: '', changed: true, removed: true };
  }

  return { text: sanitized, changed: sanitized !== original, removed: false };
}

function withText(item, sanitizedText) {
  if (typeof item === 'string') return sanitizedText;
  if (!item || typeof item !== 'object') return sanitizedText;
  if (Object.prototype.hasOwnProperty.call(item, 'description')) return { ...item, description: sanitizedText };
  if (Object.prototype.hasOwnProperty.call(item, 'name')) return { ...item, name: sanitizedText };
  if (Object.prototype.hasOwnProperty.call(item, 'test')) return { ...item, test: sanitizedText };
  if (Object.prototype.hasOwnProperty.call(item, 'step')) return { ...item, step: sanitizedText };
  if (Object.prototype.hasOwnProperty.call(item, 'action')) return { ...item, action: sanitizedText };
  return sanitizedText;
}

function sanitizeArray(items, removed, rewritten, key) {
  if (!Array.isArray(items)) return [];
  const kept = [];
  for (const item of items) {
    const original = textOf(item).trim();
    if (!original) continue;

    const result = sanitizeText(original);
    if (result.removed) {
      removed.push({ key, text: original });
      continue;
    }
    if (result.changed) {
      rewritten.push({ key, before: original, after: result.text });
      kept.push(withText(item, result.text));
      continue;
    }
    kept.push(item);
  }
  return kept;
}

function applyDiagnosticStageGuard(result) {
  if (!result || typeof result !== 'object') return { output: result, removed: [], rewritten: [], changed: false };

  const output = { ...result };
  const removed = [];
  const rewritten = [];

  // repairSteps remains for legacy UI compatibility, but at DIAG stage it may
  // contain inspection/measurement/verification steps only.
  output.repairSteps = sanitizeArray(output.repairSteps, removed, rewritten, 'repairSteps');
  output.recommendedTests = sanitizeArray(output.recommendedTests, removed, rewritten, 'recommendedTests');
  output.additionalChecks = sanitizeArray(output.additionalChecks, removed, rewritten, 'additionalChecks');
  output.proTips = sanitizeArray(output.proTips, removed, rewritten, 'proTips');

  if (removed.length || rewritten.length) {
    output.diagnosticStageGuard = {
      enforced: true,
      removedCount: removed.length,
      rewrittenCount: rewritten.length,
      reason: 'Repair/invasive actions are blocked until TEST -> VERIFY.'
    };
    const changes = removed.length + rewritten.length;
    output.notes = `${output.notes || ''} Diagnostic stage guard sanitized ${changes} repair/invasive action${changes === 1 ? '' : 's'} pending verification.`.trim();
  }

  return { output, removed, rewritten, changed: removed.length > 0 || rewritten.length > 0 };
}

module.exports = {
  applyDiagnosticStageGuard,
  isForbiddenDiagnosticAction,
  sanitizeText,
  FORBIDDEN_ACTION_RE,
  SAFE_ACTION_RE
};
