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
    const base = diffuse[0];
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
 * @param {{format: "png"|"webp", quality?: number}} [options.textureFormat]
 *   Output texture encoding. Default PNG.
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

    const { images, slots, skipped } = await bakeTextures(options.stem, {
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
        glowColor: hullArea?.glowColor ?? null,
        invertRoughness: options.invertRoughness
    });

    const materials = [];
    const hullMaterialIndex = materials.length;
    materials.push({ name: hullArea?.name ?? options.stem, ...slots });

    primitives.forEach((prim) =>
    {
        prim.material = Object.keys(slots).length ? hullMaterialIndex : null;
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
