// utils/colourDistance.js
//
// CIELAB + CIEDE2000 perceptual DISTANCE, OKLab/OKLCH, and CIE L* — a VERBATIM CommonJS port
// of two frontend modules. Pure maths: no models, no DB, no network, no npm dependency.
//
// ---------------------------------------------------------------------------------------
// DECISION Phase 88.3.1 (D-02): a verbatim port of the frontend maths, pinned by ONE shared
// numeric fixture vector asserted independently in BOTH repos.
// ---------------------------------------------------------------------------------------
// CHOSEN: this file is a line-for-line port — same function names, same private helper names,
// same variable names, same order of operations, same constants — of
//   * `periodictabletop/src/lib/colourDistance.ts`  (deltaE2000, oklch)
//   * `periodictabletop/src/lib/wcag.ts:129-243`    (parseHex, relativeLuminance, lStar)
// Those two FRONTEND files are the **SOURCE OF TRUTH**. A change is made THERE first and
// ported here, never the reverse. The two repos share no directory and cannot import each
// other, so the mechanism that catches a divergence is a shared numeric fixture:
// `tests/unit/colourDistance.test.js` here asserts the SAME four (hexA, hexB) -> ΔE2000 rows
// and the SAME four hex -> L* rows as `periodictabletop/src/lib/colourDistance.test.ts`.
// **Changing a number in one without changing it in the other is a defect, not a fix.**
//
// REJECTED, alternative 1 — an independent backend implementation with no shared fixture.
// CIEDE2000 has several published forms with known sign/quadrant traps, and a third-decimal
// divergence is not cosmetic here. `Storm #27272a` sits 15.56 from the new dark `blue` band
// and 16.21 from `teal` — a margin of **0.65**. `legacy orange #fff3e0` sits 11.29 from the
// new light `orange` surface and 12.01 from `amber` — a margin of **0.72**. Either flip ships
// as a green suite on both sides and a permanently wrong migration row
// (88.3.1-RESEARCH.md Pitfall 5, 88.3.1-UI-SPEC.md section 4.2).
//
// REJECTED, alternative 2 — an npm colour package (`culori` / `chroma-js` / `colorjs.io`)
// inside a PRODUCTION MIGRATION PATH. The plan 88.3.1-05 remap rewrites
// `Groups.background_color` permanently; a supply-chain surface buys nothing for maths this
// repo has already verified against 15 independent data points
// (88.3.1-RESEARCH.md `## Package Legitimacy Audit`). Backend deps intersect colour libraries
// is `[]` and stays `[]`.
//
// REJECTED, alternative 3 — a shared npm package published between the two repos. Same
// supply-chain surface, plus a release step in the middle of a data migration.
//
// REJECTED, alternative 4 — using `oklch(hex).L` as a stand-in for CIE L* in plan 88.3.1-05's
// computed-fallback arm. `oklch().L` is OKLab lightness on a 0-1 scale; CIE L* is 0-100. The
// fallback branches on `lStar(hex) < 50`, so substituting `oklch().L` would compare a 0-1
// number against 50 and take the dark arm for EVERY colour, silently. That is why
// `relativeLuminance` and `lStar` are ported here too and not left to be improvised.
//
// Changing this is a decision, not a cleanup.
//
// ---------------------------------------------------------------------------------------
// THE SECOND, STRONGER SAFETY LAYER — the computed path is nearly unreachable.
// ---------------------------------------------------------------------------------------
// 88.3.1-UI-SPEC.md section 4.2 point 1 hard-codes ALL FIFTEEN known old->new rows as
// literals in the remap migration. `deltaE2000` (and `lStar`, for the DARK/LIGHT band
// decision) is therefore only consulted for a stored hex that is NOT one of those fifteen —
// which, per 88.3.1-RESEARCH.md assumptions A1/A2, should be no row that exists today. The
// D-03 production census (plan 88.3.1-05) is the instrument that confirms it. This module is
// the belt to that migration's braces, not the primary mechanism.
//
// ---------------------------------------------------------------------------------------
// THE TWO TRAPS THIS IMPLEMENTATION HAS TO GET RIGHT (RESEARCH Pitfall 5).
// ---------------------------------------------------------------------------------------
//  1. The MEAN HUE `hbp`. When |h1p - h2p| > 180 degrees the mean is NOT (h1p + h2p) / 2 —
//     the pair straddles the 0/360 seam and the correct mean is (h1p + h2p +/- 360) / 2,
//     choosing the sign on whether the raw sum is under 360. Getting this wrong moves `T`,
//     `dTheta` and therefore `Rt`, and it only shows up on colours near red — which is where
//     four of the eight presets sit. It also breaks SYMMETRY first, which is why the test
//     asserts it.
//  2. The SIGN of the `Rt` rotation term. `Rt = -sin(2*dTheta)*Rc` — negative. A positive
//     `Rt` still returns plausible numbers everywhere and only misorders near-blue pairs,
//     which is exactly the `Storm -> blue vs teal` row.
//
// ---------------------------------------------------------------------------------------
// PORT DEVIATIONS — the complete list. Nothing else differs.
// ---------------------------------------------------------------------------------------
//  a. Module system: `module.exports` instead of `export`; TypeScript annotations replaced
//     by JSDoc.
//  b. `parseHex` is INLINED. The frontend imports it from `./wcag`; there is no backend
//     `wcag` module. The source of truth for its behaviour is
//     `periodictabletop/src/lib/wcag.ts:129`.
//  c. TWO sRGB transfer functions coexist here because this one file merges two frontend
//     modules that each define a private `linearize` with a DIFFERENT knee, on purpose:
//       - `linearize` / `SRGB_KNEE` = 0.04045 (IEC 61966-2-1) — used by the Lab/OKLab path,
//         ported from `colourDistance.ts`.
//       - `wcagLinearize` / `WCAG_SRGB_KNEE` = 0.03928 (the constant WCAG 2.x publishes) —
//         used by `relativeLuminance`/`lStar`, ported from `wcag.ts`.
//     The frontend keeps them apart by file boundary; a single file cannot, so the WCAG pair
//     carries a `wcag`-prefixed name. This is the ONLY rename in the port and it is forced by
//     the merge — the two constants differ by ~1e-5 in luminance, they are separate ON
//     PURPOSE, and neither should ever be "converged" onto the other.
//
// ---------------------------------------------------------------------------------------
// TOTALITY CONTRACT (threat T-88.3.1-01 / T-88.3.1-10, ASVS V5).
// ---------------------------------------------------------------------------------------
// EVERY exported function is TOTAL. A malformed, null, non-string or hostile input returns
// `null` and never throws — these functions are handed arbitrary `Groups.background_color`
// values by a migration. `null` must NEVER be coerced to 0 by a caller: 0 reads as "a perfect
// match" and would mis-remap a row. A caller that gets `null` leaves the row untouched.

