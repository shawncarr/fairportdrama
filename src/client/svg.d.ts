/** SVG files in src/client are bundled as their markup (esbuild's text loader). */
declare module '*.svg' {
  const markup: string;
  export default markup;
}
