
/**
 * Static texture baking: EVE DDS maps to application-supported glTF PBR maps.
 *
 * The quad shader's MaterialMap is a four-band region selector, not metallic
 * input. All color composition happens in linear space and is encoded to sRGB
 * only after the source equations have been evaluated. Data maps stay linear.
 *
 * Carbon's dust is a second shaded layer. A single static glTF material cannot
 * reproduce that layer's independent view-dependent response, so the bake uses
 * the documented fixed approximation of blending its authored diffuse color at
 * 14% of the source dirt amount (modulated by the source dust-noise alpha).
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CjsDdsFormat } from "@carbonenginejs/runtime/resource/formats/dds";
import { CjsPngFormat } from "@carbonenginejs/runtime/resource/formats/png";
import sharp from "sharp";

const REGION_CENTERS = [ 0, 1 / 3, 2 / 3, 1 ];
const REGION_SCALE = 3.1914894580841064;
const REGION_OFFSET = 1.0319149494171143;
const PAINT_F0 = [ 0.038384001702070236, 0.03935199975967407, 0.03916500136256218 ];
const DEFAULT_F0 = [ 0.04, 0.04, 0.04 ];
// This baseline supports authored F0 values through 0.5 without texture clipping.
export const SPECULAR_IOR = (1 + Math.SQRT1_2) / (1 - Math.SQRT1_2);
export const SPECULAR_F0_BASELINE = ((SPECULAR_IOR - 1) / (SPECULAR_IOR + 1)) ** 2;
const DEFAULT_DUST = [ 0.045, 0.043, 0.045 ];
const DUST_APPROXIMATION = 0.14;

export function decompressIfGzip(bytes)
{
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
    {
        return new Uint8Array(gunzipSync(bytes));
    }
    return bytes;
}

/** Cap libvips' thread pool from GR2_TO_GLB_SHARP_THREADS. */
export function applySharpConcurrencyFromEnv(env = process.env)
{
    const value = Number(env.GR2_TO_GLB_SHARP_THREADS);
    if (Number.isInteger(value) && value > 0) sharp.concurrency(value);
}

/** Full-variant policy: lossless output avoids chroma damage to data textures. */
export const WEBP_ENCODING_POLICY = {
    baseColor: { lossless: true },
    normal: { lossless: true },
    metallicRoughness: { lossless: true },
    specularColor: { lossless: true },
    emissive: { lossless: true }
};

/** Reconstruct the source quad shader's four material-region weights. */
export function materialRegionWeights(selector)
{
    const weights = REGION_CENTERS.map((center) =>
        Math.min(1, Math.max(0, REGION_OFFSET - Math.abs((selector - center) * REGION_SCALE)))
    );
    const total = Math.max(weights.reduce((sum, value) => sum + value, 0), 0.001);
    return weights.map((value) => value / total);
}

