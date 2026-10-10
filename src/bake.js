/**
 * Texture baking: EVE DDS maps to glTF PBR PNGs.
 *
 * Suffix conventions observed on ship texture sets (all maps share one UV space):
 *   _a  BC7 RGBA  albedo (base color)
 *   _n  BC5 RG    normal XY (Z reconstructed; green flipped to glTF/OpenGL convention)
 *   _r  BC4 R     roughness
 *   _m  BC4 R     metallic
 *   _g  BC4 R     glow (emissive)
 *   _d  BC4 R     dirt  (unused: needs the shader's blend math)
 *   _p3 BC4 R     paint mask (unused without SOF material colors)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CjsDdsFormat } from "@carbonenginejs/runtime/resource/formats/dds";
import { CjsPngFormat } from "@carbonenginejs/runtime/resource/formats/png";

export function decompressIfGzip(bytes)
{
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
    {
        return new Uint8Array(gunzipSync(bytes));
    }
    return bytes;
}

async function readDdsRgba(path)
{
    const bytes = decompressIfGzip(new Uint8Array(await readFile(path)));
    const image = await CjsDdsFormat.read(bytes, { emit: "rgba" });
    if (!image?.data?.length || !image.width || !image.height)
    {
        throw new Error(`${path}: DDS decode produced no pixels`);
    }
    return { width: image.width, height: image.height, data: image.data };
}

async function tryRead(path)
{
    try
    {
        return await readDdsRgba(path);
    }
    catch (error)
    {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

async function encodePng(width, height, data)
{
    const png = await CjsPngFormat.write({ width, height, data });
    return png instanceof Uint8Array ? png : new Uint8Array(png);
}

/** Rebuild a glTF-convention RGB normal map from a BC5 (RG) DDS. */
function buildNormalMap(image, flipGreen)
{
    const { width, height, data } = image;
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++)
    {
        const x = data[i * 4] / 255 * 2 - 1;
        let y = data[i * 4 + 1] / 255 * 2 - 1;
        if (flipGreen) y = -y;
        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
        out[i * 4] = Math.round((x * 0.5 + 0.5) * 255);
        out[i * 4 + 1] = Math.round((y * 0.5 + 0.5) * 255);
        out[i * 4 + 2] = Math.round((z * 0.5 + 0.5) * 255);
        out[i * 4 + 3] = 255;
    }
    return { width, height, data: out };
}

/** Combine roughness (G) and metallic (B) into one glTF metallicRoughness map. */
function buildMetallicRoughnessMap(roughness, metallic, invertRoughness)
{
    const source = roughness ?? metallic;
    const { width, height } = source;
    const other = roughness ?? metallic;
    if (other && (other.width !== width || other.height !== height))
    {
        throw new Error(`roughness (${roughness?.width ?? "-"}x${roughness?.height ?? "-"}) and metallic (${metallic?.width ?? "-"}x${metallic?.height ?? "-"}) sizes differ`);
    }
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++)
    {
        const r = roughness ? roughness.data[i * 4] : 255;
        out[i * 4] = 255;
        out[i * 4 + 1] = invertRoughness ? 255 - r : r;
        out[i * 4 + 2] = metallic ? metallic.data[i * 4] : 0;
        out[i * 4 + 3] = 255;
    }
    return { width, height, data: out };
}

/** Expand a single-channel map to grayscale RGB. */
function grayToRgb(image)
{
    const { width, height, data } = image;
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++)
    {
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i * 4];
        out[i * 4 + 3] = 255;
    }
    return { width, height, data: out };
}

/** Multiply RGB in place by a faction tint (EVE ship albedos are grayscale). */
function applyTint(image, tint)
{
    const data = new Uint8Array(image.data);
    for (let i = 0; i < data.length; i += 4)
    {
        data[i] = Math.min(255, Math.round(data[i] * tint[0]));
        data[i + 1] = Math.min(255, Math.round(data[i + 1] * tint[1]));
        data[i + 2] = Math.min(255, Math.round(data[i + 2] * tint[2]));
    }
    return { width: image.width, height: image.height, data };
}

/**
 * Blend grayscale albedo with faction material colors through the paint mask:
 * mask 0 selects material 1, mask 1 selects material 3 (the "_p3" channel).
 */
