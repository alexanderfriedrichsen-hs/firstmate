export type NativeCommand = {
  name: string;
  description: string;
  argumentHint?: string;
};
export function nativeCommands(
  input: unknown,
  terminal: string[] = [],
): NativeCommand[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.slice(0, 1000).flatMap((value: any) => {
    const c =
      typeof value === "string"
        ? { name: value, description: "Provider command" }
        : value;
    if (
      !c ||
      typeof c.name !== "string" ||
      !/^[\w][\w:.-]*$/.test(c.name) ||
      terminal.includes(c.name) ||
      seen.has(c.name)
    )
      return [];
    seen.add(c.name);
    const hint = c.argumentHint ?? c.input?.hint;
    return [
      {
        name: c.name,
        description:
          typeof c.description === "string"
            ? c.description
            : "Provider command",
        ...(typeof hint === "string" ? { argumentHint: hint } : {}),
      },
    ];
  });
}
