
/** High-level conversion: EVE ship (.gr2 + per-area DDS/SOF data) to .glb. */

import { createHash } from "node:crypto";
import { CjsGr2Format } from "@carbonenginejs/runtime/resource/formats/gr2";
import { CjsCmfFormat } from "@carbonenginejs/runtime/resource/formats/cmf";
import { extractGeometry } from "./geometry.js";
import { bakeTextures, decompressIfGzip } from "./bake.js";
import { loadSofShip } from "./sof.js";
import { writeGlb } from "./glb.js";
import { compressGlbGeometry } from "./compress.js";

const TEXTURE_ROLES = {
    AlbedoMap: "albedo",
    NormalMap: "normal",
    RoughnessMap: "roughness",
    MaterialMap: "material",
    GlowMap: "glow",
    DirtMap: "dirt",
    PaintMaskMap: "paintMask",
    DustNoiseMap: "dustNoise",
    HeatGlowNoiseMap: "heatGlowNoise",
    SailsDetailMap: "sailsDetail",
    Detail1Map: "detail1",
    Detail2Map: "detail2",
    Detail3Map: "detail3",
    Layer1Map: "layer1",
    Layer2Map: "layer2",
    LayerMaskMap: "layerMask"
};

const TEXTURE_SLOT_KEYS = [ "baseColor", "normal", "metallicRoughness", "specularColor", "emissive" ];

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

/** Lightweight-only normalization; the faithful bake never boosts brightness. */
function normalizeMaterialBrightness(diffuse)
{
    const base = diffuse?.[0];
    if (!base) return diffuse;
    const scale = 1 / Math.max(luminance(base), 1e-6);
    return diffuse.map((color) => color?.map((v) => v * scale) ?? null);
}

/** Pick a representative opaque hull for the lightweight material. */
export function pickHullArea(sofShip)
{
    return sofShip?.areas.find((area) => area.group === "opaqueAreas" && !isHeatShader(area.shader) && !isGlassShader(area.shader) && !isSailsShader(area.shader)) ?? null;
}

/**
 * Explicit static conversion decision for every source shader family. Unsupported
 * opaque families get their own factor approximation, never the primary hull.
 */
export function classifyArea(area)
{
    const shader = area.shader ?? "";
    if (area.group === "depthAreas") return { family: "depth", visible: false, reason: "depth-only areas are not visible color surfaces" };
    if (area.group === "distortionAreas" || /distortion/i.test(shader))
    {
        return { family: "distortion", visible: false, reason: "screen-space distortion has no static self-contained glTF equivalent; the area is omitted explicitly" };
    }
    if (area.group === "additiveAreas" || /(?:^|_)fx(?:directional|v5)/i.test(shader))
    {
        return { family: "additive", visible: true, alphaMode: "BLEND", doubleSided: true, reason: "fixed emissive alpha-blended approximation at frame zero" };
    }
    if (/quadheatdetail/i.test(shader)) return { family: "heatDetail", visible: true, reason: "per-area quad heat/detail static bake" };
    if (isHeatShader(shader)) return { family: "heat", visible: true, reason: "per-area quad heat static bake with authored heat glow" };
    if (isGlassShader(shader))
    {
        const transparent = area.group === "transparentAreas";
        return {
            family: "glass",
            visible: true,
            alphaMode: transparent ? "BLEND" : "OPAQUE",
            baseColorFactor: transparent ? [ 1, 1, 1, 0.35 ] : undefined,
            reason: transparent
                ? "per-area glass bake with fixed 0.35 alpha; view-dependent Fresnel opacity is not retained"
                : "per-area opaque glass bake; source batch opacity is preserved"
        };
    }
    if (area.group === "transparentAreas")
    {
        return { family: "hull", visible: true, alphaMode: "BLEND", reason: "per-area transparent quad bake using source alpha" };
    }
    if (isSailsShader(shader)) return { family: "sails", visible: true, doubleSided: true, reason: "per-area sails bake with static detail composite" };
    if (/quaddetail/i.test(shader)) return { family: "detail", visible: true, reason: "per-area quad/detail static bake" };
    if (area.group === "decalAreas" || area.alphaCutout)
    {
        return { family: "hull", visible: true, alphaMode: "MASK", alphaCutoff: area.alphaCutoff ?? 0.5, reason: "per-area decal bake with alpha cutout" };
    }
    if (/quadv5/i.test(shader) || area.group === "opaqueAreas")
    {
        const supported = /quadv5/i.test(shader);
        return {
            family: supported ? "hull" : "unsupported",
            visible: true,
            reason: supported ? "per-area opaque quad static bake" : `unsupported opaque shader ${shader || "unknown"} uses its own fixed factor approximation`
        };
    }
    return { family: "unsupported", visible: true, reason: `unsupported ${area.group} shader ${shader || "unknown"} uses its own fixed factor approximation` };
}

