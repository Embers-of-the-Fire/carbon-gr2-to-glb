import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    bakeSkybox,
    cubeToEquirect,
    encodeHdr,
    extractSceneParameters,
    linearizeSrgbFace,
    projectDiffuseSh,
    repairSpikes,
    runBatchSkybox,
    srgbToLinear,
    SKYBOX_EQUIRECT_WIDTH,
    SKYBOX_EQUIRECT_HEIGHT
} from "../src/skybox.js";

/** Six constant-color faces in DirectX order (+X, -X, +Y, -Y, +Z, -Z). */
function constantFaces(size = 8)
{
    const colors = [
        [ 1, 0, 0 ], // +X red
        [ 0, 1, 0 ], // -X green
        [ 0, 0, 1 ], // +Y blue
        [ 1, 1, 0 ], // -Y yellow
        [ 0, 1, 1 ], // +Z cyan
        [ 1, 0, 1 ] // -Z magenta
    ];
    return colors.map(([ r, g, b ]) =>
    {
        const face = new Float32Array(size * size * 4);
        for (let i = 0; i < size * size; i++)
        {
            face[i * 4] = r;
            face[i * 4 + 1] = g;
            face[i * 4 + 2] = b;
            face[i * 4 + 3] = 1;
        }
        return face;
    });
}

function equirectPixel(pixels, width, px, py)
{
    const o = (py * width + px) * 3;
    return [ pixels[o], pixels[o + 1], pixels[o + 2] ];
}

/**
 * Minimal valid 4x4 BC7_UNORM cubemap DDS: magic + 124-byte header + DX10
 * header + six 16-byte mode-0 BC7 blocks (decoding to opaque black).
 */
function makeCubeDdsBytes()
{
    const bytes = new Uint8Array(148 + 6 * 16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x20534444, true); // "DDS "
    view.setUint32(4, 124, true); // dwSize
    view.setUint32(8, 0x1007, true); // dwFlags
    view.setUint32(12, 4, true); // dwHeight
    view.setUint32(16, 4, true); // dwWidth
    view.setUint32(80, 4, true); // DDPF_FOURCC
    view.setUint32(84, 0x30315844, true); // "DX10"
    view.setUint32(108, 0x8, true); // dwCaps: TEXTURE
    view.setUint32(112, 0xfc00, true); // dwCaps2: all six cube faces
    view.setUint32(128, 98, true); // DXGI_FORMAT_BC7_UNORM
    view.setUint32(132, 3, true); // D3D11_RESOURCE_DIMENSION_TEXTURE2D
    view.setUint32(136, 4, true); // miscFlag: TEXTURECUBE
    view.setUint32(140, 1, true); // arraySize
    for (let face = 0; face < 6; face++) bytes[148 + face * 16] = 0x01; // BC7 mode 0
    return bytes;
}

/** Decode the new-style-RLE scanlines of an encodeHdr output. */
function decodeHdrScanlines(hdr, width, height, headerLength)
{
    const scanlines = [];
    let pos = headerLength;
    for (let y = 0; y < height; y++)
    {
        assert.equal(hdr[pos], 2);
        assert.equal(hdr[pos + 1], 2);
        assert.equal((hdr[pos + 2] << 8) | hdr[pos + 3], width);
        pos += 4;
        const scanline = new Uint8Array(width * 4);
        for (let channel = 0; channel < 4; channel++)
        {
            let x = 0;
            while (x < width)
            {
                let count = hdr[pos++];
                if (count > 128)
                {
                    count -= 128;
                    const value = hdr[pos++];
                    for (let i = 0; i < count; i++) scanline[(x++) * 4 + channel] = value;
                }
                else
                {
                    for (let i = 0; i < count; i++) scanline[(x++) * 4 + channel] = hdr[pos++];
                }
            }
        }
        scanlines.push(scanline);
    }
    assert.equal(pos, hdr.length);
    return scanlines;
}

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

