import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { writeGlb } from "../src/glb.js";
import { validateGlb } from "../src/validate.js";

async function fixture({ invalidIndex = false, complete = true, variant = "full" } = {})
{
    const image = await sharp({
        create: { width: 1, height: 1, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } }
    }).webp({ lossless: true }).toBuffer();
    const names = [ "basecolor", "normal", "roughness", "specular", "emissive" ];
    const images = names.map((name) => ({ name: `area_${name}`, data: new Uint8Array(image), mimeType: "image/webp" }));
    const textured = variant === "full";
    return writeGlb({
        name: "fixture",
        metadata: { variant, complete, sourceMesh: "fixture", sourceLod: 0 },
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
            material: 0
        } ],
        materials: [ {
            name: "hull",
            baseColor: textured ? 0 : undefined,
            normal: textured ? 1 : undefined,
            metallicRoughness: textured ? 2 : undefined,
            specularColor: textured ? 3 : undefined,
            emissive: textured ? 4 : undefined,
            emissiveStrength: textured ? 1 : undefined,
            extras: { conversionFamily: "hull" }
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
