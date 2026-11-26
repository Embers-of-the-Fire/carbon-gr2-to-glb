import { test } from "node:test";
import assert from "node:assert/strict";
import { CjsGr2Format } from "@carbonenginejs/runtime/resource/formats/gr2";
import { extractGeometry, selectLodMesh } from "../src/geometry.js";

const encodeFrame = (T, B, N) => CjsGr2Format.tangents.encode(T, B, N);

/** Packed UNorm sentinel marking a vertex with no authored tangent frame. */
const NULL_FRAME = [ 0, 1, 0, 1 ];

/** Valid frame for the flat +Z square fixtures below (w = +1). */
const FRAME_XY = encodeFrame([ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ]);

/**
 * Build a synthetic shared-GR2 mesh record. All channels are plain arrays,
 * mirroring the deinterleaved float channels of the runtime projection.
 */
function makeMesh({
    name = "ship",
    positions,
    normals = null,
    uvs,
    packedTangents = null,
    groups,
    groupNames = null,
    bytesPerIndex = 2
})
{
    const vertex = { position: positions, texcoord0: uvs };
    if (normals) vertex.normal = normals;
    if (packedTangents) vertex.packedTangentLegacy = packedTangents;
    return {
        name,
        vertex,
        indices: groups.map((faces, i) => ({
            name: groupNames ? groupNames[i] : `area_${i}`,
            faces,
            bytesPerIndex
        }))
    };
}

const SQUARE_POSITIONS = [ 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0 ];
const SQUARE_UVS = [ 0, 0, 1, 0, 1, 1, 0, 1 ];
const SQUARE_NORMALS = [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1 ];
const SQUARE_FACES = [ 0, 1, 2, 0, 2, 3 ];

function squareMesh(overrides = {})
{
    return makeMesh({
        positions: SQUARE_POSITIONS,
        normals: SQUARE_NORMALS,
        uvs: SQUARE_UVS,
        packedTangents: [ ...FRAME_XY, ...FRAME_XY, ...FRAME_XY, ...FRAME_XY ],
        groups: [ SQUARE_FACES ],
        ...overrides
    });
}

function squareShared(overrides = {})
{
    return { meshes: [ squareMesh(overrides) ] };
}

const near = (actual, expected, epsilon = 1e-3) => Math.abs(actual - expected) <= epsilon;

function tangentAt(primitive, vertex)
{
    return [
        primitive.tangents[vertex * 4],
        primitive.tangents[vertex * 4 + 1],
        primitive.tangents[vertex * 4 + 2],
        primitive.tangents[vertex * 4 + 3]
    ];
}

function normalAt(primitive, vertex)
{
    return [
        primitive.normals[vertex * 3],
        primitive.normals[vertex * 3 + 1],
        primitive.normals[vertex * 3 + 2]
    ];
}

function assertUnit(vector, label)
{
    const length = Math.hypot(...vector);
    assert.ok(near(length, 1, 1e-3), `${label} must be unit length, got ${length}`);
}

// --- LOD selection ------------------------------------------------------------

test("selectLodMesh picks the unsuffixed base for lod 0 regardless of array order", () =>
{
    const shared = { meshes: [
        { name: "X LOD 100" },
        { name: "X LOD 500" },
        { name: "X" }
    ] };
    const selection = selectLodMesh(shared);
    assert.equal(selection.index, 2);
    assert.equal(selection.name, "X");
    assert.equal(selection.lod, 0);
    assert.equal(selection.mesh.name, "X");
});

test("selectLodMesh orders siblings base-first by descending threshold", () =>
{
    const shared = { meshes: [
        { name: "X LOD 100" },
        { name: "X" },
        { name: "X LOD 500" }
    ] };
    const selection = selectLodMesh(shared);
    assert.deepEqual(
        selection.siblings.map((s) => [ s.rank, s.name, s.threshold ]),
        [ [ 0, "X", null ], [ 1, "X LOD 500", 500 ], [ 2, "X LOD 100", 100 ] ]
    );
    assert.equal(selectLodMesh(shared, { lod: 1 }).name, "X LOD 500");
    assert.equal(selectLodMesh(shared, { lod: 2 }).name, "X LOD 100");
    assert.equal(selectLodMesh(shared, { lod: 2 }).index, 0);
});

test("selectLodMesh reports single-mesh inputs with one level", () =>
{
    const selection = selectLodMesh({ meshes: [ { name: "only" } ] });
    assert.equal(selection.index, 0);
    assert.equal(selection.lod, 0);
    assert.equal(selection.siblings.length, 1);
});

