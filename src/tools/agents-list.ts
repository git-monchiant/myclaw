/**
 * agents_list tool — แสดง AI providers ที่ configure ไว้
 */

import type { ToolDefinition } from "./types.js";

export const agentsListTool: ToolDefinition = {
  name: "agents_list",
  description:
    "List available AI providers and their configuration. Shows which provider is active, models configured, and available tools. " +
    "Use when the user asks about AI capabilities, which model is being used, or what tools are available.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
  execute: async () => {
    // Detect providers
    const providers: Array<{
      name: string;
      status: "active" | "available" | "not_configured";
      model: string;
    }> = [];

    const hasGemini = !!process.env.GEMINI_API_KEY?.trim();
    const hasOllama = !!process.env.OLLAMA_MODEL?.trim();
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY?.trim();

    // Active provider (same logic as ai.ts)
    const activeProvider = hasGemini ? "gemini" : hasOllama ? "ollama" : hasAnthropic ? "anthropic" : "none";

    providers.push({
      name: "gemini",
      status: hasGemini ? (activeProvider === "gemini" ? "active" : "available") : "not_configured",
      model: process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash",
    });

    providers.push({
      name: "ollama",
      status: hasOllama ? (activeProvider === "ollama" ? "active" : "available") : "not_configured",
      model: process.env.OLLAMA_MODEL?.trim() || "(not set)",
    });

    providers.push({
      name: "anthropic",
      status: hasAnthropic ? (activeProvider === "anthropic" ? "active" : "available") : "not_configured",
      model: "claude-sonnet-4",
    });

    // Search provider
    const searchProvider = process.env.WEB_SEARCH_PROVIDER?.trim()
      || (process.env.BRAVE_API_KEY?.trim() ? "brave" : undefined)
      || (process.env.PERPLEXITY_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim() ? "perplexity" : undefined)
      || (process.env.XAI_API_KEY?.trim() ? "grok" : undefined)
      || (hasGemini ? "gemini" : "none");

    // TTS
    const ttsModel = process.env.GEMINI_TTS_MODEL?.trim() || "gemini-2.5-flash-preview-tts";
    const hasTts = hasGemini;

    // Available tools
    const tools = [
      "datetime", "web_search", "web_fetch", "memory_search", "memory_get",
      "image", "tts", "message", "session_status", "sessions_list",
      "sessions_history", "agents_list",
    ];

    return JSON.stringify({
      activeProvider,
      providers,
      searchProvider,
      tts: { available: hasTts, model: ttsModel },
      tools,
      toolCount: tools.length,
    });
  },
};
