export type McpToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

// Generic MCP response wrapper — eliminates 30+ boilerplate try/catch blocks
export async function wrapTool<T>(
  fn: () => Promise<T>,
  stringifyFn: (obj: unknown) => string
): Promise<McpToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: stringifyFn(result) }] };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: stringifyFn({ error: error.message }) }],
      isError: true,
    };
  }
}
