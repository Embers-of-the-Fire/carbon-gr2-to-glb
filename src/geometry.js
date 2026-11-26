/**
 * Geometry extraction: EVE shared mesh (from CjsCmfFormat.loadShared) to the
 * flat per-primitive buffers the GLB writer wants.
 *
 * EVE/Carbon is left-handed (Y up, Z forward); glTF is right-handed.
 * Conversion negates Z on positions/normals, flips tangent Z and handedness,
 * and reverses triangle winding.
 *
 * LOD selection follows the runtime's Granny convention (see
 * @carbonenginejs/runtime resource/formats/gr2/core/targets.js): a full-detail
 * mesh named "Base" is accompanied by reduced siblings named
 * "Base LOD <threshold>". LOD 0 is always the unique unsuffixed base mesh,
 * never an arbitrary array position; higher LODs pick siblings in descending
 * threshold order. Duplicate base names, duplicate thresholds, missing bases
 * and multiple unrelated meshes are rejected as ambiguous layouts.
 *
 * Tangent frames come from the source packedTangentLegacy channel. Null
 * sentinel frames and malformed frames are repaired per vertex from
 * runtime-generated normals/tangents (generated once across all index
 * groups); vertices generation cannot help get a deterministic orthonormal
 * fallback. No triangle is removed and no vertex is compacted away.
 */

import { CjsGr2Format } from "@carbonenginejs/runtime/resource/formats/gr2";
import { generateNormals, generateTangents } from "@carbonenginejs/runtime/math/mesh";

const decodeTangentFrame = CjsGr2Format.tangents?.decode;
const isNullPackedTangent = CjsGr2Format.tangents?.isNullTangent ?? CjsGr2Format.tangents?.isNull;

if (typeof decodeTangentFrame !== "function")
{
    throw new Error("CjsGr2Format.tangents.decode is unavailable; the runtime package does not expose tangent decoding");
}

/** Granny LOD sibling suffix: "BaseName LOD <threshold>". */
const LOD_SUFFIX_PATTERN = /^(.*?) LOD (\d+)$/u;

/** Runtime index-group naming: `area_<MaterialIndex>`. */
const AREA_NAME_PATTERN = /^area_(\d+)$/u;

const VECTOR_EPSILON_SQUARED = 1e-12;

/**
 * Deterministically select the source mesh for a shared GR2 root.
 *
 * LOD 0 is the unique unsuffixed full-detail base mesh. LOD n (n >= 1) is the
 * sibling with the n-th largest threshold. The returned sibling records are
 * ordered base first, then descending threshold.
 *
 * @param {object} shared Shared mesh root from CjsCmfFormat.loadShared.
 * @param {object} [options]
 * @param {number} [options.lod] LOD rank. Default 0 (full-detail base mesh).
 * @returns {{mesh: object, index: number, name: string, lod: number, siblings: Array<{rank: number, index: number, name: string, threshold: number|null}>}}
 * @throws {Error} On ambiguous or unexpected mesh layouts and out-of-range LODs.
 */
