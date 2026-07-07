import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as vscode from 'vscode';

import { runEngineRaw } from '../../engine/runner';
import { workspaceRoot } from '../../instructions/paths';

const AGENT_DIR = '.agent';

/** Post the recent compile-trace rows plus analytics. */
export async function postTraceRows(webview: vscode.Webview): Promise<void> {
  const wsRoot = workspaceRoot();
  if (!wsRoot) {
    await webview.postMessage({ type: 'traceRows', rows: [] });
    return;
  }
  try {
    const raw = runEngineRaw([
      '--instruction-studio-trace-list', '--workspace-root', wsRoot, '--limit', '20',
    ]);
    const payload = JSON.parse(raw) as { rows?: unknown[] };
    await webview.postMessage({ type: 'traceRows', rows: payload.rows ?? [] });
    await postTraceAnalytics(webview);
  } catch {
    await webview.postMessage({ type: 'traceRows', rows: [] });
    await webview.postMessage({ type: 'traceAnalytics', analytics: null });
  }
}

async function postTraceAnalytics(webview: vscode.Webview): Promise<void> {
  const wsRoot = workspaceRoot();
  if (!wsRoot) {
    await webview.postMessage({ type: 'traceAnalytics', analytics: null });
    return;
  }
  try {
    const raw = runEngineRaw(['--instruction-studio-trace-analytics', '--workspace-root', wsRoot]);
    const payload = JSON.parse(raw) as { analytics?: unknown };
    await webview.postMessage({ type: 'traceAnalytics', analytics: payload.analytics ?? null });
  } catch {
    await webview.postMessage({ type: 'traceAnalytics', analytics: null });
  }
}

/** Summarize the latest execution log + lineage into `.agent/trace-summary.md`. */
function writeTraceSummary(wsRoot: string): string {
  const summaryPath = path.join(wsRoot, AGENT_DIR, 'trace-summary.md');
  const execPath = path.join(wsRoot, AGENT_DIR, 'execution-log.json');
  const lineagePath = path.join(wsRoot, AGENT_DIR, 'lineage.json');
  const execution = fs.existsSync(execPath)
    ? (JSON.parse(fs.readFileSync(execPath, 'utf8')) as Array<Record<string, unknown>>)
    : [];
  const lineage = fs.existsSync(lineagePath)
    ? (JSON.parse(fs.readFileSync(lineagePath, 'utf8')) as Array<Record<string, unknown>>)
    : [];
  const last = execution[execution.length - 1] ?? {};
  const lines = lineage.slice(-5).map((row) =>
    `- ${(row.modifiedBy as string) || 'Persona'} -> ${(row.file as string) || 'file'} :: ${(row.rule as string) || ''}`);
  const body = [
    '# Instruction Studio Trace Summary',
    '',
    `Workflow: ${String(last.workflowName || 'n/a')}`,
    `Version: v${String(last.versionIndex || 'n/a')}`,
    `Timestamp: ${String(last.timestamp || 'n/a')}`,
    `Rules: ${String(last.activeRuleCount || 0)} active / ${String(last.inactiveRuleCount || 0)} disabled`,
    '',
    '## Recent lineage',
    ...(lines.length > 0 ? lines : ['- n/a']),
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, body, 'utf8');
  return summaryPath;
}

/** Stage trace artifacts in git according to the chosen mode (full|summary|exclude). */
export async function stageTrace(webview: vscode.Webview, traceMode?: string): Promise<void> {
  const wsRoot = workspaceRoot();
  if (!wsRoot) {
    await webview.postMessage({ type: 'gitTraceResult', ok: false, message: 'Open a workspace folder first.' });
    return;
  }
  const mode = String(traceMode || 'exclude').trim();
  try {
    if (mode === 'full') {
      const files = ['execution-log.json', 'lineage.json', 'rule-usage.json']
        .map((f) => path.join(AGENT_DIR, f));
      spawnSync('git', ['add', ...files], { cwd: wsRoot, encoding: 'utf8' });
      await webview.postMessage({ type: 'gitTraceResult', ok: true, message: 'Staged full trace artifacts.' });
      return;
    }
    if (mode === 'summary') {
      const summaryPath = writeTraceSummary(wsRoot);
      spawnSync('git', ['add', path.relative(wsRoot, summaryPath).replace(/\\/g, '/')], { cwd: wsRoot, encoding: 'utf8' });
      await webview.postMessage({ type: 'gitTraceResult', ok: true, message: 'Staged trace summary.' });
      return;
    }
    await webview.postMessage({ type: 'gitTraceResult', ok: true, message: 'Trace staging skipped (exclude).' });
  } catch (err) {
    await webview.postMessage({
      type: 'gitTraceResult',
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
