/**
 * SOF integration: pull real faction material colors, glow colors, shader
 * identity and authoritative texture paths for one ship DNA from the client's
 * SOF catalog (data.black).
 *
 * `createSofContext` loads the catalog once; `resolveSofDna` resolves any
 * number of DNA strings against it. Texture values are full `res:/...` paths
 * so callers can resolve them against a resource index or cache.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { EveSOF } from "@carbonenginejs/runtime/sof";
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
    return EveSOF.Create({ black: bytes });
}

/**
 * @param {object} sof EveSOF instance from createSofContext.
 * @param {string} dna SOF DNA, e.g. "af1_t1:amarrbase:amarr".
 * @returns {Promise<{dna: string, geometryResPath: string|null, areas: Array<object>}>}
 */
export async function resolveSofDna(sof, dna)
{
    const values = await sof.BuildValuesFromDNA(dna);

    const mesh = values.mesh;
    if (!mesh) throw new Error(`DNA "${dna}" produced no mesh`);

    const texturesOf = (area) =>
    {
        const out = {};
        for (const res of area.effect?.resources ?? [])
        {
            if (res.resourcePath) out[res.name] = res.resourcePath;
        }
        return out;
    };

    const materialsOf = (area) => ({
        diffuse: [ 1, 2, 3, 4 ].map((n) => constant(area, `Mtl${n}DiffuseColor`)?.slice(0, 3) ?? null),
        gloss: [ 1, 2, 3, 4 ].map((n) => constant(area, `Mtl${n}Gloss`)?.[0] ?? null)
    });

    const areas = [];
    for (const group of [ "opaqueAreas", "transparentAreas", "decalAreas", "additiveAreas", "distortionAreas", "depthAreas" ])
    {
        for (const area of mesh[group] ?? [])
        {
            areas.push({
                group,
                name: area.name,
                index: area.index ?? null,
                count: area.count ?? null,
                shader: shaderFamily(area),
                textures: texturesOf(area),
                materials: materialsOf(area),
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
