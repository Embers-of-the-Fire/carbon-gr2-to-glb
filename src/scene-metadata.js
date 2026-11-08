/**
 * Metadata-only extraction for EVE EveSpaceScene Black descriptors.
 *
 * Carbon owns the binary Black decoding. This module deliberately performs no
 * lighting defaults, runtime overrides, vector conversion, or environment-id
 * mapping: those are data-pipeline decisions. Values are preserved verbatim
 * (including malformed values) so the caller can reject them deterministically
 * instead of silently turning them into defaults.
 */

import { readFile } from "node:fs/promises";
import "@carbonenginejs/runtime/trinity";
import { CjsBlackFormat } from "@carbonenginejs/runtime/resource/formats/black";
import { decompressIfGzip } from "./bake.js";

function copyIfPresent(out, scene, field)
{
    if (scene !== null && typeof scene === "object" && Object.hasOwn(scene, field))
    {
        out[field] = scene[field];
    }
}

/** Extract the scene fields needed to build lighting profiles. */
export function extractSceneLightingMetadata(scene)
{
    const out = {};
    for (const field of [
        "nebulaIntensity",
        "reflectionIntensity",
        "ambientColor",
        "envMapResPath",
        "sunDirection",
        "sunDiffuseColor"
    ])
    {
        copyIfPresent(out, scene, field);
    }

    const resources = scene?.backgroundEffect?.resources;
    if (resources !== undefined && resources !== null)
    {
        if (!Array.isArray(resources))
        {
            // Preserve a malformed resource table as an explicitly invalid
            // mapping rather than making it look like an absent NebulaMap.
            out.nebulaMap = null;
        }
        else
        {
            const matches = resources.filter((resource) => resource?.name === "NebulaMap");
            if (matches.length > 1)
            {
                throw new Error(`expected at most one NebulaMap resource, got ${matches.length}`);
            }
            if (matches.length === 1)
            {
                out.nebulaMap = Object.hasOwn(matches[0], "resourcePath")
                    ? matches[0].resourcePath
                    : null;
            }
        }
    }
    return out;
}

/**
 * Decode one Black payload without producing any environment assets. Any
 * valid Black root that is not an EveSpaceScene is rejected, so a job staging
 * a different Black resource fails instead of reporting success with no
 * lighting fields.
 */
export function extractSceneLightingMetadataFromBlack(blackBytes)
{
    const black = decompressIfGzip(blackBytes);
    const scene = CjsBlackFormat.readPayload(black, { captureUnknownBlackFields: true }).object;
    if (scene._type !== "EveSpaceScene")
    {
        throw new Error(`expected EveSpaceScene Black root, got ${scene._type}`);
    }
    return extractSceneLightingMetadata(scene);
}

/**
 * Metadata-only batch entry point. Manifest: `{ jobs: [{ id, black }] }`.
 * Returns `{ jobs: [{ id, ok, error?, ...metadata }] }`; no cube is read and no
 * HDR or protobuf output is written.
 */
export async function runBatchSceneMetadata(manifest)
{
    const results = [];
    for (const job of manifest.jobs ?? [])
    {
        try
        {
            const blackBytes = new Uint8Array(await readFile(job.black));
            const metadata = extractSceneLightingMetadataFromBlack(blackBytes);
            results.push({ id: job.id, ok: true, ...metadata });
        }
        catch (error)
        {
            // `job` may be null/undefined (a hole in the manifest's jobs
            // array); the failure must still be reported without rethrowing.
            results.push({ id: job?.id, ok: false, error: String(error?.message ?? error) });
        }
    }
    return { jobs: results };
}
