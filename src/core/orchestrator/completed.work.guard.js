/**
 * Deterministic Completed Work Guard
 *
 * Prevents the AI from turning technician history into a duplicate repair
 * recommendation. This is intentionally deterministic: prompt instructions
 * are helpful, but they are not a safety/control boundary.
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

  if (Array.isArray(data.parts)) {
    data.parts = data.parts.filter(item => !itemMatchesCompletedWork(item, completedWork));
  }

  return { data, removed };
}

function applyCompletedWorkGuard(output, mechanicNotices = []) {
  const completedWork = extractCompletedWork(mechanicNotices);
  if (!completedWork.length) return { output, completedWork: [], removed: [], changed: false };

  let parsed = output;
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output);
    } catch (_) {
      return {
        output,
        completedWork,
        removed: [],
        changed: false,
        needsReinspection: false,
        note: 'Completed-work history detected; non-JSON specialist output left intact for evidence review.'
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
    changed: result.removed.length > 0
  };
}

module.exports = {
  extractCompletedWork,
  applyCompletedWorkGuard
};
