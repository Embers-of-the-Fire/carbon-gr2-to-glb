#!/usr/bin/env node
/**
 * gr2-to-glb — convert an EVE ship GR2 + sibling DDS textures to a
 * self-contained GLB.
 *
 * Usage:
 *   node cli.js <input.gr2> [-o output.glb] [--textures <dir>] [--lod <n>]
 *               [--flip-v] [--no-flip-green] [--no-convert]
 *
 * Textures are located by stem: <stem>_a.dds, _n, _r, _m, _g next to the
 * input (or in --textures). Gzip-wrapped files are decompressed automatically.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { convertShip } from "./src/convert.js";

function usage(code)
{
    console.log(`Usage: node cli.js <input.gr2> [-o output.glb] [options]

Options:
  -o, --output <path>   Output .glb path (default: <input>.glb)
  --textures <dir>      Directory with the <stem>_*.dds set (default: input dir)
  --stem <name>         Texture stem override (default: input basename)
  --lod <n>             LOD mesh index, 0 = full detail (default: 0)
  --flip-v              Flip UV V coordinates (default: off; EVE UVs match glTF)
  --no-flip-green       Keep DirectX normal-map green channel (default: flip)
  --no-convert          Skip left-handed to right-handed coordinate conversion
  --tint <r,g,b>        Faction color multiplier for the grayscale albedo,
                        0..1 per channel (e.g. Amarr gold: 0.85,0.65,0.35)
  --data-black <path>   SOF catalog (data.black, gzip or raw)
  --dna <h:f:r>         SOF DNA string, e.g. af1_t1:amarrbase:amarr.
                        With --data-black this pulls real faction colors,
                        glow color/strength and texture paths from the catalog.
  --no-boost            Keep data-faithful faction color brightness (default).
  --boost               Normalize faction-color brightness to the raw albedo
                        luminance (for viewers with weak lighting)
  --invert-roughness    Treat the _r map as smoothness (roughness = 1 - value)
  -h, --help            Show this help`);
    process.exit(code);
}

function parseArgs(argv)
{
    const args = { input: null, output: null, textures: null, stem: null, lod: 0, flipV: false, flipGreen: true, convert: true, tint: null, dataBlack: null, dna: null, boost: false, invertRoughness: false };
    for (let i = 0; i < argv.length; i++)
    {
        const arg = argv[i];
        switch (arg)
        {
            case "-h": case "--help": usage(0); break;
            case "-o": case "--output": args.output = argv[++i]; break;
            case "--textures": args.textures = argv[++i]; break;
            case "--stem": args.stem = argv[++i]; break;
            case "--lod": args.lod = Number(argv[++i]); break;
            case "--flip-v": args.flipV = true; break;
            case "--no-flip-green": args.flipGreen = false; break;
            case "--no-convert": args.convert = false; break;
            case "--tint":
                args.tint = String(argv[++i]).split(",").map(Number);
                if (args.tint.length !== 3 || args.tint.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
                {
                    console.error("--tint expects r,g,b with each channel in 0..1");
                    process.exit(1);
                }
                break;
            case "--data-black": args.dataBlack = argv[++i]; break;
            case "--dna": args.dna = argv[++i]; break;
            case "--boost": args.boost = true; break;
            case "--invert-roughness": args.invertRoughness = true; break;
            default:
                if (arg.startsWith("-")) { console.error(`unknown option: ${arg}`); usage(1); }
                if (args.input) { console.error("only one input file is supported"); usage(1); }
                args.input = arg;
        }
    }
    if (!args.input) usage(1);
    if ((args.dataBlack && !args.dna) || (!args.dataBlack && args.dna))
    {
        console.error("--data-black and --dna must be given together");
        process.exit(1);
    }
    if (!Number.isInteger(args.lod) || args.lod < 0) { console.error("--lod must be a non-negative integer"); process.exit(1); }
    return args;
}

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input);
const inputDir = dirname(input);
const stem = args.stem ?? basename(input, extname(input));
const output = resolve(args.output ?? join(inputDir, `${stem}.glb`));

const gr2Bytes = new Uint8Array(await readFile(input));

const { glb, stats } = await convertShip(gr2Bytes, {
    textureDir: args.textures ? resolve(args.textures) : inputDir,
    stem,
    lod: args.lod,
    convertCoordinates: args.convert,
    flipV: args.flipV,
    flipGreen: args.flipGreen,
    tint: args.tint,
    boost: args.boost,
    invertRoughness: args.invertRoughness,
    sof: args.dataBlack ? { dataBlack: resolve(args.dataBlack), dna: args.dna } : undefined
});

await writeFile(output, glb);

console.log(`${stats.mesh} (LOD ${stats.lod} of ${stats.lodsAvailable}): ${stats.vertices} vertices, ${stats.triangles} triangles, ${stats.primitives} primitives`);
if (stats.dna) console.log(`dna: ${stats.dna} (hull shader: ${stats.shader})`);
console.log(`materials: ${stats.materials.join(", ")}`);
console.log(`textures: ${stats.images.length ? stats.images.join(", ") : "none found"}`);
for (const skipped of stats.skippedTextures) console.log(`skipped: ${skipped}`);
console.log(`wrote ${output} (${(glb.byteLength / 1024 / 1024).toFixed(2)} MiB)`);
