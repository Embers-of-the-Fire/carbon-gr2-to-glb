/**
 * High-level conversion: EVE ship (.gr2 + DDS textures) to .glb.
 */

import { CjsGr2Format } from "@carbonenginejs/runtime/resource/formats/gr2";
import { CjsCmfFormat } from "@carbonenginejs/runtime/resource/formats/cmf";
import { extractGeometry } from "./geometry.js";
import { bakeTextures, decompressIfGzip } from "./bake.js";
import { loadSofShip } from "./sof.js";
import { writeGlb } from "./glb.js";
import { compressGlbGeometry } from "./compress.js";

function isHeatShader(shader)
{
    return /heat|glowcylindric/i.test(shader ?? "");
}

function isGlassShader(shader)
{
    return /glass/i.test(shader ?? "");
}

function isSailsShader(shader)
{
    return /sails/i.test(shader ?? "");
}

function luminance(rgb)
{
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/**
 * Scale every material color by the same factor so the base material's
 * luminance matches the raw albedo: hue and material relationships are
 * preserved, but the faction tint no longer darkens the ship in viewers
 * without game-strength lighting.
 */
function normalizeMaterialBrightness(diffuse)
{
    const base = diffuse?.[0];
    if (!base) return diffuse;
    const scale = 1 / Math.max(luminance(base), 1e-6);
    return diffuse.map((color) => color?.map((v) => v * scale) ?? null);
}

/**
 * Pick the primary opaque hull area (the one carrying the ship's albedo set)
 * from a resolved SOF ship.
 *
 * @param {object|null} sofShip Resolved SOF ship from resolveSofDna/loadSofShip.
 * @returns {object|null}
 */
export function pickHullArea(sofShip)
{
    return sofShip?.areas.find((area) => area.group === "opaqueAreas" && !isHeatShader(area.shader)) ?? null;
}

/** Glass canopy look: translucent dark blend, glossy under environment lighting. */
const GLASS_BASE_COLOR_FACTOR = [ 1, 1, 1, 0.35 ];
const GLASS_ROUGHNESS_FACTOR = 0.05;
const GLASS_METALLIC_FACTOR = 0;

/**
 * Base (geometry-only) variant look: brightness-normalized hull color so the
 * faction hue survives without the albedo texture, a mildly metallic mid-gloss
 * finish, and a dark heat-shader body whose emissive comes from the SOF glow
 * color. Tuned for the default studio environment of the viewer.
 */
const BASE_HULL_BRIGHTNESS = 0.7;
const BASE_HULL_METALLIC = 0.35;
const BASE_HEAT_BASE_COLOR = [ 0.05, 0.05, 0.05, 1 ];

/** Split an HDR glow color into an LDR emissive factor + emissive strength. */
function emissiveFactors(glowColor)
{
    if (!glowColor) return null;
    const strength = Math.max(...glowColor, 1);
    return { emissiveFactor: glowColor.map((v) => v / strength), emissiveStrength: strength };
}

/** Map SOF mesh-area group indices to material indices by shader family. */
function mapGroupsToMaterials(sofShip, { hullMat, heatMat, glassMat, sailsMat })
{
    const materialByGroupIndex = new Map();
    for (const area of sofShip.areas)
    {
        if (area.index === null || area.index === undefined) continue;
        if (materialByGroupIndex.has(area.index)) continue;
        if (isHeatShader(area.shader)) materialByGroupIndex.set(area.index, heatMat);
        else if (isGlassShader(area.shader)) materialByGroupIndex.set(area.index, glassMat);
        else if (isSailsShader(area.shader)) materialByGroupIndex.set(area.index, sailsMat);
        else if (area.group === "transparentAreas") materialByGroupIndex.set(area.index, glassMat);
        else materialByGroupIndex.set(area.index, hullMat);
    }
    return materialByGroupIndex;
}

/**
 * Build the glTF material list for the base (geometry-only) variant: one
 * factor-only PBR material per SOF area class, no textures.
 *
 * @param {object|null} sofShip Resolved SOF ship (null in stem-fallback mode).
 * @returns {{materials: Array<object>, materialByGroupIndex: Map<number, number>, defaultMaterial: number|null}}
 */
export function buildFactorMaterials(sofShip)
{
    const materials = [];
    const push = (mat) =>
    {
        materials.push(mat);
        return materials.length - 1;
    };

    const diffuse = normalizeMaterialBrightness(sofShip ? (pickHullArea(sofShip)?.materials.diffuse ?? null) : null);
    const base = diffuse?.[0] ?? null;
    const hullMat = push({
        name: "hull",
        baseColorFactor: base
            ? [
                Math.min(1, base[0] * BASE_HULL_BRIGHTNESS),
                Math.min(1, base[1] * BASE_HULL_BRIGHTNESS),
                Math.min(1, base[2] * BASE_HULL_BRIGHTNESS),
                1
            ]
            : [ BASE_HULL_BRIGHTNESS, BASE_HULL_BRIGHTNESS, BASE_HULL_BRIGHTNESS, 1 ],
        roughnessFactor: 0.6,
        metallicFactor: BASE_HULL_METALLIC
    });

    if (!sofShip) return { materials, materialByGroupIndex: new Map(), defaultMaterial: hullMat };

    const heatArea = sofShip.areas.find((area) => isHeatShader(area.shader)) ?? null;
    const heatEmissive = emissiveFactors(heatArea?.heatGlowColor ?? heatArea?.glowColor ?? null);
    const heatMat = heatArea && heatEmissive
        ? push({
            name: "heat",
            baseColorFactor: BASE_HEAT_BASE_COLOR,
            roughnessFactor: 0.4,
            metallicFactor: 0,
            ...heatEmissive
        })
        : hullMat;

    const glassMat = sofShip.areas.some((area) => isGlassShader(area.shader) || area.group === "transparentAreas")
        ? push({
            name: "glass",
            baseColorFactor: GLASS_BASE_COLOR_FACTOR,
            metallicFactor: GLASS_METALLIC_FACTOR,
            roughnessFactor: GLASS_ROUGHNESS_FACTOR,
            alphaMode: "BLEND"
        })
        : hullMat;

    const materialByGroupIndex = mapGroupsToMaterials(sofShip, {
        hullMat,
        heatMat,
        glassMat,
        sailsMat: hullMat
    });

    return { materials, materialByGroupIndex, defaultMaterial: hullMat };
}

/**
 * Build the glTF material list for a ship: one material per SOF area class
 * (hull, heat, glass, sails, transparent/decal), sharing one baked texture set.
 *
 * @param {object|null} sofShip Resolved SOF ship (null in stem-fallback mode).
 * @param {object} slots Baked texture slots from bakeTextures.
 * @returns {{materials: Array<object>, materialByGroupIndex: Map<number, number>, defaultMaterial: number|null}}
 */
export function buildAreaMaterials(sofShip, slots)
{
    const has = Object.keys(slots).length > 0;
    const materials = [];
    const push = (mat) =>
    {
        materials.push(mat);
        return materials.length - 1;
    };

    const hullMat = has ? push({
        name: "hull",
        baseColor: slots.baseColor,
        normal: slots.normal,
        metallicRoughness: slots.metallicRoughness,
        emissive: slots.emissive,
        emissiveStrength: slots.emissiveStrength
    }) : null;

    if (!sofShip) return { materials, materialByGroupIndex: new Map(), defaultMaterial: hullMat };

    const heatMat = slots.emissiveHeat !== undefined ? push({
        name: "heat",
        baseColor: slots.baseColor,
        normal: slots.normal,
        metallicRoughness: slots.metallicRoughness,
        emissive: slots.emissiveHeat,
        emissiveStrength: slots.emissiveHeatStrength
    }) : hullMat;

    const glassMat = has ? push({
        name: "glass",
        baseColor: slots.baseColor,
        normal: slots.normal,
        metallicRoughness: slots.metallicRoughness,
        baseColorFactor: GLASS_BASE_COLOR_FACTOR,
        metallicFactor: GLASS_METALLIC_FACTOR,
        roughnessFactor: GLASS_ROUGHNESS_FACTOR,
        alphaMode: "BLEND"
    }) : hullMat;

    const sailsMat = slots.baseColorDetail !== undefined ? push({
        name: "sails",
        baseColor: slots.baseColorDetail,
        normal: slots.normal,
        metallicRoughness: slots.metallicRoughness,
        emissive: slots.emissive,
        emissiveStrength: slots.emissiveStrength
    }) : hullMat;

    const materialByGroupIndex = mapGroupsToMaterials(sofShip, { hullMat, heatMat, glassMat, sailsMat });

    return { materials, materialByGroupIndex, defaultMaterial: hullMat };
}

/**
 * @param {Uint8Array} gr2Bytes GR2 file bytes (gzip-wrapped or raw).
 * @param {object} options
 * @param {string} options.stem Texture stem, e.g. "af1_t1".
 * @param {string} [options.textureDir] Directory holding the DDS set (default
 *   filesystem resolver; ignored when `resolveTexture` is given).
 * @param {(logical: string, resPath: string|null, fallbackName: string) => Promise<Uint8Array|null>} [options.resolveTexture]
 *   Texture byte source overriding `textureDir`.
 * @param {number} [options.lod] LOD mesh index. Default 0 (full detail).
 * @param {boolean} [options.convertCoordinates] Default true.
 * @param {boolean} [options.flipV] Default false.
 * @param {boolean} [options.flipGreen] Default true.
 * @param {number[]} [options.tint] RGB albedo multiplier (ignored when SOF provides colors).
 * @param {boolean} [options.boost] Normalize faction-color brightness to the raw
 *   albedo luminance. Default false (data-faithful darkening).
 * @param {{dataBlack: string|Uint8Array, dna: string}} [options.sof] SOF catalog + DNA for real faction data.
 * @param {object} [options.sofShip] Pre-resolved SOF ship (from resolveSofDna);
 *   takes precedence over `sof` so batch runs can share one catalog.
 *   INVARIANT: this object is the only SOF/catalog influence on the output GLB —
 *   the data pipeline's build-state cache fingerprints it (sofShipHash), so any
 *   data.black data that affects the output must be carried here. Extend
 *   resolveSofDna instead of reading the catalog elsewhere.
 * @param {{format: "png"|"webp"|"none"}} [options.textureFormat]
 *   Output texture encoding. Default PNG. WebP encodes per WEBP_ENCODING_POLICY.
 *   `"none"` skips texture baking entirely and emits the base (geometry-only)
 *   variant: factor-only PBR materials derived from the SOF constants.
 * @param {"meshopt"} [options.geometryCompression] Geometry compression
 *   (EXT_meshopt_compression). Default none.
 * @returns {Promise<{glb: Uint8Array, stats: object}>}
 */
export async function convertShip(gr2Bytes, options)
{
    const bytes = decompressIfGzip(gr2Bytes);
    const shared = CjsCmfFormat.loadShared(CjsGr2Format.read(bytes));

    const { name, primitives } = extractGeometry(shared, {
        lod: options.lod ?? 0,
        convertCoordinates: options.convertCoordinates,
        flipV: options.flipV
    });

    let sofShip = options.sofShip ?? null;
    if (!sofShip && options.sof)
    {
        sofShip = await loadSofShip(options.sof.dataBlack, options.sof.dna);
    }
    if (sofShip?.geometryResPath && !sofShip.geometryResPath.toLowerCase().endsWith(`${options.stem.toLowerCase()}.gr2`))
    {
        console.warn(`warning: DNA resolves to ${sofShip.geometryResPath}, but input stem is "${options.stem}"`);
    }

    const hullArea = pickHullArea(sofShip);
    const heatArea = sofShip?.areas.find((area) => isHeatShader(area.shader)) ?? null;
    const sailsArea = sofShip?.areas.find((area) => isSailsShader(area.shader)) ?? null;

    const factorOnly = options.textureFormat?.format === "none";

    let images = [];
    let slots = {};
    let skipped = [];
    if (!factorOnly)
    {
        ({ images, slots, skipped } = await bakeTextures(options.stem, {
            textureDir: options.textureDir,
            resolveTexture: options.resolveTexture,
            flipGreen: options.flipGreen,
            tint: options.tint,
            textureFormat: options.textureFormat,
            textureNames: hullArea ? {
                albedo: hullArea.textures.AlbedoMap,
                normal: hullArea.textures.NormalMap,
                roughness: hullArea.textures.RoughnessMap,
                metallic: hullArea.textures.MaterialMap,
                glow: hullArea.textures.GlowMap,
                dirt: hullArea.textures.DirtMap,
                paintMask: hullArea.textures.PaintMaskMap
            } : undefined,
            diffuse: hullArea?.materials.diffuse
                ? (options.boost === true ? normalizeMaterialBrightness(hullArea.materials.diffuse) : hullArea.materials.diffuse)
                : null,
            gloss: hullArea?.materials.gloss ?? null,
            glowColor: hullArea?.glowColor ?? null,
            heatGlowColor: heatArea?.heatGlowColor ?? heatArea?.glowColor ?? null,
            detailMap: sailsArea?.textures.SailsDetailMap ?? null,
            invertRoughness: options.invertRoughness
        }));
    }

    const { materials, materialByGroupIndex, defaultMaterial } = factorOnly
        ? buildFactorMaterials(sofShip)
        : buildAreaMaterials(sofShip, slots);

    primitives.forEach((prim, groupIndex) =>
    {
        prim.material = materialByGroupIndex.get(groupIndex) ?? defaultMaterial;
    });

    let glb = writeGlb({ name, primitives, materials, images });
    if (options.geometryCompression === "meshopt")
    {
        glb = await compressGlbGeometry(glb);
    }

    return {
        glb,
        stats: {
            mesh: name,
            dna: sofShip?.dna ?? null,
            shader: hullArea?.shader ?? null,
            lod: options.lod ?? 0,
            lodsAvailable: shared.meshes.length,
            primitives: primitives.length,
            triangles: primitives.reduce((sum, p) => sum + p.indices.length / 3, 0),
            vertices: primitives.length ? primitives[0].positions.length / 3 : 0,
            images: images.map((image) => image.name),
            materials: materials.map((mat) => mat.name),
            skippedTextures: skipped,
            compression: {
                textures: options.textureFormat?.format ?? "png",
                geometry: options.geometryCompression ?? "none"
            }
        }
    };
}
