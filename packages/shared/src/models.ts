/** Human-readable dashboard choices for provider-specific model IDs. */
export const AGENT_MODEL_CATALOG = {
  claude: [
    { id: "claude-opus-5", label: "Claude Opus 5", detail: "Highest capability" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", detail: "Strong balance" },
    { id: "claude-fable-5", label: "Claude Fable 5", detail: "Fast, economical" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", detail: "Previous flagship" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", detail: "Previous balance" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", detail: "Fastest Claude option" },
  ],
  // Slugs the Codex CLI actually accepts. The `*-codex` and `codex-mini-latest`
  // ids this list used to carry are API-era names that a ChatGPT-account login
  // rejects with a 400 - `codex exec` reports it as a failed turn, so every run
  // died before producing output. `codex exec --help` and the CLI's own
  // models cache are the source of truth if these need refreshing.
  codex: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", detail: "Frontier agentic coding" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", detail: "Balanced for everyday work" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", detail: "Fast and affordable" },
    { id: "gpt-5.5", label: "GPT-5.5", detail: "Complex coding and research" },
    { id: "gpt-5.4", label: "GPT-5.4", detail: "Strong everyday coding" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", detail: "Small, fast, cost-efficient" },
  ],
} as const;
