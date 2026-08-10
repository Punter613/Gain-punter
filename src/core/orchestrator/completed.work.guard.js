/**
 * Deterministic Completed Work Guard
 *
 * Prevents the AI from turning technician history into a duplicate repair
 * recommendation. Prompt instructions are helpful, but they are not a
 * deterministic control boundary.
 */

const WORK_ALIASES = [
  ['cv axle', 'cv axles', 'cv joint', 'cv joints', 'constant velocity axle', 'constant velocity axles'],
  ['lower ball joint', 'lower ball joints'],
  ['upper ball joint', 'upper ball joints'],
  ['upper control arm', 'upper control arms'],
  ['lower control arm', 'lower control arms'],
  ['control arm bushing', 'control arm bushings'],
  ['intermediate shaft'],
  ['rack and pinion', 'rack & pinion', 'steering rack'],
  ['tie rod', 'tie rods', 'tie-rod'],
  ['wheel bearing', 'wheel bearings'],
  ['rear axle assembly', 'rear axle assemblies'],
  ['engine mount', 'engine mounts', 'motor mount', 'motor mounts'],
  ['transmission mount', 'transmission mounts']
];

const COMPLETION_RE = /\b(?:replaced|replace|installed|install|changed|change|swapped|swap|renewed|renew|repaired|repair)\b/i;
const NEGATED_COMPLETION_RE = /\b(?:(?:not|never)\s+(?:been\s+)?(?:replaced|replace|installed|install|changed|change|swapped|swap|renewed|renew|repaired|repair)|(?:did\s+not|didn't|was\s+not|wasn't|were\s+not|weren't|has\s+not|hasn't|have\s+not|haven't)\s+(?:been\s+)?(?:replaced|replace|installed|install|changed|change|swapped|swap|renewed|renew|repaired|repair))\b/i;
const FUTURE_WORK_RE = /\b(?:need(?:s)?\s+to|should|recommend(?:ed)?\s+to|plan(?:ned)?\s+to|will|must|requires?\s+to)\s+(?:replace|install|change|swap|renew|repair)\b/i;
const INSPECTION_ONLY_RE = /\b(?:inspect(?:ed|ing|ion)?|check(?:ed|ing)?|test(?:ed|ing)?|verify|verified|measur(?:e|ed|ing)|observ(?:e|ed|ing)|found|shows?|noted)\b/i;

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\\n/g, ' ')
    .replace(/[^a-z0-9& -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitNoticeClauses(notices = []) {
  const raw = Array.isArray(notices) ? notices.join('\n') : String(notices || '');
  return raw
    .split(/[.!?;\n]+/)
    .map(normalize)
    .filter(Boolean);
}

function findAliasMentions(clause) {
  const mentions = [];

  for (const aliases of WORK_ALIASES) {
    const canonical = aliases[0];
    for (const alias of aliases) {
      let from = 0;
      while (from < clause.length) {
        const index = clause.indexOf(alias, from);
        if (index === -1) break;
        mentions.push({ canonical, alias, index, end: index + alias.length });
        from = index + alias.length;
      }
    }
  }

  // Prefer the longest alias at the same position so "cv axles" does not
  // produce a second shorter mention for "cv axle".
  return mentions
    .sort((a, b) => a.index - b.index || b.alias.length - a.alias.length)
    .filter((mention, index, sorted) => {
      const previous = sorted[index - 1];
      return !(previous && previous.index === mention.index && previous.canonical === mention.canonical);
    });
}

function extractCompletedWork(notices = []) {
  const completed = new Set();

  for (const clause of splitNoticeClauses(notices)) {
    const mentions = findAliasMentions(clause);
    if (!mentions.length) continue;

    let activeCompletion = false;
    let cursor = 0;

    for (let i = 0; i < mentions.length; i++) {
      const mention = mentions[i];
      const next = mentions[i + 1];
      const before = clause.slice(cursor, mention.index);
      const after = clause.slice(mention.end, next ? next.index : clause.length);
      const local = `${before} ${mention.alias} ${after}`;

      if (NEGATED_COMPLETION_RE.test(before) || FUTURE_WORK_RE.test(before)) {
        activeCompletion = false;
      } else if (COMPLETION_RE.test(before)) {
        activeCompletion = true;
      } else if (INSPECTION_ONLY_RE.test(before)) {
        // "replaced CV axle and inspected upper ball joint" must not let the
        // earlier completion verb bleed into the inspected component.
        activeCompletion = false;
      }

      const explicitlyNotCompleted = NEGATED_COMPLETION_RE.test(local) || FUTURE_WORK_RE.test(local);
      const explicitlyCompletedAfter = !explicitlyNotCompleted && COMPLETION_RE.test(after);
      const inspectionOnlyAfter = INSPECTION_ONLY_RE.test(after) && !COMPLETION_RE.test(after);

      if (!explicitlyNotCompleted && (explicitlyCompletedAfter || (activeCompletion && !inspectionOnlyAfter))) {
        completed.add(mention.canonical);
      }

      // A direct completion after the component becomes the active context for
      // a following list; a negation/inspection resets it.
      if (explicitlyNotCompleted || inspectionOnlyAfter) activeCompletion = false;
      else if (explicitlyCompletedAfter) activeCompletion = true;

      cursor = mention.end;
    }
  }

  return [...completed];
}

function itemMatchesCompletedWork(item, completedWork) {
  const text = normalize(
    typeof item === 'string'
      ? item
      : [item?.description, item?.name, item?.part, item?.component, item?.repair, item?.title, item?.cause]
          .filter(Boolean)
          .join(' ')
  );

  return completedWork.some(work => {
    if (work === 'cv axle') return /\bcv\b.*\baxle|\bcv\b.*\bjoint|constant velocity/.test(text);
    if (work === 'lower ball joint') return text.includes('lower ball joint');
    if (work === 'upper ball joint') return text.includes('upper ball joint');
    if (work === 'upper control arm') return text.includes('upper control arm');
    if (work === 'lower control arm') return text.includes('lower control arm');
    if (work === 'control arm bushing') return text.includes('control arm bushing');
    return text.includes(work);
  });
}

function guardJson(data, completedWork) {
  if (!data || typeof data !== 'object') return { data, removed: [] };

  const removed = [];
  const arrayKeys = [
    'repairs', 'repairsNeeded', 'recommendedRepairs', 'recommendations',
    'parts', 'requiredRepairs', 'repairItems', 'actions',
    'secondaryCauses', 'knownIssues', 'repairSteps', 'proTips',
    'recommendedTests', 'additionalChecks', 'probability'
  ];

  for (const key of arrayKeys) {
    if (!Array.isArray(data[key])) continue;
    const kept = [];

    for (const item of data[key]) {
      if (itemMatchesCompletedWork(item, completedWork)) {
        removed.push(typeof item === 'string' ? item : (item.description || item.name || item.part || item.component || item.repair || item.title || item.cause || JSON.stringify(item)));
      } else {
        kept.push(item);
      }
    }

    data[key] = kept;
  }

  if (typeof data.primaryCause === 'string' && itemMatchesCompletedWork(data.primaryCause, completedWork)) {
    removed.push(data.primaryCause);
    data.primaryCause = 'AI proposed already-completed work as the primary cause — flagged for mechanic re-evaluation rather than shown as a confident diagnosis.';
    data.primaryCauseFlaggedForReview = true;
  }

  return { data, removed };
}

function guardText(text, completedWork) {
  const original = String(text || '');
  const removed = [];
  const patterns = completedWork.map(work => {
    if (work === 'cv axle') return /(?:replace|replacement|install|change)\b[^.\n]*(?:cv\s+(?:axle|axles|joint|joints)|constant velocity)[^.\n]*[.\n]?/gi;
    return new RegExp(`(?:replace|replacement|install|change)\\b[^.\\n]*\\b${work.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b[^.\\n]*[.\\n]?`, 'gi');
  });

  let guarded = original;
  for (const pattern of patterns) {
    guarded = guarded.replace(pattern, match => {
      removed.push(match.trim());
      return '';
    });
  }

  if (removed.length) {
    guarded = `${guarded.trim()}\n\nPreviously completed work excluded from new repair recommendations: ${completedWork.join(', ')}. Reinspect/rework only if evidence shows the prior repair failed or was incorrect.`.trim();
  }

  return { output: guarded, removed };
}

function applyCompletedWorkGuard(output, mechanicNotices = []) {
  const completedWork = extractCompletedWork(mechanicNotices);
  if (!completedWork.length) return { output, completedWork: [], removed: [], changed: false };

  let parsed = output;
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output);
    } catch (_) {
      const textResult = guardText(output, completedWork);
      return {
        output: textResult.output,
        completedWork,
        removed: textResult.removed,
        changed: textResult.removed.length > 0,
        needsReinspection: textResult.removed.length > 0,
        note: 'Completed-work history enforced on non-JSON specialist output.'
      };
    }
  }

  const result = guardJson(parsed, completedWork);
  if (result.removed.length) {
    result.data.completedWorkExcluded = completedWork;
    result.data.guardNotice = 'Previously completed work was removed from new repair recommendations. Reinspect only if evidence indicates failed or incorrect prior work.';
  }

  return {
    output: typeof output === 'string' ? JSON.stringify(result.data) : result.data,
    completedWork,
    removed: result.removed,
    changed: result.removed.length > 0,
    needsReinspection: result.removed.length > 0
  };
}

module.exports = {
  extractCompletedWork,
  applyCompletedWorkGuard
};