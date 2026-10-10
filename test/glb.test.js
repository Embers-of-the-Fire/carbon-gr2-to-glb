import { test } from "node:test";
import assert from "node:assert/strict";
import { writeGlb } from "../src/glb.js";

function parseGlb(bytes)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(0, true), 0x46546c67, "glTF magic");
    assert.equal(view.getUint32(4, true), 2, "glTF version");
    assert.equal(view.getUint32(8, true), bytes.byteLength, "total length field");
    const jsonLength = view.getUint32(12, true);
    assert.equal(view.getUint32(16, true), 0x4e4f534a, "JSON chunk type");
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    return { json, binStart: 20 + jsonLength + 8 };
}

test("writes a structurally valid GLB with one primitive", () =>
{
    const positions = new Float32Array([ 0, 0, 0, 1, 0, 0, 0, 1, 0 ]);
    const normals = new Float32Array([ 0, 0, 1, 0, 0, 1, 0, 0, 1 ]);
    const uvs = new Float32Array([ 0, 0, 1, 0, 0, 1 ]);
    const indices = new Uint16Array([ 0, 1, 2 ]);

    const glb = writeGlb({
        name: "triangle",
        primitives: [ { name: "area_0", positions, normals, uvs, indices, material: 0 } ],
        materials: [ { name: "plain" } ],
        images: []
    });

    const { json } = parseGlb(glb);
    assert.equal(json.asset.version, "2.0");
    assert.equal(json.meshes[0].primitives.length, 1);
    const prim = json.meshes[0].primitives[0];
    assert.deepEqual(prim.attributes, { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 });
    assert.equal(json.accessors[prim.indices].count, 3);
    assert.deepEqual(json.accessors[prim.attributes.POSITION].min, [ 0, 0, 0 ]);
    assert.deepEqual(json.accessors[prim.attributes.POSITION].max, [ 1, 1, 0 ]);
    const usedBytes = json.bufferViews.at(-1).byteOffset + json.bufferViews.at(-1).byteLength;
    assert.ok(json.buffers[0].byteLength >= usedBytes && json.buffers[0].byteLength - usedBytes < 4, "bin length is used bytes plus alignment padding");
});

test("embeds images and references them from material slots", () =>
{
    const png = new Uint8Array([ 0x89, 0x50, 0x4e, 0x47 ]);
    const glb = writeGlb({
        name: "textured",
        primitives: [ {
            name: "area_0",
            positions: new Float32Array(9),
            normals: new Float32Array(9),
            uvs: new Float32Array(6),
            indices: new Uint16Array([ 0, 1, 2 ]),
            material: 0
        } ],
        materials: [ { name: "tex", baseColor: 0, normal: 1, metallicRoughness: 2, emissive: 3 } ],
        images: [
            { name: "a", data: png, mimeType: "image/png" },
            { name: "b", data: png, mimeType: "image/png" },
            { name: "c", data: png, mimeType: "image/png" },
            { name: "d", data: png, mimeType: "image/png" }
        ]
    });

    const { json } = parseGlb(glb);
    assert.equal(json.images.length, 4);
    assert.equal(json.textures.length, 4);
    const mat = json.materials[0];
    assert.equal(mat.pbrMetallicRoughness.baseColorTexture.index, 0);
    assert.equal(mat.pbrMetallicRoughness.metallicRoughnessTexture.index, 2);
    assert.equal(mat.normalTexture.index, 1);
    assert.equal(mat.emissiveTexture.index, 3);
    for (const image of json.images)
    {
        assert.equal(image.mimeType, "image/png");
        assert.equal(typeof image.bufferView, "number");
    }
    for (const texture of json.textures)
    {
        assert.equal(typeof texture.source, "number");
        assert.equal(texture.extensions, undefined);
    }
});

test("wires webp images through EXT_texture_webp and marks it required", () =>
{
    const png = new Uint8Array([ 0x89, 0x50, 0x4e, 0x47 ]);
    const webp = new Uint8Array([ 0x52, 0x49, 0x46, 0x46 ]);
    const glb = writeGlb({
        name: "webp",
        primitives: [ {
            name: "area_0",
            positions: new Float32Array(9),
            normals: new Float32Array(9),
            uvs: new Float32Array(6),
            indices: new Uint16Array([ 0, 1, 2 ]),
            material: 0
        } ],
        materials: [ { name: "tex", baseColor: 0, normal: 1 } ],
        images: [
            { name: "a", data: webp, mimeType: "image/webp" },
            { name: "b", data: png, mimeType: "image/png" }
        ]
    });

    const { json } = parseGlb(glb);
    assert.deepEqual(json.extensionsRequired, [ "EXT_texture_webp" ]);
    assert.ok(json.extensionsUsed.includes("EXT_texture_webp"));
    assert.equal(json.textures[0].source, undefined);
    assert.deepEqual(json.textures[0].extensions, { EXT_texture_webp: { source: 0 } });
    assert.equal(json.textures[1].source, 1);
});

test("rejects nothing when indices exceed 16 bits via Uint32Array", () =>
{
    const glb = writeGlb({
        name: "wide",
        primitives: [ {
            name: "area_0",
            positions: new Float32Array(12),
            normals: new Float32Array(12),
            uvs: new Float32Array(8),
            indices: new Uint32Array([ 0, 1, 70000 ]),
            material: null
        } ],
        materials: [],
        images: []
    });
    const { json } = parseGlb(glb);
    assert.equal(json.accessors[json.meshes[0].primitives[0].indices].componentType, 5125);
});
