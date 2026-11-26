import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
    applySharpConcurrencyFromEnv,
    bakeQuadAppearance,
    blendAlbedoWithMaterials,
    buildMetallicRoughnessMap,
    buildNormalMap,
    linearToSrgb,
    materialRegionWeights,
    resampleImage,
    srgbToLinear,
    WEBP_ENCODING_POLICY
} from "../src/bake.js";

function rgba(width, height, colorAt)
{
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const [r, g, b, a = 255] = colorAt(x, y);
            const i = (y * width + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = a;
        }
    }
    return { width, height, data };
}

function pixel(image, x, y)
{
    const i = (y * image.width + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

function materials(overrides = {})
{
    return {
        diffuse: [ [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0] ],
        fresnel: [ [0.1, 0.2, 0.3], [0.2, 0.3, 0.4], [0.3, 0.4, 0.5], [0.4, 0.5, 0.6] ],
        dustDiffuse: [ [0.01, 0.01, 0.01], [0.02, 0.02, 0.02], [0.03, 0.03, 0.03], [0.04, 0.04, 0.04] ],
        gloss: [ 0.5, 0.6, 0.7, 0.8 ],
        ...overrides
    };
}

function appearanceMaps({ selector = 0, paint = 0, reflectivity = 128, dirt = 0 } = {})
{
    return {
        albedo: rgba(1, 1, () => [128, 128, 128]),
        material: rgba(1, 1, () => [selector, 0, 0]),
        paintMask: rgba(1, 1, () => [paint, 0, 0]),
        roughness: rgba(1, 1, () => [reflectivity, 0, 0]),
        dirt: rgba(1, 1, () => [dirt, 0, 0]),
        dustNoise: null
    };
}

test("material regions reconstruct exact bands and interpolate between them", () =>
{
    assert.deepEqual(materialRegionWeights(0), [1, 0, 0, 0]);
    assert.deepEqual(materialRegionWeights(1 / 3), [0, 1, 0, 0]);
    assert.deepEqual(materialRegionWeights(2 / 3), [0, 0, 1, 0]);
    assert.deepEqual(materialRegionWeights(1), [0, 0, 0, 1]);
    const between = materialRegionWeights(1 / 6);
    assert.ok(Math.abs(between[0] - between[1]) < 1e-12);
    assert.equal(between[2], 0);
    assert.ok(Math.abs(between.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
});

test("region selectors are independent from the paint mask", () =>
{
    const red = bakeQuadAppearance(appearanceMaps({ selector: 0, paint: 0 }), materials());
    const green = bakeQuadAppearance(appearanceMaps({ selector: 85, paint: 0 }), materials());
    assert.notDeepEqual(red.baseColor.data, green.baseColor.data);
    assert.notDeepEqual(red.specularColor.data, green.specularColor.data);
    assert.equal(red.metallicRoughness.data[2], 0, "MaterialMap must never become metallic input");
    assert.equal(green.metallicRoughness.data[2], 0);
});

test("paint removes the region tint without changing albedo's color-space conversion", () =>
{
    const baked = bakeQuadAppearance(appearanceMaps({ selector: 0, paint: 255 }), materials());
    assert.deepEqual(pixel(baked.baseColor, 0, 0), [128, 128, 128, 255]);
    assert.equal(pixel(baked.metallicRoughness, 0, 0)[1], Math.round(0.6 * 255));
    assert.ok(pixel(baked.specularColor, 0, 0)[0] > 50 && pixel(baked.specularColor, 0, 0)[0] < 60, "paint uses the fixed dielectric F0");
});

test("roughness uses region gloss and reflectivity while specular preserves authored F0", () =>
{
    const baked = bakeQuadAppearance(appearanceMaps({ selector: 0, paint: 0, reflectivity: 128 }), materials());
    const expectedRoughness = Math.round((1 - 128 / 255 * 0.5) * 255);
    assert.equal(pixel(baked.metallicRoughness, 0, 0)[1], expectedRoughness);
    assert.deepEqual(pixel(baked.specularColor, 0, 0).slice(0, 3), [89, 124, 149]);
});

test("linear and sRGB conversions use the standard transfer function", () =>
{
    assert.ok(Math.abs(srgbToLinear(0.5) - 0.21404114048223255) < 1e-12);
    assert.ok(Math.abs(linearToSrgb(srgbToLinear(0.5)) - 0.5) < 1e-12);
    assert.equal(linearToSrgb(-1), 0);
    assert.equal(linearToSrgb(2), 1);
});

test("normal reconstruction retains source XY, applies source bias, and optionally flips green", () =>
{
    const source = rgba(1, 1, () => [128, 128, 0]);
    const diagnostics = {};
    const normal = buildNormalMap(source, false, diagnostics);
    const flipped = buildNormalMap(source, true, {});
    assert.equal(normal.data[2], 255);
    assert.equal(normal.data[0], flipped.data[0]);
    assert.notEqual(normal.data[1], flipped.data[1]);
    assert.equal(normal.data[3], 255);
    assert.equal(diagnostics.flipGreen, false);
    assert.equal(diagnostics.sourceBias, 0.002);
    assert.equal(diagnostics.clampedZ, 0);
});

test("detail normals combine map strength, alpha, and per-region selectors", () =>
{
    const source = rgba(1, 1, () => [128, 128, 0]);
    const detail = rgba(1, 1, () => [255, 128, 0, 255]);
    const selectorMap = rgba(1, 1, () => [255, 0, 0]);
    const layer = {
        image: detail,
        tiling: 1,
        weight: 1,
        selectorMap,
        regionStrengths: [0, 0, 0, 1]
    };
    const selected = buildNormalMap(source, false, {}, [layer]);
    const deselected = buildNormalMap(source, false, {}, [{ ...layer, regionStrengths: [1, 0, 0, 0] }]);
    assert.equal(selected.data[0], 255);
    assert.equal(deselected.data[0], 129);
});

test("resampleImage returns the input untouched when sizes match", () =>
{
    const image = rgba(2, 2, () => [1, 2, 3]);
    assert.equal(resampleImage(image, 2, 2), image);
});

test("resampleImage upscales with exact source corners", () =>
{
    const image = rgba(2, 2, (x, y) =>
    {
        const value = [0, 100, 200, 255][y * 2 + x];
        return [value, value, value];
    });
    const out = resampleImage(image, 4, 4, "paint mask");
    assert.deepEqual(pixel(out, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(pixel(out, 3, 0), [100, 100, 100, 255]);
    assert.deepEqual(pixel(out, 0, 3), [200, 200, 200, 255]);
    assert.deepEqual(pixel(out, 3, 3), [255, 255, 255, 255]);
});

test("legacy two-color paint blend remains available to library callers", () =>
{
    const albedo = rgba(2, 2, () => [255, 255, 255]);
    const mask = rgba(2, 2, (x) => [x === 0 ? 0 : 255, 0, 0]);
    const blended = blendAlbedoWithMaterials(albedo, mask, [1, 0, 0], [0, 0, 1]);
    assert.deepEqual(pixel(blended, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(blended, 1, 0), [0, 0, 255, 255]);
});

test("legacy metallic-roughness repacker retains explicit metallic inputs", () =>
{
    const roughness = rgba(2, 2, () => [100, 0, 0]);
    const metallic = rgba(2, 2, () => [50, 0, 0]);
    const out = buildMetallicRoughnessMap(roughness, metallic, false);
    assert.deepEqual(pixel(out, 0, 0), [255, 100, 50, 255]);
});

test("full-variant WebP encoding is lossless for every emitted texture role", () =>
{
    for (const slot of [ "baseColor", "normal", "metallicRoughness", "specularColor", "emissive" ])
    {
        assert.equal(WEBP_ENCODING_POLICY[slot].lossless, true, `missing lossless policy for ${slot}`);
    }
});

test("applySharpConcurrencyFromEnv caps libvips threads from the env var", () =>
{
    const previous = sharp.concurrency();
    try
    {
        applySharpConcurrencyFromEnv({ GR2_TO_GLB_SHARP_THREADS: "3" });
        assert.equal(sharp.concurrency(), 3);
        for (const invalid of [ {}, { GR2_TO_GLB_SHARP_THREADS: "abc" }, { GR2_TO_GLB_SHARP_THREADS: "-1" }, { GR2_TO_GLB_SHARP_THREADS: "1.5" } ])
        {
            applySharpConcurrencyFromEnv(invalid);
            assert.equal(sharp.concurrency(), 3);
        }
    }
    finally
    {
        sharp.concurrency(previous);
    }
});