export function srgbToLinear(value)
{
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value)
{
    const clamped = Math.min(1, Math.max(0, value));
    if (clamped === 0 || clamped === 1) return clamped;
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function encodeSrgb(value)
{
    return Math.round(linearToSrgb(value) * 255);
}

function encodeLinear(value)
{
    return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

function encodeNormalComponent(value)
{
    return Math.round((Math.min(1, Math.max(-1, value)) * 0.5 + 0.5) * 255);
}

function clamp01(value)
{
    return Math.min(1, Math.max(0, value));
}

function mix(a, b, amount)
{
    return a * (1 - amount) + b * amount;
}

function mixColor(a, b, amount)
{
    return a.map((value, index) => mix(value, b[index], amount));
}

function weightedColor(weights, colors, fallback)
{
    const out = [ 0, 0, 0 ];
    for (let region = 0; region < 4; region++)
    {
        const color = colors?.[region] ?? fallback;
        for (let channel = 0; channel < 3; channel++) out[channel] += weights[region] * color[channel];
    }
    return out;
}

function weightedScalar(weights, values, fallback)
{
    let out = 0;
    for (let region = 0; region < 4; region++) out += weights[region] * (values?.[region] ?? fallback);
    return out;
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

/** Filesystem-backed texture resolver for single-file conversions. */
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

/** Resolve full res:/ paths from a staged local-file map. */
export function makeMappedTextureResolver(files)
{
    return async (logical, resPath) =>
    {
        const local = resPath ? files[resPath] : null;
        if (!local) return null;
        return new Uint8Array(await readFile(local));
    };
}

async function encodeImage(width, height, data, format, logical)
{
    if (format?.format === "webp")
    {
        const policy = WEBP_ENCODING_POLICY[logical] ?? { lossless: true };
        const webp = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
            raw: { width, height, channels: 4 }
        }).webp(policy).toBuffer();
        return { data: new Uint8Array(webp), mimeType: "image/webp", policy: { ...policy } };
    }
    const png = await CjsPngFormat.write({ width, height, data });
    return {
        data: png instanceof Uint8Array ? png : new Uint8Array(png),
        mimeType: "image/png",
        policy: { lossless: true }
    };
}

/**
 * Rebuild a glTF RGB normal from Carbon's BC5 XY. Carbon adds 0.002 before
 * expanding XY to [-1, 1]. Authored tangent frames are retained by the geometry
 * exporter, so the default is to preserve green rather than flipping it again.
 */
export function buildNormalMap(image, flipGreen = false, diagnostics = {}, detailLayers = [])
{
    const { width, height, data } = image;
    const out = new Uint8Array(width * height * 4);
    let clampedZ = 0;
    for (let i = 0; i < width * height; i++)
    {
        let x = (data[i * 4] / 255 + 0.002) * 2 - 1;
        let y = (data[i * 4 + 1] / 255 + 0.002) * 2 - 1;
        const pixelX = i % width;
        const pixelY = Math.floor(i / width);
        for (const layer of detailLayers)
        {
            const texel = sampleRepeated(layer.image, (pixelX + 0.5) / width * layer.tiling, (pixelY + 0.5) / height * layer.tiling);
            const regionWeight = layer.selectorMap
                ? weightedScalar(materialRegionWeights(layer.selectorMap.data[i * 4] / 255), layer.regionStrengths, 1)
                : 1;
            const amount = clamp01(texel[3] / 255 * layer.weight * regionWeight);
            const detailX = (texel[0] / 255 + 0.002) * 2 - 1;
            const detailY = (texel[1] / 255 + 0.002) * 2 - 1;
            x = mix(x, detailX, amount);
            y = mix(y, detailY, amount);
        }
        if (flipGreen) y = -y;
        const remainder = 1 - x * x - y * y;
        if (remainder < 0) clampedZ++;
        const z = Math.sqrt(Math.max(0, remainder));
        out[i * 4] = encodeNormalComponent(x);
        out[i * 4 + 1] = encodeNormalComponent(y);
        out[i * 4 + 2] = encodeNormalComponent(z);
        out[i * 4 + 3] = 255;
    }
    diagnostics.flipGreen = flipGreen;
    diagnostics.sourceBias = 0.002;
    diagnostics.detailLayers = detailLayers.map((layer) => ({
        tiling: layer.tiling,
        weight: layer.weight,
        regionStrengths: layer.regionStrengths ?? null
    }));
    diagnostics.clampedZ = (diagnostics.clampedZ ?? 0) + clampedZ;
    return { width, height, data: out };
}

/** Bilinear resampling used only to align maps for per-texel composition. */
export function resampleImage(image, width, height, label)
{
    if (image.width === width && image.height === height) return image;
    const srcWidth = image.width;
    const srcHeight = image.height;
    const src = image.data;
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
    {
        const fy = Math.min(Math.max((y + 0.5) * srcHeight / height - 0.5, 0), srcHeight - 1);
        const y0 = Math.floor(fy);
        const y1 = Math.min(y0 + 1, srcHeight - 1);
        const ty = fy - y0;
        for (let x = 0; x < width; x++)
        {
            const fx = Math.min(Math.max((x + 0.5) * srcWidth / width - 0.5, 0), srcWidth - 1);
            const x0 = Math.floor(fx);
            const x1 = Math.min(x0 + 1, srcWidth - 1);
            const tx = fx - x0;
            const outIndex = (y * width + x) * 4;
            for (let c = 0; c < 4; c++)
            {
                const top = src[(y0 * srcWidth + x0) * 4 + c] * (1 - tx) + src[(y0 * srcWidth + x1) * 4 + c] * tx;
                const bottom = src[(y1 * srcWidth + x0) * 4 + c] * (1 - tx) + src[(y1 * srcWidth + x1) * 4 + c] * tx;
                out[outIndex + c] = Math.round(top * (1 - ty) + bottom * ty);
            }
        }
    }
    return { width, height, data: out, resampledFrom: `${label ?? "map"}:${srcWidth}x${srcHeight}` };
}

function sampleRepeated(image, u, v)
{
    const wrap = (value) => ((value % 1) + 1) % 1;
    const x = Math.min(image.width - 1, Math.floor(wrap(u) * image.width));
    const y = Math.min(image.height - 1, Math.floor(wrap(v) * image.height));
    const offset = (y * image.width + x) * 4;
    return image.data.subarray(offset, offset + 4);
}

function aligned(image, width, height, label, records)
{
    if (!image || image.width === width && image.height === height) return image;
    records.push({
        role: label,
        source: `${image.width}x${image.height}`,
        output: `${width}x${height}`,
        reason: "per-texel composition alignment"
    });
    return resampleImage(image, width, height, label);
}

/**
 * Bake base color, roughness and source-F0 maps from the static quad equations.
 * Exported for deterministic synthetic tests; input maps must already align.
 */
export function bakeQuadAppearance({ albedo, material, paintMask, roughness, dirt, dustNoise }, materials, options = {})
{
    if (!albedo || !material || !paintMask || !roughness || !dirt)
    {
        throw new Error("quad appearance requires albedo, material, paint, roughness and dirt maps");
    }
    const { width, height } = albedo;
    for (const [name, image] of Object.entries({ material, paintMask, roughness, dirt }))
    {
        if (image.width !== width || image.height !== height) throw new Error(`${name} must align with albedo before baking`);
    }
    const baseColor = new Uint8Array(width * height * 4);
    const metallicRoughness = new Uint8Array(width * height * 4);
    const specularColor = new Uint8Array(width * height * 4);
    const paintStrength = options.paintStrength ?? 1;
    const detail = options.detail ?? null;
    const detailTiling = options.detailTiling ?? 1;
    for (let pixel = 0; pixel < width * height; pixel++)
    {
        const offset = pixel * 4;
        const selector = material.data[offset] / 255;
        const weights = materialRegionWeights(selector);
        const paint = clamp01(paintMask.data[offset] / 255 * paintStrength);
        const dirtAmount = dirt.data[offset] / 255;
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        const noise = dustNoise ? sampleRepeated(dustNoise, (x + 0.5) / width * 20, (y + 0.5) / height * 20) : null;
        const dustWeight = clamp01(dirtAmount * (noise ? noise[3] / 255 + 0.5 : 1) * DUST_APPROXIMATION);
        const diffuse = weightedColor(weights, materials.diffuse, [ 1, 1, 1 ]);
        const dustDiffuse = weightedColor(weights, materials.dustDiffuse, DEFAULT_DUST);
        const dustyDiffuse = mixColor(diffuse, dustDiffuse, dustWeight);
        const surfaceDiffuse = mixColor(dustyDiffuse, [ 1, 1, 1 ], paint);
        const fresnel = weightedColor(weights, materials.fresnel, DEFAULT_F0);
        const f0 = mixColor(fresnel, PAINT_F0, paint);
        const gloss = weightedScalar(weights, materials.gloss, 0.5);
        const reflectivity = roughness.data[offset] / 255;
        const rough = clamp01(1 - mix(reflectivity * gloss, 0.4, paint));
        let detailMultiplier = 1;
        if (detail)
        {
            const texel = sampleRepeated(detail, (x + 0.5) / width * detailTiling, (y + 0.5) / height * detailTiling);
            detailMultiplier = mix(1, texel[0] / 255, options.detailStrength ?? 1);
        }
        for (let channel = 0; channel < 3; channel++)
        {
            const albedoLinear = srgbToLinear(albedo.data[offset + channel] / 255);
            baseColor[offset + channel] = encodeSrgb(albedoLinear * surfaceDiffuse[channel] * detailMultiplier);
            specularColor[offset + channel] = encodeSrgb(f0[channel] / SPECULAR_F0_BASELINE);
        }
        baseColor[offset + 3] = albedo.data[offset + 3];
        metallicRoughness[offset] = 255;
        metallicRoughness[offset + 1] = encodeLinear(rough);
        metallicRoughness[offset + 2] = 0;
        metallicRoughness[offset + 3] = 255;
        specularColor[offset + 3] = 255;
    }
    return {
        baseColor: { width, height, data: baseColor },
        metallicRoughness: { width, height, data: metallicRoughness },
        specularColor: { width, height, data: specularColor }
    };
}

/** Legacy helper retained for users of the original two-color paint bake. */
export function blendAlbedoWithMaterials(albedo, mask, mtl1, mtl3)
{
    if (mask) mask = resampleImage(mask, albedo.width, albedo.height, "paint mask");
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

/** Legacy channel repacker; MaterialMap must not be passed as `metallic`. */
export function buildMetallicRoughnessMap(roughness, metallic, invertRoughness, glossBlend)
{
    const base = roughness ?? metallic;
    const { width, height } = base;
    if (roughness) roughness = resampleImage(roughness, width, height, "roughness");
    if (metallic) metallic = resampleImage(metallic, width, height, "metallic");
    let mask = glossBlend?.mask ?? null;
    if (mask) mask = resampleImage(mask, width, height, "paint mask");
    const g1 = glossBlend?.gloss?.[0] ?? null;
    const g3 = glossBlend?.gloss?.[2] ?? g1;
    const blendGloss = mask && g1 !== null && g3 !== null;
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++)
    {
        const r = roughness ? roughness.data[i * 4] : 255;
        let rough = invertRoughness ? 255 - r : r;
        if (roughness && blendGloss)
        {
            const w = mask.data[i * 4] / 255;
            const gloss = g1 * (1 - w) + g3 * w;
            rough = Math.round(255 - (255 - rough) * gloss);
        }
        out[i * 4] = 255;
        out[i * 4 + 1] = rough;
        out[i * 4 + 2] = metallic ? metallic.data[i * 4] : 0;
        out[i * 4 + 3] = 255;
    }
    return { width, height, data: out };
}

function buildEmissive(glow, glowColor, options = {})
{
    const { width, height } = glow;
    const color = glowColor ?? [ 1, 1, 1 ];
    const strength = Math.max(...color, 1);
    const normalized = color.map((value) => value / strength);
    const out = new Uint8Array(width * height * 4);
    const heatNoise = options.heatNoise ?? null;
    for (let pixel = 0; pixel < width * height; pixel++)
    {
        const offset = pixel * 4;
        let mask;
        if (heatNoise)
        {
            const x = pixel % width;
            const y = Math.floor(pixel / width);
            const u = (x + 0.5) / width;
            const v = (y + 0.5) / height;
            const weights = options.material ? materialRegionWeights(options.material.data[offset] / 255) : [ 1, 0, 0, 0 ];
            const heatData = [ 0, 1, 2, 3 ].map((component) => weightedScalar(
                weights,
                options.heatGlowData?.map((entry) => entry?.[component] ?? null),
                [ 1, 0.025, 4, 0.002 ][component]
            ));
            // At fixed time zero the shader's forward/backward scrolling samples
            // coincide, so their channel-wise products square the same texel.
            const noise = sampleRepeated(heatNoise, u * heatData[2], v * heatData[2]);
            const distortedU = u + ((noise[0] / 255) ** 2 - 0.5) * heatData[3];
            const distortedV = v + ((noise[1] / 255) ** 2 - 0.5) * heatData[3];
            const texel = sampleRepeated(glow, distortedU, distortedV);
            mask = (texel[0] / 255) ** 2.4 * clamp01(heatData[0]);
        }
        else
        {
            mask = (glow.data[offset] / 255) ** 2.4;
        }
        for (let channel = 0; channel < 3; channel++) out[offset + channel] = encodeSrgb(mask * normalized[channel]);
        out[offset + 3] = 255;
    }
    return { image: { width, height, data: out }, strength };
}

function buildAdditiveEmissive(layer, mask, baseColor)
{
    const { width, height } = layer;
    const alignedMask = resampleImage(mask, width, height, "additive mask");
    const color = baseColor ?? [ 1, 1, 1 ];
    const strength = Math.max(...color, 1);
    const normalized = color.map((value) => value / strength);
    const emissive = new Uint8Array(width * height * 4);
    const alpha = new Uint8Array(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++)
    {
        const offset = pixel * 4;
        const amount = layer.data[offset] / 255 * alignedMask.data[offset] / 255;
        for (let channel = 0; channel < 3; channel++) emissive[offset + channel] = encodeSrgb(amount * normalized[channel]);
        emissive[offset + 3] = 255;
        alpha[offset] = alpha[offset + 1] = alpha[offset + 2] = 0;
        alpha[offset + 3] = encodeLinear(amount);
    }
    return {
        emissive: { width, height, data: emissive },
        baseColor: { width, height, data: alpha },
        strength
    };
}

const FALLBACKS = {
    albedo: "a",
    normal: "n",
    roughness: "r",
    material: "m",
    glow: "g",
    dirt: "d",
    paintMask: "p3"
};

const QUAD_REQUIRED = [ "albedo", "normal", "roughness", "material", "glow", "dirt", "paintMask" ];

function completeMaterialSet(materials)
{
    return [ "diffuse", "fresnel", "dustDiffuse", "gloss" ].every((role) =>
        Array.isArray(materials?.[role]) && materials[role].length === 4 && materials[role].every((value) => value !== null && value !== undefined)
    );
}

/** Load and bake one SOF area. Areas are deliberately independent. */
export async function bakeTextures(stem, options = {})
{
    const names = options.textureNames ?? {};
    const resolveTexture = options.resolveTexture ?? makeFileTextureResolver(options.textureDir ?? ".");
    const textureFormat = options.textureFormat ?? { format: "png" };
    const family = options.family ?? "hull";
    const additive = family === "additive";
    const materials = options.materials ?? {
        diffuse: options.diffuse ?? null,
        fresnel: options.fresnel ?? null,
        dustDiffuse: options.dustDiffuse ?? null,
        gloss: options.gloss ?? null
    };
    if (options.tint && !materials.diffuse)
    {
        materials.diffuse = [ options.tint, options.tint, options.tint, options.tint ];
    }
    const diagnostics = {
        sourceTextures: [],
        outputTextures: [],
        resampled: [],
        missing: [],
        skipped: [],
        approximations: [],
        normal: {}
    };
    const load = async (logical, required) =>
    {
        const fallback = FALLBACKS[logical] ? `${options.fallbackStem ?? stem}_${FALLBACKS[logical]}.dds` : null;
        const label = names[logical] ?? fallback;
        if (!label)
        {
            if (required) diagnostics.missing.push({ role: logical, path: null, reason: "no authoritative resource path" });
            return null;
        }
        const bytes = await resolveTexture(logical, names[logical] ?? null, label);
        const image = await tryDecode(bytes, label);
        diagnostics.sourceTextures.push({
            role: logical,
            path: label,
            present: image !== null,
            width: image?.width ?? null,
            height: image?.height ?? null,
            colorSpace: logical === "albedo" ? "sRGB" : "linear-data"
        });
        if (!image && required) diagnostics.missing.push({ role: logical, path: label, reason: "texture bytes unavailable" });
        return image;
    };

    const strictAppearance = options.requireCompleteMaterials === true;
    const required = additive
        ? [ "layer1", "layerMask" ]
        : [ ...(strictAppearance ? QUAD_REQUIRED : [ "albedo" ]), ...(strictAppearance ? [ "dustNoise" ] : []), ...((family === "heat" || family === "heatDetail") && strictAppearance ? [ "heatGlowNoise" ] : []), ...(family === "sails" ? [ "sailsDetail" ] : []), ...(family === "detail" || family === "heatDetail" ? [ "detail1", "detail2" ] : []) ];
    const optional = additive
        ? []
        : [ "dustNoise", ...((family === "heat" || family === "heatDetail") ? [ "heatGlowNoise" ] : []) ];
    const logicalNames = new Set([ ...QUAD_REQUIRED, ...required, ...optional, "detail3" ]);
    const loaded = {};
    await Promise.all([ ...logicalNames ].map(async (logical) =>
    {
        loaded[logical] = await load(logical, required.includes(logical));
    }));

    if (!additive && options.requireCompleteMaterials === true && !completeMaterialSet(materials))
    {
        diagnostics.missing.push({ role: "materialParameters", path: null, reason: "four complete diffuse/Fresnel/dust/gloss slots are required" });
    }
    if (!additive)
    {
        diagnostics.approximations.push("Carbon dust's second shaded layer is represented by a fixed 14% diffuse blend; its independent view-dependent lighting is not retained.");
        if (family === "sails") diagnostics.approximations.push("SailsDetailMap is composited at its authored static UV tiling; scroll and deformation parameters are omitted.");
        if (family === "detail" || family === "heatDetail") diagnostics.approximations.push("Detail normal maps use their authored static masks and UV tiling; detail albedo/Fresnel overlays and animation are omitted.");
        if (family === "heat" || family === "heatDetail") diagnostics.approximations.push("Heat glow uses the authored static glow mask, heat parameters, and heat color at a fixed engine-on frame; heat animation is omitted.");
    }
    else
    {
        diagnostics.approximations.push("Additive animation and true additive blending are approximated by a fixed emissive alpha-blended material at frame zero.");
    }

    const images = [];
    const slots = {};
    async function addImage(name, rgba, logical)
    {
        const encoded = await encodeImage(rgba.width, rgba.height, rgba.data, textureFormat, logical);
        images.push({ name, data: encoded.data, mimeType: encoded.mimeType });
        diagnostics.outputTextures.push({
            role: logical,
            name,
            width: rgba.width,
            height: rgba.height,
            mimeType: encoded.mimeType,
            encoding: encoded.policy,
            bytes: encoded.data.byteLength
        });
        return images.length - 1;
    }

    if (additive)
    {
        if (loaded.layer1 && loaded.layerMask)
        {
            const baked = buildAdditiveEmissive(loaded.layer1, loaded.layerMask, options.parameters?.BaseColor?.slice(0, 3));
            slots.baseColor = await addImage(`${stem}_additive_alpha`, baked.baseColor, "baseColor");
            slots.emissive = await addImage(`${stem}_additive_emissive`, baked.emissive, "emissive");
            slots.emissiveStrength = baked.strength;
        }
    }
    else
    {
        if (loaded.normal)
        {
            const hasDetail = family === "detail" || family === "heatDetail";
            const detailMaterial = hasDetail
                ? aligned(loaded.material, loaded.normal.width, loaded.normal.height, "detail material", diagnostics.resampled)
                : null;
            const detailLayers = hasDetail
                ? [ loaded.detail1, loaded.detail2, loaded.detail3 ].flatMap((image, index) =>
                {
                    const data = options.parameters?.[`Detail${index + 1}Data`];
                    if (!image || !data || data[0] <= 0) return [];
                    return [ {
                        image,
                        tiling: data[0],
                        weight: data[1] ?? 1,
                        regionStrengths: options.parameters?.DetailSelector ?? [ 1, 1, 1, 1 ],
                        selectorMap: detailMaterial
                    } ];
                })
                : [];
            slots.normal = await addImage(`${stem}_normal`, buildNormalMap(loaded.normal, options.flipGreen === true, diagnostics.normal, detailLayers), "normal");
        }
        if (loaded.albedo && loaded.material && loaded.paintMask && loaded.roughness && loaded.dirt)
        {
            const { width, height } = loaded.albedo;
            const maps = {
                albedo: loaded.albedo,
                material: aligned(loaded.material, width, height, "material", diagnostics.resampled),
                paintMask: aligned(loaded.paintMask, width, height, "paint mask", diagnostics.resampled),
                roughness: aligned(loaded.roughness, width, height, "roughness", diagnostics.resampled),
                dirt: aligned(loaded.dirt, width, height, "dirt", diagnostics.resampled),
                dustNoise: loaded.dustNoise
            };
            const detail = family === "sails" ? loaded.sailsDetail : null;
            const detailTiling = family === "sails" ? options.parameters?.SailsDetailData?.[0] ?? 1 : 1;
            const detailStrength = family === "sails" ? options.parameters?.SailsDetailData?.[2] ?? 1 : 1;
            const baked = bakeQuadAppearance(maps, materials, {
                paintStrength: options.paintStrength ?? 1,
                detail,
                detailTiling,
                detailStrength
            });
            slots.baseColor = await addImage(`${stem}_basecolor`, baked.baseColor, "baseColor");
            slots.metallicRoughness = await addImage(`${stem}_roughness`, baked.metallicRoughness, "metallicRoughness");
            slots.specularColor = await addImage(`${stem}_specular`, baked.specularColor, "specularColor");
        }
        else if (loaded.albedo && !strictAppearance)
        {
            slots.baseColor = await addImage(`${stem}_basecolor`, loaded.albedo, "baseColor");
        }
        if (loaded.glow)
        {
            const glowColor = family === "heat" || family === "heatDetail"
                ? options.heatGlowColor ?? options.glowColor
                : options.glowColor;
            const heat = family === "heat" || family === "heatDetail";
            const emissive = buildEmissive(loaded.glow, glowColor, {
                heatNoise: heat ? loaded.heatGlowNoise : null,
                heatGlowData: heat ? materials.heatGlowData : null,
                material: heat ? aligned(loaded.material, loaded.glow.width, loaded.glow.height, "heat material", diagnostics.resampled) : null
            });
            slots.emissive = await addImage(`${stem}_emissive`, emissive.image, "emissive");
            slots.emissiveStrength = emissive.strength;
        }
    }

    for (const logical of [ "layer2" ])
    {
        if (names[logical]) diagnostics.skipped.push({ role: logical, path: names[logical], reason: "dynamic layer or secondary detail is covered by the documented static approximation" });
    }

    return {
        images,
        slots,
        skipped: [ ...diagnostics.skipped.map((entry) => `${entry.path ?? entry.role} (${entry.reason})`), ...diagnostics.approximations ],
        diagnostics,
        complete: diagnostics.missing.length === 0
    };
}
