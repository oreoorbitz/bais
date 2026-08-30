// bais/src/toml.ts — TS wrapper re-exporting BAML TOML parser (BAML is validator).
// BAML is the source of truth: baml_src/ns_toml/toml.baml.

export async function parseBaisFile(text: string) {
  const { toml } = await import("../baml_sdk/index.js");
  return await (toml as any).parse_bais_file(text);
}
export async function serializeBaisFile(f: any) {
  const { toml } = await import("../baml_sdk/index.js");
  return await (toml as any).serialize_bais_file(f);
}
