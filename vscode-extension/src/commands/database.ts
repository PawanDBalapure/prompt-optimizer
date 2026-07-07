import * as path from 'node:path';
import * as vscode from 'vscode';

import { runEngineRaw } from '../engine/runner';
import { getDbPath } from '../state/config';

/** Register cache / database administration commands (engine CLI wrappers). */
export function registerDatabaseCommands(context: vscode.ExtensionContext): void {
  const push = (d: vscode.Disposable) => context.subscriptions.push(d);
  const showError = (label: string, err: unknown): void => {
    vscode.window.showErrorMessage(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  };

  push(vscode.commands.registerCommand('prompt-proxy.cacheStats', async () => {
    try {
      const raw = runEngineRaw(['--cache-stats', '--db', getDbPath(context)]);
      const stats = JSON.parse(raw) as { total_entries?: number; avg_confidence?: number; total_hits?: number };
      vscode.window.showInformationMessage(
        `Cache: ${stats.total_entries ?? 0} entries | avg confidence ${((stats.avg_confidence ?? 0) * 100).toFixed(1)}% | ${stats.total_hits ?? 0} total hits`,
      );
    } catch (err) { showError('Cache stats', err); }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.clearCache', async () => {
    const confirm = await vscode.window.showWarningMessage(
      'Clear the Prompt Optimizer semantic cache? This cannot be undone.',
      { modal: true },
      'Clear',
    );
    if (confirm !== 'Clear') { return; }
    try {
      runEngineRaw(['--clear-cache', '--db', getDbPath(context)]);
      vscode.window.showInformationMessage('Prompt Optimizer cache cleared.');
    } catch (err) { showError('Cache clear', err); }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.healthCheck', async () => {
    try {
      const raw = runEngineRaw(['--health-check', '--db', getDbPath(context)]);
      const report = JSON.parse(raw) as { ok: boolean };
      const status = report.ok ? '$(pass) Healthy' : '$(error) Issues detected';
      const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content: `// Prompt Optimizer health report\n// ${status}\n${JSON.stringify(report, null, 2)}\n`,
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) { showError('Health check', err); }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.showMetrics', async () => {
    try {
      const raw = runEngineRaw(['--metrics', '--db', getDbPath(context)]);
      const rows = JSON.parse(raw) as Array<{ metric: string; count: number; last_at: number }>;
      if (rows.length === 0) {
        vscode.window.showInformationMessage('No metrics recorded yet. Optimize a prompt to populate counters.');
        return;
      }
      const lines = rows
        .sort((a, b) => b.count - a.count)
        .map((r) => `${r.metric.padEnd(36)} ${String(r.count).padStart(8)}  (last: ${new Date(r.last_at).toISOString()})`);
      const doc = await vscode.workspace.openTextDocument({
        language: 'plaintext',
        content: `Prompt Optimizer metrics\n${'='.repeat(72)}\n${lines.join('\n')}\n`,
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) { showError('Show metrics', err); }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.runMaintenance', async () => {
    const confirm = await vscode.window.showWarningMessage(
      'Run retention/eviction maintenance on the prompt-optimizer database?',
      { modal: true, detail: 'Default caps: 10k cache rows, 5k digests/workspace, 20k KG nodes/workspace. Stale entries older than 90 days (cache) / 180 days (digests) are pruned.' },
      'Run',
      'Run + VACUUM',
    );
    if (!confirm) { return; }
    try {
      const args = ['--db-prune', '--db', getDbPath(context)];
      if (confirm === 'Run + VACUUM') { args.push('--vacuum'); }
      const raw = runEngineRaw(args);
      const report = JSON.parse(raw) as {
        evicted: Record<string, number>;
        vacuumed: boolean;
        duration_ms: number;
      };
      const total = Object.values(report.evicted).reduce((a, b) => a + b, 0);
      vscode.window.showInformationMessage(
        `Maintenance complete: ${total} entries evicted in ${report.duration_ms}ms${report.vacuumed ? ' (VACUUM run)' : ''}.`,
      );
    } catch (err) { showError('Maintenance', err); }
  }));

  push(vscode.commands.registerCommand('prompt-proxy.exportDatabase', async () => {
    const defaultName = `prompt-optimizer-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    const target = await vscode.window.showSaveDialog({
      title: 'Export prompt-optimizer database',
      defaultUri: vscode.Uri.file(path.join(process.env.USERPROFILE || process.env.HOME || '.', defaultName)),
      filters: { 'SQLite database': ['db', 'sqlite'] },
    });
    if (!target) { return; }
    try {
      const raw = runEngineRaw(['--export-db', target.fsPath, '--db', getDbPath(context)]);
      const report = JSON.parse(raw) as { ok: boolean; bytes: number; duration_ms: number; error?: string };
      if (report.ok) {
        const open = await vscode.window.showInformationMessage(
          `Database exported (${report.bytes} bytes, ${report.duration_ms}ms).`,
          'Reveal in Explorer',
        );
        if (open) { await vscode.commands.executeCommand('revealFileInOS', target); }
      } else {
        vscode.window.showErrorMessage(`Export failed: ${report.error}`);
      }
    } catch (err) { showError('Export', err); }
  }));
}
