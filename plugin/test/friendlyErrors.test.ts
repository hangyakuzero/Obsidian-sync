import { describe, expect, it } from "vitest";
import { friendlyApiMessage } from "../src/ui/friendlyErrors";

describe("friendlyApiMessage", () => {
  it("maps auth error codes to clear user-facing messages", () => {
    expect(friendlyApiMessage("CONFLICT", "account already exists")).toBe(
      "Username already exists. Choose another username or select Existing user.",
    );
    expect(friendlyApiMessage("NOT_FOUND", "account not found")).toBe("Username not found.");
    expect(friendlyApiMessage("UNAUTHORIZED", "invalid password")).toBe(
      "Password rejected. Check your password and try again.",
    );
    expect(friendlyApiMessage("BAD_REQUEST", "password must be 8-200 chars")).toBe(
      "password must be 8-200 chars",
    );
    expect(friendlyApiMessage(undefined, "network down")).toBe("network down");
    expect(friendlyApiMessage(undefined, "")).toBe("Something went wrong.");
  });
});
