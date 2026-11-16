/** The base of a scalar, parametrized, or list type. */
export const baseType = (type: string) => type.trim().split(/[<(]/)[0].trim();

/** The argument of a parametrized type, preserving punctuation in choices. */
export const typeArgument = (type: string) =>
  type
    .trim()
    .match(/^[^<(]+\((.*)\)$/)?.[1]
    .trim();

/** The options of `choice(a|b)` or `keyword(a|b)`. */
export function typeOptions(type: string): string[] {
  const argument = typeArgument(type);
  return argument ? argument.split("|").map((option) => option.trim()) : [];
}