test("selectLodMesh rejects an out-of-range LOD with the available levels", () =>
{
    const shared = { meshes: [ { name: "X" }, { name: "X LOD 500" } ] };
    assert.throws(
        () => selectLodMesh(shared, { lod: 2 }),
        /LOD 2 requested, but mesh "X" only has 2 level\(s\).*LOD 0 = "X".*LOD 1 = "X LOD 500"/s
    );
});

test("selectLodMesh rejects duplicate unsuffixed base names", () =>
{
    assert.throws(
        () => selectLodMesh({ meshes: [ { name: "X" }, { name: "X" } ] }),
        /2 meshes share the unsuffixed base name "X"/
    );
});

test("selectLodMesh rejects duplicate LOD thresholds", () =>
{
    assert.throws(
        () => selectLodMesh({ meshes: [ { name: "X" }, { name: "X LOD 5" }, { name: "X LOD 5" } ] }),
        /duplicate LOD threshold 5/
    );
});

test("selectLodMesh rejects LOD siblings without their base mesh", () =>
{
    assert.throws(
        () => selectLodMesh({ meshes: [ { name: "X LOD 5" } ] }),
        /no unsuffixed base mesh "X"/
    );
});

test("selectLodMesh rejects multiple unrelated meshes", () =>
{
    assert.throws(
        () => selectLodMesh({ meshes: [ { name: "X" }, { name: "Y" } ] }),
        /unrelated mesh layout/
    );
});

test("selectLodMesh rejects non-integer and negative LOD requests", () =>
{
    assert.throws(() => selectLodMesh({ meshes: [ { name: "X" } ] }, { lod: -1 }), /non-negative integer/);
    assert.throws(() => selectLodMesh({ meshes: [ { name: "X" } ] }, { lod: 1.5 }), /non-negative integer/);
});

test("selectLodMesh rejects an empty shared root", () =>
{
    assert.throws(() => selectLodMesh({ meshes: [] }), /contains no meshes/);
    assert.throws(() => selectLodMesh({}), /contains no meshes/);
});

// --- extractGeometry: LOD integration ------------------------------------------

test("extractGeometry returns the selection record and diagnostics", () =>
{
    const shared = { meshes: [ { name: "X LOD 100" }, squareMesh({ name: "X" }), { name: "X LOD 500" } ] };
    const result = extractGeometry(shared);
    assert.equal(result.name, "X");
    assert.equal(result.selection.index, 1);
    assert.equal(result.selection.lod, 0);
    assert.deepEqual(result.diagnostics.selection.siblings.map((s) => s.name), [ "X", "X LOD 500", "X LOD 100" ]);
    assert.equal(result.diagnostics.vertices, 4);
    assert.equal(result.diagnostics.areas[0].triangles, 2);
});

test("extractGeometry selects higher LOD ranks from scattered siblings", () =>
{
    const lowDetail = squareMesh({ name: "X LOD 900", positions: SQUARE_POSITIONS.map((v) => v * 0.5) });
    const shared = { meshes: [ lowDetail, { name: "X LOD 100" }, squareMesh({ name: "X" }) ] };
    const result = extractGeometry(shared, { lod: 1 });
    assert.equal(result.selection.name, "X LOD 900");
    assert.ok(near(result.primitives[0].positions[0], 0.5 * 0) );
    assert.ok(near(result.primitives[0].positions[3], 0.5 * 1));
});

// --- Area identity -------------------------------------------------------------

test("primitives carry sourceAreaIndex from area_<N> group names and array position otherwise", () =>
{
    const shared = { meshes: [ makeMesh({
        positions: SQUARE_POSITIONS,
        normals: SQUARE_NORMALS,
        uvs: SQUARE_UVS,
        packedTangents: [ ...FRAME_XY, ...FRAME_XY, ...FRAME_XY, ...FRAME_XY ],
        groups: [ [ 0, 1, 2 ], [ 0, 2, 3 ], [ 0, 1, 2 ] ],
        groupNames: [ "area_3", "hull_glass", "area_12" ]
    }) ] };
    const { primitives, diagnostics } = extractGeometry(shared);
    assert.deepEqual(primitives.map((p) => p.sourceAreaIndex), [ 3, 1, 12 ]);
    assert.deepEqual(primitives.map((p) => p.sourceAreaName), [ "area_3", "hull_glass", "area_12" ]);
    assert.deepEqual(diagnostics.areas.map((a) => a.sourceAreaIndex), [ 3, 1, 12 ]);
});

