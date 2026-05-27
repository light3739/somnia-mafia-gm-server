import { describe, it, expect } from "vitest";
import { scrubText, SCRUB_VERSION_EXPORT } from "../../src/agents/scrubber.js";
import { SCRUB_VERSION } from "../../src/agents/trace.js";

describe("scrubText", () => {
  it("exposes the same SCRUB_VERSION as trace.ts", () => {
    expect(SCRUB_VERSION_EXPORT).toEqual(SCRUB_VERSION);
  });

  it("EMPTY_RESPONSE for empty / whitespace input", () => {
    for (const s of ["", "   ", "\n\t ", "    \n  "]) {
      const r = scrubText(s);
      expect(r.outcome).toEqual("EMPTY_RESPONSE");
      expect(r.sanitized).toBeNull();
      expect(r.matches).toEqual([]);
      expect(r.scrubVersion).toEqual(SCRUB_VERSION);
    }
  });

  it("BLOCKED_ROLE_LEAK on direct role claims", () => {
    const cases = [
      "I am the detective.",
      "as the mafia, I think we should kill Alice",
      "My role is doctor",
      "I am detective",
      "I'm a doctor", // colloquial — should still trigger
    ];
    for (const text of cases) {
      const r = scrubText(text);
      expect(r.outcome, `expected BLOCKED for ${JSON.stringify(text)}`).toEqual("BLOCKED_ROLE_LEAK");
      expect(r.matches.length).toBeGreaterThan(0);
      expect(r.sanitized).toBeNull();
    }
  });

  it("BLOCKED_ROLE_LEAK on role-action claims", () => {
    for (const text of [
      "I checked Alice last night",
      "I healed Bob last night",
      "I killed Charlie tonight",
    ]) {
      const r = scrubText(text);
      expect(r.outcome).toEqual("BLOCKED_ROLE_LEAK");
    }
  });

  it("BLOCKED_TEMPORAL_HALLUCINATION for first-day night references", () => {
    for (const text of [
      "Let's start by talking about what each of us saw last night.",
      "What happened overnight?",
      "I want to discuss night actions.",
      "Что вы видели прошлой ночью?",
    ]) {
      const r = scrubText(text, { firstDiscussionDay: true });
      expect(r.outcome, `expected first-day block for ${JSON.stringify(text)}`).toEqual(
        "BLOCKED_TEMPORAL_HALLUCINATION"
      );
      expect(r.sanitized).toBeNull();
      expect(r.matches.length).toBeGreaterThan(0);
    }
  });

  it("allows night-result discussion outside the first discussion day", () => {
    const text = "No one died last night, so I want pressure on Bob.";
    const r = scrubText(text, { firstDiscussionDay: false });
    expect(r.outcome).toEqual("ALLOWED");
    expect(r.sanitized).toEqual(text);
  });

  it("BLOCKED_UNSUPPORTED_ATTRIBUTION when the model invents focus for a silent player", () => {
    const text = "haiman, I want to know why you're so focused on Agent #2. Let's hear from you.";
    const r = scrubText(text, { unsupportedAttributionNames: ["haiman"] });
    expect(r.outcome).toEqual("BLOCKED_UNSUPPORTED_ATTRIBUTION");
    expect(r.sanitized).toBeNull();
    expect(r.matches[0]).toContain("haiman");
  });

  it("allows neutral questions to silent players", () => {
    const text = "haiman, what do you think about Agent #2?";
    const r = scrubText(text, { unsupportedAttributionNames: ["haiman"] });
    expect(r.outcome).toEqual("ALLOWED");
    expect(r.sanitized).toEqual(text);
  });

  it("ALLOWED on neutral statements (no false positives)", () => {
    const cases = [
      "Bob is acting suspicious today.",
      "I think Alice changed her vote too quickly.",
      "The detective story is a great genre.",
      "doctor of math",
      "mafia movies are fun to watch",
      "checked the time, almost noon",
    ];
    for (const text of cases) {
      const r = scrubText(text);
      expect(r.outcome, `expected ALLOWED for ${JSON.stringify(text)}`).toEqual("ALLOWED");
      expect(r.sanitized).toEqual(text);
    }
  });

  it("trims surrounding whitespace in ALLOWED output", () => {
    const r = scrubText("   hello   ");
    expect(r.outcome).toEqual("ALLOWED");
    expect(r.sanitized).toEqual("hello");
  });
});
