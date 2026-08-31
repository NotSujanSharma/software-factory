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
  codex: [
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", detail: "Most capable coding" },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", detail: "Long-horizon coding" },
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex", detail: "Agentic coding" },
    { id: "gpt-5-codex", label: "GPT-5 Codex", detail: "General coding" },
    { id: "codex-mini-latest", label: "Codex Mini", detail: "Fast and economical" },
  ],
} as const;
