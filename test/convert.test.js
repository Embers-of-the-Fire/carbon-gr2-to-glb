import { test } from "node:test";
import assert from "node:assert/strict";
import { CjsGr2Format } from "@carbonenginejs/runtime/resource/formats/gr2";
import { CjsDdsFormat } from "@carbonenginejs/runtime/resource/formats/dds";
import { PixelFormat, TextureType } from "@carbonenginejs/runtime/consts/render-context";
import { buildAreaMaterial, buildFactorMaterials, classifyArea, convertShip, pickHullArea } from "../src/convert.js";
import { validateGlb } from "../src/validate.js";
import { bakeTextures } from "../src/bake.js";

function area(name, group, index, shader, overrides = {})
{
    return {
        group,
        name,
        index,
        count: 1,
        shader,
        alphaCutout: false,
        textures: {},
        materials: {
            diffuse: [ [0.5, 0.4, 0.3], [0.1, 0.1, 0.1], [0.2, 0.2, 0.2], [0.3, 0.3, 0.3] ],
            fresnel: [ [0.1, 0.1, 0.1], [0.2, 0.2, 0.2], [0.3, 0.3, 0.3], [0.4, 0.4, 0.4] ],
            dustDiffuse: [ [0.01, 0.01, 0.01], [0.01, 0.01, 0.01], [0.01, 0.01, 0.01], [0.01, 0.01, 0.01] ],
            gloss: [ 0.5, 0.6, 0.7, 0.8 ],
            heatGlowData: [ null, null, null, null ]
        },
        parameters: {},
        paintStrength: 1,
        glowColor: [1, 0.8, 0.2],
        heatGlowColor: [2, 1, 0.5],
        ...overrides
    };
}

const rifterAreas = [
    area("area_hull", "opaqueAreas", 0, "skinned_quadv5"),
    area("area_booster", "opaqueAreas", 1, "skinned_quadheatv5"),
    area("area_sails", "opaqueAreas", 2, "skinned_quadsailsv5"),
    area("area_reactor", "opaqueAreas", 3, "skinned_quadheatv5"),
    area("area_glass", "opaqueAreas", 4, "skinned_quadglassv5")
];

const slots = {
    baseColor: 0,
    normal: 1,
    metallicRoughness: 2,
    specularColor: 3,
    emissive: 4,
    emissiveStrength: 2
};

test("pickHullArea returns a non-special opaque area", () =>
{
    assert.equal(pickHullArea({ areas: rifterAreas }).name, "area_hull");
});

test("special-area decisions are explicit and preserve source batch opacity", () =>
{
    assert.equal(classifyArea(rifterAreas[0]).family, "hull");
    assert.equal(classifyArea(rifterAreas[1]).family, "heat");
    assert.equal(classifyArea(rifterAreas[2]).family, "sails");
    assert.equal(classifyArea(rifterAreas[4]).alphaMode, "OPAQUE");
    assert.equal(classifyArea(area("canopy", "transparentAreas", 5, "quadglassv5")).alphaMode, "BLEND");
    assert.equal(classifyArea(area("distortion", "distortionAreas", 6, "fxdistortionv5")).visible, false);
    assert.equal(classifyArea(area("depth", "depthAreas", 7, "depthonlyv5")).visible, false);
});

test("additive areas use a fixed emissive approximation, not a hull material", () =>
{
    const additive = area("lightning", "additiveAreas", 3, "skinned_fxdirectionalv5", {
        parameters: { BaseColor: [0.2, 0.5, 1, 1] }
    });
    const decision = classifyArea(additive);
    const material = buildAreaMaterial(additive, { baseColor: 8, emissive: 9 }, decision);
    assert.equal(decision.family, "additive");
    assert.equal(decision.alphaMode, "BLEND");
    assert.equal(material.baseColor, 8);
    assert.equal(material.emissive, 9);
    assert.match(material.extras.conversionDecision, /frame zero/);
});

