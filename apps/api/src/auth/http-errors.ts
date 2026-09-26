import { HttpException } from "@nestjs/common";
import { AuthError } from "@iptv/auth";
import { ForbiddenError } from "@iptv/auth";

/** Map domain/auth errors to HTTP; unknown errors propagate as 500. */
export function throwHttp(err: unknown): never {
  if (err instanceof AuthError) {
    throw new HttpException({ code: err.code, message: err.message }, err.statusCode);
  }
  if (err instanceof ForbiddenError) {
    throw new HttpException({ code: err.code, message: err.message }, err.statusCode);
  }
  throw err;
}