test("cubeToEquirect maps the engine's equirect convention onto the right faces", () =>
{
    const width = 64;
    const height = 32;
    const size = 8;
    const pixels = cubeToEquirect(constantFaces(size), size, width, height);

    // Center of the image: longitude 0 -> +X in engine space -> EVE +X face.
    assert.deepEqual(equirectPixel(pixels, width, 32, 16), [ 1, 0, 0 ]);
    // Left edge: longitude -pi -> -X.
    assert.deepEqual(equirectPixel(pixels, width, 0, 16), [ 0, 1, 0 ]);
    // Top row: the +Y pole.
    assert.deepEqual(equirectPixel(pixels, width, 20, 0), [ 0, 0, 1 ]);
    // Bottom row: the -Y pole.
    assert.deepEqual(equirectPixel(pixels, width, 20, height - 1), [ 1, 1, 0 ]);
    // Three quarters across: longitude +pi/2 -> +Z in engine space, which is
    // EVE -Z after the handedness conversion (negated Z).
    assert.deepEqual(equirectPixel(pixels, width, 48, 16), [ 1, 0, 1 ]);
    // One quarter across: engine -Z -> EVE +Z.
    assert.deepEqual(equirectPixel(pixels, width, 16, 16), [ 0, 1, 1 ]);
});

test("encodeHdr writes the header flutter_scene accepts and roundtrips RGBE", () =>
{
    const width = 16;
    const height = 8;
    const pixels = new Float32Array(width * height * 3);
    for (let py = 0; py < height; py++)
    {
        for (let px = 0; px < width; px++)
        {
            const o = (py * width + px) * 3;
            pixels[o] = 0.25 + px / width; // some HDR range, incl. > 1
            pixels[o + 1] = py === 0 ? 0 : 0.5; // a zero plane exercises RLE runs
            pixels[o + 2] = 2.0 * (py + 1) / height;
        }
    }
    const hdr = encodeHdr(pixels, width, height);
    const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
    const text = new TextDecoder().decode(hdr.slice(0, header.length));
    assert.equal(text, header);

    // Minimal new-style-RLE decode, mirroring flutter_scene's decoder.
    const scanlines = decodeHdrScanlines(hdr, width, height, header.length);
    for (let y = 0; y < height; y++)
    {
        const scanline = scanlines[y];
        for (let x = 0; x < width; x++)
        {
            const e = scanline[x * 4 + 3];
            const o = (y * width + x) * 3;
            for (let c = 0; c < 3; c++)
            {
                const expected = pixels[o + c];
                const decoded = e === 0 ? 0 : scanline[x * 4 + c] * 2 ** (e - 136);
                // RGBE carries ~1% relative precision.
                assert.ok(Math.abs(decoded - expected) <= Math.max(expected * 0.01, 1e-6),
                    `pixel (${x}, ${y}) channel ${c}: ${decoded} vs ${expected}`);
            }
        }
    }
});

test("bakeSkybox leaves an existing HDR untouched when the descriptor fails", async () =>
{
    const directory = await mkdtemp(join(tmpdir(), "skybox-"));
    const outHdr = join(directory, "existing.hdr");
    const sentinel = new Uint8Array([ 9, 9, 9 ]);
    await writeFile(outHdr, sentinel);

    await assert.rejects(
        bakeSkybox({
            cubeBytes: makeCubeDdsBytes(),
            blackBytes: new Uint8Array([ 1, 2, 3, 4 ]), // not a Black payload
            outHdr
        }),
        /BLACK|black/i
    );
    // The prior HDR must survive byte-for-byte; only a fully computed bake
    // may replace it.
    assert.deepEqual(new Uint8Array(await readFile(outHdr)), sentinel);
});

test("bakeSkybox rejects a valid non-EveSpaceScene Black root without touching the HDR", async () =>
{
    const directory = await mkdtemp(join(tmpdir(), "skybox-"));
    const outHdr = join(directory, "existing.hdr");
    const sentinel = new Uint8Array([ 9, 9, 9 ]);
    await writeFile(outHdr, sentinel);

    await assert.rejects(
        bakeSkybox({
            cubeBytes: makeCubeDdsBytes(),
            blackBytes: makeBlackBytes("Tr2Effect"), // valid Black, wrong root
            outHdr
        }),
        /expected EveSpaceScene Black root, got Tr2Effect/
    );
    assert.deepEqual(new Uint8Array(await readFile(outHdr)), sentinel);
});