export function selectLodMesh(shared, options = {})
{
    const meshes = shared?.meshes;
    if (!Array.isArray(meshes) || meshes.length === 0)
    {
        throw new Error("shared GR2 root contains no meshes");
    }

    const requestedLod = options.lod ?? 0;
    if (!Number.isInteger(requestedLod) || requestedLod < 0)
    {
        throw new Error(`LOD must be a non-negative integer, got ${JSON.stringify(options.lod ?? null)}`);
    }

    const baseIndexesByName = new Map();   // unsuffixed base name -> [mesh index]
    const siblingsByBase = new Map();      // base name -> [{index, threshold}]
    for (let index = 0; index < meshes.length; index++)
    {
        const name = String(meshes[index]?.name ?? "");
        const parsed = LOD_SUFFIX_PATTERN.exec(name);
        if (parsed)
        {
            const list = siblingsByBase.get(parsed[1]) ?? [];
            list.push({ index, threshold: Number(parsed[2]) });
            siblingsByBase.set(parsed[1], list);
        }
        else
        {
            const list = baseIndexesByName.get(name) ?? [];
            list.push(index);
            baseIndexesByName.set(name, list);
        }
    }

    for (const [name, indexes] of baseIndexesByName)
    {
        if (indexes.length > 1)
        {
            throw new Error(
                `ambiguous mesh layout: ${indexes.length} meshes share the unsuffixed base name "${name}"`
                + ` (indexes ${indexes.join(", ")}); refusing to pick one arbitrarily`
            );
        }
    }

    for (const [base, siblings] of siblingsByBase)
    {
        if (!baseIndexesByName.has(base))
        {
            throw new Error(
                `mesh layout error: LOD sibling${siblings.length > 1 ? "s" : ""} "${base} LOD <threshold>"`
                + ` (index${siblings.length > 1 ? "es" : ""} ${siblings.map((s) => s.index).join(", ")})`
                + ` ${siblings.length > 1 ? "have" : "has"} no unsuffixed base mesh "${base}"`
            );
        }
    }

    const baseNames = [...baseIndexesByName.keys()];
    if (baseNames.length !== 1 || siblingsByBase.size > 1)
    {
        const layout = meshes.map((mesh, index) => `${index}: "${mesh?.name ?? ""}"`).join(", ");
        throw new Error(
            `expected one ship mesh with optional "BaseName LOD <threshold>" siblings,`
            + ` found an unrelated mesh layout (${layout})`
        );
    }

    const baseName = baseNames[0];
    const baseIndex = baseIndexesByName.get(baseName)[0];
    const siblings = siblingsByBase.get(baseName) ?? [];

    const thresholdIndexes = new Map();
    for (const sibling of siblings)
    {
        if (thresholdIndexes.has(sibling.threshold))
        {
            throw new Error(
                `duplicate LOD threshold ${sibling.threshold}: meshes ${thresholdIndexes.get(sibling.threshold)}`
                + ` and ${sibling.index} are both named "${baseName} LOD ${sibling.threshold}"`
            );
        }
        thresholdIndexes.set(sibling.threshold, sibling.index);
    }

    const ordered = [
        { index: baseIndex, name: baseName, threshold: null },
        ...siblings
            .slice()
            .sort((left, right) => right.threshold - left.threshold)
            .map((sibling) => ({ index: sibling.index, name: `${baseName} LOD ${sibling.threshold}`, threshold: sibling.threshold }))
    ];

    if (requestedLod >= ordered.length)
    {
        throw new Error(
            `LOD ${requestedLod} requested, but mesh "${baseName}" only has ${ordered.length} level(s): `
            + ordered.map((entry, rank) => `LOD ${rank} = "${entry.name}"`).join(", ")
        );
    }

    const chosen = ordered[requestedLod];
    return {
        mesh: meshes[chosen.index],
        index: chosen.index,
        name: chosen.name,
        lod: requestedLod,
        siblings: ordered.map((entry, rank) => ({ rank, index: entry.index, name: entry.name, threshold: entry.threshold }))
    };
}

/**
 * @param {string|null|undefined} groupName Runtime index-group name.
 * @param {number} fallbackIndex Array position used when the name does not
 *   match the runtime's `area_<N>` convention.
 * @returns {number} Source area identity for material association.
 */
function parseSourceAreaIndex(groupName, fallbackIndex)
{
    const match = typeof groupName === "string" ? AREA_NAME_PATTERN.exec(groupName) : null;
    return match ? Number(match[1]) : fallbackIndex;
}

/**
 * Validate a float vertex channel; reject empty (when required), incomplete
 * or non-finite data.
 *
 * @returns {number|null} Vertex count carried by the channel, or null when
 *   the channel is absent and not required.
 */