test("unnamed groups fall back to their array position", () =>
{
    const shared = { meshes: [ makeMesh({
        positions: SQUARE_POSITIONS,
        normals: SQUARE_NORMALS,
        uvs: SQUARE_UVS,
        packedTangents: [ ...FRAME_XY, ...FRAME_XY, ...FRAME_XY, ...FRAME_XY ],
        groups: [ SQUARE_FACES, [ 0, 1, 2 ] ],
        groupNames: [ "area_0", null ]
    }) ] };
    const { primitives } = extractGeometry(shared);
    assert.equal(primitives[0].sourceAreaIndex, 0);
    assert.equal(primitives[1].sourceAreaIndex, 1);
    assert.equal(primitives[1].name, "area_1");
});

// --- Coordinate conversion and handedness ---------------------------------------

test("coordinate conversion negates Z, reverses winding, and flips tangent handedness", () =>
{
    const invSqrt2 = 1 / Math.SQRT2;
    const positions = [ 0, 0, 5, 2, 0, 5, 0, 3, 5 ];
    const normals = [ 0, invSqrt2, invSqrt2, 0, invSqrt2, invSqrt2, 0, invSqrt2, invSqrt2 ];
    const uvs = [ 0, 0, 1, 0, 0, 1 ];
    const frame = encodeFrame([ 0, 0, 1 ], [ 1, 0, 0 ], [ 0, invSqrt2, invSqrt2 ]);
    const shared = { meshes: [ makeMesh({
        positions, normals, uvs,
        packedTangents: [ ...frame, ...frame, ...frame ],
        groups: [ [ 0, 1, 2 ] ]
    }) ] };

    const converted = extractGeometry(shared);
    const prim = converted.primitives[0];
    assert.deepEqual([...prim.positions.filter((_, i) => i % 3 === 2)], [ -5, -5, -5 ]);
    assert.deepEqual([...prim.indices], [ 0, 2, 1 ], "winding must be reversed");
    const n = normalAt(prim, 0);
    assert.ok(near(n[1], invSqrt2) && near(n[2], -invSqrt2), `converted normal ${n}`);
    const t = tangentAt(prim, 0);
    assert.ok(near(t[2], -1, 1e-3), `tangent Z must be negated, got ${t}`);
    assert.equal(t[3], -1, "tangent handedness must flip with the coordinate conversion");

    const untouched = extractGeometry(shared, { convertCoordinates: false });
    const uprim = untouched.primitives[0];
    assert.deepEqual([...uprim.indices], [ 0, 1, 2 ]);
    assert.ok(near(normalAt(uprim, 0)[2], invSqrt2));
    assert.equal(tangentAt(uprim, 0)[3], 1, "without conversion the authored w=+1 frame is preserved");
    assert.ok(near(tangentAt(uprim, 0)[2], 1, 1e-3), "without conversion the authored tangent is preserved");
});

test("flipV flips V and the handedness of generated tangents", () =>
{
    const shared = squareShared(); // packed channel present: authored w preserved
    const flipped = extractGeometry(shared, { flipV: true });
    assert.deepEqual([...flipped.primitives[0].uvs.filter((_, i) => i % 2 === 1)], [ 1, 1, 0, 0 ]);

    const noPacked = { meshes: [ makeMesh({
        positions: SQUARE_POSITIONS,
        normals: SQUARE_NORMALS,
        uvs: SQUARE_UVS,
        groups: [ SQUARE_FACES ]
    }) ] };
    // No coordinate conversion here so generated w reflects UV handedness directly
    // (default conversion would mirror-space the result and legitimately flip w).
    const generated = extractGeometry(noPacked, { convertCoordinates: false });
    assert.equal(tangentAt(generated.primitives[0], 0)[3], 1, "square UVs generate positive handedness");
    const generatedFlipped = extractGeometry(noPacked, { convertCoordinates: false, flipV: true });
    assert.equal(tangentAt(generatedFlipped.primitives[0], 0)[3], -1, "flipped UVs generate negative handedness");
});

// --- Tangent frame repair --------------------------------------------------------

