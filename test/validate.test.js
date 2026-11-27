import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { writeGlb } from "../src/glb.js";
import { validateGlb } from "../src/validate.js";

async function fixture({
    invalidIndex = false,
    material = 0,
    complete = true,
    variant = "full",
    artifactVariant = variant,
    materialFamily = "hull"
} = {})
{
    const image = await sharp({
        create: { width: 1, height: 1, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } }
    }).webp({ lossless: true }).toBuffer();
    const names = [ "basecolor", "normal", "roughness", "specular", "emissive" ];
    const images = names.map((name) => ({ name: `area_${name}`, data: new Uint8Array(image), mimeType: "image/webp" }));
    const textured = variant === "full";
    return writeGlb({
        name: "fixture",
        metadata: { variant: artifactVariant, complete, sourceMesh: "fixture", sourceLod: 0 },
        primitives: [ {
            name: "area_0",
            sourceAreaIndex: 0,
            sourceAreaName: "area_0",
            sofAreaName: "area_hull",
            conversionFamily: "hull",
            positions: new Float32Array([ 0, 0, 0, 1, 0, 0, 0, 1, 0 ]),
            normals: new Float32Array([ 0, 0, 1, 0, 0, 1, 0, 0, 1 ]),
            tangents: new Float32Array([ 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1 ]),
            uvs: new Float32Array([ 0, 0, 1, 0, 0, 1 ]),
            indices: new Uint16Array(invalidIndex ? [ 0, 1, 3 ] : [ 0, 1, 2 ]),
            material
        } ],
        materials: [ {
            name: "hull",
            baseColor: textured ? 0 : undefined,
            normal: textured ? 1 : undefined,
            metallicRoughness: textured ? 2 : undefined,
            specularColor: textured ? 3 : undefined,
            emissive: textured ? 4 : undefined,
            emissiveStrength: textured ? 1 : undefined,
            ...(materialFamily === undefined ? {} : { extras: { conversionFamily: materialFamily } })
        } ],
        images: textured ? images : []
    });
}

test("independent validation decodes geometry and every embedded texture", async () =>
{
    const report = await validateGlb(await fixture(), { variant: "full", expectedTriangles: 1, expectedAreas: [ 0 ] });
    assert.equal(report.valid, true, report.errors.join("\n"));
    assert.equal(report.stats.images, 5);
    assert.equal(report.stats.decodedTextureBytes, 20);
    assert.equal(report.stats.triangles, 1);
    assert.equal(report.warnings.length, 0);
});

test("independent validation rejects invalid indices", async () =>
{
    const report = await validateGlb(await fixture({ invalidIndex: true }));
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((error) => /index 3 is outside 3 vertices/.test(error)));
});

test("independent validation rejects LINES primitives instead of counting them as triangles", async () =>
{
    const bytes = await fixture();
    const jsonLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
    const json = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength));
    const lineModeJson = json.replace('"mode":4', '"mode":1');
    assert.notEqual(lineModeJson, json);
    bytes.set(new TextEncoder().encode(lineModeJson), 20);

    const report = await validateGlb(bytes, { expectedTriangles: 1 });
    assert.equal(report.valid, false);
    assert.equal(report.stats.triangles, 0);
    assert.ok(report.errors.some((error) => /primitive mode 1 is not TRIANGLES/.test(error)));
});

test("independent validation rejects missing or invalid primitive materials", async () =>
{
    for (const material of [ null, 1 ])
    {
        const report = await validateGlb(await fixture({ material }));
        assert.equal(report.valid, false);
        assert.ok(report.errors.some((error) => /primitive 0 has an invalid or missing material reference/.test(error)));
    }
});

test("independent validation rejects incomplete conversions", async () =>
{
    const report = await validateGlb(await fixture({ complete: false }));
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((error) => /not marked as a complete conversion/.test(error)));
});

test("base validation does not require full-variant textures", async () =>
{
    const report = await validateGlb(await fixture({ variant: "base" }), { variant: "base" });
    assert.equal(report.valid, true, report.errors.join("\n"));
    assert.equal(report.stats.images, 0);
});

test("full validation uses the primitive family when material family metadata is absent", async () =>
{
    const report = await validateGlb(await fixture({
        variant: "base",
        artifactVariant: "full",
        materialFamily: undefined
    }));
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((error) => /required base color texture is missing for hull/.test(error)));
});

test("validation rejects inconsistent primitive and material families", async () =>
{
    const report = await validateGlb(await fixture({ materialFamily: "additive" }));
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((error) => /does not match area family hull/.test(error)));
});