function emissiveFactors(glowColor)
{
    if (!glowColor) return null;
    const strength = Math.max(...glowColor, 1);
    return { emissiveFactor: glowColor.map((v) => v / strength), emissiveStrength: strength };
}

function factorForArea(area, lightweight = false)
{
    const diffuse = lightweight ? normalizeMaterialBrightness(area?.materials?.diffuse ?? null) : area?.materials?.diffuse;
    const base = diffuse?.find(Boolean) ?? [ 0.7, 0.7, 0.7 ];
    return {
        baseColorFactor: [ base[0] * (lightweight ? 0.7 : 1), base[1] * (lightweight ? 0.7 : 1), base[2] * (lightweight ? 0.7 : 1), 1 ],
        roughnessFactor: 1 - (area?.materials?.gloss?.find((value) => value !== null && value !== undefined) ?? 0.4),
        metallicFactor: lightweight ? 0.35 : 0
    };
}

/** Build the independent geometry/factor lightweight variant. */
export function buildFactorMaterials(sofShip)
{
    const materials = [];
    const materialByArea = new Map();
    if (!sofShip)
    {
        materials.push({ name: "hull", baseColorFactor: [ 0.7, 0.7, 0.7, 1 ], roughnessFactor: 0.6, metallicFactor: 0.35 });
        return { materials, materialByArea, defaultMaterial: 0 };
    }
    for (const area of sofShip.areas)
    {
        const decision = classifyArea(area);
        if (!decision.visible) continue;
        const material = {
            name: `${area.ordinal ?? area.index}_${area.name}_${decision.family}`,
            ...factorForArea(area, true),
            alphaMode: decision.alphaMode,
            alphaCutoff: decision.alphaCutoff,
            doubleSided: decision.doubleSided === true,
            extras: { conversionFamily: decision.family, conversionDecision: decision.reason }
        };
        const glow = decision.family === "heat" || decision.family === "heatDetail" ? area.heatGlowColor ?? area.glowColor : area.glowColor;
        Object.assign(material, emissiveFactors(decision.family === "additive" ? area.parameters?.BaseColor?.slice(0, 3) : glow) ?? {});
        if (decision.baseColorFactor) material.baseColorFactor = decision.baseColorFactor;
        materialByArea.set(area, materials.push(material) - 1);
    }
    return { materials, materialByArea, defaultMaterial: null };
}

/** Build one faithful material from one area's own baked slots. */
export function buildAreaMaterial(area, slots, decision = classifyArea(area))
{
    const unsupported = decision.family === "unsupported";
    const material = {
        name: `${area.ordinal ?? area.index}_${area.name}_${decision.family}`,
        baseColor: slots.baseColor,
        normal: slots.normal,
        metallicRoughness: slots.metallicRoughness,
        specularColor: slots.specularColor,
        emissive: slots.emissive,
        emissiveStrength: slots.emissiveStrength,
        alphaMode: decision.alphaMode,
        alphaCutoff: decision.alphaCutoff,
        doubleSided: decision.doubleSided === true,
        extras: { conversionFamily: decision.family, conversionDecision: decision.reason }
    };
    if (unsupported || slots.baseColor === undefined) Object.assign(material, factorForArea(area));
    if (decision.baseColorFactor) material.baseColorFactor = decision.baseColorFactor;
    if (decision.family === "additive") material.emissiveFactor = [ 1, 1, 1 ];
    return material;
}

