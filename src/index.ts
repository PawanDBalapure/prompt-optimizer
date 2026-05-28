export { SemanticCacheManager, CacheQueryResult, CacheSearchResult } from './SemanticCacheManager.js';
export { PromptProxyEngine } from './PromptProxyEngine.js';
export { PromptEvalEngine, BenchmarkConfig, TestCase, BenchmarkReport, TestResult } from './PromptEvalEngine.js';
export { parseToPromptIR, lintPrompt, compilePromptIR, explainRewrite } from './PromptIRHelper.js';
export { RepoStackInfo, inferRepoStack } from './RepoAwareness.js';
export {
	IdeContextFile,
	IdeContextLog,
	ProcessPromptResponse,
	ProcessingMode,
	PromptIDEContext,
	PromptOptimizationRequest,
	PromptOptimizationResponse,
	PromptPricingConfig,
	PromptProxyEngineOptions,
} from './contracts.js';
export { LocalSemanticVectorizer } from './localSemanticVectorizer.js';
export { VSCodePromptProxyAdapter } from './adapters/VSCodePromptProxyAdapter.js';
export { IntelliJPromptProxyAdapter } from './adapters/IntelliJPromptProxyAdapter.js';
export { evaluateBestPractices, findingsToDiagnostics } from './engine/bestPractices.js';
export type { BestPracticeFinding } from './engine/bestPractices.js';
export {
	readWorkspaceMemory,
	formatMemorySections,
	persistMemorySnapshot,
	loadPersistedMemory,
} from './engine/workspaceMemory.js';
export type { WorkspaceMemoryEntry, WorkspaceMemorySnapshot } from './engine/workspaceMemory.js';
export { KnowledgeGraph } from './engine/knowledgeGraph.js';
export type { KgNode, KgNodeType, KgSuggestion } from './engine/knowledgeGraph.js';
export { CrossWorkspaceFederation } from './engine/crossWorkspace.js';
export type { PeerWorkspace, CrossWorkspaceMatch } from './engine/crossWorkspace.js';