function channelVertexCount(values, components, label, meshName, required)
{
    if (!values || values.length === 0)
    {
        if (required) throw new Error(`mesh "${meshName}" has no ${label} data`);
        return null;
    }
    if (values.length % components !== 0)
    {
        throw new Error(
            `mesh "${meshName}" ${label} channel has ${values.length} values,`
            + ` not a multiple of ${components} (malformed vertex data)`
        );
    }
    for (let i = 0; i < values.length; i++)
    {
        if (!Number.isFinite(values[i]))
        {
            throw new Error(`mesh "${meshName}" ${label} channel has a non-finite value at component ${i}`);
        }
    }
    return values.length / components;
}

/**
 * Validate one index group and coerce it to a fresh typed array, widening to
 * Uint32Array when the source declares 4-byte indices or references vertices
 * past the 16-bit range.
 */
function coerceIndices(faces, bytesPerIndex, vertexCount, meshName, groupName)
{
    if (faces == null)
    {
        throw new Error(`mesh "${meshName}" index group "${groupName}" has no faces`);
    }
    if (faces.length === 0)
    {
        // Zero-triangle areas are preserved, not dropped.
        return faces instanceof Uint32Array || bytesPerIndex === 4 ? new Uint32Array(0) : new Uint16Array(0);
    }
    if (faces.length % 3 !== 0)
    {
        throw new Error(
            `mesh "${meshName}" index group "${groupName}" has ${faces.length} indices,`
            + ` not a multiple of 3 (incomplete triangle)`
        );
    }
    let max = -1;
    for (let i = 0; i < faces.length; i++)
    {
        const value = faces[i];
        if (!Number.isInteger(value))
        {
            throw new Error(`mesh "${meshName}" index group "${groupName}" has a non-integer index at position ${i}`);
        }
        if (value < 0 || value >= vertexCount)
        {
            throw new Error(
                `mesh "${meshName}" index group "${groupName}" index ${value} at position ${i}`
                + ` is out of range for ${vertexCount} vertices`
            );
        }
        if (value > max) max = value;
    }
    const wide = bytesPerIndex === 4 || max > 0xffff || faces instanceof Uint32Array;
    const out = wide ? new Uint32Array(faces.length) : new Uint16Array(faces.length);
    out.set(faces);
    return out;
}

function lengthSquared3(values, offset)
{
    return values[offset] * values[offset] + values[offset + 1] * values[offset + 1] + values[offset + 2] * values[offset + 2];
}

function lengthSquaredOf(vector)
{
    return vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2];
}

/**
 * Deterministic unit tangent perpendicular to a (near-)unit normal: cross the
 * normal with the world axis it is least parallel to. Used only when tangent
 * generation leaves a degenerate (zero-length) vertex.
 */
function orthonormalTangent(normal)
{
    const nx = normal[0], ny = normal[1], nz = normal[2];
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let tx, ty, tz;
    if (ax <= ay && ax <= az) { tx = 0; ty = -nz; tz = ny; }        // cross((1,0,0), n)
    else if (ay <= az) { tx = nz; ty = 0; tz = -nx; }               // cross((0,1,0), n)
    else { tx = -ny; ty = nx; tz = 0; }                             // cross((0,0,1), n)
    const length = Math.hypot(tx, ty, tz) || 1;
    return [ tx / length, ty / length, tz / length ];
}

/** Decoded packed frame validity: finite, non-degenerate, decisive handedness. */
function validDecodedFrame(frame)
{
    const t = frame.T, b = frame.B, n = frame.N;
    for (const vector of [ t, b, n ])
    {
        for (const component of vector)
        {
            if (!Number.isFinite(component)) return false;
        }
    }
    if (lengthSquaredOf(t) <= VECTOR_EPSILON_SQUARED) return false;
    if (lengthSquaredOf(b) <= VECTOR_EPSILON_SQUARED) return false;
    if (lengthSquaredOf(n) <= VECTOR_EPSILON_SQUARED) return false;
    const cx = n[1] * t[2] - n[2] * t[1];
    const cy = n[2] * t[0] - n[0] * t[2];
    const cz = n[0] * t[1] - n[1] * t[0];
    return cx * b[0] + cy * b[1] + cz * b[2] !== 0;
}

