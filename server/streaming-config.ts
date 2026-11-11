/**
 * S3b (resilience plan Appendix A): runtime-infrastructure switch for SDK
 * partial/stream events (`includePartialMessages`). Default ON; kill-switch
 * via `AGENT_STREAMING_ENABLED=false`. Read by BOTH runtimes (local
 * ai-client.ts, docker agent-entry.ts) so host and container stay consistent
 * (the container env is forwarded by DockerRuntime).
 *
 * Not user/app/capability configurable — this is runtime infra (same class as
 * the A2UI gate), never part of a capability bundle. Applies to NEW runtimes
 * only (no-hot-reload convention).
 */
export function isStreamingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_STREAMING_ENABLED !== "false";
}
