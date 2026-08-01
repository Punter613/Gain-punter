// feedback.memory.adapter.js
// In-memory storage adapter for feedback examples and quick feedback

class FeedbackMemoryAdapter {
  constructor() {
    // arrays hold plain objects; avoid Maps to satisfy requirement
    this.examples = []; // full training examples
    this.quickFeedback = []; // high-volume quick thumbs
    this.retrainedIds = new Set();
  }

  async save(example) {
    // Ensure metadata exists
    example.metadata = example.metadata || {};
    if (!example.metadata.feedbackVersion) example.metadata.feedbackVersion = 1;
    if (!example.id) example.id = `fb_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    example.storedAt = new Date().toISOString();
    this.examples.push(example);
    return example;
  }

  async saveQuick(quick) {
    const q = {
      id: quick.id || `q_${Date.now()}_${Math.random().toString(36).slice(2,9)}`,
      requestId: quick.requestId,
      provider: quick.provider || null,
      model: quick.model || null,
      verdict: quick.verdict, // 'up'|'down'|'neutral'
      timestamp: new Date().toISOString(),
      metadata: quick.metadata || {}
    };
    this.quickFeedback.push(q);
    return q;
  }

  async getExamples(limit = 100) {
    // Return sorted by weight desc, newest first for equal weights
    return this.examples
      .slice()
      .sort((a, b) => (b.weight || 0) - (a.weight || 0) || new Date(b.storedAt) - new Date(a.storedAt))
      .slice(0, limit);
  }

  async getMechanicStats(mechanicId) {
    // Aggregate simple stats from stored examples and quick feedback
    const byMechanic = this.examples.filter(e => e.mechanicId === mechanicId);
    const quickByMechanic = this.quickFeedback.filter(q => q.metadata?.mechanicId === mechanicId);

    const totalExamples = byMechanic.length;
    const correct = byMechanic.filter(e => e.labels?.diagnosis === 'correct').length;
    const wrong = byMechanic.filter(e => e.labels?.diagnosis === 'wrong').length;
    const partial = byMechanic.filter(e => e.labels?.diagnosis === 'partial').length;

    const quickDown = quickByMechanic.filter(q => q.verdict === 'down').length;
    const quickUp = quickByMechanic.filter(q => q.verdict === 'up').length;

    return {
      mechanicId,
      totalExamples,
      correct,
      wrong,
      partial,
      quick: { up: quickUp, down: quickDown },
      accuracy: totalExamples > 0 ? (correct / totalExamples) : null
    };
  }

  async getBlindspots() {
    // Blindspots = aggregated features where examples flagged ai_missed or hallucinated
    const blindspotMap = {};
    for (const ex of this.examples) {
      const tags = ex.labels?.issues || [];
      for (const t of tags) {
        if (t === 'ai_missed' || t === 'ai_hallucinated') {
          const key = ex.metadata?.vehicle?.vin || ex.metadata?.component || 'unknown';
          blindspotMap[key] = blindspotMap[key] || { key, count: 0, examples: [] };
          blindspotMap[key].count += 1;
          blindspotMap[key].examples.push({ id: ex.id, weight: ex.weight || 0 });
        }
      }
    }
    return Object.values(blindspotMap).sort((a,b)=>b.count-a.count);
  }

  async markRetrained(ids = []) {
    for (const id of ids) this.retrainedIds.add(id);
    return Array.from(this.retrainedIds);
  }
}

module.exports = FeedbackMemoryAdapter;
