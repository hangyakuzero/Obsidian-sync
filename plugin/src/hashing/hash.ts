export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  const view = new Uint8Array(digest);
  return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
}