import { describe, expect, test } from "bun:test";
import {
  assistantChatRequestSchema,
  assistantGuideSchema,
  assistantPageContextSchema,
} from "./assistant.ts";
import {
  PLATFORM_CONFIG_REQUIRED,
  PLATFORM_CONFIG_SECRET_KEYS,
  parsePlatformConfigRequest,
  validatePlatformConfigValue,
} from "./platform-config.ts";

describe("assistant chat contract", () => {
  test("accepts a message with a page outline", () => {
    const parsed = assistantChatRequestSchema.parse({
      message: "Where do I deploy?",
      history: [{ role: "user", content: "hi" }],
      context: {
        path: "/projects/foo",
        title: "foo · Skiff · Skiff",
        project: "foo",
        targets: [
          {
            id: "project.deploy",
            label: "Deploy",
            kind: "button",
            selector: "button",
          },
        ],
      },
    });
    expect(parsed.context.targets[0]?.id).toBe("project.deploy");
    expect(parsed.history).toHaveLength(1);
  });

  test("rejects an empty message and an oversized outline", () => {
    expect(
      assistantChatRequestSchema.safeParse({
        message: "  ",
        context: { path: "/", targets: [] },
      }).success,
    ).toBe(false);
    const targets = Array.from({ length: 121 }, (_, index) => ({
      label: `target ${index}`,
      kind: "other" as const,
    }));
    expect(
      assistantPageContextSchema.safeParse({ path: "/", targets }).success,
    ).toBe(false);
  });

  test("a tour needs at least one step and at most eight", () => {
    expect(assistantGuideSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(
      assistantGuideSchema.safeParse({
        intro: "Here it is",
        steps: [
          { title: "Deploy", body: "Press Deploy.", target: "project.deploy" },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("assistant platform settings", () => {
  test("requires a base URL and model, and keeps the key secret", () => {
    expect(PLATFORM_CONFIG_REQUIRED.assistant).toEqual([
      "SKIFF_ASSISTANT_BASE_URL",
      "SKIFF_ASSISTANT_MODEL",
    ]);
    expect(PLATFORM_CONFIG_SECRET_KEYS.has("SKIFF_ASSISTANT_API_KEY")).toBe(
      true,
    );
  });

  test("validates the provider, URL, model and agent count", () => {
    expect(
      validatePlatformConfigValue(
        "SKIFF_ASSISTANT_BASE_URL",
        "http://127.0.0.1:11434/v1",
      ),
    ).toBe(null);
    expect(
      validatePlatformConfigValue(
        "SKIFF_ASSISTANT_BASE_URL",
        "https://api.openai.com/v1/",
      ),
    ).toBe("must not end with a slash");
    expect(
      validatePlatformConfigValue(
        "SKIFF_ASSISTANT_BASE_URL",
        "file:///etc/passwd",
      ),
    ).toContain("http(s)");
    expect(
      validatePlatformConfigValue("SKIFF_ASSISTANT_MODEL", "gpt-4.1-mini"),
    ).toBe(null);
    expect(
      validatePlatformConfigValue("SKIFF_ASSISTANT_MODEL", "bad model!"),
    ).toContain("model id");
    expect(validatePlatformConfigValue("SKIFF_ASSISTANT_MAX_AGENTS", "4")).toBe(
      null,
    );
    expect(
      validatePlatformConfigValue("SKIFF_ASSISTANT_MAX_AGENTS", "9"),
    ).toContain("1 to 4");
  });

  test("a configure request cannot write a key outside the section", () => {
    const parsed = parsePlatformConfigRequest({
      id: "cfg_aaaaaaaa",
      requestedAt: new Date().toISOString(),
      by: "user_1",
      action: "configure",
      section: "assistant",
      set: { SKIFF_SMTP_HOST: "smtp.example.com" },
      unset: [],
    });
    expect(parsed.ok).toBe(false);
  });
});