test("alpha cutout is applied independently of the bake family", () =>
{
    for (const [shader, family] of [
        [ "quadheatdetailv5", "heatDetail" ],
        [ "quadheatv5", "heat" ],
        [ "quadglassv5", "glass" ],
        [ "quadsailsv5", "sails" ],
        [ "quaddetailv5", "detail" ],
        [ "quadv5", "hull" ],
        [ "new_shader", "unsupported" ],
        [ "fxdirectionalv5", "additive" ]
    ])
    {
        assert.equal(classifyArea(area("opaque", "opaqueAreas", 0, shader)).family, family);
        for (const group of [ "opaqueAreas", "transparentAreas", "decalAreas" ])
        {
            const cutout = area("cutout", group, 0, shader, { alphaCutout: true, alphaCutoff: 0.7 });
            const decision = classifyArea(cutout);
            assert.equal(decision.family, classifyArea({ ...cutout, alphaCutout: false }).family);
            assert.equal(decision.alphaMode, "MASK");
            assert.equal(decision.alphaCutoff, 0.7);
            for (const material of [ buildAreaMaterial(cutout, slots), buildFactorMaterials({ areas: [ cutout ] }).materials[0] ])
            {
                assert.equal(material.alphaMode, "MASK");
                assert.equal(material.alphaCutoff, 0.7);
                assert.equal(material.extras.conversionFamily, decision.family);
            }
        }
    }
    assert.equal(classifyArea(area("decal", "decalAreas", 0, "quadheatdetailv5")).alphaCutoff, 0.5);
    assert.equal(classifyArea(area("cutout", "opaqueAreas", 0, "quadheatdetailv5", { alphaCutout: true, alphaCutoff: 0 })).alphaCutoff, 0);
    assert.equal(classifyArea(area("depth", "depthAreas", 0, "depthonlyv5", { alphaCutout: true })).visible, false);
});

test("surfaces without cutout preserve their existing blend behavior", () =>
{
    assert.equal(classifyArea(area("transparent", "transparentAreas", 0, "quadv5")).alphaMode, "BLEND");
    assert.equal(classifyArea(area("glass", "transparentAreas", 0, "quadglassv5")).alphaMode, "BLEND");
    assert.equal(classifyArea(area("additive", "additiveAreas", 0, "fxdirectionalv5")).alphaMode, "BLEND");
    assert.equal(classifyArea(area("heatDetail", "opaqueAreas", 0, "quadheatdetailv5")).alphaMode, undefined);
});

test("unsupported opaque shaders use their own fixed factors with a diagnostic", () =>
{
    const unknown = area("mystery", "opaqueAreas", 9, "new_shader");
    const decision = classifyArea(unknown);
    const material = buildAreaMaterial(unknown, {}, decision);
    assert.equal(decision.family, "unsupported");
    assert.deepEqual(material.baseColorFactor, [0.5, 0.4, 0.3, 1]);
    assert.match(material.extras.conversionDecision, /unsupported opaque shader/);
    assert.equal(material.baseColor, undefined);
});

test("faithful area materials bind specular and emissive features", () =>
{
    const material = buildAreaMaterial(rifterAreas[1], slots);
    assert.equal(material.baseColor, slots.baseColor);
    assert.equal(material.specularColor, slots.specularColor);
    assert.equal(material.emissive, slots.emissive);
    assert.equal(material.emissiveStrength, slots.emissiveStrength);
});

test("lightweight variant remains factor-only and area-specific", () =>
{
    const { materials, materialByArea } = buildFactorMaterials({ areas: rifterAreas });
    assert.equal(materials.length, rifterAreas.length);
    for (const material of materials)
    {
        assert.equal(material.baseColor, undefined);
        assert.equal(material.normal, undefined);
        assert.equal(material.metallicRoughness, undefined);
    }
    assert.notEqual(materialByArea.get(rifterAreas[0]), materialByArea.get(rifterAreas[2]));
});

