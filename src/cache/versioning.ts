import type Database from 'better-sqlite3';
import { reportEngineError } from '../engine/logger.js';

export interface PromptVersionRow {
  version: number;
  raw_prompt: string;
  optimized_prompt: string;
  target_model: string;
  timestamp: number;
  performance_score: number;
  experiment_branch: string;
}

export function recordVersion(
  db: Database.Database,
  key: string,
  rawPrompt: string,
  optimizedPrompt: string,
  targetModel: string,
  branch: string,
  performanceScore: number,
): number {
  try {
    const getVer = db.prepare('SELECT MAX(version) as max_v FROM prompt_versions WHERE prompt_key = ?');
    const row = getVer.get(key) as { max_v: number | null } | undefined;
    const nextVer = (row?.max_v ?? 0) + 1;

    db.prepare(`
      INSERT INTO prompt_versions (prompt_key, version, raw_prompt, optimized_prompt, target_model, timestamp, performance_score, experiment_branch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(key, nextVer, rawPrompt, optimizedPrompt, targetModel, Date.now(), performanceScore, branch);
    return nextVer;
  } catch (error) {
    reportEngineError('versioning_record', error);
    return -1;
  }
}

export function getVersions(db: Database.Database, key: string): PromptVersionRow[] {
  try {
    return db.prepare(
      'SELECT version, raw_prompt, optimized_prompt, target_model, timestamp, performance_score, experiment_branch FROM prompt_versions WHERE prompt_key = ? ORDER BY version DESC',
    ).all(key) as PromptVersionRow[];
  } catch {
    return [];
  }
}

export function rollbackToVersion(
  db: Database.Database,
  key: string,
  versionNum: number,
): { raw_prompt: string; optimized_prompt: string } | null {
  try {
    return db.prepare(
      'SELECT raw_prompt, optimized_prompt FROM prompt_versions WHERE prompt_key = ? AND version = ?',
    ).get(key, versionNum) as { raw_prompt: string; optimized_prompt: string } | null;
  } catch {
    return null;
  }
}