/** CIE epsilon (216/24389) and kappa (24389/27) — the exact rational forms. */
const CIE_EPSILON = 216 / 24389;
const CIE_KAPPA = 24389 / 27;

/** IEC 61966-2-1 sRGB transfer-function knee (see PORT DEVIATION (c)). */
const SRGB_KNEE = 0.04045;

/** The WCAG 2.x sRGB transfer-function knee (see PORT DEVIATION (c)). */
const WCAG_SRGB_KNEE = 0.03928;

/** WCAG 2.x relative-luminance coefficients. */
const LUMINANCE_R = 0.2126;
const LUMINANCE_G = 0.7152;
const LUMINANCE_B = 0.0722;

/** D65 white point, the reference white every value in `88.3.1-UI-SPEC.md` was measured against. */
const WHITE_X = 0.95047;
const WHITE_Y = 1.0;
const WHITE_Z = 1.08883;

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_FULL = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_FUNC = /^rgba?\(\s*([^)]*)\)$/i;

/**
 * Clamp to an integer channel in 0-255. Non-finite input yields **NaN**, so that `parseHex`
 * rejects the colour via `rgb.some(Number.isNaN)`.
 *
 * The NaN is the contract, not an oversight (frontend DECISION Phase 88.3-cr / CR-04):
 * returning 0 would turn a malformed channel into a silent black, so `rgb(x, 0, 0)` would
 * parse as an accepted colour and every reading taken against it would be wrong-but-plausible.
 *
 * @param {number} value
 * @returns {number} an integer 0-255, or NaN
 */
function toChannel(value) {
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.min(255, Math.max(0, Math.round(value)));
}

/**
 * Parse a colour string into an sRGB triple.
 *
 * PORTED, INLINED (PORT DEVIATION (b)). Source of truth for this behaviour:
 * `periodictabletop/src/lib/wcag.ts:129`, which owns every hex/rgb() parse in that tree.
 *
 * Accepts `#rgb`, `#rrggbb`, `rgb(r, g, b)` and `rgba(r, g, b, a)`. Case-insensitive,
 * surrounding whitespace tolerated. Alpha is parsed and discarded.
 *
 * Returns `null` for everything else, including `null`, `undefined` and non-strings.
 * Never throws.
 *
 * @param {unknown} value
 * @returns {[number, number, number]|null} sRGB triple, or null
 */
