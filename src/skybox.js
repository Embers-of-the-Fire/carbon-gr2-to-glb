/**
 * Skybox baking: EVE space-scene cubemaps to Radiance HDR equirects + sidecar
 * parameters for the app's flutter_scene viewer.
 *
 * Input is the full-detail nebula cube (`*_cube.dds`, BC6H_SF16 2048x2048 —
 * except y01, the one LDR outlier, which is BC7 — 6 faces) plus the scene
 * descriptor (`*_cube.black`, an `EveSpaceScene`).
 * Output per skybox:
 *
 * - a 2048x1024 Radiance `.hdr` equirect (RGBE, new-style RLE), decoded by
 *   flutter_scene's stock `decodeRadianceHdr`;
 * - the sidecar fields (black-derived scalars + the diffuse SH projection)
 *   returned to the caller as JSON; the .pb2 assembly lives in Python.
 *
 * Orientation: the equirect uses the engine's convention (row 0 = +Y pole;
 * u sweeps longitude (u-0.5)*2pi = atan2(dirZ, dirX)). EVE is left-handed
 * (Y up, Z forward) and the ship geometry conversion negates Z to reach the
 * app's right-handed space, so the cube is sampled with the same transform
 * undone (dirEve = (x, y, -z)); background and model reflections then agree.
 *
 * The diffuse SH projection replicates flutter_scene's
 * `EnvironmentMap._projectEquirect` exactly (192x96 quadrature grid, real L2
 * basis, A_l band factors folded in with 1/pi), so the runtime never runs the
 * quadrature — critically on the web, which has no isolates.
 */

import { readFile, writeFile } from "node:fs/promises";
import { parseDDSHeader, decodeImageFloat } from "dds-ktx-parser";
import "@carbonenginejs/runtime/trinity";
import { CjsBlackFormat } from "@carbonenginejs/runtime/resource/formats/black";
import { decompressIfGzip } from "./bake.js";

/** Shipped equirect size (from the 2048x2048 full-detail cube). */
export const SKYBOX_EQUIRECT_WIDTH = 2048;
export const SKYBOX_EQUIRECT_HEIGHT = 1024;

/**
 * Decode the 6 level-0 faces of a DDS cubemap to linear float RGBA arrays.
 * BC6H (signed/unsigned half) covers the HDR nebula cubes; BC7 is accepted
 * for y01, the catalog's one LDR cube (radiance <= 1). dds-ktx-parser maps
 * both BC7_UNORM and BC7_UNORM_SRGB to "BC7"; y01 is UNORM (linear bytes),
 * which is what the equirect pipeline assumes.
 */
export function decodeCubeFaces(ddsBytes)
{
    const info = parseDDSHeader(ddsBytes);
    if (!info) throw new Error("not a DDS file or unsupported header");
    if (info.faces !== 6) throw new Error(`expected a 6-face cubemap, got ${info.faces} face(s)`);
    if (info.format !== "BC6H_SF16" && info.format !== "BC6H" && info.format !== "BC7")
    {
        throw new Error(`expected a BC6H/BC7 cubemap, got ${info.format}`);
    }
    if (info.shape.width !== info.shape.height)
    {
        throw new Error(`expected square faces, got ${info.shape.width}x${info.shape.height}`);
    }
    const size = info.shape.width;
    // DDS layer order is the DirectX cubemap face order +X, -X, +Y, -Y, +Z, -Z.
    const faces = [];
    for (let face = 0; face < 6; face++)
    {
        const layer = info.layers.find((l) => l.face === face && l.level === 0);
        if (!layer) throw new Error(`cubemap is missing face ${face} level 0`);
        faces.push(decodeImageFloat(ddsBytes, info.format, layer));
    }
    return { size, faces };
}

/**
 * Sample one cube direction with bilinear interpolation.
 *
 * `d` is in EVE's left-handed space; `faces` follow the DirectX order
 * +X, -X, +Y, -Y, +Z, -Z, each row-major with row 0 at the top. The face
 * selection and (s, t) mapping are the DirectX/Vulkan cubemap convention:
 *   +X: s=-z t=-y   -X: s=+z t=-y   +Y: s=+x t=+z
 *   -Y: s=+x t=-z   +Z: s=+x t=-y   -Z: s=-x t=-y
 */
