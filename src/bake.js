/**
 * Texture baking: EVE DDS maps to glTF PBR textures.
 *
 * Suffix conventions observed on ship texture sets (all maps share one UV space):
 *   _a  BC7 RGBA  albedo (base color)
 *   _n  BC5 RG    normal XY (Z reconstructed; green flipped to glTF/OpenGL convention)
 *   _r  BC4 R     roughness
 *   _m  BC4 R     metallic
 *   _g  BC4 R     glow (emissive)
 *   _d  BC4 R     dirt  (unused: needs the shader's blend math)
 *   _p3 BC4 R     paint mask (unused without SOF material colors)
 *
 * Texture bytes are obtained through a resolver callback
 * `(logical, resPath, fallbackName) => bytes | null`, so callers can serve
 * files from a local directory, a staged cache, or any other source. Output
 * encoding is configurable: PNG (lossless) or WebP (EXT_texture_webp).
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CjsDdsFormat } from "@carbonenginejs/runtime/resource/formats/dds";
import { CjsPngFormat } from "@carbonenginejs/runtime/resource/formats/png";
import sharp from "sharp";

export function decompressIfGzip(bytes)
{
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
    {
        return new Uint8Array(gunzipSync(bytes));
    }
    return bytes;
}

async function decodeDdsRgba(bytes, label)
{
    const raw = decompressIfGzip(bytes);
    const image = await CjsDdsFormat.read(raw, { emit: "rgba" });
    if (!image?.data?.length || !image.width || !image.height)
    {
        throw new Error(`${label}: DDS decode produced no pixels`);
    }
    return { width: image.width, height: image.height, data: image.data };
}

async function tryDecode(bytes, label)
{
    if (!bytes) return null;
    return decodeDdsRgba(bytes, label);
}

/**
 * Filesystem-backed texture resolver: serves `<dir>/<basename(resPath)>` or,
 * when no SOF path is known, `<dir>/<fallbackName>`.
 *
 * @param {string} dir Directory containing the DDS files.
 * @returns {(logical: string, resPath: string|null, fallbackName: string) => Promise<Uint8Array|null>}
 */
export function makeFileTextureResolver(dir)
{
    return async (logical, resPath, fallbackName) =>
    {
        const file = join(dir, resPath ? basename(resPath) : fallbackName);
        try
        {
            return new Uint8Array(await readFile(file));
        }
        catch (error)
        {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    };
}

/**
 * Directory-map texture resolver: serves bytes from an explicit
 * `res:/... -> local path` map (e.g. a staged download cache).
 *
 * @param {Record<string, string>} files Map of full resource path to local file.
 * @returns {(logical: string, resPath: string|null, fallbackName: string) => Promise<Uint8Array|null>}
 */
export function makeMappedTextureResolver(files)
{
    return async (logical, resPath) =>
    {
        const local = resPath ? files[resPath] : null;
        if (!local) return null;
        return new Uint8Array(await readFile(local));
    };
}

async function encodeImage(width, height, data, format)
{
    if (format?.format === "webp")
    {
        const webp = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
            raw: { width, height, channels: 4 }
        }).webp({ quality: format.quality ?? 90 }).toBuffer();
        return { data: new Uint8Array(webp), mimeType: "image/webp" };
    }
    const png = await CjsPngFormat.write({ width, height, data });
    return { data: png instanceof Uint8Array ? png : new Uint8Array(png), mimeType: "image/png" };
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

