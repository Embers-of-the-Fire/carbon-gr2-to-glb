/**
 * High-level conversion: EVE ship (.gr2 + sibling .dds textures) to .glb.
 */

import { CjsGr2Format } from "@carbonenginejs/runtime/resource/formats/gr2";
import { CjsCmfFormat } from "@carbonenginejs/runtime/resource/formats/cmf";
import { extractGeometry } from "./geometry.js";
import { bakeTextures, decompressIfGzip } from "./bake.js";
import { loadSofShip } from "./sof.js";
import { writeGlb } from "./glb.js";

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
 * @param {Uint8Array} gr2Bytes GR2 file bytes (gzip-wrapped or raw).
 * @param {object} options
 * @param {string} options.textureDir Directory holding the DDS set.
 * @param {string} options.stem Texture stem, e.g. "af1_t1".
 * @param {number} [options.lod] LOD mesh index. Default 0 (full detail).
 * @param {boolean} [options.convertCoordinates] Default true.
 * @param {boolean} [options.flipV] Default false.
 * @param {boolean} [options.flipGreen] Default true.
 * @param {number[]} [options.tint] RGB albedo multiplier (ignored when SOF provides colors).
 * @param {boolean} [options.boost] Normalize faction-color brightness to the raw
 *   albedo luminance. Default true; pass false for data-faithful darkening.
 * @param {{dataBlack: string, dna: string}} [options.sof] SOF catalog + DNA for real faction data.
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

    let sofShip = null;
    if (options.sof)
    {
        sofShip = await loadSofShip(options.sof.dataBlack, options.sof.dna);
        if (sofShip.geometryResPath && !sofShip.geometryResPath.toLowerCase().endsWith(`${options.stem.toLowerCase()}.gr2`))
        {
            console.warn(`warning: DNA resolves to ${sofShip.geometryResPath}, but input stem is "${options.stem}"`);
        }
    }

    const hullArea = sofShip?.areas.find((area) => area.group === "opaqueAreas" && !isHeatShader(area.shader)) ?? null;

    const { images, slots, skipped } = await bakeTextures(options.textureDir, options.stem, {
        flipGreen: options.flipGreen,
        tint: options.tint,
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

    const glb = writeGlb({ name, primitives, materials, images });

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
            skippedTextures: skipped
        }
    };
}
