import { test } from "node:test";
import assert from "node:assert/strict";
import { runBatch } from "../src/batch.js";
import { sofShipHash } from "../src/sof.js";

function sofShip()
{
    return {
        dna: "mf4_t1:minmatarbase:minmatar",
        geometryResPath: "res:/dx9/model/hull/mf4_t1.gr2",
        areas: [
            {
                group: "opaqueAreas",
                name: "area_hull",
                index: 0,
                count: 1,
                shader: "skinned_quadv5",
                textures: { AlbedoMap: "res:/dx9/texture/mf4_t1_a.dds" },
                materials: { diffuse: [ [ 0.5, 0.4, 0.3 ], null, null, null ], gloss: [ 0.25, null, null, null ] },
                glowColor: [ 1, 0.8, 0.2 ],
                heatGlowColor: null
            }
        ]
    };
}

test("sofShipHash is stable across identical resolutions", () =>
{
    assert.equal(sofShipHash(sofShip()), sofShipHash(sofShip()));
});

test("sofShipHash matches the fixed vector (guards the serialization format)", () =>
{
    // sha256 of '{"dna":"mf4_t1:minmatarbase:minmatar","geometryResPath":"res:/dx9/model/hull/mf4_t1.gr2","areas":[]}'
    // The build-state cache consumes these hashes across runs; a format change
    // here must be deliberate (it invalidates every cached model).
    const minimal = { dna: "mf4_t1:minmatarbase:minmatar", geometryResPath: "res:/dx9/model/hull/mf4_t1.gr2", areas: [] };
    assert.equal(sofShipHash(minimal), "2b631f86a3b8432e178d461f206659d366402e5b9bf6e2a7af14c9b11ee71bbf");
});

test("sofShipHash changes with any resolved value", () =>
{
    const base = sofShipHash(sofShip());
    const variants = [
        (ship) => { ship.areas[0].materials.diffuse[0][0] = 0.51; },
        (ship) => { ship.areas[0].glowColor = null; },
        (ship) => { ship.areas[0].heatGlowColor = [ 2, 1, 0.5 ]; },
        (ship) => { ship.areas[0].shader = "skinned_quadheatv5"; },
        (ship) => { ship.areas[0].textures.AlbedoMap = "res:/dx9/texture/mf4_t1_a2.dds"; },
        (ship) => { ship.geometryResPath = "res:/dx9/model/hull/mf4_t2.gr2"; }
    ];
    for (const mutate of variants)
    {
        const ship = sofShip();
        mutate(ship);
        assert.notEqual(sofShipHash(ship), base, `mutation ${mutate} must change the fingerprint`);
    }
});

test("runBatch converts from a pre-resolved sof without reading the catalog", async () =>
{
    const { results } = await runBatch({
        dataBlack: "/nonexistent/data.black",
        jobs: [
            {
                id: "587",
                dna: "mf4_t1:minmatarbase:minmatar",
                sof: sofShip(),
                gr2: "/nonexistent/mf4_t1.gr2",
                textures: {},
                out: "/nonexistent/out/587.glb"
            }
        ]
    });
    assert.equal(results.length, 1);
    // The job must fail on the missing GR2 input — never on the (bogus)
    // catalog path, proving the pre-resolved sof skipped catalog loading.
    assert.match(results[0].error, /mf4_t1\.gr2/);
});

test("runBatch re-resolves against the catalog when a job carries no sof", async () =>
{
    const { results } = await runBatch({
        dataBlack: "/nonexistent/data.black",
        jobs: [
            {
                id: "587",
                dna: "mf4_t1:minmatarbase:minmatar",
                gr2: "/nonexistent/mf4_t1.gr2",
                textures: {},
                out: "/nonexistent/out/587.glb"
            }
        ]
    });
    assert.equal(results.length, 1);
    assert.match(results[0].error, /data\.black/);
});
