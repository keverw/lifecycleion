const PATH_SEGMENT_PATTERN = /\w+|\[(\d+)\]/g;

/**
 * Parses a mixed object/array path such as "user.roles[0].name" into lookup parts.
 */
export function getPathParts(path: string): string[] {
  return Array.from(
    path.matchAll(PATH_SEGMENT_PATTERN),
    (match) => match[1] ?? match[0],
  );
}