export function sampleCube(faces, size, x, y, z, out)
{
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let face, ma, u, v;
    if (ax >= ay && ax >= az)
    {
        if (x > 0) { face = 0; ma = ax; u = -z; v = -y; }
        else { face = 1; ma = ax; u = z; v = -y; }
    }
    else if (ay >= az)
    {
        if (y > 0) { face = 2; ma = ay; u = x; v = z; }
        else { face = 3; ma = ay; u = x; v = -z; }
    }
    else
    {
        if (z > 0) { face = 4; ma = az; u = x; v = -y; }
        else { face = 5; ma = az; u = -z; v = -y; }
    }

    const px = (0.5 * (u / ma + 1)) * size - 0.5;
    const py = (0.5 * (v / ma + 1)) * size - 0.5;
    const x0 = Math.min(Math.max(Math.floor(px), 0), size - 1);
    const y0 = Math.min(Math.max(Math.floor(py), 0), size - 1);
    const x1 = Math.min(x0 + 1, size - 1);
    const y1 = Math.min(y0 + 1, size - 1);
    const tx = Math.min(Math.max(px - x0, 0), 1);
    const ty = Math.min(Math.max(py - y0, 0), 1);

    const data = faces[face];
    const i00 = (y0 * size + x0) * 4;
    const i01 = (y0 * size + x1) * 4;
    const i10 = (y1 * size + x0) * 4;
    const i11 = (y1 * size + x1) * 4;
    for (let c = 0; c < 3; c++)
    {
        const top = data[i00 + c] + (data[i01 + c] - data[i00 + c]) * tx;
        const bottom = data[i10 + c] + (data[i11 + c] - data[i10 + c]) * tx;
        out[c] = top + (bottom - top) * ty;
    }
    return out;
}

/**
 * Remap the cube faces to a linear RGB equirect (width x height, row 0 = the
 * +Y pole), undoing the left-handed to right-handed conversion (negated Z)
 * the ship geometry pipeline applies.
 */
export function cubeToEquirect(faces, size, width = SKYBOX_EQUIRECT_WIDTH, height = SKYBOX_EQUIRECT_HEIGHT)
{
    const pixels = new Float32Array(width * height * 3);
    const sample = [ 0, 0, 0 ];
    const twoPi = 2 * Math.PI;
    for (let py = 0; py < height; py++)
    {
        const v = (py + 0.5) / height;
        const latitude = (0.5 - v) * Math.PI;
        const dirY = Math.sin(latitude);
        const cosLat = Math.cos(latitude);
        for (let px = 0; px < width; px++)
        {
            const u = (px + 0.5) / width;
            const longitude = (u - 0.5) * twoPi;
            const dirX = cosLat * Math.cos(longitude);
            const dirZ = cosLat * Math.sin(longitude);
            sampleCube(faces, size, dirX, dirY, -dirZ, sample);
            const o = (py * width + px) * 3;
            pixels[o] = sample[0];
            pixels[o + 1] = sample[1];
            pixels[o + 2] = sample[2];
        }
    }
    return pixels;
}

/**
 * Repair BC6H decode spikes in the equirect. The decoder emits isolated
 * pixels with huge negative (occasionally NaN) channels; bilinear sampling
 * smears each into its 2x2 footprint, so repair runs after the remap: a
 * pixel with any negative or non-finite channel is replaced by the mean of
 * its valid 8-neighbors (longitude wraps; the poles do not). RGBE cannot
 * carry negatives or NaN, and skybox radiance is physically non-negative, so
 * a pixel with no valid neighbors becomes black. Returns the repaired pixel
 * count.
 */
export function repairSpikes(pixels, width, height)
{
    const isValid = (o) =>
        Number.isFinite(pixels[o]) && pixels[o] >= 0 &&
        Number.isFinite(pixels[o + 1]) && pixels[o + 1] >= 0 &&
        Number.isFinite(pixels[o + 2]) && pixels[o + 2] >= 0;
    let repaired = 0;
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const o = (y * width + x) * 3;
            if (isValid(o)) continue;
            let r = 0, g = 0, b = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++)
            {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -1; dx <= 1; dx++)
                {
                    if (dx === 0 && dy === 0) continue;
                    const nx = (x + dx + width) % width;
                    const no = (ny * width + nx) * 3;
                    if (!isValid(no)) continue;
                    r += pixels[no];
                    g += pixels[no + 1];
                    b += pixels[no + 2];
                    n++;
                }
            }
            pixels[o] = n ? r / n : 0;
            pixels[o + 1] = n ? g / n : 0;
            pixels[o + 2] = n ? b / n : 0;
            repaired++;
        }
    }
    return repaired;
}

/** frexp: x = fraction * 2^exponent with fraction in [0.5, 1). */
function frexp(x)
{
    if (x === 0 || !Number.isFinite(x)) return [ 0, 0 ];
    const exponent = Math.floor(Math.log2(Math.abs(x))) + 1;
    return [ x / 2 ** exponent, exponent ];
}

