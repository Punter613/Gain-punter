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
  ['engine mount', 'engine mounts', 'motor mount', 'motor mounts'],
  ['transmission mount', 'transmission mounts']
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\\n/g, ' ')
    .replace(/[^a-z0-9& -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCompletedWork(notices = []) {
  const text = normalize(Array.isArray(notices) ? notices.join(' ') : notices);
  if (!text) return [];

  return WORK_ALIASES
    .filter(aliases => aliases.some(alias => text.includes(alias)))
    .map(aliases => aliases[0]);
}

function itemMatchesCompletedWork(item, completedWork) {
  const text = normalize(
    typeof item === 'string'
      ? item
      : [item?.description, item?.name, item?.part, item?.component, item?.repair, item?.title]
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
    'parts', 'requiredRepairs', 'repairItems', 'actions'
  ];

  for (const key of arrayKeys) {
    if (!Array.isArray(data[key])) continue;
    const kept = [];

    for (const item of data[key]) {
      if (itemMatchesCompletedWork(item, completedWork)) {
        removed.push(typeof item === 'string' ? item : (item.description || item.name || item.part || item.component || item.repair || item.title || JSON.stringify(item)));
      } else {
        kept.push(item);
      }
    }

    data[key] = kept;
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
