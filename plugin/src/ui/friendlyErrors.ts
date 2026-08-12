/**
 * Map server error codes to human-friendly messages for auth flows so the
 * user knows exactly what went wrong (duplicate username, rejected password).
 */
export function friendlyApiMessage(code: string | undefined, raw: string): string {
  switch (code) {
    case "CONFLICT":
      return "Username already exists. Choose another username or select Existing user.";
    case "NOT_FOUND":
      return "Username not found.";
    case "UNAUTHORIZED":
      return "Password rejected. Check your password and try again.";
    case "BAD_REQUEST":
      return raw || "Invalid input. Check your username and password.";
    case "PAYLOAD_REQUIRED":
      return "This file has no content and cannot be synced.";
    default:
      return raw || "Something went wrong.";
  }
}
