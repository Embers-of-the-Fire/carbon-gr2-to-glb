import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    extractSceneLightingMetadata,
    runBatchSceneMetadata
} from "../src/scene-metadata.js";

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
