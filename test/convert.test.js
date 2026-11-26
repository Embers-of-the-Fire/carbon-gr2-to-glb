import { test } from "node:test";
import assert from "node:assert/strict";
import { CjsGr2Format } from "@carbonenginejs/runtime/resource/formats/gr2";
import { buildAreaMaterial, buildFactorMaterials, classifyArea, convertShip, pickHullArea } from "../src/convert.js";
import { validateGlb } from "../src/validate.js";

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
