/**
 * The tool catalogue, rendered for the prompt.
 *
 * A pure function of `CHAT_TOOLS`, and that is the whole point: nothing hand-writes a list of
 * tools into the prompt, so a tool the model is told about is by construction a tool the
 * dispatcher can resolve. Newsdesk renders the same way and for the same reason.
 */

import { CHAT_TOOLS, type ChatTool } from './registry.js';

export function renderCatalogue(tools: ChatTool[] = CHAT_TOOLS): string {
  return tools
    .map((tool) =>
      [
        `### ${tool.name}`,
        '',
        tool.description,
        '',
        'Arguments:',
        '```json',
        JSON.stringify(tool.inputSchema, null, 2),
        '```',
      ].join('\n'),
    )
    .join('\n\n');
}

export function catalogueNames(tools: ChatTool[] = CHAT_TOOLS): string[] {
  return tools.map((t) => t.name);
}