/** Encode one scanline channel plane with the Radiance new-style RLE. */
function rleEncodePlane(line, out)
{
    const n = line.length;
    let x = 0;
    while (x < n)
    {
        let run = 0;
        while (x + run < n && run < 127 && line[x + run] === line[x]) run++;
        if (run >= 4)
        {
            out.push(128 + run, line[x]);
            x += run;
            continue;
        }
        // Literal dump: consume until a run of 4+ starts or 128 bytes are
        // collected. The run at x is < 4 here, so at least one byte lands in
        // the packet.
        const start = x;
        let count = 0;
        while (x < n && count < 128)
        {
            let ahead = 0;
            while (x + ahead < n && ahead < 127 && line[x + ahead] === line[x]) ahead++;
            if (ahead >= 4) break;
            x++;
            count++;
        }
        if (count === 0) throw new Error("RLE encoder produced an empty literal packet");
        out.push(count);
        for (let i = start; i < start + count; i++) out.push(line[i]);
    }
}

/**
 * Encode linear RGB float pixels (width x height, row 0 at the top) as a
 * Radiance `.hdr` (RGBE, new-style RLE, `-Y height +X width`) — the exact
 * layout flutter_scene's `decodeRadianceHdr` reads.
 */
export function encodeHdr(pixels, width, height)
{
    const header = new TextEncoder().encode(
        `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`
    );
    const body = [];
    const plane = new Uint8Array(width);
    const rgbe = new Uint8Array(width * 4);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const o = (y * width + x) * 3;
            const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
            const peak = Math.max(r, g, b);
            if (peak < 1e-32) continue; // stays 0,0,0,0
            const [ fraction, exponent ] = frexp(peak);
            const scale = (fraction * 256) / peak;
            rgbe[x * 4] = Math.min(255, Math.floor(r * scale));
            rgbe[x * 4 + 1] = Math.min(255, Math.floor(g * scale));
            rgbe[x * 4 + 2] = Math.min(255, Math.floor(b * scale));
            rgbe[x * 4 + 3] = exponent + 128;
        }
        body.push(2, 2, (width >> 8) & 0xff, width & 0xff);
        for (let channel = 0; channel < 4; channel++)
        {
            for (let x = 0; x < width; x++) plane[x] = rgbe[x * 4 + channel];
            rleEncodePlane(plane, body);
        }
    }
    return Uint8Array.from([ ...header, ...body ]);
}

/**
 * Project a linear RGB equirect onto the 9 L2 diffuse spherical-harmonic RGB
 * coefficients. Replicates flutter_scene's `EnvironmentMap._projectEquirect`
 * (192x96 quadrature, real SH basis, Lambertian A_l band factors and the
 * 1/pi BRDF term folded in), so the result feeds
 * `EnvironmentMap.fromEquirectImageBytes(diffuseSphericalHarmonics:)` as-is.
 * Returns 27 floats, coefficient-major (c0.r, c0.g, c0.b, c1.r, ...).
 */
export function projectDiffuseSh(pixels, width, height)
{
    const numPhi = 192;
    const numTheta = 96;
    const coefficients = new Float64Array(27);
    const twoPi = 2 * Math.PI;
    const cellSolidAngle = (twoPi * Math.PI) / (numPhi * numTheta);

    for (let j = 0; j < numTheta; j++)
    {
        const v = (j + 0.5) / numTheta;
        const latitude = (v - 0.5) * Math.PI;
        const cosLat = Math.cos(latitude);
        const dirY = Math.sin(latitude);
        const weightRow = cosLat * cellSolidAngle;
        // Row 0 stores the +y (up) pole; increasing v maps to increasing
        // latitude, so the row lookup flips (matches the runtime projection).
        const py = Math.min(height - 1, Math.max(0, Math.floor((1 - v) * height)));
        for (let i = 0; i < numPhi; i++)
        {
            const u = (i + 0.5) / numPhi;
            const longitude = (u - 0.5) * twoPi;
            const dirX = cosLat * Math.cos(longitude);
            const dirZ = cosLat * Math.sin(longitude);
            const px = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
            const o = (py * width + px) * 3;
            const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
            const basis = [
                0.282095,
                0.488603 * dirY,
                0.488603 * dirZ,
                0.488603 * dirX,
                1.092548 * dirX * dirY,
                1.092548 * dirY * dirZ,
                0.315392 * (3 * dirZ * dirZ - 1),
                1.092548 * dirX * dirZ,
                0.546274 * (dirX * dirX - dirY * dirY)
            ];
            for (let k = 0; k < 9; k++)
            {
                const w = basis[k] * weightRow;
                coefficients[k * 3] += r * w;
                coefficients[k * 3 + 1] += g * w;
                coefficients[k * 3 + 2] += b * w;
            }
        }
    }

    // Fold in the Lambertian convolution band factors (A_l) divided by pi:
    // A_0/pi = 1, A_1/pi = 2/3, A_2/pi = 1/4. Band 0 is unchanged.
    for (let k = 1; k <= 3; k++)
    {
        coefficients[k * 3] *= 2 / 3;
        coefficients[k * 3 + 1] *= 2 / 3;
        coefficients[k * 3 + 2] *= 2 / 3;
    }
    for (let k = 4; k <= 8; k++)
    {
        coefficients[k * 3] *= 0.25;
        coefficients[k * 3 + 1] *= 0.25;
        coefficients[k * 3 + 2] *= 0.25;
    }
    return Array.from(coefficients);
}

