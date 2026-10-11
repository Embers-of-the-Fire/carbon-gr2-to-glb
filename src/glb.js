/**
 * Minimal glTF 2.0 binary (GLB) writer.
 *
 * Takes ready-made geometry and encoded images, assembles the JSON chunk
 * and a single BIN chunk, and returns the .glb bytes.
 *
 * WebP payloads are emitted as plain `image/webp` image sources — without the
 * EXT_texture_webp extension wiring the glTF 2.0 spec would demand. This is a
 * deliberate app-internal contract: the EFA viewer (Flutter Scene) rejects
 * unknown `extensionsRequired` but decodes WebP image bytes by content
 * sniffing (package:image). Files are meant for that consumer only.
 */

const COMPONENT_FLOAT = 5126;
const COMPONENT_USHORT = 5123;
const COMPONENT_UINT = 5125;

function align4(n)
{
    return (n + 3) & ~3;
}

/**
 * @param {object} model
 * @param {Array<{name: string, positions: Float32Array, normals: Float32Array, tangents?: Float32Array|null, uvs: Float32Array, indices: Uint16Array|Uint32Array, material: number|null}>} model.primitives
 * @param {Array<{name: string, baseColor?: number, normal?: number, metallicRoughness?: number, emissive?: number, alphaMode?: string, baseColorFactor?: number[], metallicFactor?: number, roughnessFactor?: number, emissiveFactor?: number[], emissiveStrength?: number, doubleSided?: boolean}>} model.materials Texture slots are texture indices.
 * @param {Array<{name: string, data: Uint8Array, mimeType: string}>} model.images
 * @param {string} [model.name]
 * @returns {Uint8Array} GLB file bytes.
 */
