// DC color round-trip A/B: LPQ (FineHash) vs Ohta I1I2I3 (1980).
//
// Three transforms are compared, all with chroma normalized to [-1,+1]:
//
//   LPQ        - FineHash's color space
//   Ohta       - original I1I2I3, chroma spans +/-0.5 (half range)
//   Ohta-scaled - I2/I3 rescaled to +/-1 so ranges match LPQ exactly;
//                 isolates the axis choice from the range asymmetry
//
// Usage: node test/color-ab.mjs

// ---- Normalized transforms --------------------------------------------------
// Input/output: R, G, B in [0, 255].

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// LPQ: L in [0,1], P in [-1,1], Q in [-1,1]
//
// Forward:  L = (R+G+B)/3/255,  P = ((R+G)/2-B)/255,  Q = (R-G)/255
// Inverse:  R = L + P/3 + Q/2,  G = L + P/3 - Q/2,    B = L - 2P/3
//           (all x 255, clamped to [0,255])
const LPQ = {
  name: 'LPQ',
  fwd: (r, g, b) => [
    (r + g + b) / (3 * 255),
    ((r + g) / 2 - b) / 255,
    (r - g) / 255,
  ],
  inv: (l, p, q) => [
    clamp((l + p / 3 + q / 2) * 255),
    clamp((l + p / 3 - q / 2) * 255),
    clamp((l - 2 * p / 3) * 255),
  ],
  lumaRange:   [0, 1],
  chromaRange: [-1, 1],
};

// Ohta I1I2I3: I1 in [0,1], I2 in [-0.5,0.5], I3 in [-0.5,0.5]
//
// Forward:  I1 = (R+G+B)/3/255,  I2 = (R-B)/(2*255),  I3 = (2G-R-B)/(4*255)
// Inverse:  R = I1 + I2 - 2I3/3,  G = I1 + 4I3/3,  B = I1 - I2 - 2I3/3
//           (all x 255, clamped to [0,255])
const OHTA = {
  name: 'Ohta I1I2I3',
  fwd: (r, g, b) => [
    (r + g + b) / (3 * 255),
    (r - b) / (2 * 255),
    (2 * g - r - b) / (4 * 255),
  ],
  inv: (i1, i2, i3) => [
    clamp((i1 + i2 - 2 * i3 / 3) * 255),
    clamp((i1 + 4 * i3 / 3) * 255),
    clamp((i1 - i2 - 2 * i3 / 3) * 255),
  ],
  lumaRange:   [0, 1],
  chromaRange: [-0.5, 0.5],
};

// Ohta I1I2I3 with chroma rescaled to +/-1 - isolates axis choice from range.
// I2' = (R-B)/255  in [-1,1]   (I2 x 2)
// I3' = (2G-R-B)/(2*255) in [-1,1]  (I3 x 2)
//
// Inverse (x36 denominator, same as LPQ):
//   R = (36*I1 + 18*I2' - 12*I3') / 36
//   G = (36*I1 + 24*I3')           / 36
//   B = (36*I1 - 18*I2' - 12*I3') / 36
const OHTA_SCALED = {
  name: 'Ohta-scaled',
  fwd: (r, g, b) => [
    (r + g + b) / (3 * 255),
    (r - b) / 255,
    (2 * g - r - b) / (2 * 255),
  ],
  inv: (i1, i2, i3) => [
    clamp((36 * i1 + 18 * i2 - 12 * i3) / 36 * 255),
    clamp((36 * i1 + 24 * i3)            / 36 * 255),
    clamp((36 * i1 - 18 * i2 - 12 * i3) / 36 * 255),
  ],
  lumaRange:   [0, 1],
  chromaRange: [-1, 1],
};

// ---- Quantizer --------------------------------------------------------------

function quantize(v, lo, hi, bits) {
  const levels = (1 << bits) - 1;
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return (Math.round(t * levels) / levels) * (hi - lo) + lo;
}

function roundtrip(cs, r, g, b, lumaBits, chromaBits) {
  const [x0, x1, x2] = cs.fwd(r, g, b);
  const q0 = quantize(x0, cs.lumaRange[0],   cs.lumaRange[1],   lumaBits);
  const q1 = quantize(x1, cs.chromaRange[0], cs.chromaRange[1], chromaBits);
  const q2 = quantize(x2, cs.chromaRange[0], cs.chromaRange[1], chromaBits);
  return cs.inv(q0, q1, q2);
}

// ---- Error metrics ----------------------------------------------------------

