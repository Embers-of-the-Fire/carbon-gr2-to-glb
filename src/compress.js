/**
 * Optional GLB post-processing: geometry compression.
 *
 * "meshopt" applies EXT_meshopt_compression via gltf-transform (reorder +
 * quantize + meshopt). Loaders must support EXT_meshopt_compression (three.js,
 * Babylon, and the tiny meshopt decoder all do).
 */

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";

let encoderReady = null;

async function ensureEncoder()
{
    encoderReady ??= MeshoptEncoder.ready;
    await encoderReady;
}

/**
 * @param {Uint8Array} glb GLB file bytes.
 * @param {object} [options]
 * @param {"medium"|"high"} [options.level] Compression level. Default "medium".
 * @returns {Promise<Uint8Array>} Compressed GLB file bytes.
 */
export async function compressGlbGeometry(glb, options = {})
{
    await ensureEncoder();
    const io = new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
    const doc = await io.readBinary(glb);
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: options.level ?? "medium" }));
    return new Uint8Array(await io.writeBinary(doc));
}
