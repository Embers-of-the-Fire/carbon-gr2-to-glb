import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CjsGr2Format } from "@carbonenginejs/runtime/resource/formats/gr2";
import { runBatch } from "../src/batch.js";
import { sofShipHash } from "../src/sof.js";
import { validateGlb } from "../src/validate.js";

const execFileAsync = promisify(execFile);

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

/** A hull area with every authoritative texture path and complete materials. */
function fullShip()
{
    const ship = sofShip();
    ship.areas[0].textures = {
        AlbedoMap: "res:/dx9/texture/mf4_t1_a.dds",
        NormalMap: "res:/dx9/texture/mf4_t1_n.dds",
        RoughnessMap: "res:/dx9/texture/mf4_t1_r.dds",
        MaterialMap: "res:/dx9/texture/mf4_t1_m.dds",
        GlowMap: "res:/dx9/texture/mf4_t1_g.dds",
        DirtMap: "res:/dx9/texture/mf4_t1_d.dds",
        PaintMaskMap: "res:/dx9/texture/mf4_t1_p3.dds",
        DustNoiseMap: "res:/dx9/texture/mf4_t1_dustnoise.dds"
    };
    ship.areas[0].materials = {
        diffuse: [ [ 0.5, 0.4, 0.3 ], [ 0.5, 0.4, 0.3 ], [ 0.5, 0.4, 0.3 ], [ 0.5, 0.4, 0.3 ] ],
        fresnel: [ [ 0.04, 0.04, 0.04 ], [ 0.04, 0.04, 0.04 ], [ 0.04, 0.04, 0.04 ], [ 0.04, 0.04, 0.04 ] ],
        dustDiffuse: [ [ 0.045, 0.043, 0.045 ], [ 0.045, 0.043, 0.045 ], [ 0.045, 0.043, 0.045 ], [ 0.045, 0.043, 0.045 ] ],
        gloss: [ 0.25, 0.25, 0.25, 0.25 ]
    };
    return ship;
}

