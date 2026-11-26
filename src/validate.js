
/** Independent structural validation for generated self-contained GLBs. */

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import sharp from "sharp";

const SUPPORTED_REQUIRED = new Set([ "EXT_meshopt_compression", "KHR_mesh_quantization" ]);
const SUPPORTED_USED = new Set([
    "EXT_meshopt_compression",
    "KHR_mesh_quantization",
    "KHR_materials_emissive_strength",
    "KHR_materials_specular"
]);
const QUAD_FAMILIES = new Set([ "hull", "heat", "glass", "sails", "detail", "heatDetail" ]);
let decoderReady = null;

function parseDocument(bytes)
{
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 28) throw new Error("GLB is too short");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error("GLB magic is missing");
    if (view.getUint32(4, true) !== 2) throw new Error("GLB version is not 2");
    if (view.getUint32(8, true) !== bytes.byteLength) throw new Error("GLB length field does not match the byte count");
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength + 8 > bytes.byteLength)
    {
        throw new Error("GLB JSON chunk is missing or truncated");
    }
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    const binHeader = 20 + jsonLength;
    if (view.getUint32(binHeader + 4, true) !== 0x004e4942) throw new Error("GLB BIN chunk is missing");
    const binLength = view.getUint32(binHeader, true);
    if (binHeader + 8 + binLength > bytes.byteLength) throw new Error("GLB BIN chunk is truncated");
    return { json, binStart: binHeader + 8 };
}

function textureIndexError(errors, materialName, role, texture, textureCount)
{
    if (!Number.isInteger(texture?.index) || texture.index < 0 || texture.index >= textureCount)
    {
        errors.push(`${materialName}: ${role} has an invalid texture reference`);
        return false;
    }
    return true;
}

/**
 * Parse, decode, and inspect one generated GLB. The returned report never hides
 * failures behind a successful process exit; callers decide how to persist it.
 */
