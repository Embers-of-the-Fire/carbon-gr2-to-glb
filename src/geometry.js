/**
 * Geometry extraction: EVE shared mesh (from CjsCmfFormat.loadShared) to the
 * flat per-primitive buffers the GLB writer wants.
 *
 * EVE/Carbon is left-handed (Y up, Z forward); glTF is right-handed.
 * Conversion negates Z on positions/normals and reverses triangle winding.
 */

import { CjsGr2Format } from "@carbonenginejs/runtime/resource/formats/gr2";

const decodeTangentFrame = CjsGr2Format.tangents?.decode;

if (typeof decodeTangentFrame !== "function")
{
    throw new Error("CjsGr2Format.tangents.decode is unavailable; the runtime package does not expose tangent decoding");
}

/**
 * @param {object} shared Shared mesh root from CjsCmfFormat.loadShared.
 * @param {object} [options]
 * @param {number} [options.lod] LOD mesh index; 0 is the full-detail mesh.
 * @param {boolean} [options.convertCoordinates] LH->RH conversion. Default true.
 * @param {boolean} [options.flipV] Flip UV V coordinates. Default false (EVE UVs already match glTF's top-left origin).
 * @returns {{name: string, primitives: Array<{name, positions, normals, uvs, indices}>}}
 */
export function extractGeometry(shared, options = {})
{
    const lodIndex = options.lod ?? 0;
    const convert = options.convertCoordinates !== false;
    const flipV = options.flipV === true;

    const mesh = shared.meshes[lodIndex];
    if (!mesh) throw new Error(`no mesh at LOD index ${lodIndex} (meshes: ${shared.meshes.length})`);

    const vertex = mesh.vertex ?? mesh.lods?.[0]?.vertex;
    if (!vertex?.position?.length) throw new Error(`mesh "${mesh.name}" has no position data`);

    const vertexCount = vertex.position.length / 3;

    const positions = new Float32Array(vertex.position);
    const normals = new Float32Array(vertexCount * 3);

    if (vertex.normal?.length)
    {
        normals.set(vertex.normal);
    }
    else if (vertex.packedTangentLegacy?.length)
    {
        const packed = vertex.packedTangentLegacy;
        for (let i = 0; i < vertexCount; i++)
        {
            const frame = decodeTangentFrame(packed.slice(i * 4, i * 4 + 4));
            normals[i * 3] = frame.N[0];
            normals[i * 3 + 1] = frame.N[1];
            normals[i * 3 + 2] = frame.N[2];
        }
    }
    else
    {
        throw new Error(`mesh "${mesh.name}" has neither normal nor packedTangentLegacy data`);
    }

    if (!vertex.texcoord0?.length) throw new Error(`mesh "${mesh.name}" has no texcoord0 data`);
    const uvs = new Float32Array(vertex.texcoord0);

    if (flipV)
    {
        for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
    }

    if (convert)
    {
        for (let i = 2; i < positions.length; i += 3) positions[i] = -positions[i];
        for (let i = 2; i < normals.length; i += 3) normals[i] = -normals[i];
    }

    const indexGroups = mesh.indices ?? mesh.lods?.[0]?.indices;
    if (!Array.isArray(indexGroups) || !indexGroups.length)
    {
        throw new Error(`mesh "${mesh.name}" has no index data`);
    }

    const primitives = indexGroups.map((group, areaIndex) =>
    {
        const source = group.faces instanceof Uint16Array || group.faces instanceof Uint32Array
            ? group.faces
            : new Uint16Array(group.faces);
        const indices = new (source.constructor)(source);

        if (convert)
        {
            for (let i = 0; i < indices.length; i += 3)
            {
                const t = indices[i + 1];
                indices[i + 1] = indices[i + 2];
                indices[i + 2] = t;
            }
        }

        return {
            name: group.name ?? `area_${areaIndex}`,
            positions,
            normals,
            uvs,
            indices
        };
    });

    return { name: mesh.name, primitives };
}
