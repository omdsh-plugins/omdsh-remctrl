/**
 * One artifact, because M0 has one half.
 *
 * `lib/index.js` is the NODE half, bundled from the JavaScript tsc already
 * wrote to `lib/types`, and imported by the host Loader through the row in
 * `cordis.patch.yml`. There is no `lib/client.js` yet: the desktop pairing
 * panel is the first thing that needs a browser bundle, and until it exists a
 * client config would only add a purity gate with nothing to guard.
 *
 * `contract.js` is a second entry rather than something consumers reach through
 * the root, so the future browser half — and any test bench — can have the wire
 * vocabulary without pulling in a listener.
 */
import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'

/** This bundle's id: the package name. */
const ID = '@omdsh-plugins/omdsh-remctrl'

const nodeHalf: UserConfig = {
  name: ID,
  entry: ['lib/types/index.js', 'lib/types/contract.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default defineConfig([nodeHalf])
