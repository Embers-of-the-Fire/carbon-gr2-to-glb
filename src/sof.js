/**
 * SOF integration: pull real faction material colors, glow colors, shader
 * identity and authoritative texture paths for one ship DNA from the client's
 * SOF catalog (data.black).
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
 * @param {string} dataBlackPath Path to the client's data.black (gzip or raw).
 * @param {string} dna SOF DNA, e.g. "af1_t1:amarrbase:amarr".
 * @returns {Promise<{dna: string, geometryResPath: string|null, areas: Array<object>}>}
 */
export async function loadSofShip(dataBlackPath, dna)
{
    const bytes = decompressIfGzip(new Uint8Array(await readFile(dataBlackPath)));
    const sof = await EveSOF.Create({ black: bytes });
    const values = await sof.BuildValuesFromDNA(dna);

    const mesh = values.mesh;
    if (!mesh) throw new Error(`DNA "${dna}" produced no mesh`);

    const texturesOf = (area) =>
    {
        const out = {};
        for (const res of area.effect?.resources ?? [])
        {
            if (res.resourcePath) out[res.name] = basename(res.resourcePath);
        }
        return out;
    };

    const materialsOf = (area) => ({
        diffuse: [ 1, 2, 3, 4 ].map((n) => constant(area, `Mtl${n}DiffuseColor`)?.slice(0, 3) ?? null),
        gloss: [ 1, 2, 3, 4 ].map((n) => constant(area, `Mtl${n}Gloss`)?.[0] ?? null)
    });

    const areas = [];
    for (const group of [ "opaqueAreas", "transparentAreas", "decalAreas", "distortionAreas", "depthAreas" ])
    {
        for (const area of mesh[group] ?? [])
        {
            areas.push({
                group,
                name: area.name,
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
