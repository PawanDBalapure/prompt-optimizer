import * as fs from 'node:fs';
import * as path from 'node:path';

import type { InstructionStudioPreset } from './instructionStudioPresets.js';

const STUDIO_DIR = '.instruction_studio';
const PERSONAS_FILE = 'personas.json';

export type InstructionStudioCustomPersona = Omit<InstructionStudioPreset, 'category'> & {
  category: 'Custom Persona';
};

function personasPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, STUDIO_DIR, PERSONAS_FILE);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'custom-persona';
}

function normalizePersona(input: Partial<InstructionStudioCustomPersona>): InstructionStudioCustomPersona {
  const label = (input.label ?? input.persona ?? 'Custom Persona').trim() || 'Custom Persona';
  const idRaw = (input.id ?? `custom-${slugify(label)}`).trim();
  const id = idRaw.startsWith('custom-') ? idRaw : `custom-${slugify(idRaw)}`;
  return {
    id,
    category: 'Custom Persona',
    label,
    workflowName: (input.workflowName ?? `${label} Workflow`).trim() || `${label} Workflow`,
    persona: (input.persona ?? label).trim() || label,
    condition: (input.condition ?? 'Always').trim() || 'Always',
    priority: (input.priority as any) ?? 'Medium',
    agentScope: (input.agentScope as any) ?? 'Code Generation',
    ruleText: (input.ruleText ?? 'Add a custom rule.').trim() || 'Add a custom rule.',
  };
}

function readRaw(workspaceRoot: string): InstructionStudioCustomPersona[] {
  const file = personasPath(workspaceRoot);
  if (!fs.existsSync(file)) { return []; }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(raw)) { return []; }
    return raw
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => normalizePersona(entry as Partial<InstructionStudioCustomPersona>));
  } catch {
    return [];
  }
}

function writeRaw(workspaceRoot: string, personas: InstructionStudioCustomPersona[]): void {
  const file = personasPath(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(personas, null, 2)}\n`, 'utf8');
}

export function listInstructionStudioCustomPersonas(workspaceRoot: string): InstructionStudioCustomPersona[] {
  return readRaw(workspaceRoot);
}

export function saveInstructionStudioCustomPersona(
  workspaceRoot: string,
  personaInput: Partial<InstructionStudioCustomPersona>,
): InstructionStudioCustomPersona {
  const persona = normalizePersona(personaInput);
  const current = readRaw(workspaceRoot);
  const next = current.filter((entry) => entry.id !== persona.id);
  next.push(persona);
  next.sort((a, b) => a.label.localeCompare(b.label));
  writeRaw(workspaceRoot, next);
  return persona;
}

export function deleteInstructionStudioCustomPersona(workspaceRoot: string, id: string): boolean {
  const current = readRaw(workspaceRoot);
  const next = current.filter((entry) => entry.id !== id);
  if (next.length === current.length) { return false; }
  writeRaw(workspaceRoot, next);
  return true;
}
