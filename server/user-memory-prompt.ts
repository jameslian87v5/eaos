/**
 * user-memory-prompt.ts — the platform prompt that teaches the agent to use the
 * user MEMORY.md. Kept SEPARATE from capability allowlists (it is an ordinary
 * controlled document, not a capability). Rendered for both runtimes with the
 * runtime-appropriate EXACT path (host absolute path for local, /user-memory
 * for docker). The read/write instructions always reference that exact path,
 * never a bare relative filename.
 */
export function buildUserMemoryPrompt(memoryFilePath: string): string {
  return [
    "",
    "## User Memory",
    `This user has a persistent memory file at \`${memoryFilePath}\`.`,
    `- At the start of a new task, read \`${memoryFilePath}\` to recall durable, user-level context.`,
    "- Update it ONLY with durable, user-level facts worth remembering across chats (preferences, key decisions, long-running goals, agreed conventions).",
    "- Never store secrets, credentials, tokens, or sensitive personal data in it.",
    "- Keep it concise and current; prune or rewrite stale entries rather than appending forever.",
    `- You may only write to THIS user's memory file at \`${memoryFilePath}\`; never access or edit another user's memory or any CLAUDE.md.`,
  ].join("\n");
}
