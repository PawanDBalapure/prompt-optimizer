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
        // Run optimization request through the engine
        const response = await this.engine.processRequest({
          raw_prompt: `${test.input}\nExpected criteria: ${test.expected}`,
          target_model: variant.target_model,
        });

        const compiled = response.optimized_prompt;
        
        // Empirically score the compiled prompt for this variant
        const evalScore = this.scoreQuality(compiled, test, variant.target_model, response.diagnostics ?? []);
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
    targetModel: string,
    diagnostics: any[]
  ): { score: number; passed: boolean; reason: string } {
    let score = 100;
    const reasons: string[] = [];

    // 1. Deduct for diagnostic problems found during compilation
    if (diagnostics.length > 0) {
      const deduct = Math.min(30, diagnostics.length * 15);
      score -= deduct;
      reasons.push(`Lint warnings deducted ${deduct}pts`);
    }

    // 2. Validate model-specific format rules compliance
    if (targetModel === 'claude') {
      if (compiled.includes('<instructions>') && compiled.includes('</instructions>')) {
        score += 5; // bonus points
      } else {
        score -= 20;
        reasons.push('Missing Claude XML tags (-20pts)');
      }
    } else if (targetModel === 'gpt') {
      if (compiled.includes('# SYSTEM PRESET') || compiled.includes('# CORE OBJECTIVE')) {
        score += 5;
      } else {
        score -= 15;
        reasons.push('Missing GPT markdown headers (-15pts)');
      }
    } else if (targetModel === 'gemini') {
      if (compiled.includes('Core Goal:') || compiled.includes('[EXAMPLE]')) {
        score += 5;
      } else {
        score -= 15;
        reasons.push('Missing Gemini highlights (-15pts)');
      }
    } else if (targetModel === 'deepseek') {
      if (compiled.includes('Logical Constraints:') || compiled.includes('Persona:')) {
        score += 5;
      } else {
        score -= 15;
        reasons.push('Missing DeepSeek logical-constraint blocks (-15pts)');
      }
    } else if (targetModel === 'grok') {
      if (compiled.includes('Output Requirements:') || compiled.includes('Be brutally direct and concise.')) {
        score += 5;
      } else {
        score -= 15;
        reasons.push('Missing Grok direct-output requirements (-15pts)');
      }
    } else if (targetModel === 'local') {
      if (compiled.includes('[ROLE]') || compiled.includes('[RULES]')) {
        score += 5;
      } else {
        score -= 15;
        reasons.push('Missing local model tags (-15pts)');
      }
      // Ensure compactness for local models
      if (compiled.length > 1500) {
        score -= 15;
        reasons.push('Prompt is too verbose for small local reasoning window (-15pts)');
      }
    }

    // 3. Keyword/Assertion criteria validation
    const lowerCompiled = compiled.toLowerCase();
    const keywords = test.keywords ?? test.expected.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    let matchedKeywordsNum = 0;
    for (const kw of keywords) {
      if (lowerCompiled.includes(kw.toLowerCase())) {
        matchedKeywordsNum++;
      }
    }

    const keywordPercentage = keywords.length > 0 ? (matchedKeywordsNum / keywords.length) : 1;
    if (keywordPercentage < 1) {
      const deduct = Math.round((1 - keywordPercentage) * 30);
      score -= deduct;
      reasons.push(`Missed criteria keywords: checked ${matchedKeywordsNum}/${keywords.length} (-${deduct}pts)`);
    }

    score = Math.max(0, Math.min(100, score));
    const passed = score >= 75;

    return {
      score,
      passed,
      reason: reasons.length > 0 ? reasons.join(', ') : 'Exceeded all compliance standards',
    };
  }
}
