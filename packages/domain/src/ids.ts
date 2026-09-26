import { v7 as uuidv7 } from "uuid";

/** Opaque entity identifier. UUIDv7 preferred (time-ordered). */
export type EntityId = string;

/** Generate a new UUIDv7 entity id. */
export function newId(): EntityId {
  return uuidv7();
}