test("lightweight base-color factors stay in range after brightness normalization", () =>
{
    for (const diffuse of [ [0.8, 0, 0], [0, 0.8, 0], [0, 0, 0.8], [0, 0, 0], [-0.1, 0.4, 0.8] ])
    {
        const hull = area("hull", "opaqueAreas", 0, "quadv5", { materials: { diffuse: [ diffuse ] } });
        const { materials } = buildFactorMaterials({ areas: [ hull ] });
        for (const value of materials[0].baseColorFactor)
        {
            assert.ok(value >= 0 && value <= 1, `factor ${value} for diffuse ${diffuse}`);
        }
    }
    const red = area("red", "opaqueAreas", 0, "quadv5", { materials: { diffuse: [ [0.8, 0, 0] ] } });
    assert.deepEqual(buildFactorMaterials({ areas: [ red ] }).materials[0].baseColorFactor, [1, 0, 0, 1]);
});

test("lightweight neutral colors retain their normalized brightness", () =>
{
    for (const value of [ 0.1, 0.5, 0.8, 1 ])
    {
        const hull = area("neutral", "opaqueAreas", 0, "quadv5", { materials: { diffuse: [ [value, value, value] ] } });
        const { materials } = buildFactorMaterials({ areas: [ hull ] });
        for (const channel of materials[0].baseColorFactor.slice(0, 3))
        {
            assert.ok(Math.abs(channel - 0.7) < 1e-12);
        }
    }
});

test("convertShip emits valid factor-only GLBs with and without resolved SOF data", async () =>
{
    const gr2 = CjsGr2Format.writeShared({
        meshes: [ {
            name: "SyntheticShip",
            vertex: {
                position: new Float32Array([ 0, 0, 0, 1, 0, 0, 0, 1, 0 ]),
                normal: new Float32Array([ 0, 0, 1, 0, 0, 1, 0, 0, 1 ]),
                texcoord0: new Float32Array([ 0, 0, 1, 0, 0, 1 ])
            },
            indices: [ { name: "area_0", faces: new Uint16Array([ 0, 1, 2 ]), bytesPerIndex: 2 } ]
        } ]
    });
    const hull = area("area_hull", "opaqueAreas", 0, "quadv5");
    for (const sofShip of [ { dna: "synthetic", geometryResPath: null, areas: [ hull ] }, null ])
    {
        const { stats, glb } = await convertShip(gr2, {
            stem: "SyntheticShip",
            sofShip,
            textureFormat: { format: "none" }
        });
        assert.equal(stats.complete, true);
        assert.equal(stats.variant, "base");
        assert.equal(stats.images.length, 0);
        assert.equal(stats.triangles, 1);
        const report = await validateGlb(glb, { variant: "base", expectedTriangles: 1 });
        assert.equal(report.valid, true, report.errors.join("\n"));
    }
});

test("convertShip uses the input stem for fallback DDS paths and per-area output names", async () =>
{
    const gr2 = CjsGr2Format.writeShared({
        meshes: [ {
            name: "af1_t1",
            vertex: {
                position: new Float32Array([ 0, 0, 0, 1, 0, 0, 0, 1, 0 ]),
                normal: new Float32Array([ 0, 0, 1, 0, 0, 1, 0, 0, 1 ]),
                texcoord0: new Float32Array([ 0, 0, 1, 0, 0, 1 ])
            },
            indices: [ { name: "area_0", faces: new Uint16Array([ 0, 1, 2 ]), bytesPerIndex: 2 } ]
        } ]
    });
    const texture = CjsDdsFormat.write({
        description: {
            type: TextureType.TEX_TYPE_2D,
            format: PixelFormat.PIXEL_FORMAT_BC1_UNORM,
            width: 4,
            height: 4,
            depth: 1,
            mipCount: 1,
            arraySize: 1
        },
        data: new Uint8Array(8)
    });
    const requested = [];
    const { stats, glb } = await convertShip(gr2, {
        stem: "af1_t1",
        resolveTexture: async (logical, resPath, fallbackName) =>
        {
            requested.push({ logical, resPath, fallbackName });
            return /^af1_t1_(a|n|r|m|g|d|p3)\.dds$/.test(fallbackName ?? "") ? texture : null;
        }
    });
    for (const [logical, suffix] of Object.entries({
        albedo: "a", normal: "n", roughness: "r", material: "m", glow: "g", dirt: "d", paintMask: "p3"
    }))
    {
        assert.deepEqual(requested.find((entry) => entry.logical === logical), {
            logical, resPath: null, fallbackName: `af1_t1_${suffix}.dds`
        });
    }
    assert.equal(stats.complete, true);
    assert.ok(stats.images.includes("af1_t1_0_area_0_basecolor"));
    assert.ok(stats.images.every((name) => name.startsWith("af1_t1_0_area_0_")));
    const report = await validateGlb(glb, { variant: "full", expectedTriangles: 1 });
    assert.equal(report.valid, true, report.errors.join("\n"));
});