test("bakeSkybox writes the HDR once the descriptor parses", async () =>
{
    const directory = await mkdtemp(join(tmpdir(), "skybox-"));
    const outHdr = join(directory, "out.hdr");
    const result = await bakeSkybox({
        cubeBytes: makeCubeDdsBytes(),
        blackBytes: null,
        outHdr
    });
    const hdr = new Uint8Array(await readFile(outHdr));
    assert.ok(hdr.length > 0);
    assert.equal(new TextDecoder().decode(hdr.slice(0, 10)), "#?RADIANCE");
    assert.equal(result.repairedPixels, 0);
    assert.equal(result.diffuseSh.length, 27);
});

test("runBatchSkybox reports a null job and continues", async () =>
{
    const directory = await mkdtemp(join(tmpdir(), "skybox-"));
    const cube = join(directory, "cube.dds");
    await writeFile(cube, makeCubeDdsBytes());
    const outHdr = join(directory, "ok.hdr");
    const result = await runBatchSkybox({
        jobs: [
            null,
            { id: "ok", cube, outHdr }
        ]
    });
    // The null job is reported, not thrown; the later job still runs.
    assert.equal(result.jobs.length, 2);
    assert.deepEqual(result.jobs[0], {
        id: undefined,
        ok: false,
        error: "Cannot read properties of null (reading 'cube')"
    });
    assert.equal(result.jobs[1].id, "ok");
    assert.equal(result.jobs[1].ok, true);
    assert.ok(result.jobs[1].diffuseSh.length === 27);
});

test("encodeHdr rejects widths outside the Radiance RLE range", () =>
{
    for (const width of [ 1, 4, 7, 32768, 65536 ])
    {
        assert.throws(
            () => encodeHdr(new Float32Array(width * 2 * 3), width, 2),
            /outside the Radiance RLE range/,
            `width ${width} should be rejected`
        );
    }
    // The range boundaries themselves stay encodable.
    for (const width of [ 8, 32767 ])
    {
        encodeHdr(new Float32Array(width * 2 * 3), width, 2);
    }
});