/**
 * @param {object} shared Shared mesh root from CjsCmfFormat.loadShared.
 * @param {object} [options]
 * @param {number} [options.lod] LOD rank; 0 selects the full-detail base mesh
 *   (see selectLodMesh). Default 0.
 * @param {boolean} [options.convertCoordinates] LH->RH conversion. Default true.
 * @param {boolean} [options.flipV] Flip UV V coordinates. Default false (EVE UVs already match glTF's top-left origin).
 * @returns {{name: string, primitives: Array<object>, selection: object, diagnostics: object}}
 *   Each primitive carries positions/normals/tangents/uvs/indices buffers, the
 *   group name, and sourceAreaIndex/sourceAreaName for SOF material association.
 */
export function extractGeometry(shared, options = {})
{
    const selection = selectLodMesh(shared, options);
    const mesh = selection.mesh;
    const convert = options.convertCoordinates !== false;
    const flipV = options.flipV === true;

    const vertex = mesh.vertex ?? mesh.lods?.[0]?.vertex;
    if (!vertex?.position?.length) throw new Error(`mesh "${mesh.name}" has no position data`);

    const vertexCount = channelVertexCount(vertex.position, 3, "position", mesh.name, true);
    const uvCount = channelVertexCount(vertex.texcoord0, 2, "texcoord0", mesh.name, true);
    if (uvCount !== vertexCount)
    {
        throw new Error(`mesh "${mesh.name}" texcoord0 carries ${uvCount} vertices, expected ${vertexCount}`);
    }
    const normalCount = channelVertexCount(vertex.normal, 3, "normal", mesh.name, false);
    if (normalCount !== null && normalCount !== vertexCount)
    {
        throw new Error(`mesh "${mesh.name}" normal channel carries ${normalCount} vertices, expected ${vertexCount}`);
    }
    const packedCount = channelVertexCount(vertex.packedTangentLegacy, 4, "packedTangentLegacy", mesh.name, false);
    if (packedCount !== null && packedCount !== vertexCount)
    {
        throw new Error(`mesh "${mesh.name}" packedTangentLegacy channel carries ${packedCount} frames, expected ${vertexCount}`);
    }

    const indexGroups = mesh.indices ?? mesh.lods?.[0]?.indices;
    if (!Array.isArray(indexGroups) || !indexGroups.length)
    {
        throw new Error(`mesh "${mesh.name}" has no index data`);
    }

    const groups = indexGroups.map((group, areaIndex) =>
    {
        const name = group?.name ?? `area_${areaIndex}`;
        const faces = coerceIndices(group?.faces, group?.bytesPerIndex, vertexCount, mesh.name, name);
        return { name, faces, sourceAreaIndex: parseSourceAreaIndex(name, areaIndex) };
    });

    /** Concatenated triangle soup across all index groups, for fallback generation. */
    let allIndicesCache = null;
    const allIndices = () =>
    {
        if (allIndicesCache === null)
        {
            const total = groups.reduce((sum, group) => sum + group.faces.length, 0);
            allIndicesCache = new Uint32Array(total);
            let offset = 0;
            for (const group of groups)
            {
                allIndicesCache.set(group.faces, offset);
                offset += group.faces.length;
            }
        }
        return allIndicesCache;
    };

    // Final buffers (pre-conversion). UVs are flipped before tangent
    // generation so generated handedness matches the exported coordinates.
    const positions = new Float32Array(vertex.position);
    const uvs = new Float32Array(vertex.texcoord0);
    if (flipV)
    {
        for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
    }
    const normals = new Float32Array(vertexCount * 3);
    const tangents = new Float32Array(vertexCount * 4);

    // Decode every packed frame up front (index-aligned with vertices).
    let frames = null;
    if (packedCount !== null)
    {
        const packed = vertex.packedTangentLegacy;
        frames = new Array(vertexCount);
        for (let i = 0; i < vertexCount; i++)
        {
            const slice = packed.slice(i * 4, i * 4 + 4);
            frames[i] = { packed: slice, frame: decodeTangentFrame(slice) };
        }
    }

    // --- Normals: keep valid source normals; repair the rest per vertex.
    let repairedNormals = 0;
    let degenerateNormalFallbacks = 0;
    let generatedNormals = null;
    const normalValid = new Uint8Array(vertexCount);

    if (normalCount !== null)
    {
        const source = vertex.normal;
        for (let i = 0; i < vertexCount; i++)
        {
            if (lengthSquared3(source, i * 3) > VECTOR_EPSILON_SQUARED)
            {
                normals[i * 3] = source[i * 3];
                normals[i * 3 + 1] = source[i * 3 + 1];
                normals[i * 3 + 2] = source[i * 3 + 2];
                normalValid[i] = 1;
            }
        }
    }

    for (let i = 0; i < vertexCount; i++)
    {
        if (normalValid[i]) continue;
        const offset = i * 3;

        let replacement = null;
        const frame = frames ? frames[i].frame : null;
        if (frame && lengthSquaredOf(frame.N) > VECTOR_EPSILON_SQUARED
            && frame.N.every((component) => Number.isFinite(component)))
        {
            replacement = frame.N;
        }
        else
        {
            generatedNormals ??= generateNormals(positions, allIndices());
            const candidate = [ generatedNormals[offset], generatedNormals[offset + 1], generatedNormals[offset + 2] ];
            if (lengthSquaredOf(candidate) > VECTOR_EPSILON_SQUARED)
            {
                replacement = candidate;
            }
            else
            {
                replacement = [ 0, 0, 1 ];
                degenerateNormalFallbacks++;
            }
        }

        const length = Math.hypot(replacement[0], replacement[1], replacement[2]) || 1;
        normals[offset] = replacement[0] / length;
        normals[offset + 1] = replacement[1] / length;
        normals[offset + 2] = replacement[2] / length;
        normalValid[i] = 1;
        repairedNormals++;
    }

    // --- Tangents: keep valid decoded frames; repair null/invalid/missing.
    let nullTangentFrames = 0;
    let invalidTangentFrames = 0;
    let repairedTangents = 0;
    let degenerateTangentFallbacks = 0;
    let generatedTangents = null;
    let generatedHandedness = null;

    for (let i = 0; i < vertexCount; i++)
    {
        const offset = i * 3;
        const tOffset = i * 4;
        let valid = false;

        if (frames)
        {
            const { packed, frame } = frames[i];
            const isNull = (typeof isNullPackedTangent === "function" && isNullPackedTangent(packed)) || frame.null === true;
            if (isNull)
            {
                nullTangentFrames++;
            }
            else if (validDecodedFrame(frame))
            {
                const length = Math.hypot(frame.T[0], frame.T[1], frame.T[2]) || 1;
                tangents[tOffset] = frame.T[0] / length;
                tangents[tOffset + 1] = frame.T[1] / length;
                tangents[tOffset + 2] = frame.T[2] / length;
                const cx = frame.N[1] * frame.T[2] - frame.N[2] * frame.T[1];
                const cy = frame.N[2] * frame.T[0] - frame.N[0] * frame.T[2];
                const cz = frame.N[0] * frame.T[1] - frame.N[1] * frame.T[0];
                tangents[tOffset + 3] = cx * frame.B[0] + cy * frame.B[1] + cz * frame.B[2] >= 0 ? 1 : -1;
                valid = true;
            }
            else
            {
                invalidTangentFrames++;
            }
        }

        if (!valid)
        {
            if (generatedTangents === null)
            {
                generatedTangents = generateTangents(positions, normals, uvs, allIndices());
                generatedHandedness = generatedTangents.handedness;
            }
            const candidate = [ generatedTangents[offset], generatedTangents[offset + 1], generatedTangents[offset + 2] ];
            if (lengthSquaredOf(candidate) > VECTOR_EPSILON_SQUARED)
            {
                const length = Math.hypot(candidate[0], candidate[1], candidate[2]) || 1;
                tangents[tOffset] = candidate[0] / length;
                tangents[tOffset + 1] = candidate[1] / length;
                tangents[tOffset + 2] = candidate[2] / length;
                tangents[tOffset + 3] = generatedHandedness[i] < 0 ? -1 : 1;
            }
            else
            {
                const fallback = orthonormalTangent([ normals[offset], normals[offset + 1], normals[offset + 2] ]);
                tangents[tOffset] = fallback[0];
                tangents[tOffset + 1] = fallback[1];
                tangents[tOffset + 2] = fallback[2];
                tangents[tOffset + 3] = 1;
                degenerateTangentFallbacks++;
            }
            repairedTangents++;
        }
    }

    // Normalize kept source normals (validated finite and non-zero above).
    if (normalCount !== null)
    {
        for (let i = 0; i < vertexCount; i++)
        {
            if (!normalValid[i]) continue;
            const offset = i * 3;
            const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
            normals[offset] /= length;
            normals[offset + 1] /= length;
            normals[offset + 2] /= length;
        }
    }

    if (convert)
    {
        for (let i = 2; i < positions.length; i += 3) positions[i] = -positions[i];
        for (let i = 2; i < normals.length; i += 3) normals[i] = -normals[i];
        for (let i = 0; i < tangents.length; i += 4)
        {
            tangents[i + 2] = -tangents[i + 2];
            tangents[i + 3] = -tangents[i + 3];
        }
    }

    // Hard output guarantees: finite, unit normals/tangents, w in {+1, -1}.
    for (let i = 0; i < vertexCount; i++)
    {
        const offset = i * 3;
        const tOffset = i * 4;
        if (![ positions[offset], positions[offset + 1], positions[offset + 2],
            normals[offset], normals[offset + 1], normals[offset + 2],
            tangents[tOffset], tangents[tOffset + 1], tangents[tOffset + 2], tangents[tOffset + 3] ]
            .every(Number.isFinite))
        {
            throw new Error(`mesh "${mesh.name}" produced non-finite output at vertex ${i}`);
        }
        if (Math.abs(Math.abs(tangents[tOffset + 3]) - 1) > 0)
        {
            throw new Error(`mesh "${mesh.name}" produced an invalid tangent handedness at vertex ${i}`);
        }
    }

    const primitives = groups.map((group) =>
    {
        const indices = new group.faces.constructor(group.faces);
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
            name: group.name,
            sourceAreaIndex: group.sourceAreaIndex,
            sourceAreaName: group.name,
            positions,
            normals,
            tangents,
            uvs,
            indices
        };
    });

    const diagnostics = {
        selection: {
            index: selection.index,
            name: selection.name,
            lod: selection.lod,
            siblings: selection.siblings
        },
        vertices: vertexCount,
        areas: primitives.map((primitive) => ({
            name: primitive.sourceAreaName,
            sourceAreaIndex: primitive.sourceAreaIndex,
            triangles: primitive.indices.length / 3
        })),
        normals: {
            repaired: repairedNormals,
            degenerateFallbacks: degenerateNormalFallbacks
        },
        tangents: {
            packedChannel: packedCount !== null,
            nullFrames: nullTangentFrames,
            invalidFrames: invalidTangentFrames,
            repaired: repairedTangents,
            degenerateFallbacks: degenerateTangentFallbacks
        }
    };

    return { name: mesh.name, primitives, selection, diagnostics };
}