test("null sentinel frames are repaired and counted, valid neighbours are preserved", () =>
{
    const packed = [ ...FRAME_XY, ...FRAME_XY, ...NULL_FRAME, ...FRAME_XY ];
    const shared = squareShared({ packedTangents: packed });
    const { primitives, diagnostics } = extractGeometry(shared);
    const prim = primitives[0];

    assert.equal(diagnostics.tangents.nullFrames, 1);
    assert.equal(diagnostics.tangents.invalidFrames, 0);
    assert.equal(diagnostics.tangents.repaired, 1);
    assert.equal(diagnostics.tangents.degenerateFallbacks, 0);
    assert.equal(diagnostics.normals.repaired, 0, "source normals must be preserved");

    for (let i = 0; i < 4; i++)
    {
        const t = tangentAt(prim, i);
        assert.ok(t.every(Number.isFinite), `tangent ${i} must be finite`);
        assert.ok(Math.abs(Math.abs(t[3]) - 1) === 0, `tangent ${i} w must be exactly +/-1`);
        assertUnit(t.slice(0, 3), `tangent ${i}`);
        const n = normalAt(prim, i);
        const dot = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
        assert.ok(near(dot, 0, 1e-3), `tangent ${i} must stay perpendicular to its normal (dot ${dot})`);
    }
    // Authored neighbours keep their decoded direction.
    assert.ok(near(tangentAt(prim, 0)[0], 1, 1e-3) && near(tangentAt(prim, 0)[1], 0, 1e-3));
});

test("degenerate non-sentinel packed frames are counted invalid and repaired", () =>
{
    // u0 == u2 and u1 == u3 decode T parallel to B, collapsing the decoded
    // normal to zero without matching the null-frame sentinel: invalid, not null.
    const packed = [ 0.3, 0.6, 0.3, 0.6, ...FRAME_XY, ...FRAME_XY, ...FRAME_XY ];
    const shared = squareShared({ packedTangents: packed });
    const { primitives, diagnostics } = extractGeometry(shared);
    assert.equal(diagnostics.tangents.invalidFrames, 1);
    assert.equal(diagnostics.tangents.nullFrames, 0);
    assert.equal(diagnostics.tangents.repaired, 1);
    assert.ok(tangentAt(primitives[0], 0).every(Number.isFinite));
});

test("a missing packed channel generates tangents for every vertex", () =>
{
    const shared = { meshes: [ makeMesh({
        positions: SQUARE_POSITIONS,
        normals: SQUARE_NORMALS,
        uvs: SQUARE_UVS,
        groups: [ SQUARE_FACES ]
    }) ] };
    const { primitives, diagnostics } = extractGeometry(shared);
    assert.equal(diagnostics.tangents.packedChannel, false);
    assert.equal(diagnostics.tangents.nullFrames, 0);
    assert.equal(diagnostics.tangents.invalidFrames, 0);
    assert.equal(diagnostics.tangents.repaired, 4);
    for (let i = 0; i < 4; i++) assertUnit(tangentAt(primitives[0], i).slice(0, 3), `tangent ${i}`);
});

test("degenerate UVs fall back to a deterministic orthonormal tangent", () =>
{
    const flatUvs = [ 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5 ];
    const shared = { meshes: [ makeMesh({
        positions: SQUARE_POSITIONS,
        normals: SQUARE_NORMALS,
        uvs: flatUvs,
        groups: [ SQUARE_FACES ]
    }) ] };
    const { primitives, diagnostics } = extractGeometry(shared);
    assert.equal(diagnostics.tangents.degenerateFallbacks, 4);
    const prim = primitives[0];
    for (let i = 0; i < 4; i++)
    {
        const t = tangentAt(prim, i);
        assertUnit(t.slice(0, 3), `tangent ${i}`);
        const n = normalAt(prim, i);
        assert.ok(near(t[0] * n[0] + t[1] * n[1] + t[2] * n[2], 0, 1e-3));
    }
    // Deterministic: every fallback vertex gets the same basis.
    const first = tangentAt(prim, 0).slice(0, 3);
    for (let i = 1; i < 4; i++) assert.deepEqual(tangentAt(prim, i).slice(0, 3), first);
});

test("missing normal channel recovers normals from decoded tangent frames", () =>
{
    const shared = squareShared({ normals: null });
    const { primitives, diagnostics } = extractGeometry(shared);
    assert.equal(diagnostics.normals.repaired, 4);
    assert.equal(diagnostics.normals.degenerateFallbacks, 0);
    const n = normalAt(primitives[0], 0);
    assert.ok(near(n[2], -1, 1e-3), `recovered normal is Z-negated by the coordinate conversion, got ${n}`);
    assertUnit(n, "recovered normal");
});

// --- Malformed data rejection -----------------------------------------------------

