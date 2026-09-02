// mcData.js — real Minecraft block/medium VOCABULARY + world constants, SHARED by the live transport (minecraftMcpi.js)
// and the dream sim (voxelDream.js), so a policy Rook learns in the cheap headless dream reads the world with IDENTICAL
// semantics on a real server — water is water, lava burns, the void is a fall, in both. Grounded in the installed data:
// the Bedrock dedicated server (…/minecraft/bedrock-server-1.26.40.8), the Java client (.minecraft version 26.2), and
// the FTB packs — plus stable Minecraft constants. One vocabulary, three block encodings (Java/Bedrock names + Pi ids).
//
// Honest note on the data: the vanilla resource-pack blocks.json is a TEXTURE map (short names, no fluid semantics) and
// the full registry lives compiled in the version jar / a data-gen — heavy to parse here. So the fluid/hazard classes
// below are the STABLE, well-known Minecraft semantics (unchanged for years), confirmed against the installed layout,
// not a fragile jar dump. mediumOf() takes whatever the transport returns (a name or a legacy numeric id).

// sea level + world floor per edition (Java 63, Bedrock 62; Pi is a small flat world at 0).
export const SEA_LEVEL = { java: 63, bedrock: 62, pi: 0 };
export const MIN_Y = { java: -64, bedrock: -64, pi: 0 };

// mediums: air | water | lava | hazard | ground | void. `isPassable` = you can enter it (air/water); `isHazard` = it harms.
const NAMED = {
  air: "air", cave_air: "air", void_air: "air",
  water: "water", flowing_water: "water", bubble_column: "water", kelp: "water", kelp_plant: "water", seagrass: "water", tall_seagrass: "water",
  lava: "lava", flowing_lava: "lava",
  magma: "hazard", magma_block: "hazard", fire: "hazard", soul_fire: "hazard", campfire: "hazard", soul_campfire: "hazard",
  cactus: "hazard", sweet_berry_bush: "hazard", powder_snow: "hazard", wither_rose: "hazard", pointed_dripstone: "hazard",
};
const NUMERIC = { 0: "air", 8: "water", 9: "water", 10: "lava", 11: "lava", 51: "hazard" };   // Pi/RaspberryJuice legacy ids (51=fire)

// mediumOf(block) — block is a NAMED string ("minecraft:water" | "water") OR a legacy NUMERIC id. Unknown ⇒ ground (a
// solid you stand on). null/undefined ⇒ ground too (a missing read is treated as solid, the conservative default).
export function mediumOf(block) {
  if (block == null || block === "") return "ground";
  if (typeof block === "number" || /^\d+$/.test(block)) return NUMERIC[+block] || "ground";
  const name = String(block).replace(/^minecraft:/, "").toLowerCase();
  return NAMED[name] || "ground";
}
export const isPassable = (m) => m === "air" || m === "water";
export const isHazard = (m) => m === "lava" || m === "hazard";

// mediumFromHeight(y, {sea, minY}) — classify by a SURFACE height (for a height-only source like world.getHeight or the
// dream's heightmap): below the floor ⇒ void (a fall), at/under sea ⇒ water, else ground. lava is placed by the world,
// not derivable from height, so a height-only classifier never returns 'lava'.
export function mediumFromHeight(y, { sea = SEA_LEVEL.java, minY = MIN_Y.java } = {}) {
  if (!Number.isFinite(+y) || +y <= minY) return "void";
  return +y <= sea ? "water" : "ground";
}
