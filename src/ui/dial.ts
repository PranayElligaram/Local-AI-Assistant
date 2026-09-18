/**
 * Geometry of the reactor dial, in the instrument's viewBox units (the WebGL
 * ring is r 300). Shared by the live instrument, the boot assembly and the
 * ignition screen so all three are the same object.
 */

const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180
  return `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`
}

/** Every two degrees, longer at 10° and 30°. Two paths so the majors can be
 *  brighter without 180 separate nodes. */
function scale() {
  let minor = ''
  let major = ''
  for (let deg = 0; deg < 360; deg += 2) {
    const len = deg % 30 === 0 ? 24 : deg % 10 === 0 ? 14 : 7
    const seg = `M${polar(372, deg)}L${polar(372 + len, deg)}`
    if (deg % 30 === 0) major += seg
    else minor += seg
  }
  return { minor, major }
}

/** Four mounting brackets on the diagonals: a short arc and a radial stub. */
function brackets() {
  let d = ''
  for (const c of [45, 135, 225, 315]) {
    d += `M${polar(418, c - 6)}A418,418 0 0,1 ${polar(418, c + 6)}`
    d += `M${polar(418, c)}L${polar(434, c)}`
  }
  return d
}

export const SCALE = scale()
export const BRACKETS = brackets()
