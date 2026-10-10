import { test } from "node:test";
import assert from "node:assert/strict";
import {
    blendAlbedoWithMaterials,
    buildMetallicRoughnessMap,
    resampleImage,
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
    assert.equal(out.width, 4);
    assert.equal(out.height, 4);
    assert.deepEqual(pixel(out, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(pixel(out, 3, 0), [100, 100, 100, 255]);
    assert.deepEqual(pixel(out, 0, 3), [200, 200, 200, 255]);
    assert.deepEqual(pixel(out, 3, 3), [255, 255, 255, 255]);
});

test("resampleImage downscales to the requested size", () =>
{
    const image = rgba(4, 4, (x) => [x * 64, 0, 0]);
    const out = resampleImage(image, 2, 2);
    assert.equal(out.width, 2);
    assert.equal(out.height, 2);
    assert.equal(out.data.length, 2 * 2 * 4);
});

test("blend uses a mask larger than the albedo without failing", () =>
{
    const albedo = rgba(4, 4, () => [255, 255, 255]);
    const mask = rgba(2, 2, () => [255, 0, 0]);
    const blended = blendAlbedoWithMaterials(albedo, mask, [1, 0, 0], [0, 0, 1]);
    assert.equal(blended.width, 4);
    assert.equal(blended.height, 4);
    for (let y = 0; y < 4; y++)
    {
        for (let x = 0; x < 4; x++)
        {
            assert.deepEqual(pixel(blended, x, y), [0, 0, 255, 255], `texel ${x},${y}`);
        }
    }
});

test("blend picks material 1 where a resampled mask is zero", () =>
{
    const albedo = rgba(4, 4, () => [255, 255, 255]);
    const mask = rgba(2, 2, () => [0, 0, 0]);
    const blended = blendAlbedoWithMaterials(albedo, mask, [1, 0, 0], [0, 0, 1]);
    assert.deepEqual(pixel(blended, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(blended, 3, 3), [255, 0, 0, 255]);
});

test("blend keeps an already matching mask per texel", () =>
{
    const albedo = rgba(4, 4, () => [255, 255, 255]);
    const mask = rgba(4, 4, (x) => [x < 2 ? 0 : 255, 0, 0]);
    const blended = blendAlbedoWithMaterials(albedo, mask, [1, 0, 0], [0, 0, 1]);
    assert.deepEqual(pixel(blended, 1, 2), [255, 0, 0, 255]);
    assert.deepEqual(pixel(blended, 2, 2), [0, 0, 255, 255]);
});

test("metallic-roughness repacks maps of differing sizes", () =>
{
    const roughness = rgba(4, 4, () => [100, 0, 0]);
    const metallic = rgba(2, 2, () => [50, 0, 0]);
    const out = buildMetallicRoughnessMap(roughness, metallic, false);
    assert.equal(out.width, 4);
    assert.equal(out.height, 4);
    assert.deepEqual(pixel(out, 0, 0), [255, 100, 50, 255]);
    assert.deepEqual(pixel(out, 3, 3), [255, 100, 50, 255]);
});

test("metallic-roughness inverts roughness when asked", () =>
{
    const roughness = rgba(2, 2, () => [100, 0, 0]);
    const out = buildMetallicRoughnessMap(roughness, null, true);
    assert.deepEqual(pixel(out, 1, 1), [255, 155, 0, 255]);
});

test("metallic-roughness applies per-material gloss through the paint mask", () =>
{
    const roughness = rgba(2, 2, () => [100, 0, 0]);
    const mask = rgba(2, 2, (x) => [x === 0 ? 0 : 255, 0, 0]);
    const out = buildMetallicRoughnessMap(roughness, null, false, { mask, gloss: [0.5, null, 1.0, null] });
    assert.equal(pixel(out, 0, 0)[1], Math.round(255 - (255 - 100) * 0.5));
    assert.equal(pixel(out, 1, 0)[1], 100);
});

test("metallic-roughness leaves roughness untouched without a mask", () =>
{
    const roughness = rgba(2, 2, () => [100, 0, 0]);
    const out = buildMetallicRoughnessMap(roughness, null, false, { mask: null, gloss: [0.5, null, 1.0, null] });
    assert.deepEqual(pixel(out, 0, 0), [255, 100, 0, 255]);
});

test("webp encoding policy covers every emitted texture slot", () =>
{
    for (const slot of [ "baseColor", "baseColorDetail", "normal", "metallicRoughness", "emissive", "emissiveHeat" ])
    {
        assert.ok(WEBP_ENCODING_POLICY[slot], `missing policy for ${slot}`);
    }
    assert.equal(WEBP_ENCODING_POLICY.baseColor.lossless, true);
    assert.equal(WEBP_ENCODING_POLICY.emissive.lossless, true);
    assert.equal(WEBP_ENCODING_POLICY.emissiveHeat.lossless, true);
    assert.equal(WEBP_ENCODING_POLICY.normal.quality, 95);
    assert.equal(WEBP_ENCODING_POLICY.normal.smartSubsample, true);
    assert.equal(WEBP_ENCODING_POLICY.metallicRoughness.quality, 95);
});
