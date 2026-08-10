// Raw file imports, used by tests that assert a shipped asset is real.
// Declared here rather than pulling in vite/client, which would also add DOM
// lib globally - the project targets workerd, where `document` does not exist.
declare module '*?raw' {
  const content: string;
  export default content;
}