/** One textured triangle in an `area_0` index group, matching SOF area index 0. */
function syntheticGr2()
{
    return CjsGr2Format.writeShared({
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
        (ship) => { ship.areas[0].materials.fresnel = [ [ 0.1, 0.1, 0.1 ], null, null, null ]; },
        (ship) => { ship.areas[0].materials.dustDiffuse = [ [ 0.01, 0.01, 0.01 ], null, null, null ]; },
        (ship) => { ship.areas[0].parameters = { GeneralData: [ 0.75, 0, 0, 0 ] }; },
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

test("runBatch marks a full job with missing textures incomplete and preserves the existing output", async (t) =>
{
    const directory = await mkdtemp(join(tmpdir(), "carbon-gr2-batch-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const gr2 = join(directory, "mf4_t1.gr2");
    const outDir = join(directory, "out");
    const out = join(outDir, "587.glb");
    await writeFile(gr2, syntheticGr2());
    await mkdir(outDir, { recursive: true });
    const knownGood = Buffer.from("known-good glb sentinel");
    await writeFile(out, knownGood);

    const { results } = await runBatch({
        dataBlack: "/nonexistent/data.black",
        jobs: [
            {
                id: "587",
                dna: "mf4_t1:minmatarbase:minmatar",
                sof: fullShip(),
                gr2,
                textures: {},
                out
            }
        ]
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].incomplete, true);
    assert.equal(results[0].out, undefined);
    assert.equal(results[0].stats.variant, "full");
    assert.equal(results[0].stats.complete, false);
    assert.ok(results[0].stats.missingInputs.some((input) => input.role === "albedo"));
    assert.match(results[0].error, /incomplete high-quality conversion/);
    assert.match(results[0].error, /area_hull:albedo/);
    // The rejected job must not replace the known-good output, and the atomic
    // write path must not leave temp files behind.
    assert.deepEqual(await readFile(out), knownGood);
    assert.deepEqual(await readdir(outDir), [ "587.glb" ]);
});

test("runBatch converts a base job from a pre-resolved sof end to end", async (t) =>
{
    const directory = await mkdtemp(join(tmpdir(), "carbon-gr2-batch-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const gr2 = join(directory, "mf4_t1.gr2");
    const outDir = join(directory, "out");
    const out = join(outDir, "587.glb");
    await writeFile(gr2, syntheticGr2());

    const { results } = await runBatch({
        dataBlack: "/nonexistent/data.black",
        texture: { format: "none" },
        jobs: [
            {
                id: "587",
                dna: "mf4_t1:minmatarbase:minmatar",
                sof: sofShip(),
                gr2,
                textures: {},
                out
            }
        ]
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].error, undefined);
    assert.equal(results[0].out, out);
    assert.equal(results[0].stats.variant, "base");
    assert.equal(results[0].stats.complete, true);
    assert.equal(results[0].stats.images.length, 0);
    assert.deepEqual(await readdir(outDir), [ "587.glb" ]);
    const report = await validateGlb(new Uint8Array(await readFile(out)), { variant: "base", expectedTriangles: 1 });
    assert.equal(report.valid, true, report.errors.join("\n"));
});

test("runBatch preserves output symlinks when publishing", async (t) =>
{
    for (const targetExists of [ true, false ])
    {
        await t.test(targetExists ? "existing target" : "missing target", async (t) =>
        {
            const directory = await mkdtemp(join(tmpdir(), "carbon-gr2-batch-symlink-"));
            t.after(() => rm(directory, { recursive: true, force: true }));
            const gr2 = join(directory, "mf4_t1.gr2");
            const outDir = join(directory, "out");
            const targetDir = join(directory, "published");
            const out = join(outDir, "587.glb");
            const target = join(targetDir, "587.glb");
            const linkTarget = join("..", "published", "587.glb");
            await writeFile(gr2, syntheticGr2());
            await mkdir(outDir, { recursive: true });
            if (targetExists)
            {
                await mkdir(targetDir, { recursive: true });
                await writeFile(target, "stale glb sentinel");
            }
            await symlink(linkTarget, out);

            const { results } = await runBatch({
                dataBlack: "/nonexistent/data.black",
                texture: { format: "none" },
                jobs: [
                    {
                        id: "587",
                        dna: "mf4_t1:minmatarbase:minmatar",
                        sof: sofShip(),
                        gr2,
                        textures: {},
                        out
                    }
                ]
            });

            assert.equal(results.length, 1);
            assert.equal(results[0].error, undefined);
            assert.equal(results[0].out, out);
            assert.equal((await lstat(out)).isSymbolicLink(), true);
            assert.equal(await readlink(out), linkTarget);
            const output = await readFile(target);
            assert.deepEqual(await readFile(out), output);
            const report = await validateGlb(new Uint8Array(output), { variant: "base", expectedTriangles: 1 });
            assert.equal(report.valid, true, report.errors.join("\n"));
            assert.deepEqual(await readdir(targetDir), [ "587.glb" ]);
        });
    }
});

test("batch CLI rejects a dangling statistics symlink to an artifact before writing", async (t) =>
{
    const directory = await mkdtemp(join(tmpdir(), "carbon-gr2-batch-cli-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const gr2 = join(directory, "mf4_t1.gr2");
    const out = join(directory, "new", "models", "ship.glb");
    const statsOut = join(directory, "stats.json");
    const linkTarget = join("new", "models", "ship.glb");
    const manifestPath = join(directory, "manifest.json");
    await writeFile(gr2, syntheticGr2());
    await writeFile(manifestPath, JSON.stringify({
        dataBlack: "/nonexistent/data.black",
        texture: { format: "none" },
        jobs: [
            {
                id: "587",
                dna: "mf4_t1:minmatarbase:minmatar",
                sof: sofShip(),
                gr2,
                textures: {},
                out
            }
        ]
    }));
    await symlink(linkTarget, statsOut);

    await assert.rejects(execFileAsync(process.execPath, [
        fileURLToPath(new URL("../cli.js", import.meta.url)),
        "--batch", manifestPath,
        "--stats-out", statsOut
    ]), (error) =>
    {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /statistics path .* conflicts with artifact/);
        return true;
    });

    await assert.rejects(lstat(out), { code: "ENOENT" });
    assert.equal((await lstat(statsOut)).isSymbolicLink(), true);
    assert.equal(await readlink(statsOut), linkTarget);
});

test("batch CLI accepts an artifact in output directories that do not exist yet", async (t) =>
{
    const directory = await mkdtemp(join(tmpdir(), "carbon-gr2-batch-cli-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const gr2 = join(directory, "mf4_t1.gr2");
    const out = join(directory, "new", "models", "ship.glb");
    const statsOut = join(directory, "stats.json");
    const manifestPath = join(directory, "manifest.json");
    await writeFile(gr2, syntheticGr2());
    await writeFile(manifestPath, JSON.stringify({
        dataBlack: "/nonexistent/data.black",
        texture: { format: "none" },
        jobs: [
            {
                id: "587",
                dna: "mf4_t1:minmatarbase:minmatar",
                sof: sofShip(),
                gr2,
                textures: {},
                out
            }
        ]
    }));

    const { stderr } = await execFileAsync(process.execPath, [
        fileURLToPath(new URL("../cli.js", import.meta.url)),
        "--batch", manifestPath,
        "--stats-out", statsOut
    ]);

    assert.match(stderr, /converted 1\/1 jobs/);
    assert.ok((await readFile(out)).length > 0);
    const diagnostics = JSON.parse(await readFile(statsOut, "utf8"));
    assert.equal(diagnostics.results[0].out, out);
    assert.equal(diagnostics.results[0].error, undefined);
});

test("runBatch produces byte-identical GLBs for two identical conversions", async (t) =>
{
    const directory = await mkdtemp(join(tmpdir(), "carbon-gr2-batch-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const gr2 = join(directory, "mf4_t1.gr2");
    await writeFile(gr2, syntheticGr2());
    const manifest = (out) => ({
        dataBlack: "/nonexistent/data.black",
        texture: { format: "none" },
        jobs: [
            {
                id: "587",
                dna: "mf4_t1:minmatarbase:minmatar",
                sof: sofShip(),
                gr2,
                textures: {},
                out
            }
        ]
    });

    const first = join(directory, "first", "587.glb");
    const second = join(directory, "second", "587.glb");
    const { results: firstResults } = await runBatch(manifest(first));
    const { results: secondResults } = await runBatch(manifest(second));

    assert.equal(firstResults[0].error, undefined);
    assert.equal(secondResults[0].error, undefined);
    assert.deepEqual(await readFile(first), await readFile(second));
});
