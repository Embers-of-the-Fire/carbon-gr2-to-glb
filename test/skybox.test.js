import { test } from "node:test";
import assert from "node:assert/strict";
import {
    cubeToEquirect,
    encodeHdr,
    extractSceneParameters,
    projectDiffuseSh,
    repairSpikes,
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
    let pos = header.length;
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
    assert.equal(pos, hdr.length);
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
