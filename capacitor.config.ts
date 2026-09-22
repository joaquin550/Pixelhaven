import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native iOS shell.
 *
 * The game itself is unchanged: Capacitor serves the same `dist/` build inside
 * a WKWebView, so what you test on the iPad is exactly what the browser runs.
 * Everything here is about making the web view stop behaving like a browser.
 */
const config: CapacitorConfig = {
  appId: 'com.casalovero.pixelhaven',
  appName: 'Pixel Haven',
  webDir: 'dist',

  ios: {
    // The game does its own camera control. Without this, dragging the island
    // also rubber-bands the whole web view, which feels broken.
    scrollEnabled: false,
    // Let the canvas run edge to edge under the rounded corners; the UI
    // already keeps itself inside the safe area.
    contentInset: 'never',
    // Matches the sky at night, so any frame before the first render is the
    // right colour rather than white.
    backgroundColor: '#10161f',
  },

  server: {
    // Everything ships in the bundle. No cleartext, no remote origin.
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
};

export default config;