export function writeGlb(model)
{
    const { primitives, materials, images } = model;

    const buffers = [];
    const bufferViews = [];
    const accessors = [];
    const textures = [];
    const gltfImages = [];
    let binLength = 0;

    function pushBuffer(bytes)
    {
        const view = { buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength };
        bufferViews.push(view);
        buffers.push(bytes);
        binLength = align4(binLength + bytes.byteLength);
        return bufferViews.length - 1;
    }

    for (const image of images)
    {
        const view = pushBuffer(image.data);
        gltfImages.push({ name: image.name, mimeType: image.mimeType, bufferView: view });
    }

    for (let i = 0; i < images.length; i++)
    {
        textures.push({ name: images[i].name, sampler: 0, source: i });
    }

    const gltfMaterials = materials.map((mat) =>
    {
        const pbr = {};
        if (mat.baseColor !== undefined && mat.baseColor !== null)
        {
            pbr.baseColorTexture = { index: mat.baseColor };
        }
        pbr.baseColorFactor = mat.baseColorFactor ?? [ 1, 1, 1, 1 ];
        if (mat.metallicRoughness !== undefined && mat.metallicRoughness !== null)
        {
            pbr.metallicRoughnessTexture = { index: mat.metallicRoughness };
        }
        pbr.metallicFactor = mat.metallicFactor ?? (mat.metallicRoughness != null ? 1 : 0);
        pbr.roughnessFactor = mat.roughnessFactor ?? 1;
        const out = { name: mat.name, pbrMetallicRoughness: pbr, doubleSided: mat.doubleSided === true };
        if (mat.normal !== undefined && mat.normal !== null) out.normalTexture = { index: mat.normal };
        if (mat.emissive !== undefined && mat.emissive !== null)
        {
            out.emissiveTexture = { index: mat.emissive };
        }
        if (out.emissiveTexture || mat.emissiveFactor || mat.emissiveStrength > 1)
        {
            out.emissiveFactor = mat.emissiveFactor ?? [ 1, 1, 1 ];
        }
        if (typeof mat.emissiveStrength === "number" && mat.emissiveStrength > 1)
        {
            out.extensions = { KHR_materials_emissive_strength: { emissiveStrength: mat.emissiveStrength } };
        }
        if (mat.alphaMode && mat.alphaMode !== "OPAQUE") out.alphaMode = mat.alphaMode;
        return out;
    });

    const gltfPrimitives = [];
    let totalVertices = 0;

    for (const prim of primitives)
    {
        const { positions, normals, tangents, uvs, indices } = prim;
        const vertexCount = positions.length / 3;
        totalVertices += vertexCount;

        const min = [ Infinity, Infinity, Infinity ];
        const max = [ -Infinity, -Infinity, -Infinity ];
        for (let i = 0; i < positions.length; i += 3)
        {
            for (let c = 0; c < 3; c++)
            {
                const v = positions[i + c];
                if (v < min[c]) min[c] = v;
                if (v > max[c]) max[c] = v;
            }
        }

        const posView = pushBuffer(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
        accessors.push({ bufferView: posView, componentType: COMPONENT_FLOAT, count: vertexCount, type: "VEC3", min, max });
        const posAccessor = accessors.length - 1;

        let nrmAccessor;
        if (normals && normals.length)
        {
            const view = pushBuffer(new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength));
            accessors.push({ bufferView: view, componentType: COMPONENT_FLOAT, count: vertexCount, type: "VEC3" });
            nrmAccessor = accessors.length - 1;
        }

        let tanAccessor;
        if (tangents && tangents.length)
        {
            const view = pushBuffer(new Uint8Array(tangents.buffer, tangents.byteOffset, tangents.byteLength));
            accessors.push({ bufferView: view, componentType: COMPONENT_FLOAT, count: vertexCount, type: "VEC4" });
            tanAccessor = accessors.length - 1;
        }

        let uvAccessor;
        if (uvs && uvs.length)
        {
            const view = pushBuffer(new Uint8Array(uvs.buffer, uvs.byteOffset, uvs.byteLength));
            accessors.push({ bufferView: view, componentType: COMPONENT_FLOAT, count: vertexCount, type: "VEC2" });
            uvAccessor = accessors.length - 1;
        }

        const indexView = pushBuffer(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength));
        const indexAccessor = accessors.length;
        accessors.push({
            bufferView: indexView,
            componentType: indices instanceof Uint32Array ? COMPONENT_UINT : COMPONENT_USHORT,
            count: indices.length,
            type: "SCALAR"
        });

        const attributes = { POSITION: posAccessor };
        if (nrmAccessor !== undefined) attributes.NORMAL = nrmAccessor;
        if (tanAccessor !== undefined) attributes.TANGENT = tanAccessor;
        if (uvAccessor !== undefined) attributes.TEXCOORD_0 = uvAccessor;

        const out = { attributes, indices: indexAccessor, mode: 4 };
        if (prim.material !== undefined && prim.material !== null) out.material = prim.material;
        gltfPrimitives.push(out);
    }

    const gltf = {
        asset: { version: "2.0", generator: "carbon-gr2-to-glb" },
        scene: 0,
        scenes: [ { name: model.name ?? "scene", nodes: [ 0 ] } ],
        nodes: [ { name: model.name ?? "mesh", mesh: 0 } ],
        meshes: [ { name: model.name ?? "mesh", primitives: gltfPrimitives } ],
        materials: gltfMaterials,
        images: gltfImages,
        textures,
        samplers: [ { wrapS: 10497, wrapT: 10497 } ],
        accessors,
        bufferViews,
        buffers: [ { byteLength: binLength } ]
    };

    const extensionsUsed = [];
    if (gltfMaterials.some((mat) => mat.extensions?.KHR_materials_emissive_strength))
    {
        extensionsUsed.push("KHR_materials_emissive_strength");
    }
    if (extensionsUsed.length)
    {
        gltf.extensionsUsed = extensionsUsed;
    }

    const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
    const jsonChunkLength = align4(jsonBytes.byteLength);
    const binChunkLength = binLength;
    const totalLength = 12 + 8 + jsonChunkLength + 8 + binChunkLength;

    const out = new Uint8Array(totalLength);
    const view = new DataView(out.buffer);
    let offset = 0;

    view.setUint32(offset, 0x46546c67, true); offset += 4; // "glTF"
    view.setUint32(offset, 2, true); offset += 4;
    view.setUint32(offset, totalLength, true); offset += 4;

    view.setUint32(offset, jsonChunkLength, true); offset += 4;
    view.setUint32(offset, 0x4e4f534a, true); offset += 4; // "JSON"
    out.set(jsonBytes, offset);
    out.fill(0x20, offset + jsonBytes.byteLength, offset + jsonChunkLength);
    offset += jsonChunkLength;

    view.setUint32(offset, binChunkLength, true); offset += 4;
    view.setUint32(offset, 0x004e4942, true); offset += 4; // "BIN\0"
    let cursor = offset;
    for (const bytes of buffers)
    {
        out.set(bytes, cursor);
        cursor = align4(cursor + bytes.byteLength);
    }

    return out;
}
