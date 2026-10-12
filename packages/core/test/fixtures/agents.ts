import type { SystemServices } from '../../src/wiring.ts';
import type { PermissionId } from '../../src/agents/permissions.ts';
import { registerTestResponder } from '../../src/ai/providers/test.ts';
import type { ChatRequest } from '../../src/ai/types.ts';

/** Creates, installs (with the given grants) and enables a small custom agent for tests. */
export async function installTestAgent(
  s: SystemServices,
  opts: { id: string; tools: string[]; permissions: PermissionId[]; grants?: PermissionId[]; grantScopes?: Partial<Record<PermissionId, { sources?: string[]; folders?: string[]; domains?: string[] }>>; outputSchema?: Record<string, unknown> },
): Promise<void> {
  await s.agents.saveDefinition({
    id: opts.id,
    name: `Тестовый агент ${opts.id}`,
    description: 'Агент для автоматических тестов.',
    instructions: 'Выполни задачу, используя инструменты, и верни итог.',
    tools: opts.tools,
    permissions: opts.permissions.map((p) => ({ permission: p, reason: 'для теста' })),
    taskType: 'extraction',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, additionalProperties: true },
    outputSchema: opts.outputSchema ?? { type: 'object', required: ['summary'], properties: { summary: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } } },
  });
  await s.agents.install({ id: opts.id, scope: 'system', grants: opts.grants ?? opts.permissions, ...(opts.grantScopes ? { grantScopes: opts.grantScopes } : {}) });
  await s.agents.setEnabled(opts.id, true);
}

/** Scripted model for one agent: each call returns the next envelope (the last one repeats). */
export function scriptAgent(agentName: string, steps: (string | ((req: ChatRequest) => string))[]): { off: () => void; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let i = 0;
  const off = registerTestResponder(
    (req) => (req.system ?? '').includes(`агента «${agentName}»`),
    (req) => {
      calls.push({ ...req, messages: req.messages.map((m) => ({ ...m })) }); // snapshot: the runtime keeps appending
      const step = steps[Math.min(i, steps.length - 1)]!;
      i++;
      return typeof step === 'function' ? step(req) : step;
    },
  );
  return { off, calls };
}

export const toolCall = (calls: { tool: string; args: unknown }[]) => JSON.stringify({ action: 'tool_calls', tool_calls: calls.map((c) => ({ tool: c.tool, arguments_json: JSON.stringify(c.args) })), result: null });
export const final = (result: unknown) => JSON.stringify({ action: 'final', tool_calls: [], result });