function areaTextureNames(area)
{
    const names = {};
    for (const [sourceName, path] of Object.entries(area.textures ?? {}))
    {
        const role = TEXTURE_ROLES[sourceName];
        if (role) names[role] = path;
    }
    return names;
}

function hashImage(image)
{
    return createHash("sha256").update(image.data).digest("hex");
}

function areaKey(area)
{
    return `${area.ordinal ?? area.index ?? "null"}:${area.name ?? "unnamed"}`;
}

function unconsumedAreaTextures(area)
{
    return Object.entries(area.textures ?? {})
        .filter(([role]) => TEXTURE_ROLES[role] === undefined)
        .map(([role, path]) => ({ role, path, reason: "not consumed by the fixed static bake" }));
}

function flipGreenForArea(area, options)
{
    const keyed = options.areaNormalY?.[area.name] ?? options.areaNormalY?.[area.index];
    const normalY = keyed ?? options.normalY ?? (options.flipGreen === true ? -1 : 1);
    return normalY === -1;
}

function bakeSignature(area, decision, options)
{
    return JSON.stringify({
        textures: Object.fromEntries(Object.entries(areaTextureNames(area)).sort(([left], [right]) => left.localeCompare(right))),
        family: decision.family,
        materials: area.materials,
        paintStrength: area.paintStrength,
        glowColor: area.glowColor,
        heatGlowColor: area.heatGlowColor,
        parameters: area.parameters,
        flipGreen: flipGreenForArea(area, options),
        tint: area.group === "opaqueAreas" && area.shader === "quadv5" && area.materials?.diffuse == null ? options.tint : null
    });
}

function fallbackAreaForPrimitive(primitive)
{
    return {
        group: "opaqueAreas",
        name: primitive.sourceAreaName,
        index: primitive.sourceAreaIndex,
        shader: "quadv5",
        alphaCutout: false,
        textures: {},
        materials: { diffuse: null, fresnel: null, dustDiffuse: null, gloss: null },
        parameters: {},
        paintStrength: 1,
        glowColor: null,
        heatGlowColor: null
    };
}

/**
 * @param {Uint8Array} gr2Bytes GR2 file bytes (gzip-wrapped or raw).
 * @param {object} options Conversion options. sofShip is the only catalog input.
 * @returns {Promise<{glb: Uint8Array, stats: object}>}
 */
