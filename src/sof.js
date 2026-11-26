/**
 * SOF integration: pull real faction material colors, glow colors, shader
 * identity and authoritative texture paths for one ship DNA from the client's
 * SOF catalog (data.black).
 *
 * `createSofContext` loads the catalog once; `resolveSofDna` resolves any
 * number of DNA strings against it. Texture values are full `res:/...` paths
 * so callers can resolve them against a resource index or cache.
 *
 * INVARIANT: the object returned by `resolveSofDna` is the converter's ONLY
 * window into data.black — `convertShip` reads SOF/catalog data exclusively
 * through it. The EFA data pipeline fingerprints this object
 * (`sofShipHash`) for its models build-state cache, so any catalog data that
 * affects GLB output must be carried on this object; extend `resolveSofDna`
 * rather than reading the catalog elsewhere.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { EveSOF } from "@carbonenginejs/runtime/sof";
import { CjsBlackFormat } from "@carbonenginejs/runtime/resource/formats/black";
import { decompressIfGzip } from "./bake.js";

function constant(area, name)
{
    return area.effect?.constParameters?.find((p) => p.name === name)?.value ?? null;
}

function shaderFamily(area)
{
    const path = area.effect?.effectFilePath ?? "";
    const file = basename(path, ".fx").toLowerCase();
    return file.replace(/^unpacked(skinned)?_/, "");
}

/**
 * @param {string|Uint8Array} dataBlack Path to the client's data.black
 *   (gzip or raw), or the catalog bytes directly.
 * @returns {Promise<object>} EveSOF instance bound to the catalog.
 */
export async function createSofContext(dataBlack)
{
    const bytes = typeof dataBlack === "string"
        ? decompressIfGzip(new Uint8Array(await readFile(dataBlack)))
        : decompressIfGzip(dataBlack);
    // New game builds can add SOF fields the runtime schema does not know yet
    // (e.g. EveSOFDataLogoSet.Corporation). EveSOF.Create reads bytes with
    // strict Black settings, so decode here with unknown-field capture and
    // hand over the object graph; unknown slots are inert for DNA builds.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const data = CjsBlackFormat.readPayload(buffer, { captureUnknownBlackFields: true }).object;
    return EveSOF.Create({ black: data });
}

/**
 * Content fingerprint of a resolved SOF ship: sha256 over the JSON of the
 * exact object `convertShip` consumes. Covers every data.black-derived value
 * that influences GLB output, so a catalog change that leaves a DNA's
 * resolved values untouched (e.g. adding an unrelated hull) does not change
 * the fingerprint. Stability relies on `resolveSofDna`'s fixed key/array
 * construction order, which makes JSON.stringify of this object graph
 * deterministic within a Node version.
 *
 * @param {object} sofShip Resolved SOF ship from resolveSofDna.
 * @returns {string} Lowercase hex sha256.
 */
export function sofShipHash(sofShip)
{
    return createHash("sha256").update(JSON.stringify(sofShip)).digest("hex");
}

/**
 * @param {object} sof EveSOF instance from createSofContext.
 * @param {string} dna SOF DNA, e.g. "af1_t1:amarrbase:amarr".
 * @returns {Promise<{dna: string, geometryResPath: string|null, areas: Array<object>}>}
 */
export async function resolveSofDna(sof, dna)
{
    const values = await sof.BuildValuesFromDNA(dna);

    const mesh = values?.mesh;
    if (!mesh)
    {
        const error = new Error(`DNA "${dna}" produced no mesh`);
        error.code = "NO_SOURCE_MESH";
        throw error;
    }

    const texturesOf = (area) =>
    {
        const out = {};
        for (const res of area.effect?.resources ?? [])
        {
            if (res.resourcePath) out[res.name] = res.resourcePath;
        }
        return out;
    };

    // Defaults from the quad shader's declared constant buffer. SOF omits
    // unassigned slots; the runtime binds the effect defaults in that case.
    const materialDefaults = {
        DiffuseColor: [ 1, 1, 1 ],
        FresnelColor: [ 1, 1, 1 ],
        DustDiffuseColor: [ 1, 1, 1 ],
        Gloss: 0.4
    };
    const materialsOf = (area) => ({
        diffuse: [ 1, 2, 3, 4 ].map((n) => constant(area, `Mtl${n}DiffuseColor`)?.slice(0, 3) ?? [ ...materialDefaults.DiffuseColor ]),
        fresnel: [ 1, 2, 3, 4 ].map((n) => constant(area, `Mtl${n}FresnelColor`)?.slice(0, 3) ?? [ ...materialDefaults.FresnelColor ]),
        dustDiffuse: [ 1, 2, 3, 4 ].map((n) => constant(area, `Mtl${n}DustDiffuseColor`)?.slice(0, 3) ?? [ ...materialDefaults.DustDiffuseColor ]),
        gloss: [ 1, 2, 3, 4 ].map((n) => constant(area, `Mtl${n}Gloss`)?.[0] ?? materialDefaults.Gloss),
        heatGlowData: [ 1, 2, 3, 4 ].map((n) => constant(area, `Mtl${n}HeatGlowData`)?.slice(0, 4) ?? null)
    });

    const parametersOf = (area) =>
    {
        const out = {};
        for (const parameter of area.effect?.constParameters ?? [])
        {
            if (parameter.name && Array.isArray(parameter.value)) out[parameter.name] = [ ...parameter.value ];
        }
        return out;
    };

    const areas = [];
    for (const group of [ "opaqueAreas", "transparentAreas", "decalAreas", "additiveAreas", "distortionAreas", "depthAreas" ])
    {
        for (const area of mesh[group] ?? [])
        {
            areas.push({
                ordinal: areas.length,
                group,
                name: area.name,
                index: area.index ?? null,
                count: area.count ?? null,
                shader: shaderFamily(area),
                shaderPath: area.effect?.effectFilePath ?? null,
                alphaCutout: area.alphaCutout === true,
                alphaCutoff: area.alphaCutoff ?? null,
                castsShadows: area.castsShadows ?? null,
                generateDepthArea: area.generateDepthArea === true,
                textures: texturesOf(area),
                materials: materialsOf(area),
                defaultedMaterialParameters: [ 1, 2, 3, 4 ].flatMap((n) =>
                    Object.keys(materialDefaults).filter((name) => constant(area, `Mtl${n}${name}`) === null).map((name) => `Mtl${n}${name}`)
                ),
                parameters: parametersOf(area),
                paintStrength: constant(area, "GeneralData")?.[0] ?? 1,
                glowColor: constant(area, "GeneralGlowColor")?.slice(0, 3) ?? null,
                heatGlowColor: constant(area, "GeneralHeatGlowColor")?.slice(0, 3) ?? null
            });
        }
    }

    return {
        dna,
        geometryResPath: mesh.geometryResPath ?? null,
        areas
    };
}

/**
 * Backward-compatible one-shot helper: load the catalog and resolve one DNA.
 *
 * @param {string|Uint8Array} dataBlackPath Path to data.black (gzip or raw), or its bytes.
 * @param {string} dna SOF DNA, e.g. "af1_t1:amarrbase:amarr".
 */
export async function loadSofShip(dataBlackPath, dna)
{
    return resolveSofDna(await createSofContext(dataBlackPath), dna);
}