function pixelErr(orig, recon) {
  const dr = recon[0] - orig[0];
  const dg = recon[1] - orig[1];
  const db = recon[2] - orig[2];
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

// ---- Test corpus ------------------------------------------------------------
// Systematic 16^3 grid (4096 samples) + saturated primaries + grays.

const corpus = [];

const GRID = 16;
for (let ri = 0; ri < GRID; ri++) {
  for (let gi = 0; gi < GRID; gi++) {
    for (let bi = 0; bi < GRID; bi++) {
      corpus.push([
        Math.round((ri / (GRID - 1)) * 255),
        Math.round((gi / (GRID - 1)) * 255),
        Math.round((bi / (GRID - 1)) * 255),
      ]);
    }
  }
}

// ---- Run comparison ---------------------------------------------------------

const LUMA_BITS   = 7;
const CHROMA_BITS = 5;

const NAMED = [
  ['red',          255,   0,   0],
  ['green',          0, 255,   0],
  ['blue',           0,   0, 255],
  ['yellow',       255, 255,   0],
  ['cyan',           0, 255, 255],
  ['magenta',      255,   0, 255],
  ['white',        255, 255, 255],
  ['mid-gray',     128, 128, 128],
  ['skin tone',    224, 172, 105],
  ['sky blue',      87, 165, 212],
  ['forest green',  34, 139,  34],
  ['dark red',     139,   0,   0],
];

function runAll(colorSpaces) {
  const stats = colorSpaces.map(() => ({ ss: 0, max: 0, worst: [] }));

  for (const [r, g, b] of corpus) {
    for (let i = 0; i < colorSpaces.length; i++) {
      const out = roundtrip(colorSpaces[i], r, g, b, LUMA_BITS, CHROMA_BITS);
      const e = pixelErr([r, g, b], out);
      stats[i].ss  += e * e;
      stats[i].max  = Math.max(stats[i].max, e);
      stats[i].worst.push({ e, rgb: [r, g, b], out });
    }
  }

  const n = corpus.length;

  // Header
  const nameW = 14;
  const colW  = 10;
  const hdr = colorSpaces.map(cs => padR(cs.name, colW)).join('  ');
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`  ${padR('metric', nameW)}  ${hdr}`);
  console.log(`  ${'-'.repeat(nameW + colorSpaces.length * (colW + 2))}`);

  const rmses = stats.map(s => Math.sqrt(s.ss / n));
  const maxes = stats.map(s => s.max);
  const bestRmse = Math.min(...rmses);
  const bestMax  = Math.min(...maxes);

  console.log(`  ${padR('RMSE', nameW)}  `
    + rmses.map((v, i) => padR(v.toFixed(3) + (v === bestRmse ? ' *' : ''), colW)).join('  '));
  console.log(`  ${padR('max err', nameW)}  `
    + maxes.map((v, i) => padR(v.toFixed(2)  + (v === bestMax  ? ' *' : ''), colW)).join('  '));

  // Worst cases per color space
  console.log();
  for (let i = 0; i < colorSpaces.length; i++) {
    stats[i].worst.sort((a, b) => b.e - a.e);
    console.log(`  ${colorSpaces[i].name} worst:`);
    for (const { e, rgb, out } of stats[i].worst.slice(0, 3)) {
      console.log(`    rgb(${pad3(rgb)}) -> rgb(${pad3(out)})  err=${e.toFixed(2)}`);
    }
  }

  // Spot checks
  console.log();
  const spotHdr = colorSpaces.map(cs => padR(cs.name + ' out', 17)).join(' ');
  console.log(`  ${padR('color', 14)} ${padR('original', 17)} ${spotHdr}`
    + colorSpaces.map(cs => padR(cs.name.slice(0, 8) + '-err', 10)).join(' '));
  console.log(`  ${'-'.repeat(20 + colorSpaces.length * 27)}`);
  for (const [name, r, g, b] of NAMED) {
    const outs = colorSpaces.map(cs => roundtrip(cs, r, g, b, LUMA_BITS, CHROMA_BITS));
    const errs = outs.map(o => pixelErr([r, g, b], o));
    console.log(
      `  ${padR(name, 14)} rgb(${pad3([r, g, b])})  `
      + outs.map(o => `rgb(${pad3(o)})`).join('  ') + '  '
      + errs.map(e => e.toFixed(2).padStart(6)).join('  '),
    );
  }
}

// ---- Formatting helpers -----------------------------------------------------

function padR(s, n) {
  return String(s).padEnd(n);
}
function pad3([a, b, c]) {
  return `${String(a).padStart(3)},${String(b).padStart(3)},${String(c).padStart(3)}`;
}

// ---- Main -------------------------------------------------------------------

console.log('Color space DC round-trip comparison (7-bit luma, 5-bit chroma)');
console.log(`Corpus: ${corpus.length} pixels (${GRID}^3 systematic grid)\n`);
console.log('All three transforms use the same bit widths.');
console.log('Ohta-scaled rescales I2/I3 to +/-1 to eliminate the range asymmetry,');
console.log('leaving only the axis choice as the variable.\n');
console.log('Channel ranges:');
console.log('  LPQ:         L  in [0,1]   P  = (R+G)/2-B   in [-1,+1]       Q  = R-G         in [-1,+1]');
console.log('  Ohta:        I1 in [0,1]   I2 = (R-B)/2     in [-1/2,+1/2]   I3 = (2G-R-B)/4  in [-1/2,+1/2]');
console.log('  Ohta-scaled: I1 in [0,1]   I2\'= R-B         in [-1,+1]       I3\'= (2G-R-B)/2  in [-1,+1]');

runAll([LPQ, OHTA_SCALED, OHTA]);