/**
 * Bilinear resample of an RGBA map to a target size.
 *
 * EVE texture sets all share one UV space, so a map may ship at a lower
 * resolution than the rest (paint masks are commonly half the albedo size);
 * resampling keeps every map texel-aligned instead of failing the conversion.
 * Returns the input object untouched when the size already matches.
 *
 * @param {{width: number, height: number, data: Uint8Array}} image
 * @param {number} width Target width.
 * @param {number} height Target height.
 * @param {string} [label] Map name used in the resample warning.
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function resampleImage(image, width, height, label)
{
    if (image.width === width && image.height === height) return image;
    console.warn(
        `resampled ${label ?? "map"} ${image.width}x${image.height} -> ${width}x${height}`
    );
    const srcWidth = image.width;
    const srcHeight = image.height;
    const src = image.data;
    const out = new Uint8Array(width * height * 4);
    const cols = new Int32Array(width);
    const colFrac = new Float32Array(width);
    for (let x = 0; x < width; x++)
    {
        const fx = Math.min(Math.max((x + 0.5) * srcWidth / width - 0.5, 0), srcWidth - 1);
        cols[x] = Math.floor(fx);
        colFrac[x] = fx - cols[x];
    }
    const rows = new Int32Array(height);
    const rowFrac = new Float32Array(height);
    for (let y = 0; y < height; y++)
    {
        const fy = Math.min(Math.max((y + 0.5) * srcHeight / height - 0.5, 0), srcHeight - 1);
        rows[y] = Math.floor(fy);
        rowFrac[y] = fy - rows[y];
    }
    for (let y = 0; y < height; y++)
    {
        const row0 = rows[y] * srcWidth * 4;
        const row1 = Math.min(rows[y] + 1, srcHeight - 1) * srcWidth * 4;
        const ty = rowFrac[y];
        for (let x = 0; x < width; x++)
        {
            const col0 = cols[x] * 4;
            const col1 = Math.min(cols[x] + 1, srcWidth - 1) * 4;
            const tx = colFrac[x];
            const outIndex = (y * width + x) * 4;
            for (let c = 0; c < 4; c++)
            {
                const top = src[row0 + col0 + c] * (1 - tx) + src[row0 + col1 + c] * tx;
                const bottom = src[row1 + col0 + c] * (1 - tx) + src[row1 + col1 + c] * tx;
                out[outIndex + c] = Math.round(top * (1 - ty) + bottom * ty);
            }
        }
    }
    return { width, height, data: out };
}

/** Combine roughness (G) and metallic (B) into one glTF metallicRoughness map. */
export function buildMetallicRoughnessMap(roughness, metallic, invertRoughness)
{
    const base = roughness ?? metallic;
    const { width, height } = base;
    if (roughness) roughness = resampleImage(roughness, width, height, "roughness");
    if (metallic) metallic = resampleImage(metallic, width, height, "metallic");
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
 * A mask at a different resolution is resampled to the albedo size first.
 */
export function blendAlbedoWithMaterials(albedo, mask, mtl1, mtl3)
{
    if (mask)
    {
        mask = resampleImage(mask, albedo.width, albedo.height, "paint mask");
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
 * @param {string} stem Texture stem, e.g. "af1_t1" (used for output image names
 *   and fallback file names when SOF provides no path for a map).
 * @param {object} [options]
 * @param {(logical: string, resPath: string|null, fallbackName: string) => Promise<Uint8Array|null>} [options.resolveTexture]
 *   Texture byte source. Default: `makeFileTextureResolver(options.textureDir ?? ".")`.
 * @param {string} [options.textureDir] Directory used by the default resolver.
 * @param {boolean} [options.flipGreen] Flip normal-map green channel. Default true.
 * @param {number[]} [options.tint] RGB multiplier (0..1) applied to the albedo.
 * @param {object} [options.textureNames] Explicit `res:/` paths from SOF, keyed by
 *   logical map: albedo, normal, roughness, metallic, glow, dirt, paintMask.
 * @param {Array<number[]|null>} [options.diffuse] Mtl1..4 diffuse colors; blended
 *   through the paint mask (takes precedence over tint).
 * @param {number[]} [options.glowColor] HDR glow color; tints the emissive map
 *   and sets the emissive strength.
 * @param {{format: "png"|"webp", quality?: number}} [options.textureFormat]
 *   Output texture encoding. Default PNG.
 * @returns {Promise<{images: Array<{name, data, mimeType}>, slots: {baseColor?, normal?, metallicRoughness?, emissive?, emissiveStrength?}, skipped: string[]}>}
 */
export async function bakeTextures(stem, options = {})
{
    const flipGreen = options.flipGreen !== false;
    const tint = options.tint ?? null;
    const names = options.textureNames ?? {};
    const resolveTexture = options.resolveTexture ?? makeFileTextureResolver(options.textureDir ?? ".");
    const textureFormat = options.textureFormat ?? { format: "png" };
    const load = async (logical, fallback) =>
    {
        const label = names[logical] ?? `${stem}_${fallback}.dds`;
        const bytes = await resolveTexture(logical, names[logical] ?? null, label);
        return tryDecode(bytes, label);
    };

    const [albedo, normal, roughness, metallic, glow, dirt, paintMask] = await Promise.all([
        load("albedo", "a"),
        load("normal", "n"),
        load("roughness", "r"),
        load("metallic", "m"),
        load("glow", "g"),
        load("dirt", "d"),
        load("paintMask", "p3")
    ]);

    const skipped = [];
    if (dirt) skipped.push(`${names.dirt ?? stem + "_d.dds"} (dirt; needs shader blend math)`);

    const images = [];
    const slots = {};

    async function addImage(name, rgba)
    {
        const encoded = await encodeImage(rgba.width, rgba.height, rgba.data, textureFormat);
        images.push({ name, data: encoded.data, mimeType: encoded.mimeType });
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
