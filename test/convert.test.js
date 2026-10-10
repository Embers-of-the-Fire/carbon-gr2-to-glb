import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAreaMaterials, pickHullArea } from "../src/convert.js";

function area(name, group, index, shader)
{
    return {
        group,
        name,
        index,
        count: 1,
        shader,
        textures: {},
        materials: { diffuse: [ null, null, null, null ], gloss: [ null, null, null, null ] },
        glowColor: null,
        heatGlowColor: null
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
    baseColorDetail: 1,
    normal: 2,
    metallicRoughness: 3,
    emissive: 4,
    emissiveStrength: 2,
    emissiveHeat: 5,
    emissiveHeatStrength: 4
};

test("pickHullArea returns the non-heat opaque area", () =>
{
    const hull = pickHullArea({ areas: rifterAreas });
    assert.equal(hull.name, "area_hull");
});

test("buildAreaMaterials binds group indexes to area-class materials", () =>
{
    const { materials, materialByGroupIndex } = buildAreaMaterials({ areas: rifterAreas }, slots);
    const byName = Object.fromEntries(materials.map((mat, i) => [ mat.name, i ]));
    assert.equal(materialByGroupIndex.get(0), byName.hull);
    assert.equal(materialByGroupIndex.get(1), byName.heat);
    assert.equal(materialByGroupIndex.get(3), byName.heat);
    assert.equal(materialByGroupIndex.get(2), byName.sails);
    assert.equal(materialByGroupIndex.get(4), byName.glass);
});

test("heat material uses the heat emissive slot and strength", () =>
{
    const { materials, materialByGroupIndex } = buildAreaMaterials({ areas: rifterAreas }, slots);
    const heat = materials[materialByGroupIndex.get(1)];
    assert.equal(heat.emissive, slots.emissiveHeat);
    assert.equal(heat.emissiveStrength, slots.emissiveHeatStrength);
});

test("glass material is a glossy translucent blend", () =>
{
    const { materials, materialByGroupIndex } = buildAreaMaterials({ areas: rifterAreas }, slots);
    const glass = materials[materialByGroupIndex.get(4)];
    assert.equal(glass.alphaMode, "BLEND");
    assert.equal(glass.metallicFactor, 0);
    assert.ok(glass.roughnessFactor < 0.1);
    assert.ok(glass.baseColorFactor[3] < 1);
});

test("sails material falls back to the plain base color without a detail image", () =>
{
    const noDetail = { ...slots };
    delete noDetail.baseColorDetail;
    const { materials, materialByGroupIndex } = buildAreaMaterials({ areas: rifterAreas }, noDetail);
    const sails = materials[materialByGroupIndex.get(2)];
    assert.equal(sails.baseColor, slots.baseColor);
});

test("buildAreaMaterials without SOF data returns a single default material", () =>
{
    const { materials, materialByGroupIndex, defaultMaterial } = buildAreaMaterials(null, slots);
    assert.equal(materials.length, 1);
    assert.equal(materialByGroupIndex.size, 0);
    assert.equal(defaultMaterial, 0);
});