export async function convertShip(gr2Bytes, options)
{
    const startedAt = Date.now();
    const bytes = decompressIfGzip(gr2Bytes);
    const shared = CjsCmfFormat.loadShared(CjsGr2Format.read(bytes));
    const extracted = extractGeometry(shared, {
        lod: options.lod ?? 0,
        convertCoordinates: options.convertCoordinates,
        flipV: options.flipV
    });

    let sofShip = options.sofShip ?? null;
    if (!sofShip && options.sof) sofShip = await loadSofShip(options.sof.dataBlack, options.sof.dna);
    if (options.stem && sofShip?.geometryResPath && !sofShip.geometryResPath.toLowerCase().endsWith(`${options.stem.toLowerCase()}.gr2`))
    {
        console.warn(`warning: DNA resolves to ${sofShip.geometryResPath}, but input stem is "${options.stem}"`);
    }

    const factorOnly = options.textureFormat?.format === "none";
    const sourceByIndex = new Map();
    for (const area of sofShip?.areas ?? [])
    {
        if (area.index === null || area.index === undefined) continue;
        const list = sourceByIndex.get(area.index) ?? [];
        list.push(area);
        sourceByIndex.set(area.index, list);
    }

    const images = [];
    const imageHashes = new Map();
    let materials = [];
    const renderPrimitives = [];
    const areaDiagnostics = [];
    const missingInputs = [];
    const skippedTextures = [];
    const bakedByArea = new Map();
    const bakedBySignature = new Map();
    const reportedAreaInputs = new Set();
    let materialByArea = new Map();
    let defaultMaterial = null;

    if (factorOnly && sofShip)
    {
        ({ materials, materialByArea, defaultMaterial } = buildFactorMaterials(sofShip));
    }
    else if (factorOnly)
    {
        ({ materials, defaultMaterial } = buildFactorMaterials(null));
    }

    for (const primitive of extracted.primitives)
    {
        const areas = sofShip ? sourceByIndex.get(primitive.sourceAreaIndex) ?? [] : [ fallbackAreaForPrimitive(primitive) ];
        if (sofShip && areas.length === 0)
        {
            areaDiagnostics.push({
                primitive: primitive.sourceAreaName,
                sourceAreaIndex: primitive.sourceAreaIndex,
                decision: "not drawn",
                visible: false,
                complete: true,
                reason: "source mesh group is absent from all SOF color draw lists"
            });
        }
        for (const area of areas)
        {
            const decision = classifyArea(area);
            const key = areaKey(area);
            const diagnostic = {
                primitive: primitive.sourceAreaName,
                sourceAreaIndex: primitive.sourceAreaIndex,
                sofArea: area.name,
                sofOrdinal: area.ordinal ?? null,
                group: area.group,
                shader: area.shader,
                defaultedMaterialParameters: area.defaultedMaterialParameters ?? [],
                family: decision.family,
                visible: decision.visible,
                decision: decision.reason,
                triangles: primitive.indices.length / 3,
                complete: true
            };
            areaDiagnostics.push(diagnostic);
            if (!factorOnly && !reportedAreaInputs.has(area))
            {
                reportedAreaInputs.add(area);
                const unconsumed = unconsumedAreaTextures(area);
                diagnostic.unconsumedTextures = unconsumed;
                skippedTextures.push(...unconsumed.map((entry) => `${key}: ${entry.path} (${entry.role}: ${entry.reason})`));
            }
            if (!decision.visible) continue;

            let materialIndex;
            if (factorOnly)
            {
                materialIndex = sofShip ? materialByArea.get(area) : defaultMaterial;
            }
            else
            {
                let baked = bakedByArea.get(area);
                if (!baked && decision.family === "unsupported")
                {
                    baked = { slots: {}, complete: true };
                    bakedByArea.set(area, baked);
                }
                if (!baked)
                {
                    const signature = bakeSignature(area, decision, options);
                    const shared = bakedBySignature.get(signature);
                    if (shared)
                    {
                        baked = shared;
                        diagnostic.textures = shared.diagnostics;
                        diagnostic.normalOrientation = shared.diagnostics.normal;
                        diagnostic.complete = shared.complete;
                        diagnostic.reusedEquivalentAreaBake = true;
                        skippedTextures.push(...shared.skipped.map((reason) => `${key}: ${reason}`));
                        for (const missing of shared.diagnostics.missing)
                        {
                            missingInputs.push({ area: area.name, index: area.index, ...missing });
                        }
                    }
                    else
                    {
                        const stem = `${options.stem}_${String(area.ordinal ?? area.index ?? "x")}_${String(area.name ?? "area").replace(/[^a-z0-9_-]+/gi, "_")}`;
                        const result = await bakeTextures(stem, {
                            textureDir: options.textureDir,
                            resolveTexture: options.resolveTexture,
                            flipGreen: flipGreenForArea(area, options),
                            textureNames: areaTextureNames(area),
                            materials: area.materials,
                            tint: sofShip ? null : options.tint,
                            paintStrength: area.paintStrength,
                            glowColor: area.glowColor,
                            heatGlowColor: area.heatGlowColor,
                            parameters: area.parameters,
                            family: decision.family === "unsupported" ? "hull" : decision.family,
                            textureFormat: options.textureFormat,
                            requireCompleteMaterials: sofShip !== null && decision.family !== "additive" && decision.family !== "unsupported"
                        });
                        const slots = { ...result.slots };
                        for (const image of result.images)
                        {
                            const hash = hashImage(image);
                            let imageIndex = imageHashes.get(hash);
                            if (imageIndex === undefined)
                            {
                                imageIndex = images.push(image) - 1;
                                imageHashes.set(hash, imageIndex);
                            }
                            const localIndex = result.images.indexOf(image);
                            for (const slot of TEXTURE_SLOT_KEYS)
                            {
                                if (slots[slot] === localIndex) slots[slot] = imageIndex;
                            }
                        }
                        for (const missing of result.diagnostics.missing)
                        {
                            missingInputs.push({ area: area.name, index: area.index, ...missing });
                        }
                        for (const output of result.diagnostics.outputTextures)
                        {
                            const image = result.images[result.diagnostics.outputTextures.indexOf(output)];
                            output.deduplicated = !images.includes(image);
                        }
                        skippedTextures.push(...result.skipped.map((reason) => `${key}: ${reason}`));
                        diagnostic.normalOrientation = result.diagnostics.normal;
                        diagnostic.textures = result.diagnostics;
                        diagnostic.complete = result.complete;
                        baked = { slots, complete: result.complete, diagnostics: result.diagnostics, skipped: result.skipped };
                        bakedBySignature.set(signature, baked);
                    }
                    bakedByArea.set(area, baked);
                }
                if (decision.family === "unsupported")
                {
                    diagnostic.complete = true;
                    diagnostic.fallback = "own-area factor material; no primary-hull substitution";
                }
                materialIndex = materials.push(buildAreaMaterial(area, baked.slots, decision)) - 1;
            }
            renderPrimitives.push({
                ...primitive,
                sofAreaName: area.name,
                conversionFamily: decision.family,
                material: materialIndex ?? defaultMaterial
            });
        }
    }

    const complete = missingInputs.length === 0 && areaDiagnostics.every((area) => area.complete !== false);
    const glbMaterials = materials.length ? materials : [ { name: "unassigned", baseColorFactor: [ 0.7, 0.7, 0.7, 1 ] } ];
    let glb = writeGlb({
        name: extracted.name,
        primitives: renderPrimitives,
        materials: glbMaterials,
        images,
        metadata: {
            variant: factorOnly ? "base" : "full",
            complete,
            sourceMesh: extracted.name,
            sourceLod: options.lod ?? 0
        }
    });
    if (options.geometryCompression === "meshopt") glb = await compressGlbGeometry(glb);

    return {
        glb,
        stats: {
            variant: factorOnly ? "base" : "full",
            complete,
            mesh: extracted.name,
            dna: sofShip?.dna ?? null,
            shader: pickHullArea(sofShip)?.shader ?? null,
            lod: options.lod ?? 0,
            lodIdentity: extracted.diagnostics?.selection ?? null,
            lodsAvailable: extracted.selection?.siblings?.length ?? shared.meshes.length,
            primitives: renderPrimitives.length,
            sourcePrimitives: extracted.primitives.length,
            triangles: renderPrimitives.reduce((sum, primitive) => sum + primitive.indices.length / 3, 0),
            sourceTriangles: extracted.primitives.reduce((sum, primitive) => sum + primitive.indices.length / 3, 0),
            vertices: extracted.primitives.length ? extracted.primitives[0].positions.length / 3 : 0,
            images: images.map((image) => image.name),
            materials: glbMaterials.map((material) => material.name),
            skippedTextures,
            missingInputs,
            diagnostics: {
                geometry: extracted.diagnostics,
                areas: areaDiagnostics,
                missingInputs,
                specialAreaDecisions: areaDiagnostics.map((area) => ({ area: area.sofArea, family: area.family, decision: area.decision })),
                complete
            },
            compression: {
                textures: options.textureFormat?.format ?? "png",
                geometry: options.geometryCompression ?? "none"
            },
            bytes: glb.byteLength,
            durationMs: Date.now() - startedAt
        }
    };
}