function readColor3(value)
{
    if (!Array.isArray(value) || value.length < 3) return null;
    const rgb = value.slice(0, 3);
    return rgb.every((v) => typeof v === "number" && Number.isFinite(v)) ? rgb : null;
}

/**
 * Extract the lighting scalars of an `EveSpaceScene` black descriptor the
 * sidecar carries: `nebulaIntensity` (background), `reflectionIntensity`
 * (image-based lighting), `ambientColor`, and the background effect's `Tint`
 * const parameter. Absent values stay absent (never zero-filled); the app
 * substitutes its defaults.
 */
export function extractSceneParameters(scene)
{
    const out = {};
    if (typeof scene?.nebulaIntensity === "number" && Number.isFinite(scene.nebulaIntensity))
    {
        out.nebulaIntensity = scene.nebulaIntensity;
    }
    if (typeof scene?.reflectionIntensity === "number" && Number.isFinite(scene.reflectionIntensity))
    {
        out.reflectionIntensity = scene.reflectionIntensity;
    }
    const ambient = readColor3(scene?.ambientColor);
    if (ambient) out.ambientColor = ambient;
    const parameters = scene?.backgroundEffect?.constParameters;
    if (Array.isArray(parameters))
    {
        const tint = readColor3(parameters.find((p) => p?.name === "Tint")?.value);
        if (tint) out.tint = tint;
    }
    return out;
}

/**
 * Bake one skybox: decode the cube DDS, remap to the equirect, repair decode
 * spikes, write the `.hdr`, and return the sidecar fields (black scalars, the
 * 27 diffuse SH floats, and the repaired-pixel count). `blackBytes` may be
 * null (descriptor absent); the black fields are then simply unset.
 */
export async function bakeSkybox({ cubeBytes, blackBytes, outHdr })
{
    const dds = decompressIfGzip(cubeBytes);
    const { size, faces } = decodeCubeFaces(dds);
    const pixels = cubeToEquirect(faces, size);
    const repairedPixels = repairSpikes(pixels, SKYBOX_EQUIRECT_WIDTH, SKYBOX_EQUIRECT_HEIGHT);
    await writeFile(outHdr, encodeHdr(pixels, SKYBOX_EQUIRECT_WIDTH, SKYBOX_EQUIRECT_HEIGHT));
    const diffuseSh = projectDiffuseSh(pixels, SKYBOX_EQUIRECT_WIDTH, SKYBOX_EQUIRECT_HEIGHT);

    let parameters = {};
    if (blackBytes)
    {
        const black = decompressIfGzip(blackBytes);
        const scene = CjsBlackFormat.readPayload(black, { captureUnknownBlackFields: true }).object;
        parameters = extractSceneParameters(scene);
    }
    return { ...parameters, diffuseSh, repairedPixels };
}

/**
 * Batch entry point. Manifest: `{ jobs: [{ id, cube, black?, outHdr }] }`
 * (paths local to the host). Returns `{ jobs: [{ id, ok, error?, ...meta }] }`;
 * per-job failures are reported, never thrown.
 */
export async function runBatchSkybox(manifest)
{
    const results = [];
    for (const job of manifest.jobs ?? [])
    {
        try
        {
            const cubeBytes = new Uint8Array(await readFile(job.cube));
            const blackBytes = job.black ? new Uint8Array(await readFile(job.black)) : null;
            const meta = await bakeSkybox({ cubeBytes, blackBytes, outHdr: job.outHdr });
            results.push({ id: job.id, ok: true, ...meta });
        }
        catch (error)
        {
            results.push({ id: job.id, ok: false, error: String(error?.message ?? error) });
        }
    }
    return { jobs: results };
}