test("material slots map original bake indexes once across areas and deduplicated images", async () =>
{
    const gr2 = CjsGr2Format.writeShared({
        meshes: [ {
            name: "SyntheticShip",
            vertex: {
                position: new Float32Array([ 0, 0, 0, 1, 0, 0, 0, 1, 0 ]),
                normal: new Float32Array([ 0, 0, 1, 0, 0, 1, 0, 0, 1 ]),
                texcoord0: new Float32Array([ 0, 0, 1, 0, 0, 1 ])
            },
            indices: [ { name: "area_0", faces: new Uint16Array([ 0, 1, 2 ]), bytesPerIndex: 2 } ]
        } ]
    });
    const texture = CjsDdsFormat.write({
        description: {
            type: TextureType.TEX_TYPE_2D,
            format: PixelFormat.PIXEL_FORMAT_BC1_UNORM,
            width: 4,
            height: 4,
            depth: 1,
            mipCount: 1,
            arraySize: 1
        },
        data: new Uint8Array(8)
    });
    const areas = [
        area("additive", "additiveAreas", 0, "fxdirectionalv5", {
            ordinal: 0,
            textures: { Layer1Map: "res:/layer.dds", LayerMaskMap: "res:/mask.dds" }
        }),
        area("hull", "opaqueAreas", 0, "quadv5", {
            ordinal: 1,
            textures: { DustNoiseMap: "res:/dust.dds" }
        }),
        area("secondHull", "opaqueAreas", 0, "quadv5", {
            ordinal: 2,
            textures: { DustNoiseMap: "res:/dust.dds" },
            paintStrength: 0.5
        })
    ];
    const resolveTexture = async () => texture;
    const { glb, stats } = await convertShip(gr2, {
        stem: "SyntheticShip",
        sofShip: { areas },
        resolveTexture
    });
    assert.equal(stats.complete, true);
    assert.ok(stats.diagnostics.areas[2].textures.outputTextures.some((output) => output.deduplicated));
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    const binStart = 20 + jsonLength + 8;
    for (const [index, source] of areas.entries())
    {
        const expected = await bakeTextures(`expected_${index}`, {
            family: classifyArea(source).family,
            textureNames: index === 0 ? { layer1: "res:/layer.dds", layerMask: "res:/mask.dds" } : { dustNoise: "res:/dust.dds" },
            resolveTexture,
            materials: source.materials,
            parameters: source.parameters,
            paintStrength: source.paintStrength,
            glowColor: source.glowColor,
            requireCompleteMaterials: index !== 0
        });
        const material = json.materials[index];
        const bindings = {
            normal: material.normalTexture,
            baseColor: material.pbrMetallicRoughness.baseColorTexture,
            metallicRoughness: material.pbrMetallicRoughness.metallicRoughnessTexture,
            specularColor: material.extensions?.KHR_materials_specular?.specularColorTexture,
            emissive: material.emissiveTexture
        };
        for (const [slot, binding] of Object.entries(bindings))
        {
            if (expected.slots[slot] === undefined)
            {
                assert.equal(binding, undefined);
                continue;
            }
            const image = json.images[json.textures[binding.index].source];
            const bufferView = json.bufferViews[image.bufferView];
            const bytes = glb.subarray(binStart + bufferView.byteOffset, binStart + bufferView.byteOffset + bufferView.byteLength);
            assert.deepEqual(Buffer.from(bytes), Buffer.from(expected.images[expected.slots[slot]].data), `${source.name} ${slot}`);
        }
    }
});