export async function validateGlb(bytes, options = {})
{
    const startedAt = Date.now();
    const errors = [];
    const warnings = [];
    let parsed;
    let document;
    try
    {
        parsed = parseDocument(bytes);
        decoderReady ??= MeshoptDecoder.ready;
        await decoderReady;
        const io = new NodeIO()
            .registerExtensions(ALL_EXTENSIONS)
            .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
        document = await io.readBinary(bytes);
    }
    catch (error)
    {
        return {
            valid: false,
            errors: [ `independent GLB parse failed: ${error.message ?? error}` ],
            warnings,
            stats: { bytes: bytes?.byteLength ?? 0, durationMs: Date.now() - startedAt }
        };
    }

    const { json } = parsed;
    const root = document.getRoot();
    if (json.asset?.version !== "2.0") errors.push("asset.version is not 2.0");
    if (options.requireComplete !== false && json.asset?.extras?.complete !== true)
    {
        errors.push("asset is not marked as a complete conversion");
    }
    if (options.variant && json.asset?.extras?.variant !== options.variant)
    {
        errors.push(`expected variant ${options.variant}, found ${json.asset?.extras?.variant ?? "unknown"}`);
    }
    for (const extension of json.extensionsRequired ?? [])
    {
        if (!SUPPORTED_REQUIRED.has(extension)) errors.push(`unsupported required extension ${extension}`);
    }
    for (const extension of json.extensionsUsed ?? [])
    {
        if (!SUPPORTED_USED.has(extension)) errors.push(`unsupported emitted extension ${extension}`);
    }

    let triangles = 0;
    let primitiveVertices = 0;
    const areas = [];
    const accessors = root.listAccessors();
    for (const accessor of accessors)
    {
        const values = accessor.getArray();
        for (let index = 0; index < values.length; index++)
        {
            if (!Number.isFinite(values[index]))
            {
                errors.push(`accessor ${accessor.getName() || "unnamed"} contains non-finite data at ${index}`);
                break;
            }
        }
    }

    const meshes = root.listMeshes();
    if (meshes.length !== 1) errors.push(`expected one mesh, found ${meshes.length}`);
    for (const mesh of meshes)
    {
        for (const primitive of mesh.listPrimitives())
        {
            const position = primitive.getAttribute("POSITION");
            const normal = primitive.getAttribute("NORMAL");
            const tangent = primitive.getAttribute("TANGENT");
            const uv = primitive.getAttribute("TEXCOORD_0");
            const indices = primitive.getIndices();
            if (!position || !normal || !tangent || !uv || !indices)
            {
                errors.push(`${mesh.getName()}: primitive lacks POSITION/NORMAL/TANGENT/TEXCOORD_0/indices`);
                continue;
            }
            const vertexCount = position.getCount();
            primitiveVertices += vertexCount;
            for (const [role, accessor, components] of [ ["NORMAL", normal, 3], ["TANGENT", tangent, 4], ["TEXCOORD_0", uv, 2] ])
            {
                if (accessor.getCount() !== vertexCount) errors.push(`${mesh.getName()}: ${role} count differs from POSITION`);
                if (accessor.getElementSize() !== components) errors.push(`${mesh.getName()}: ${role} has an unexpected component count`);
            }
            const indexValues = indices.getArray();
            if (indexValues.length % 3 !== 0) errors.push(`${mesh.getName()}: indices do not contain complete triangles`);
            for (const value of indexValues)
            {
                if (!Number.isInteger(value) || value < 0 || value >= vertexCount)
                {
                    errors.push(`${mesh.getName()}: index ${value} is outside ${vertexCount} vertices`);
                    break;
                }
            }
            triangles += indexValues.length / 3;
        }
    }

    for (const [primitiveIndex, primitive] of (json.meshes?.[0]?.primitives ?? []).entries())
    {
        const extras = primitive.extras ?? {};
        if (!Number.isInteger(extras.sourceAreaIndex) || !extras.sourceAreaName || !extras.sofAreaName || !extras.conversionFamily)
        {
            errors.push(`primitive ${primitiveIndex} lacks source-area/material association metadata`);
        }
        else
        {
            areas.push({
                sourceAreaIndex: extras.sourceAreaIndex,
                sourceAreaName: extras.sourceAreaName,
                sofAreaName: extras.sofAreaName,
                conversionFamily: extras.conversionFamily
            });
        }
    }

    const textures = root.listTextures();
    let decodedTextureBytes = 0;
    const textureDimensions = [];
    for (let index = 0; index < textures.length; index++)
    {
        const texture = textures[index];
        try
        {
            const { data, info } = await sharp(Buffer.from(texture.getImage())).raw().toBuffer({ resolveWithObject: true });
            if (!info.width || !info.height || data.length !== info.width * info.height * info.channels)
            {
                throw new Error("decoded dimensions do not match the pixel payload");
            }
            decodedTextureBytes += info.width * info.height * 4;
            textureDimensions.push({ name: texture.getName(), width: info.width, height: info.height, channels: info.channels });
            if (options.maxTextureSize && (info.width > options.maxTextureSize || info.height > options.maxTextureSize))
            {
                warnings.push(`${texture.getName()}: ${info.width}x${info.height} exceeds the application import cap ${options.maxTextureSize}`);
            }
        }
        catch (error)
        {
            errors.push(`${texture.getName() || `texture ${index}`}: embedded image decode failed: ${error.message ?? error}`);
        }
    }

    for (const [materialIndex, material] of (json.materials ?? []).entries())
    {
        const name = material.name ?? `material ${materialIndex}`;
        const family = material.extras?.conversionFamily;
        const pbr = material.pbrMetallicRoughness ?? {};
        const requiredTextures = json.asset?.extras?.variant === "base"
            ? []
            : family === "additive"
                ? [ ["base color", pbr.baseColorTexture], ["emissive", material.emissiveTexture] ]
                : QUAD_FAMILIES.has(family)
                ? [
                    ["base color", pbr.baseColorTexture],
                    ["metallic/roughness", pbr.metallicRoughnessTexture],
                    ["normal", material.normalTexture],
                    ["emissive", material.emissiveTexture],
                    ["specular color", material.extensions?.KHR_materials_specular?.specularColorTexture]
                ]
                : [];
        for (const [role, texture] of requiredTextures)
        {
            if (!texture) errors.push(`${name}: required ${role} texture is missing for ${family}`);
            else textureIndexError(errors, name, role, texture, textures.length);
        }
        if (material.alphaMode && ![ "OPAQUE", "MASK", "BLEND" ].includes(material.alphaMode))
        {
            errors.push(`${name}: unsupported alphaMode ${material.alphaMode}`);
        }
    }

    if (options.expectedTriangles !== undefined && triangles !== options.expectedTriangles)
    {
        errors.push(`triangle count ${triangles} differs from expected ${options.expectedTriangles}`);
    }
    if (options.expectedAreas)
    {
        const expected = [ ...options.expectedAreas ].sort((a, b) => a - b);
        const actual = [ ...new Set(areas.map((area) => area.sourceAreaIndex)) ].sort((a, b) => a - b);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`source areas ${actual} differ from expected ${expected}`);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        stats: {
            bytes: bytes.byteLength,
            meshes: meshes.length,
            primitives: json.meshes?.[0]?.primitives?.length ?? 0,
            triangles,
            primitiveVertices,
            accessors: accessors.length,
            images: textures.length,
            decodedTextureBytes,
            textureDimensions,
            areas,
            durationMs: Date.now() - startedAt
        }
    };
}