test("non-finite positions are rejected", () =>
{
    const positions = [ 0, 0, 0, 1, NaN, 0, 1, 1, 0, 0, 1, 0 ];
    assert.throws(() => extractGeometry(squareShared({ positions })), /position channel has a non-finite value/);
});

test("incomplete position channels are rejected", () =>
{
    assert.throws(() => extractGeometry(squareShared({ positions: [ 0, 0, 0, 1 ] })), /not a multiple of 3/);
});

test("missing or malformed UVs are rejected", () =>
{
    const mesh = squareMesh();
    delete mesh.vertex.texcoord0;
    assert.throws(() => extractGeometry({ meshes: [ mesh ] }), /no texcoord0 data/);
    assert.throws(() => extractGeometry(squareShared({ uvs: [ 0, 0, 1, NaN, 1, 1, 0, 1 ] })), /texcoord0 channel has a non-finite value/);
    assert.throws(() => extractGeometry(squareShared({ uvs: [ 0, 0, 1, 0, 1 ] })), /not a multiple of 2/);
});

test("malformed normal and packed tangent channels are rejected", () =>
{
    assert.throws(
        () => extractGeometry(squareShared({ normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1 ] })),
        /normal channel carries 3 vertices, expected 4/
    );
    assert.throws(
        () => extractGeometry(squareShared({ packedTangents: [ ...FRAME_XY, ...FRAME_XY ] })),
        /packedTangentLegacy channel carries 2 frames, expected 4/
    );
});

test("out-of-range, non-integer and incomplete indices are rejected", () =>
{
    assert.throws(() => extractGeometry(squareShared({ groups: [ [ 0, 1, 9 ] ] })), /out of range for 4 vertices/);
    assert.throws(() => extractGeometry(squareShared({ groups: [ [ 0, 1, 2.5 ] ] })), /non-integer index at position 2/);
    assert.throws(() => extractGeometry(squareShared({ groups: [ [ 0, 1, 2, 3 ] ] })), /incomplete triangle/);
});

test("a mesh without index groups is rejected", () =>
{
    const mesh = squareMesh();
    mesh.indices = [];
    assert.throws(() => extractGeometry({ meshes: [ mesh ] }), /has no index data/);
});

// --- Output guarantees --------------------------------------------------------------

test("output normals are unit length and tangents carry w of exactly +/-1", () =>
{
    const { primitives } = extractGeometry(squareShared());
    const prim = primitives[0];
    for (let i = 0; i < 4; i++)
    {
        assertUnit(normalAt(prim, i), `normal ${i}`);
        const t = tangentAt(prim, i);
        assert.ok(t[3] === 1 || t[3] === -1, `w must be exactly +/-1, got ${t[3]}`);
    }
});

test("index groups coerce to 16-bit arrays and widen only when required", () =>
{
    const shared16 = squareShared();
    assert.ok(extractGeometry(shared16).primitives[0].indices instanceof Uint16Array);

    const shared32 = squareShared({ bytesPerIndex: 4 });
    assert.ok(extractGeometry(shared32).primitives[0].indices instanceof Uint32Array);

    // A plain-array group referencing a vertex past the 16-bit range widens.
    const wideVertexCount = 70000;
    const wide = { meshes: [ makeMesh({
        positions: new Array(wideVertexCount * 3).fill(0),
        normals: new Array(wideVertexCount * 3).fill(0),
        uvs: new Array(wideVertexCount * 2).fill(0),
        groups: [ [ 0, 1, wideVertexCount - 1 ] ]
    }) ] };
    wide.meshes[0].vertex.normal[2] = 1;
    wide.meshes[0].vertex.normal[5] = 1;
    wide.meshes[0].vertex.normal[8] = 1;
    assert.ok(extractGeometry(wide).primitives[0].indices instanceof Uint32Array);
});

test("zero-triangle groups are preserved, not dropped", () =>
{
    const shared = { meshes: [ makeMesh({
        positions: SQUARE_POSITIONS,
        normals: SQUARE_NORMALS,
        uvs: SQUARE_UVS,
        packedTangents: [ ...FRAME_XY, ...FRAME_XY, ...FRAME_XY, ...FRAME_XY ],
        groups: [ SQUARE_FACES, [] ],
        groupNames: [ "area_0", "area_1" ]
    }) ] };
    const { primitives, diagnostics } = extractGeometry(shared);
    assert.equal(primitives.length, 2);
    assert.equal(primitives[1].indices.length, 0);
    assert.equal(diagnostics.areas[1].triangles, 0);
});
