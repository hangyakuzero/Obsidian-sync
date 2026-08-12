import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hashing/hash";

describe("sha256Hex", () => {
  it("hashes bytes to hex", async () => {
    const bytes = new TextEncoder().encode("hello");
    expect(await sha256Hex(bytes)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("is consistent across calls", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(bytes));
  });
});