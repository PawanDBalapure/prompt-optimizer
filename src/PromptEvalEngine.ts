import { PromptProxyEngine } from './PromptProxyEngine.js';

export interface TestCase {
  name: string;
  input: string;
  expected: string;
  keywords?: string[];
}

export interface BenchmarkConfig {
  name: string;
  tests: TestCase[];
}

export interface TestResult {
  testName: string;
  input: string;
  expected: string;
  variantScores: Array<{
    variantName: string;
    compiledPrompt: string;
    score: number; // 0 to 100
    passed: boolean;
    reason: string;
  }>;
}

export interface BenchmarkReport {
  benchmarkName: string;
  timestamp: number;
  results: TestResult[];
  averageScoreCount: number;
}

export class PromptEvalEngine {
  constructor(private readonly engine: PromptProxyEngine) {}

  /**
   * Run evaluations on prompt variants with test datasets side-by-side and score them
   */
  public async runBenchmark(config: BenchmarkConfig): Promise<BenchmarkReport> {
    const results: TestResult[] = [];
    let totalScore = 0;
    let totalVariants = 0;

    const variants = [
      { name: 'Claude Optimal', target_model: 'claude' as const },
      { name: 'GPT Optimal', target_model: 'gpt' as const },
      { name: 'Gemini Optimal', target_model: 'gemini' as const },
      { name: 'DeepSeek Optimal', target_model: 'deepseek' as const },
      { name: 'Grok Optimal', target_model: 'grok' as const },
      { name: 'Local Standard', target_model: 'local' as const },
    ];

    for (const test of config.tests) {
      const variantScores: TestResult['variantScores'] = [];

      for (const variant of variants) {
        // Run optimization request through the engine. We score the lean
        // optimized output that the engine actually ships — no model-family
        // framing wrapper (that doubles tokens, defeating the optimizer).
        const response = await this.engine.processRequest({
          raw_prompt: `${test.input}\nExpected criteria: ${test.expected}`,
          target_model: variant.target_model,
        });

        const compiled = response.optimized_prompt;

        // Score the genuine optimizer value: token reduction + structure
        // preservation + intent fidelity (NOT cosmetic per-model markers).
        const evalScore = this.scoreQuality(compiled, test, response.metrics);
        totalScore += evalScore.score;
        totalVariants++;

        variantScores.push({
          variantName: variant.name,
          compiledPrompt: compiled,
          score: evalScore.score,
          passed: evalScore.passed,
          reason: evalScore.reason,
        });
      }

      results.push({
        testName: test.name,
        input: test.input,
        expected: test.expected,
        variantScores,
      });
    }

    return {
      benchmarkName: config.name,
      timestamp: Date.now(),
      results,
      averageScoreCount: totalVariants > 0 ? Number((totalScore / totalVariants).toFixed(1)) : 0,
    };
  }

  private scoreQuality(
    compiled: string,
    test: TestCase,
    metrics: { raw_input_tokens: number; optimized_input_tokens: number; tokens_saved: number },
  ): { score: number; passed: boolean; reason: string } {
    const reasons: string[] = [];
    const lower = compiled.toLowerCase();
    let score = 0;

    // (A) Token efficiency — 35 pts. This is the engine's core value: the
    // optimized prompt must not be larger than the raw input. Full marks when
    // it is the same size or smaller; partial credit otherwise.
    const raw = Math.max(1, metrics.raw_input_tokens);
    const opt = metrics.optimized_input_tokens;
    if (opt <= raw) {
      score += 35;
    } else {
      const overshoot = (opt - raw) / raw; // fraction larger than raw
      const credit = Math.max(0, 35 * (1 - Math.min(1, overshoot)));
      score += Math.round(credit);
      reasons.push(`Optimized prompt larger than raw (${opt} > ${raw} tokens)`);
    }

    // (B) Structured task line present — 20 pts. The lean YAML must name the
    // task deterministically.
    if (/(^|\n)task:/i.test(compiled)) {
      score += 20;
    } else {
      reasons.push('No structured task line (-20pts)');
    }

    // (C) Output discipline / constraints present — 25 pts.
    if (/(^|\n)constraints:/i.test(compiled) || /output:/i.test(compiled)) {
      score += 25;
    } else {
      reasons.push('No output-discipline constraints (-25pts)');
    }

    // (D) Intent fidelity — 20 pts (scaled). The optimized prompt must still
    // carry the key task terms so meaning is preserved.
    const keywords = test.keywords
      ?? test.expected.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    let matched = 0;
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) { matched++; }
    }
    const coverage = keywords.length > 0 ? matched / keywords.length : 1;
    score += Math.round(coverage * 20);
    if (coverage < 1) {
      reasons.push(`Intent keyword coverage ${matched}/${keywords.length}`);
    }

    score = Math.max(0, Math.min(100, score));
    const passed = score >= 75;

    return {
      score,
      passed,
      reason: reasons.length > 0 ? reasons.join(', ') : 'Token-efficient, structured, intent-preserving',
    };
  }
}