function blendAlbedoWithMaterials(albedo, mask, mtl1, mtl3)
{
    if (mask && (mask.width !== albedo.width || mask.height !== albedo.height))
    {
        throw new Error(`paint mask (${mask.width}x${mask.height}) and albedo (${albedo.width}x${albedo.height}) sizes differ`);
    }
    const data = new Uint8Array(albedo.data);
    for (let i = 0; i < data.length; i += 4)
    {
        const w = mask ? mask.data[i] / 255 : 0;
        for (let c = 0; c < 3; c++)
        {
            const color = mtl1[c] * (1 - w) + (mtl3?.[c] ?? mtl1[c]) * w;
            data[i + c] = Math.min(255, Math.round(data[i + c] * color));
        }
    }
    return { width: albedo.width, height: albedo.height, data };
}

/** Tint the grayscale glow map by the HDR glow color; returns color + strength. */
function buildEmissive(glow, glowColor)
{
    const rgb = grayToRgb(glow);
    if (!glowColor) return { image: rgb, strength: 1 };
    const strength = Math.max(...glowColor, 1);
    const normalized = glowColor.map((v) => v / strength);
    return { image: applyTint(rgb, normalized), strength };
}

/**
 * Load and bake every texture of one ship set.
 *
 * @param {string} dir Directory containing the DDS files.
 * @param {string} stem Texture stem, e.g. "af1_t1".
 * @param {object} [options]
 * @param {boolean} [options.flipGreen] Flip normal-map green channel. Default true.
 * @param {number[]} [options.tint] RGB multiplier (0..1) applied to the albedo.
 * @param {object} [options.textureNames] Explicit file names from SOF, keyed by
 *   logical map: albedo, normal, roughness, metallic, glow, dirt, paintMask.
 * @param {Array<number[]|null>} [options.diffuse] Mtl1..4 diffuse colors; blended
 *   through the paint mask (takes precedence over tint).
 * @param {number[]} [options.glowColor] HDR glow color; tints the emissive map
 *   and sets the emissive strength.
 * @returns {Promise<{images: Array<{name, png}>, slots: {baseColor?, normal?, metallicRoughness?, emissive?, emissiveStrength?}, skipped: string[]}>}
 */
export async function bakeTextures(dir, stem, options = {})
{
    const flipGreen = options.flipGreen !== false;
    const tint = options.tint ?? null;
    const names = options.textureNames ?? {};
    const pick = (logical, fallback) => join(dir, names[logical] ?? `${stem}_${fallback}.dds`);

    const [albedo, normal, roughness, metallic, glow, dirt, paintMask] = await Promise.all([
        tryRead(pick("albedo", "a")),
        tryRead(pick("normal", "n")),
        tryRead(pick("roughness", "r")),
        tryRead(pick("metallic", "m")),
        tryRead(pick("glow", "g")),
        tryRead(pick("dirt", "d")),
        tryRead(pick("paintMask", "p3"))
    ]);

    const skipped = [];
    if (dirt) skipped.push(`${names.dirt ?? stem + "_d.dds"} (dirt; needs shader blend math)`);

    const images = [];
    const slots = {};

    async function addImage(name, rgba)
    {
        images.push({ name, png: await encodePng(rgba.width, rgba.height, rgba.data) });
        return images.length - 1;
    }

    if (albedo)
    {
        const mtl1 = options.diffuse?.[0] ?? tint;
        const mtl3 = options.diffuse?.[2] ?? null;
        const blended = mtl1 ? blendAlbedoWithMaterials(albedo, paintMask, mtl1, mtl3) : albedo;
        slots.baseColor = await addImage(`${stem}_basecolor`, blended);
    }
    else if (paintMask)
    {
        skipped.push(`${names.paintMask ?? stem + "_p3.dds"} (paint mask; no albedo to blend into)`);
    }
    if (normal) slots.normal = await addImage(`${stem}_normal`, buildNormalMap(normal, flipGreen));
    if (roughness || metallic)
    {
        slots.metallicRoughness = await addImage(`${stem}_mr`, buildMetallicRoughnessMap(roughness, metallic, options.invertRoughness === true));
    }
    if (glow)
    {
        const emissive = buildEmissive(glow, options.glowColor ?? null);
        slots.emissive = await addImage(`${stem}_emissive`, emissive.image);
        slots.emissiveStrength = emissive.strength;
    }

    return { images, slots, skipped };
}
