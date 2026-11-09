import type { ToolBatch } from "@rakazo/adapter-kit";
import type { ConnectorBatchActionNames } from "@rakazo/core";

export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

// These provider tools run code that can invoke any action.
export function isComposioCodeTool(toolName: string): boolean {
  const name = toolName.toUpperCase();
  return name === "COMPOSIO_REMOTE_WORKBENCH" || name === "COMPOSIO_REMOTE_BASH_TOOL";
}

export function normalizedBatchActionName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const COMPOSIO_BATCH: ToolBatch = { items: "tools", action: "tool_slug" };

export function composioToolBatch(toolName: string): ToolBatch | undefined {
  return toolName.toUpperCase() === COMPOSIO_MULTI_EXECUTE_TOOL ? COMPOSIO_BATCH : undefined;
}

/** Names are taken from the batch wire shape, preserving their display and redaction spelling. */
export function connectorBatchActionNames(
  toolName: string,
  args: unknown,
  shape = composioToolBatch(toolName),
): ConnectorBatchActionNames | undefined {
  if (!shape) return undefined;
  const items = (args as Record<string, unknown> | null)?.[shape.items];
  if (!Array.isArray(items)) return { actions: [], complete: false };
  const actions = new Set<string>();
  let complete = items.length > 0;
  for (const item of items) {
    const slug = (item as Record<string, unknown> | null)?.[shape.action];
    const action = normalizedBatchActionName(slug);
    const key = action.toUpperCase();
    if (!/^[A-Za-z0-9_-]+$/.test(action) || key === toolName.toUpperCase()) {
      complete = false;
      continue;
    }
    actions.add(action);
  }
  return { actions: [...actions], complete };
}
