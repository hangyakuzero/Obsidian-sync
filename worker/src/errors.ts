export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const STATUS_FOR_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  BAD_REQUEST: 400,
  PAYLOAD_REQUIRED: 400,
  PAYLOAD_TOO_LARGE: 413,
  UPLOAD_REQUIRED: 400,
  UPLOAD_INCOMPLETE: 409,
  HASH_MISMATCH: 400,
  CLIENT_UPGRADE_REQUIRED: 426,
  INSUFFICIENT_STORAGE: 507,
  RESYNC_REQUIRED: 460,
  INTERNAL: 500,
};
