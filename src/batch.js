/**
 * Batch conversion driver.
 *
 * Two-phase protocol so the caller (e.g. the EFA data pipeline) keeps control
 * of all asset acquisition:
 *
 *   1. `runBatchResolve(manifest)` — resolves every job's DNA against
 *      `data.black` (loaded once) and reports the authoritative `res:/`
 *      geometry/texture paths, without reading any asset bytes.
 *   2. The caller stages those files locally, then
 *      `runBatch(manifest)` — converts every job fully offline, reading
 *      textures from the staged `textures` map.
 *
 * Manifest schema:
 * {
 *   "dataBlack": "/path/to/data.black",
 *   "lod": 0,                                  // optional default
 *   "boost": false,                            // optional default
 *   "texture": { "format": "webp", "quality": 90 },   // optional default
 *   "geometry": "meshopt",                            // optional default
 *   "jobs": [
 *     {
 *       "id": "587",                           // opaque caller key
 *       "dna": "mf4_t1:minmatarbase:minmatar",
 *       // convert phase only:
 *       "gr2": "/staged/mf4_t1.gr2",
 *       "textures": { "res:/dx9/...": "/staged/file.dds", ... },
 *       "out": "/out/587.glb"
 *     }
 *   ]
 * }
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { convertShip, pickHullArea } from "./convert.js";
import { createSofContext, resolveSofDna } from "./sof.js";
import { makeMappedTextureResolver } from "./bake.js";

function validateManifest(manifest)
{
    if (!manifest || typeof manifest !== "object") throw new Error("manifest must be a JSON object");
    if (!manifest.dataBlack) throw new Error("manifest.dataBlack is required");
    if (!Array.isArray(manifest.jobs)) throw new Error("manifest.jobs must be an array");
    for (const job of manifest.jobs)
    {
        if (!job.dna) throw new Error(`job ${JSON.stringify(job.id ?? "?")} is missing "dna"`);
    }
}

/**
 * Resolve phase: report the asset paths every job needs.
 *
 * @param {object} manifest Batch manifest; jobs need only `id` and `dna`.
 * @returns {Promise<{jobs: Array<{id: string, dna: string, geometryResPath: string|null, textureResPaths: string[], error?: string}>}>}
 */
export async function runBatchResolve(manifest)
{
    validateManifest(manifest);
    const sof = await createSofContext(manifest.dataBlack);

    const jobs = [];
    for (const job of manifest.jobs)
    {
        try
        {
            const sofShip = await resolveSofDna(sof, job.dna);
            const hullArea = pickHullArea(sofShip);
            jobs.push({
                id: job.id,
                dna: job.dna,
                geometryResPath: sofShip.geometryResPath,
                textureResPaths: hullArea ? Object.values(hullArea.textures) : []
            });
        }
        catch (error)
        {
            jobs.push({ id: job.id, dna: job.dna, geometryResPath: null, textureResPaths: [], error: String(error.message ?? error) });
        }
    }
    return { jobs };
}

/**
 * Convert phase: render every job to GLB, fully offline.
 *
 * @param {object} manifest Batch manifest; jobs need `id`, `dna`, `gr2`, `out`,
 *   and `textures` (res path -> staged local file).
 * @param {{onProgress?: (job: object, stats: object) => void}} [hooks]
 * @returns {Promise<{results: Array<{id: string, out?: string, stats?: object, error?: string}>}>}
 */
export async function runBatch(manifest, hooks = {})
{
    validateManifest(manifest);
    const sof = await createSofContext(manifest.dataBlack);

    const results = [];
    for (const job of manifest.jobs)
    {
        try
        {
            if (!job.gr2 || !job.out) throw new Error("convert-phase jobs require \"gr2\" and \"out\"");
            const sofShip = await resolveSofDna(sof, job.dna);
            const gr2Bytes = new Uint8Array(await readFile(job.gr2));
            const { glb, stats } = await convertShip(gr2Bytes, {
                stem: basename(job.gr2).replace(/\.gr2$/i, ""),
                resolveTexture: makeMappedTextureResolver(job.textures ?? {}),
                sofShip,
                lod: job.lod ?? manifest.lod,
                boost: job.boost ?? manifest.boost,
                flipGreen: job.flipGreen ?? manifest.flipGreen,
                invertRoughness: job.invertRoughness ?? manifest.invertRoughness,
                textureFormat: job.texture ?? manifest.texture,
                geometryCompression: job.geometry ?? manifest.geometry
            });
            await mkdir(dirname(job.out), { recursive: true });
            await writeFile(job.out, glb);
            results.push({ id: job.id, out: job.out, stats });
            hooks.onProgress?.(job, stats);
        }
        catch (error)
        {
            results.push({ id: job.id, error: String(error.message ?? error) });
            hooks.onProgress?.(job, null);
        }
    }
    return { results };
}
