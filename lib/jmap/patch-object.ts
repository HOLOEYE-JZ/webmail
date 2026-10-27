/**
 * JMAP PatchObject paths (RFC 8620 §5.3): a key "alerts/a1/acknowledged"
 * changes that one member and leaves the rest of the object as the server
 * holds it, so a change made meanwhile on another device is not overwritten.
 */

/** The JSON Pointer path of nested members, each segment escaped (RFC 6901). */
export function patchPath(...segments: string[]): string {
  return segments.map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * The object as the server will hold it after `patch`: plain keys replace
 * the property, path keys change the member they name (null removes a map
 * member). Nothing is changed in place.
 */
export function applyPatchObject<T extends object>(target: T, patch: object): T {
  let result = { ...target } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!key.includes("/")) {
      result[key] = value;
      continue;
    }
    const segments = key.split("/").map(unescapeSegment);
    result = setIn(result, segments, value);
  }
  return result as T;
}

function setIn(object: Record<string, unknown>, [head, ...rest]: string[], value: unknown): Record<string, unknown> {
  const copy = { ...object };
  if (rest.length === 0) {
    if (value === null) delete copy[head];
    else copy[head] = value;
    return copy;
  }
  const child = copy[head];
  copy[head] = setIn(child && typeof child === "object" ? (child as Record<string, unknown>) : {}, rest, value);
  return copy;
}

/**
 * The top-level properties `patch` changes, each whole as it is after the
 * patch: a path key ("alerts/a1/acknowledged") becomes its property
 * ("alerts") with every member as the patch leaves it. For whoever reads a
 * patch as plain properties (plugins), while the server still gets the paths.
 */
export function patchedProperties<T extends object>(target: T, patch: object): Partial<T> {
  const after = applyPatchObject(target, patch) as Record<string, unknown>;
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    const property = unescapeSegment(key.split("/")[0]);
    changed[property] = property in after ? after[property] : null;
  }
  return changed as Partial<T>;
}
