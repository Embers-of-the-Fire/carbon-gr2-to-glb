import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    extractSceneLightingMetadata,
    extractSceneLightingMetadataFromBlack,
    runBatchSceneMetadata
} from "../src/scene-metadata.js";

/**
 * Build a minimal valid Black payload whose root is `rootClassName` with no
 * fields: FOURCC + version, a string table naming only the root class, an
 * empty wide-string table, and a root object carrying just the class-name
 * reference. Any schema class with no fields decodes from this.
 */
function makeBlackBytes(rootClassName)
{
    const bytes = [];
    const pushU16 = (value) => bytes.push(value & 0xff, (value >> 8) & 0xff);
    const pushU32 = (value) => bytes.push(
        value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff
    );

    pushU32(0xB1ACF11E); // Black FOURCC.
    pushU32(1); // Stream version.
    // String table: the root class name at index 0. Payload objects name
    // their class through a u16 index into this table.
    const stringTable = [ 1, 0, ...new TextEncoder().encode(rootClassName), 0 ];
    pushU32(stringTable.length);
    bytes.push(...stringTable);
    // Wide string table: empty.
    pushU32(2);
    pushU16(0);
    // Root object: reference 1, payload holding only the class-name ref.
    pushU32(1);
    pushU32(2);
    pushU16(0);
    return Uint8Array.from(bytes);
}

test("extractSceneLightingMetadata preserves source values and NebulaMap provenance", () =>
{
    const scene = {
        _type: "EveSpaceScene",
        backgroundEffect: {
            resources: [
                { name: "Other", resourcePath: "res:/other.dds" },
                { name: "NebulaMap", resourcePath: "res:/dx9/scene/universe/a05_cube.dds" }
            ]
        },
        ambientColor: [ 0.09, 0.07, 0.04, 1 ],
        nebulaIntensity: 1.25,
        reflectionIntensity: 1.55,
        envMapResPath: "res:/dx9/scene/universe/a05_cube_refl.dds",
        sunDirection: [ -1, -1, 1 ],
        sunDiffuseColor: [ 1.5, 1.5, 1.5, 1 ]
    };
    assert.deepEqual(extractSceneLightingMetadata(scene), {
        nebulaIntensity: 1.25,
        reflectionIntensity: 1.55,
        ambientColor: [ 0.09, 0.07, 0.04, 1 ],
        envMapResPath: "res:/dx9/scene/universe/a05_cube_refl.dds",
        sunDirection: [ -1, -1, 1 ],
        sunDiffuseColor: [ 1.5, 1.5, 1.5, 1 ],
        nebulaMap: "res:/dx9/scene/universe/a05_cube.dds"
    });
});

test("extractSceneLightingMetadata distinguishes absent and malformed fields", () =>
{
    assert.deepEqual(extractSceneLightingMetadata({}), {});
    assert.deepEqual(
        extractSceneLightingMetadata({ backgroundEffect: { resources: {} } }),
        { nebulaMap: null }
    );
    const malformed = extractSceneLightingMetadata({
        backgroundEffect: { resources: [ { name: "NebulaMap" } ] },
        ambientColor: null,
        reflectionIntensity: Number.NaN
    });
    assert.deepEqual(malformed.ambientColor, null);
    assert.ok(Number.isNaN(malformed.reflectionIntensity));
    assert.equal(malformed.nebulaMap, null);
});

test("extractSceneLightingMetadata rejects duplicate NebulaMap resources", () =>
{
    assert.throws(() => extractSceneLightingMetadata({
        backgroundEffect: {
            resources: [
                { name: "NebulaMap", resourcePath: "res:/one.dds" },
                { name: "NebulaMap", resourcePath: "res:/two.dds" }
            ]
        }
    }), /at most one NebulaMap/);
});

test("extractSceneLightingMetadataFromBlack accepts a minimal EveSpaceScene", () =>
{
    assert.deepEqual(extractSceneLightingMetadataFromBlack(makeBlackBytes("EveSpaceScene")), {});
});

test("extractSceneLightingMetadataFromBlack rejects valid Black roots that are not EveSpaceScene", async () =>
{
    const directory = await mkdtemp(join(tmpdir(), "scene-metadata-"));
    const other = join(directory, "effect.black");
    await writeFile(other, makeBlackBytes("Tr2Effect"));
    const blackBytes = new Uint8Array(await readFile(other));
    assert.throws(
        () => extractSceneLightingMetadataFromBlack(blackBytes),
        /expected EveSpaceScene Black root, got Tr2Effect/);

    const result = await runBatchSceneMetadata({ jobs: [ { id: "wrong-root", black: other } ] });
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].id, "wrong-root");
    assert.equal(result.jobs[0].ok, false);
    assert.match(result.jobs[0].error, /expected EveSpaceScene Black root, got Tr2Effect/);
});

test("runBatchSceneMetadata is metadata-only and reports Black decode failures", async () =>
{
    const directory = await mkdtemp(join(tmpdir(), "scene-metadata-"));
    const black = join(directory, "invalid.black");
    await writeFile(black, new Uint8Array([ 1, 2, 3, 4 ]));
    const result = await runBatchSceneMetadata({
        jobs: [ {
            id: "broken",
            black,
            // A bake verb would try to read these; metadata extraction must not.
            cube: join(directory, "missing.dds"),
            outHdr: join(directory, "must-not-exist.hdr")
        } ]
    });
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].id, "broken");
    assert.equal(result.jobs[0].ok, false);
    assert.equal(typeof result.jobs[0].error, "string");
});