function parseHex(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (input.length === 0) return null;

  const short = HEX_SHORT.exec(input);
  if (short) {
    return [
      parseInt(short[1] + short[1], 16),
      parseInt(short[2] + short[2], 16),
      parseInt(short[3] + short[3], 16),
    ];
  }

  const full = HEX_FULL.exec(input);
  if (full) {
    return [parseInt(full[1], 16), parseInt(full[2], 16), parseInt(full[3], 16)];
  }

  const func = RGB_FUNC.exec(input);
  if (func) {
    // Both separator conventions: `r, g, b, a` and `r g b / a`.
    const parts = func[1]
      .replace(/\//g, ' ')
      .split(/[\s,]+/)
      .filter((part) => part.length > 0);
    if (parts.length < 3) return null;
    // Percentage channels are NOT supported — declared rather than silently mis-parsed.
    if (parts.slice(0, 3).some((part) => part.endsWith('%'))) return null;
    const rgb = [toChannel(Number(parts[0])), toChannel(Number(parts[1])), toChannel(Number(parts[2]))];
    if (rgb.some((channel) => Number.isNaN(channel))) return null;
    return rgb;
  }

  return null;
}

/**
 * The IEC 61966-2-1 sRGB transfer function, applied to one 0-255 channel.
 *
 * @param {number} channel
 * @returns {number}
 */
function linearize(channel) {
  const c = channel / 255;
  return c <= SRGB_KNEE ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The WCAG 2.x sRGB transfer function, applied to one 0-255 channel. Distinct from
 * `linearize` above by knee constant — see PORT DEVIATION (c). Do not merge the two.
 *
 * @param {number} channel
 * @returns {number}
 */
function wcagLinearize(channel) {
  const c = channel / 255;
  return c <= WCAG_SRGB_KNEE ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Linear sRGB -> CIE XYZ (D65 primaries).
 *
 * @param {readonly [number, number, number]} rgb
 * @returns {[number, number, number]}
 */
function toXyz(rgb) {
  const r = linearize(rgb[0]);
  const g = linearize(rgb[1]);
  const b = linearize(rgb[2]);
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  ];
}

/**
 * The CIELAB compression function `f(t)`.
 *
 * @param {number} t
 * @returns {number}
 */
function labF(t) {
  return t > CIE_EPSILON ? Math.cbrt(t) : (CIE_KAPPA * t + 16) / 116;
}

/**
 * sRGB triple -> CIELAB (D65).
 *
 * Module-private on purpose, exactly as in the frontend: the `L` returned here is a second
 * route to the quantity exported below as `lStar`, and exporting it would create a duplicate
 * lightness implementation.
 *
 * @param {readonly [number, number, number]} rgb
 * @returns {{ L: number, a: number, b: number }} CIELAB triple: L* 0-100, a* and b* unbounded
 */
function toLab(rgb) {
  const [X, Y, Z] = toXyz(rgb);
  const fx = labF(X / WHITE_X);
  const fy = labF(Y / WHITE_Y);
  const fz = labF(Z / WHITE_Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * Ottosson OKLab: linear sRGB -> LMS (M1) -> cube root -> OKLab (M2).
 *
 * @param {readonly [number, number, number]} rgb
 * @returns {{ L: number, a: number, b: number }}
 */
function toOklab(rgb) {
  const r = linearize(rgb[0]);
  const g = linearize(rgb[1]);
  const b = linearize(rgb[2]);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

/**
 * CIEDE2000 perceptual colour difference, `kL = kC = kH = 1`.
 *
 * Sharma, Wu & Dalal (2005), "The CIEDE2000 Color-Difference Formula: Implementation Notes,
 * Supplementary Test Data, and Mathematical Observations" — the formulation whose whole point
 * is the two traps named in the header.
 *
 * Symmetric: `deltaE2000(a, b) === deltaE2000(b, a)`. Identity: `deltaE2000(x, x) === 0`.
 *
 * Returns `null` if EITHER input fails `parseHex` — a caller must never be handed a plausible
 * distance computed against a colour that was never understood. See the totality contract.
 *
 * @param {unknown} a - a colour string (`#rgb`, `#rrggbb`, `rgb()`, `rgba()`)
 * @param {unknown} b - a colour string
 * @returns {number|null} the CIEDE2000 distance, or null if either input fails to parse
 */
function deltaE2000(a, b) {
  const rgbA = parseHex(a);
  const rgbB = parseHex(b);
  if (!rgbA || !rgbB) return null;

  const { L: L1, a: a1, b: b1 } = toLab(rgbA);
  const { L: L2, a: a2, b: b2 } = toLab(rgbB);

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const cBar = (C1 + C2) / 2;

  // The a* expansion that pulls near-neutral colours away from the grey axis.
  const G = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;

  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  // A colour with no chroma has no hue; `atan2(0, 0)` is 0 in JS but the formula wants the
  // hue treated as absent, which the `C1p * C2p === 0` guards below do.
  const h1p = a1p === 0 && b1 === 0 ? 0 : (toDegrees(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = a2p === 0 && b2 === 0 ? 0 : (toDegrees(Math.atan2(b2, a2p)) + 360) % 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp;
  if (C1p * C2p === 0) {
    dhp = 0;
  } else {
    dhp = h2p - h1p;
    // TRAP 1, first half: take the SHORT way round the wheel, never the long one.
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(toRadians(dhp) / 2);

  const lBarP = (L1 + L2) / 2;
  const cBarP = (C1p + C2p) / 2;

  // TRAP 1, second half: the mean hue's quadrant. When the pair straddles the 0/360 seam the
  // arithmetic mean lands on the OPPOSITE side of the wheel from both inputs.
  let hBarP;
  if (C1p * C2p === 0) {
    hBarP = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hBarP = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hBarP = (h1p + h2p + 360) / 2;
  } else {
    hBarP = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos(toRadians(hBarP - 30)) +
    0.24 * Math.cos(toRadians(2 * hBarP)) +
    0.32 * Math.cos(toRadians(3 * hBarP + 6)) -
    0.20 * Math.cos(toRadians(4 * hBarP - 63));

  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));

  const Sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const Sc = 1 + 0.045 * cBarP;
  const Sh = 1 + 0.015 * cBarP * T;

  // TRAP 2: this term is NEGATIVE. A positive `Rt` returns plausible numbers everywhere and
  // only misorders near-blue pairs — the `Storm -> blue vs teal` row, margin 0.65.
  const Rt = -Math.sin(toRadians(2 * dTheta)) * Rc;

  const termL = dLp / Sl;
  const termC = dCp / Sc;
  const termH = dHp / Sh;

  return Math.sqrt(termL ** 2 + termC ** 2 + termH ** 2 + Rt * termC * termH);
}

/**
 * OKLCH: Ottosson OKLab in polar form.
 *
 * `L` is 0-1 (NOT CIE L*, which is 0-100 and is exported below as `lStar`), `C` is the chroma
 * `hypot(a, b)`, and `h` is `atan2(b, a)` normalised into `[0, 360)`.
 *
 * The hue of a NEUTRAL is meaningless. `oklch('#f5f5f5')` returns a `C` under 0.005 and an `h`
 * that is numerically defined but carries no perceptual information — a caller must check `C`
 * before trusting `h`.
 *
 * Returns `null` on a parse failure, per the totality contract.
 *
 * @param {unknown} value - a colour string
 * @returns {{ L: number, C: number, h: number }|null} L 0-1, C >= 0, h in degrees [0, 360)
 */
function oklch(value) {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const { L, a, b } = toOklab(rgb);
  const C = Math.hypot(a, b);
  const h = (toDegrees(Math.atan2(b, a)) + 360) % 360;
  return { L, C, h };
}

/**
 * WCAG 2.x sRGB relative luminance, 0 (black) to 1 (white).
 *
 * PORTED from `periodictabletop/src/lib/wcag.ts:200`, which is the source of truth. Uses
 * `wcagLinearize` (knee 0.03928), NOT the `linearize` the Lab/OKLab path uses — see PORT
 * DEVIATION (c).
 *
 * `null` in (unparseable) means `null` out. Never throws.
 *
 * @param {unknown} value - a colour string
 * @returns {number|null} relative luminance 0-1, or null
 */
function relativeLuminance(value) {
  const rgb = parseHex(value);
  if (!rgb) return null;
  return (
    LUMINANCE_R * wcagLinearize(rgb[0]) + LUMINANCE_G * wcagLinearize(rgb[1]) + LUMINANCE_B * wcagLinearize(rgb[2])
  );
}

/**
 * CIE L-star (D65), 0 (black) to 100 (white) — perceptual lightness.
 *
 * PORTED from `periodictabletop/src/lib/wcag.ts:237`, which is the source of truth.
 *
 * Yn is 1 because the WCAG luminance coefficients above already sum to 1 against the D65
 * white point, so `relativeLuminance('#ffffff')` is exactly the reference white's Y.
 *
 * THIS is the lightness plan 88.3.1-05's computed-fallback remap arm and its census script
 * branch on (`lStar(hex) < 50` selects the eight DARK bands, `>= 50` the eight LIGHT
 * surfaces). `oklch(value).L` is a DIFFERENT scale (0-1 OKLab) and is not a substitute:
 * comparing it against 50 takes the dark arm for every colour. See REJECTED alternative 4.
 *
 * `null` in (unparseable) means `null` out. Never throws.
 *
 * @param {unknown} value - a colour string
 * @returns {number|null} CIE L* 0-100, or null
 */
function lStar(value) {
  const y = relativeLuminance(value);
  if (y === null) return null;
  return y > CIE_EPSILON ? 116 * y ** (1 / 3) - 16 : CIE_KAPPA * y;
}

module.exports = { deltaE2000, oklch, relativeLuminance, lStar };