function meshWithEmptyGroup(includeTriangle)
{
    const indices = [ { name: "area_0", faces: new Uint16Array(0), bytesPerIndex: 2 } ];
    if (includeTriangle) indices.push({ name: "area_1", faces: new Uint16Array([ 0, 1, 2 ]), bytesPerIndex: 2 });
    return CjsGr2Format.writeShared({
        meshes: [ {
            name: "SyntheticShip",
            vertex: {
                position: new Float32Array([ 0, 0, 0, 1, 0, 0, 0, 1, 0 ]),
                normal: new Float32Array([ 0, 0, 1, 0, 0, 1, 0, 0, 1 ]),
                texcoord0: new Float32Array([ 0, 0, 1, 0, 0, 1 ])
            },
            indices
        } ]
    });
}

test("empty source groups remain diagnostic-only in base and full conversions", async () =>
{
    const empty = area("empty", "opaqueAreas", 0, "quadv5");
    const drawable = area("drawable", "opaqueAreas", 1, "new_shader");
    for (const sofShip of [ { areas: [ empty, drawable ] }, null ])
    {
        for (const format of [ "none", "png" ])
        {
            const requests = [];
            const { stats, glb } = await convertShip(meshWithEmptyGroup(true), {
                stem: "SyntheticShip",
                sofShip,
                textureFormat: { format },
                resolveTexture: async (logical, resPath, fallbackName) =>
                {
                    requests.push(fallbackName);
                    return null;
                }
            });
            assert.equal(stats.sourcePrimitives, 2);
            assert.equal(stats.primitives, 1);
            assert.equal(stats.triangles, 1);
            const diagnostic = stats.diagnostics.areas.find((entry) => entry.sourceAreaIndex === 0);
            assert.equal(diagnostic.triangles, 0);
            assert.equal(diagnostic.visible, false);
            assert.equal(diagnostic.complete, true);
            assert.match(diagnostic.reason, /no triangles/);
            assert.equal(diagnostic.textures, undefined);
            if (sofShip) assert.deepEqual(requests, []);
            const jsonLength = new DataView(glb.buffer, glb.byteOffset, glb.byteLength).getUint32(12, true);
            const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
            assert.equal(json.meshes[0].primitives.length, 1);
            assert.equal(json.accessors[json.meshes[0].primitives[0].indices].count, 3);
            assert.ok(json.bufferViews.every((view) => view.byteLength > 0));
        }
    }
});

test("conversion fails when no drawable triangles remain", async () =>
{
    for (const sofShip of [ { areas: [ area("empty", "opaqueAreas", 0, "quadv5") ] }, null ])
    {
        for (const format of [ "none", "png" ])
        {
            await assert.rejects(convertShip(meshWithEmptyGroup(false), {
                stem: "SyntheticShip",
                sofShip,
                textureFormat: { format },
                resolveTexture: async () => assert.fail("empty groups must skip texture baking")
            }), /No drawable triangles remain|has no index data/);
        }
    }
    for (const areas of [
        [ area("empty", "opaqueAreas", 0, "quadv5") ],
        [ area("depth", "depthAreas", 1, "depthonlyv5") ]
    ])
    {
        for (const format of [ "none", "png" ])
        {
            await assert.rejects(convertShip(meshWithEmptyGroup(true), {
                stem: "SyntheticShip",
                sofShip: { areas },
                textureFormat: { format },
                resolveTexture: async () => assert.fail("undrawn groups must skip texture baking")
            }), /No drawable triangles remain/);
        }
    }
});
