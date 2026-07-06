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
export { preservesMeaning, refineTextPreservingMeaning } from './engine/meaningGuard.js';
export type { SentenceRefiner } from './engine/meaningGuard.js';
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
export {
	compileInstructionStudioGraph,
	writeInstructionStudioSnapshot,
} from './engine/instructionStudio.js';
export type {
	InstructionStudioNodeType,
	InstructionStudioNode,
	InstructionStudioEdge,
	InstructionStudioGraph,
	CompiledInstructionEntry,
	InstructionStudioManifest,
	CompiledInstructionStudio,
	InstructionStudioWriteResult,
} from './engine/instructionStudio.js';
export { INSTRUCTION_STUDIO_PRESETS } from './engine/instructionStudioPresets.js';
export type { InstructionStudioPreset } from './engine/instructionStudioPresets.js';
export {
	listInstructionStudioCustomPersonas,
	saveInstructionStudioCustomPersona,
	deleteInstructionStudioCustomPersona,
} from './engine/instructionStudioPersonas.js';
export type { InstructionStudioCustomPersona } from './engine/instructionStudioPersonas.js';
export {
	appendInstructionStudioTraceEntry,
	listInstructionStudioTraceEntries,
	summarizeInstructionStudioTrace,
} from './engine/instructionStudioTrace.js';
export type {
	InstructionStudioTraceEntry,
	InstructionStudioTraceAnalytics,
} from './engine/instructionStudioTrace.js';
export { writeInstructionStudioTelemetryArtifacts } from './engine/instructionStudioTelemetry.js';
export type {
	InstructionStudioPersonaUsage,
	InstructionStudioRuleUsageRow,
	InstructionStudioLineageRow,
	InstructionStudioExecutionLogRow,
	InstructionStudioTelemetryArtifacts,
} from './engine/instructionStudioTelemetry.js';
export { detectInstructionStudioConflicts } from './engine/instructionStudioConflicts.js';
export type { InstructionStudioConflict } from './engine/instructionStudioConflicts.js';
export {
	loadInstructionStudioReplay,
	summarizeInstructionStudioInsights,
} from './engine/instructionStudioInsights.js';
export type {
	InstructionStudioInsights,
	InstructionStudioRuleMetric,
	InstructionStudioReplaySession,
	InstructionStudioReplayStep,
} from './engine/instructionStudioInsights.js';
export {
	RepositoryIntelligenceBuilder,
	buildRepositoryGraphSchema,
} from './engine/repositoryIntelligence.js';
export type {
	RepositoryGraphSchema,
	DiscoveryResult,
	IngestionStats,
	ImpactAnalysisRequest,
	ImpactAnalysisResult,
	GraphNode,
	GraphEdge,
} from './engine/repositoryIntelligence.js';
export { indexWorkspaceStatic } from './engine/workspaceIndexer.js';
export type { WorkspaceIndexStats } from './engine/workspaceIndexer.js';
