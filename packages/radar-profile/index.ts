import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const RADAR_DIR = join(homedir(), ".pi", "radar");
const PROFILE_PATH = join(RADAR_DIR, "profile.md");

const PROFILE_TEMPLATE = `# Radar Profile

## My stack
- (e.g. TypeScript, Python, Postgres, AWS)

## High interest
- (e.g. RAG, retrieval, embeddings)
- (e.g. agent frameworks, evals)

## Medium interest
- (e.g. multimodal, coding agents)

## Skip
- (e.g. image generation, robotics, crypto x AI)

## Hard mutes
- (e.g. "ChatGPT wrapper startup", "AGI predictions")

## Tone preferences
- Prefer technical depth over hype
- Skip vendor announcements unless there's a real artifact (code, paper, weights)
`;

function ensureProfile() {
  if (!existsSync(RADAR_DIR)) mkdirSync(RADAR_DIR, { recursive: true });
  if (!existsSync(PROFILE_PATH)) writeFileSync(PROFILE_PATH, PROFILE_TEMPLATE, "utf8");
}

export default function (pi: ExtensionAPI) {
  ensureProfile();

  pi.registerTool({
    name: "radar_profile",
    label: "Radar Profile",
    description: "Returns the user's radar profile markdown. Call this once when ranking items.",
    parameters: Type.Object({}),
    execute: async () => {
      const content = readFileSync(PROFILE_PATH, "utf8");
      return {
        content: [{ type: "text", text: content }],
        details: { path: PROFILE_PATH },
      };
    },
  });
}