test("encodeHdr writes black, not the previous row, after a nonblack pixel", () =>
{
    const width = 16;
    const height = 4;
    const pixels = new Float32Array(width * height * 3);
    // Row 0 lit across the width; rows 1-3 fully black.
    for (let x = 0; x < width; x++)
    {
        const o = x * 3;
        pixels[o] = 0.5;
        pixels[o + 1] = 0.25;
        pixels[o + 2] = 1.0;
    }
    const hdr = encodeHdr(pixels, width, height);
    const headerLength = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`.length;
    const scanlines = decodeHdrScanlines(hdr, width, height, headerLength);
    for (let x = 0; x < width; x++)
    {
        assert.deepEqual(
            Array.from(scanlines[0].slice(x * 4, x * 4 + 4)),
            [ 64, 32, 128, 129 ],
            `row 0 pixel ${x} should be lit`
        );
        for (let y = 1; y < height; y++)
        {
            assert.deepEqual(
                Array.from(scanlines[y].slice(x * 4, x * 4 + 4)),
                [ 0, 0, 0, 0 ],
                `pixel (${x}, ${y}) below a lit pixel must stay black`
            );
        }
    }
});

test("projectDiffuseSh keeps a constant environment constant (mean == radiance)", () =>
{
    // The engine contract: a constant environment of radiance L bakes to
    // coefficient 0 = L / kShBand0Basis and zeros elsewhere, and evaluating
    // the SH returns L in every direction.
    const width = 32;
    const height = 16;
    const level = [ 0.3, 0.5, 0.7 ];
    const pixels = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++)
    {
        pixels[i * 3] = level[0];
        pixels[i * 3 + 1] = level[1];
        pixels[i * 3 + 2] = level[2];
    }
    const sh = projectDiffuseSh(pixels, width, height);
    assert.equal(sh.length, 27);
    const kShBand0Basis = 0.28209479177387814;
    for (let c = 0; c < 3; c++)
    {
        assert.ok(Math.abs(sh[c] - level[c] / kShBand0Basis) < level[c] * 0.01,
            `coefficient 0 channel ${c}: ${sh[c]}`);
    }
    for (let k = 1; k < 9; k++)
    {
        for (let c = 0; c < 3; c++)
        {
            // The quadrature grid and the truncated basis constants (shared
            // verbatim with the runtime) leave a small residual; a true zero
            // would require an exact integral.
            assert.ok(Math.abs(sh[k * 3 + c]) < 1e-4, `coefficient ${k} channel ${c}: ${sh[k * 3 + c]}`);
        }
    }
});

test("projectDiffuseSh matches the runtime's band weights for a directional lobe", () =>
{
    // A lobe toward +X: the equirect's middle half (|longitude| < pi/2 is
    // where dirX > 0). Only direction-dependent coefficients may be nonzero,
    // and c3 (0.488603 * x) dominates band 1.
    const width = 64;
    const height = 32;
    const pixels = new Float32Array(width * height * 3);
    for (let py = 0; py < height; py++)
    {
        for (let px = 0; px < width; px++)
        {
            const o = (py * width + px) * 3;
            const lit = px >= width / 4 && px < (3 * width) / 4 ? 1 : 0;
            pixels[o] = lit;
            pixels[o + 1] = lit;
            pixels[o + 2] = lit;
        }
    }
    const sh = projectDiffuseSh(pixels, width, height);
    // c3 = 0.488603 * (2/3) * integral of x over the +X hemisphere = ~1.02.
    assert.ok(sh[3 * 3] > 0.9, `c3 should light toward +X: ${sh[3 * 3]}`);
    // The constant term is the hemispherical average radiance (0.5).
    assert.ok(Math.abs(sh[0] - 0.5 / 0.28209479177387814) < 0.05);
    // Symmetric lobes cancel: c1 (y) and c2 (z) stay ~0.
    assert.ok(Math.abs(sh[1 * 3]) < 1e-9, `c1: ${sh[1 * 3]}`);
    assert.ok(Math.abs(sh[2 * 3]) < 1e-9, `c2: ${sh[2 * 3]}`);
});

test("srgbToLinear applies the piecewise sRGB EOTF", () =>
{
    assert.equal(srgbToLinear(0), 0);
    assert.equal(srgbToLinear(1), 1);
    // Linear segment below the 0.04045 knee.
    assert.ok(Math.abs(srgbToLinear(0.04) - 0.04 / 12.92) < 1e-12);
    // Power-law segment above it (mid gray ~0.2140).
    assert.ok(Math.abs(srgbToLinear(0.5) - 0.21404114048) < 1e-9);
});

test("linearizeSrgbFace converts RGB channels and leaves alpha alone", () =>
{
    const face = new Float32Array([ 0.5, 1, 0.25, 0.75 ]);
    linearizeSrgbFace(face);
    // The face stores float32, so allow storage rounding on top of the EOTF.
    assert.ok(Math.abs(face[0] - srgbToLinear(0.5)) < 1e-6);
    assert.equal(face[1], 1);
    assert.ok(Math.abs(face[2] - srgbToLinear(0.25)) < 1e-6);
    assert.equal(face[3], 0.75);
});

test("repairSpikes replaces spike pixels with the neighborhood mean", () =>
{
    const width = 8;
    const height = 4;
    const pixels = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++)
    {
        pixels[i * 3] = 0.2;
        pixels[i * 3 + 1] = 0.5;
        pixels[i * 3 + 2] = 0.1;
    }
    const spike = (x, y, r, g, b) =>
    {
        const o = (y * width + x) * 3;
        pixels[o] = r;
        pixels[o + 1] = g;
        pixels[o + 2] = b;
    };
    // Interior BC6H-style negative spike.
    spike(3, 2, 0, -478.75, 0);
    // A NaN pixel at the left edge: its neighborhood wraps to the right edge.
    spike(0, 1, Number.NaN, 0.5, 0.1);
    // Two adjacent spikes repair from valid neighbors only.
    spike(5, 0, -3, 0.5, 0.1);
    spike(6, 0, 0.2, -9, 0.1);

    assert.equal(repairSpikes(pixels, width, height), 4);
    for (const [ x, y ] of [ [ 3, 2 ], [ 0, 1 ], [ 5, 0 ], [ 6, 0 ] ])
    {
        const o = (y * width + x) * 3;
        assert.ok(Math.abs(pixels[o] - 0.2) < 1e-6, `(${x},${y}) r: ${pixels[o]}`);
        assert.ok(Math.abs(pixels[o + 1] - 0.5) < 1e-6, `(${x},${y}) g: ${pixels[o + 1]}`);
        assert.ok(Math.abs(pixels[o + 2] - 0.1) < 1e-6, `(${x},${y}) b: ${pixels[o + 2]}`);
    }
    // Nothing else was touched.
    assert.equal(repairSpikes(pixels, width, height), 0);
});

test("repairSpikes uses only originally valid pixels as donors", () =>
{
    // A 3x3 with three spikes: (1,0) repairs before (0,1) and (1,1) in
    // row-major order. If repaired pixels could become donors, (0,1) would
    // pick up (1,0)'s repaired value and (1,1) both repaired values, making
    // the result scan-direction dependent. Nonuniform valid pixels pin the
    // original-donor means exactly.
    const width = 3;
    const height = 3;
    const pixels = new Float32Array(width * height * 3);
    const set = (x, y, v) =>
    {
        const o = (y * width + x) * 3;
        pixels[o] = v;
        pixels[o + 1] = v;
        pixels[o + 2] = v;
    };
    set(0, 0, 10);
    set(2, 0, 20);
    set(2, 1, 30);
    set(0, 2, 40);
    set(1, 2, 50);
    set(2, 2, 60);
    for (const [ x, y ] of [ [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ]) set(x, y, -1);

    assert.equal(repairSpikes(pixels, width, height), 3);
    // (1,0): original donors (0,0), (2,0), (2,1) -> mean 20.
    // (0,1): original donors the six valid ring pixels -> mean 35.
    // (1,1): original donors the same six valid ring pixels -> mean 35.
    const at = (x, y) =>
    {
        const o = (y * width + x) * 3;
        return [ pixels[o], pixels[o + 1], pixels[o + 2] ];
    };
    assert.deepEqual(at(1, 0), [ 20, 20, 20 ]);
    assert.deepEqual(at(0, 1), [ 35, 35, 35 ]);
    assert.deepEqual(at(1, 1), [ 35, 35, 35 ]);
    // Valid pixels are untouched.
    assert.deepEqual(at(0, 0), [ 10, 10, 10 ]);
    assert.deepEqual(at(2, 2), [ 60, 60, 60 ]);
});

test("repairSpikes blacks out a pixel with no valid neighbors", () =>
{
    const width = 4;
    const height = 4;
    // A 3x3 block of spikes around the center leaves the center neighborless.
    const pixels = new Float32Array(width * height * 3).fill(-1);
    const repaired = repairSpikes(pixels, width, height);
    assert.equal(repaired, width * height);
    for (const v of pixels) assert.equal(v, 0);
});

test("extractSceneParameters reads the EveSpaceScene fields and omits absent ones", () =>
{
    const scene = {
        _type: "EveSpaceScene",
        backgroundEffect: {
            _type: "Tr2Effect",
            constParameters: [
                { name: "Tint", value: [ 1, 0.5, 0.25, 1 ] },
                { name: "NebulaScaling", value: [ 1, 1, 1, 1 ] }
            ]
        },
        ambientColor: [ 0.09, 0.07, 0.04, 1 ],
        nebulaIntensity: 1.25,
        reflectionIntensity: 1.4,
        fogStart: -500000
    };
    assert.deepEqual(extractSceneParameters(scene), {
        nebulaIntensity: 1.25,
        reflectionIntensity: 1.4,
        ambientColor: [ 0.09, 0.07, 0.04 ],
        tint: [ 1, 0.5, 0.25 ]
    });
    assert.deepEqual(extractSceneParameters({}), {});
    assert.deepEqual(extractSceneParameters({ nebulaIntensity: Number.NaN, ambientColor: [ 1, 2 ] }), {});
    assert.deepEqual(extractSceneParameters({ reflectionIntensity: Number.NaN }), {});
    assert.deepEqual(extractSceneParameters({ backgroundEffect: null }), {});
});
